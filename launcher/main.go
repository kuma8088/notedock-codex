// NoteDock for Codex の起動用プログラム。
// プラグインに入れるのはこれだけ。サーバー本体は、パネルの「サーバーを取ってくる」ボタンが押されたときに取ってきて、
// SHA-256 を確かめてから動かす。起動しただけでは取りに行かない。
// 本体がないあいだも、Codex の問い合わせ（initialize, tools/list, resources/list, resources/read など）にはすぐ答える。
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed setup.html
var setupHTML string

type Asset struct {
	File   string `json:"file"`
	Size   int64  `json:"size"`
	Sha256 string `json:"sha256"`
}

type Release struct {
	Version string           `json:"version"`
	BaseURL string           `json:"base_url"`
	Assets  map[string]Asset `json:"assets"`
}

// Stub は、本物のサーバーが返した答えを、組み立てのときに写したもの（scripts/make-stub.py で作る）。
type Stub struct {
	Supported  []string        `json:"supported_protocol_versions"`
	Initialize json.RawMessage `json:"initialize"`
	ToolsUI    json.RawMessage `json:"tools_list_ui"`
	ToolsNoUI  json.RawMessage `json:"tools_list_no_ui"`
	Resources  json.RawMessage `json:"resources_list"`
	Templates  json.RawMessage `json:"resource_templates_list"`
	Panel      json.RawMessage `json:"panel_resource"` // パネルの resources/read の答えから text を除いたもの（uri, mimeType, _meta）
}

const (
	downloadLimit = 10 * time.Minute
	lockStale     = 15 * time.Second
	partStale     = 30 * time.Second
	pressGap      = 3 * time.Second // 失敗の直後のボタンの押し直し（二度押し）では取り直さない
	replayID      = "notedock-launcher-init"
	launcherAPI   = "/api/launcher/" // パネルからの依頼（note_api の url）。本体はこの url に 404 を返す
	markerName    = "last-failure.json"
)

func logf(f string, a ...any) {
	line := fmt.Sprintf("notedock-launcher: "+f+"\n", a...)
	os.Stderr.WriteString(line)
	// 試験用：NOTEDOCK_LAUNCHER_LOG にファイルの場所を渡すと、時刻と番号つきで書き足す（Codex の中での動きを見るため）。
	if p := os.Getenv("NOTEDOCK_LAUNCHER_LOG"); p != "" {
		if f, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
			fmt.Fprintf(f, "%s pid=%d %s", time.Now().Format("15:04:05.000"), os.Getpid(), line)
			f.Close()
		}
	}
}

func trace() bool {
	return os.Getenv("NOTEDOCK_LAUNCHER_TRACE") != "" || os.Getenv("NOTEDOCK_LAUNCHER_LOG") != ""
}

func tracef(f string, a ...any) {
	if trace() {
		logf(f, a...)
	}
}

func stateDir() (string, error) {
	if d := os.Getenv("NOTEDOCK_SERVER_DIR"); d != "" { // 試験用
		return d, nil
	}
	if runtime.GOOS == "windows" {
		la := os.Getenv("LOCALAPPDATA")
		if la == "" {
			h, err := os.UserHomeDir()
			if err != nil {
				return "", err
			}
			la = filepath.Join(h, "AppData", "Local")
		}
		return filepath.Join(la, "NoteDockCodexServer"), nil
	}
	h, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(h, "Library", "Caches", "NoteDockCodex", "server"), nil
}

func safeName(s string) bool {
	return s != "" && s != "." && s != ".." && !strings.ContainsAny(s, "/\\:") && filepath.Base(s) == s
}

func safeURL(s string) bool {
	u, err := url.Parse(s)
	if err != nil || u.User != nil || u.Host == "" {
		return false
	}
	h := u.Hostname()
	return u.Scheme == "https" || (u.Scheme == "http" && (h == "127.0.0.1" || h == "localhost"))
}

func hashFile(p string) (string, int64, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

func verified(p string, a Asset) bool {
	st, err := os.Stat(p)
	if err != nil || !st.Mode().IsRegular() || st.Size() != a.Size {
		return false
	}
	sum, _, err := hashFile(p)
	return err == nil && sum == a.Sha256
}

func token() string {
	b := make([]byte, 12)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// ---- 保存先の状態（プロセスのあいだで共有するので、すべてファイルから読む） ----

type place struct {
	dir, bin, lock, marker string
	asset                  Asset
	version, url           string
}

var (
	readyMu   sync.Mutex
	readyOnce bool
)

// 本体があって指紋が合うか。合ったら覚えておく（同じプロセスでは2回目から確かめない）。
// 大きさが合わないうちは指紋を計算しない（88MB を毎回読まないため）。
func (p *place) ready() bool {
	readyMu.Lock()
	defer readyMu.Unlock()
	if readyOnce {
		return true
	}
	st, err := os.Stat(p.bin)
	if err != nil || st.Size() != p.asset.Size {
		return false
	}
	if verified(p.bin, p.asset) {
		readyOnce = true
	}
	return readyOnce
}

// 失敗の印。版と指紋が今の release.json と同じものだけ使う。
type marker struct {
	Version string `json:"version"`
	Sha256  string `json:"sha256"`
	At      string `json:"at"`
	Kind    string `json:"kind"` // failed（取ってこられなかった）／interrupted（取ってくる途中で止められた）
	Reason  string `json:"reason"`
}

func (p *place) readMarker() *marker {
	b, err := os.ReadFile(p.marker)
	if err != nil {
		return nil
	}
	var m marker
	if json.Unmarshal(b, &m) != nil || m.Version != p.version || m.Sha256 != p.asset.Sha256 {
		return nil
	}
	return &m
}

func (p *place) writeMarker(kind, reason string) {
	b, _ := json.Marshal(marker{Version: p.version, Sha256: p.asset.Sha256, At: time.Now().Format(time.RFC3339), Kind: kind, Reason: reason})
	if os.MkdirAll(p.dir, 0o700) != nil {
		return
	}
	tmp := p.marker + ".tmp-" + token()
	if os.WriteFile(tmp, b, 0o600) == nil {
		os.Rename(tmp, p.marker)
	}
}

// 取ってくる係が生きているか（印のフォルダーの時刻が新しいか）。
func (p *place) lockAlive() bool {
	for _, q := range []string{filepath.Join(p.lock, "owner"), p.lock} {
		if st, err := os.Stat(q); err == nil {
			return time.Since(st.ModTime()) <= lockStale
		}
	}
	return false
}

// 進み具合は、いちばん新しく書かれた途中のファイルの大きさ（止まった係の残りを数えないため）。
func (p *place) partBytes() int64 {
	var n int64
	var newest time.Time
	ents, _ := os.ReadDir(p.dir)
	for _, e := range ents {
		if strings.Contains(e.Name(), ".part-") {
			if info, err := e.Info(); err == nil && info.ModTime().After(newest) {
				newest, n = info.ModTime(), info.Size()
			}
		}
	}
	return n
}

type status struct {
	State   string `json:"state"` // idle／downloading／ready／failed／unsupported
	Bytes   int64  `json:"bytes"`
	Total   int64  `json:"total"`
	Kind    string `json:"kind,omitempty"`
	Reason  string `json:"reason,omitempty"`
	At      string `json:"at,omitempty"`
	Version string `json:"version"`
	Mine    bool   `json:"mine"` // このプロセスが取ってきている
}

// ---- 取ってくる ----

// 取ってくるのは、同時に起動した中の1つだけ。ほかは待つ（状態はファイルで分かる）。
// 印のフォルダーの中の owner に自分の合言葉を書き、2秒ごとに時刻を更新する。
// 15秒更新が止まっていたら、止まったものとみなす。引き継ぐときは、印のフォルダーの名前を変えてから消す
// （名前の変更は1つしか成功しないので、2つが同時に引き継ぐことはない）。消すのは自分の合言葉の印だけ。
func ensure(ctx context.Context, p *place) error {
	if err := os.MkdirAll(p.dir, 0o700); err != nil {
		return fmt.Errorf("保存先のフォルダーを作れません: %w", err)
	}
	os.Chmod(p.dir, 0o700)
	owner := filepath.Join(p.lock, "owner")
	deadline := time.Now().Add(downloadLimit)
	for time.Now().Before(deadline) {
		if p.ready() {
			return nil
		}
		if err := os.Mkdir(p.lock, 0o700); err == nil {
			me := token()
			if err := os.WriteFile(owner, []byte(me), 0o600); err != nil {
				os.RemoveAll(p.lock)
				return fmt.Errorf("印を書けません: %w", err)
			}
			setHeld(&p.lock, &me, nil)
			cleanStaleParts(p.dir)
			stop := make(chan struct{})
			go func() {
				t := time.NewTicker(2 * time.Second)
				defer t.Stop()
				for {
					select {
					case <-stop:
						return
					case <-t.C:
						now := time.Now()
						os.Chtimes(owner, now, now)
					}
				}
			}()
			err := download(ctx, p)
			close(stop)
			releaseLock(p.lock, me)
			empty := ""
			setHeld(&empty, &empty, nil)
			return err
		}
		if !p.lockAlive() {
			grave := p.lock + ".stale-" + token()
			if os.Rename(p.lock, grave) == nil {
				logf("取ってくる途中で止まった印を片付けます")
				os.RemoveAll(grave)
			}
			continue
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(300 * time.Millisecond):
		}
	}
	return errors.New("ほかの起動が取ってくるのを待ちましたが、終わりませんでした")
}

func releaseLock(lock, me string) {
	if b, err := os.ReadFile(filepath.Join(lock, "owner")); err == nil && string(b) == me {
		os.RemoveAll(lock)
	}
}

func download(ctx context.Context, p *place) error {
	t0 := time.Now()
	ctx, cancel := context.WithTimeout(ctx, downloadLimit)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", p.url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("サーバーを取ってこられません（ネットにつながっていないかもしれません）: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("サーバーを取ってこられません: HTTP %d", resp.StatusCode)
	}
	a := p.asset
	if resp.ContentLength >= 0 && resp.ContentLength != a.Size {
		return fmt.Errorf("取ってくるファイルの大きさが違います: %d（%d のはず）", resp.ContentLength, a.Size)
	}
	f, err := os.CreateTemp(p.dir, a.File+".part-*")
	if err != nil {
		return fmt.Errorf("一時ファイルを作れません: %w", err)
	}
	part := f.Name()
	setHeld(nil, nil, &part)
	defer func() { e := ""; setHeld(nil, nil, &e) }()
	ok := false
	defer func() {
		if !ok {
			f.Close()
			os.Remove(part)
		}
	}()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, a.Size+1))
	if err != nil {
		return fmt.Errorf("取ってくる途中で切れました: %w", err)
	}
	if n != a.Size {
		return fmt.Errorf("取ってきたファイルの大きさが違います: %d（%d のはず）", n, a.Size)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != a.Sha256 {
		return fmt.Errorf("取ってきたファイルの指紋（SHA-256）が合いません。使わずに消しました: %s", got)
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Chmod(part, 0o755); err != nil {
		return err
	}
	if err := os.Rename(part, p.bin); err != nil {
		return err
	}
	ok = true
	logf("サーバーを取ってきました（%d バイト、%.1f 秒）", n, time.Since(t0).Seconds())
	return nil
}

// 前の起動が途中で止まって残した一時ファイルを消す。印を持っているときだけ呼ぶ。
// 書いている途中のファイルは時刻が新しいので、30秒以上動いていないものだけ消す。
func cleanStaleParts(dir string) {
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if !strings.Contains(e.Name(), ".part-") {
			continue
		}
		if info, err := e.Info(); err == nil && time.Since(info.ModTime()) > partStale {
			os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

// ---- 終わるときの片付け ----

var (
	cleanMu  sync.Mutex
	heldLock string
	heldTok  string
	heldPart string
	where    *place
	stopping bool // 止めるように言われた、または Codex がつなぎを閉じた
	stubSig  = make(chan os.Signal, 1)
)

func setHeld(lock, tok, part *string) {
	cleanMu.Lock()
	defer cleanMu.Unlock()
	if lock != nil {
		heldLock = *lock
	}
	if tok != nil {
		heldTok = *tok
	}
	if part != nil {
		heldPart = *part
	}
}

func isStopping() bool {
	cleanMu.Lock()
	defer cleanMu.Unlock()
	return stopping
}

// 取ってくる途中なら、途中のファイルと自分の印を消し、「途中で止められた」印を残して終わる。
// Codex はつなぎを閉じてから3秒で強制終了する（rmcp-client の close）。最後まで取り続けることはしない。
func finish(code int, why string) {
	cleanMu.Lock()
	stopping = true
	if heldPart != "" {
		os.Remove(heldPart)
		if where != nil {
			where.writeMarker("interrupted", "取ってくる途中で止められました（"+why+"）")
		}
		logf("取ってくる途中で止められたので、途中のファイルを消して終わります（%s）", why)
	} else {
		tracef("終わります（%s）", why)
	}
	if heldLock != "" {
		releaseLock(heldLock, heldTok)
	}
	os.Exit(code)
}

// ---- JSON-RPC ----

type msg struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
}

var (
	outMu sync.Mutex
	out   = bufio.NewWriter(os.Stdout)
)

func send(v any) {
	b, _ := json.Marshal(v)
	outMu.Lock()
	defer outMu.Unlock()
	out.Write(b)
	out.WriteByte('\n')
	out.Flush()
}

func reply(id json.RawMessage, result any) {
	send(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func replyRPCErr(id json.RawMessage, code int, text string) {
	send(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": text}})
}

func toolResult(structured any) map[string]any {
	return map[string]any{"content": []any{}, "structuredContent": structured}
}

func toolError(text string) map[string]any {
	return map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}, "isError": true}
}

func hasUI(params json.RawMessage) bool {
	var p struct {
		Capabilities struct {
			Extensions map[string]json.RawMessage `json:"extensions"`
		} `json:"capabilities"`
	}
	json.Unmarshal(params, &p)
	_, ok := p.Capabilities.Extensions["io.modelcontextprotocol/ui"]
	return ok
}

// 本体の panelHost（app/server/mcp.mjs）と同じ基準：extensions["io.modelcontextprotocol/ui"].mimeTypes が配列で、
// "text/html;profile=mcp-app"（ext-apps の RESOURCE_MIME_TYPE）を含むこと。start の門だけがこれを使う。
// tools/list の選び分けは、印のキーの有無（hasUI）のまま。本体は tools/list を印で分けないため（stub_test.go で、印のありなしの一覧を本体と比べている）。
func panelHost(params json.RawMessage) bool {
	var p struct {
		Capabilities struct {
			Extensions map[string]json.RawMessage `json:"extensions"`
		} `json:"capabilities"`
	}
	if json.Unmarshal(params, &p) != nil {
		return false
	}
	raw, ok := p.Capabilities.Extensions["io.modelcontextprotocol/ui"]
	if !ok {
		return false
	}
	var ext struct {
		MimeTypes []any `json:"mimeTypes"`
	}
	if json.Unmarshal(raw, &ext) != nil {
		return false
	}
	for _, m := range ext.MimeTypes {
		if s, ok := m.(string); ok && s == "text/html;profile=mcp-app" {
			return true
		}
	}
	return false
}

func initResult(stub Stub, params json.RawMessage) json.RawMessage {
	var p struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	json.Unmarshal(params, &p)
	var r map[string]any
	json.Unmarshal(stub.Initialize, &r)
	v := stub.Supported[0]
	for _, s := range stub.Supported {
		if s == p.ProtocolVersion {
			v = s
		}
	}
	r["protocolVersion"] = v
	b, _ := json.Marshal(r)
	return b
}

// 仮のパネル。本物のパネルと同じ uri・mimeType・_meta（CSP と権限）で返す。
func setupPanel(stub Stub, a Asset) any {
	var c map[string]any
	json.Unmarshal(stub.Panel, &c)
	mb := strconv.FormatInt((a.Size+500_000)/1_000_000, 10)
	c["text"] = strings.ReplaceAll(setupHTML, "{{SIZE_MB}}", mb)
	return map[string]any{"contents": []any{c}}
}

func panelURI(stub Stub) string {
	var c struct {
		URI string `json:"uri"`
	}
	json.Unmarshal(stub.Panel, &c)
	return c.URI
}

func main() {
	exe, err := os.Executable()
	if err != nil {
		logf("自分の場所が分かりません: %v", err)
		os.Exit(1)
	}
	here := filepath.Dir(exe)
	var rel Release
	var stub Stub
	if b, err := os.ReadFile(filepath.Join(here, "release.json")); err != nil || json.Unmarshal(b, &rel) != nil {
		logf("release.json が読めません: %v", err)
		os.Exit(1)
	}
	if b, err := os.ReadFile(filepath.Join(here, "stub.json")); err != nil || json.Unmarshal(b, &stub) != nil || len(stub.Supported) == 0 || len(stub.Panel) == 0 {
		logf("stub.json が読めません: %v", err)
		os.Exit(1)
	}
	key := runtime.GOOS + "-" + runtime.GOARCH
	tracef("start exe=%s PLUGIN_ROOT=%q PLUGIN_DATA=%q HOME=%q HTTPS_PROXY set=%v", exe, os.Getenv("PLUGIN_ROOT"), os.Getenv("PLUGIN_DATA"), os.Getenv("HOME"), os.Getenv("HTTPS_PROXY") != "" || os.Getenv("https_proxy") != "")
	asset, haveAsset := rel.Assets[key]
	var setupErr error
	switch {
	case !haveAsset:
		setupErr = fmt.Errorf("このパソコンの種類（%s）用のサーバーはまだありません", key)
	case !safeName(asset.File) || !safeName(rel.Version):
		setupErr = errors.New("release.json のファイル名か版の書き方が正しくありません")
	case !safeURL(rel.BaseURL):
		setupErr = errors.New("release.json の取ってくる場所が https ではありません")
	}
	sd, sdErr := stateDir()
	if setupErr == nil && sdErr != nil {
		setupErr = fmt.Errorf("保存先が決められません: %v", sdErr)
	}
	dir := filepath.Join(sd, rel.Version)
	p := &place{dir: dir, bin: filepath.Join(dir, asset.File), lock: filepath.Join(dir, ".download-lock"), marker: filepath.Join(dir, markerName), asset: asset, version: rel.Version, url: rel.BaseURL + asset.File}
	where = p

	if setupErr == nil && p.ready() {
		tracef("fast path")
		runServer(p.bin, os.Args[1:]) // Mac では exec で入れ替わる。戻ってこない
		return
	}

	// 試験用：わざと遅く答える（Codex が待ち時間の設定を読むかを確かめるため）。
	if ms, _ := strconv.Atoi(os.Getenv("NOTEDOCK_LAUNCHER_TEST_DELAY_MS")); ms > 0 {
		time.Sleep(time.Duration(ms) * time.Millisecond)
	}

	// Codex が出力のつなぎも閉じたとき、書き込みで落ちないようにする。
	signal.Ignore(syscall.SIGPIPE)
	signal.Notify(stubSig, os.Interrupt, syscall.SIGTERM)
	go func() {
		s := <-stubSig
		finish(143, s.String())
	}()

	lines := make(chan []byte, 64)
	go func() {
		r := bufio.NewReaderSize(os.Stdin, 1<<20)
		for {
			b, err := r.ReadBytes('\n')
			if len(bytes.TrimSpace(b)) > 0 {
				lines <- b
			}
			if err != nil {
				close(lines)
				return
			}
		}
	}()

	var initLine, initParams []byte
	initialized := false
	var dlMu sync.Mutex
	mine := false // このプロセスで取ってきている
	uri := panelURI(stub)

	current := func() status {
		s := status{Total: asset.Size, Version: rel.Version}
		dlMu.Lock()
		s.Mine = mine
		dlMu.Unlock()
		switch {
		case setupErr != nil:
			s.State, s.Reason = "unsupported", setupErr.Error()
		case p.ready():
			s.State, s.Bytes = "ready", asset.Size
		case s.Mine || p.lockAlive():
			s.State, s.Bytes = "downloading", p.partBytes()
		default:
			s.State = "idle"
			if m := p.readMarker(); m != nil {
				s.State, s.Kind, s.Reason, s.At = "failed", m.Kind, m.Reason, m.At
			}
		}
		return s
	}

	start := func() status {
		s := current()
		if s.State != "idle" && s.State != "failed" {
			return s
		}
		if s.State == "failed" && s.Kind == "failed" {
			if t, err := time.Parse(time.RFC3339, s.At); err == nil && time.Since(t) < pressGap {
				return s // 二度押し
			}
		}
		dlMu.Lock()
		mine = true
		dlMu.Unlock()
		ctx, cancel := context.WithCancel(context.Background())
		go func() {
			defer cancel()
			logf("パネルのボタンが押されたので、サーバーを取ってきます（%s）", p.url)
			err := ensure(ctx, p)
			if err != nil && !isStopping() {
				logf("%v", err)
				p.writeMarker("failed", err.Error())
			} else if err == nil {
				os.Remove(p.marker)
			}
			dlMu.Lock()
			mine = false
			dlMu.Unlock()
		}()
		time.Sleep(50 * time.Millisecond) // 印のフォルダーができてから答える（すぐの問い合わせでも downloading になるように）
		return current()
	}

	for b := range lines {
		var m msg
		if json.Unmarshal(b, &m) != nil {
			continue
		}
		isReq := len(m.ID) > 0 && m.Method != ""
		tracef("stub got %s id=%s", m.Method, string(m.ID))
		if !isReq {
			if m.Method == "notifications/initialized" {
				initialized = true
			}
			continue // そのほかの知らせは読み捨てる
		}
		switch m.Method {
		case "initialize":
			initLine, initParams = b, m.Params
			{
				var ip struct {
					Capabilities json.RawMessage `json:"capabilities"`
				}
				json.Unmarshal(m.Params, &ip)
				capsLine := "(none)"
				if len(ip.Capabilities) > 0 {
					var cb bytes.Buffer
					if json.Compact(&cb, ip.Capabilities) == nil {
						capsLine = cb.String()
					}
				}
				tracef("initialize capabilities=%s panelHost=%v hasUI=%v", capsLine, panelHost(m.Params), hasUI(m.Params))
			}
			reply(m.ID, initResult(stub, m.Params))
			continue
		case "ping":
			reply(m.ID, map[string]any{})
			continue
		}
		// 本体がもうある（このプロセスか、ほかのプロセスが取ってきた）なら、本体に入れ替えて、この依頼から渡す。
		if initLine != nil && setupErr == nil && p.ready() {
			tracef("server is ready: handing %s id=%s to the server", m.Method, string(m.ID))
			handoff(p.bin, initLine, initialized, b, lines)
			return
		}
		switch m.Method {
		case "tools/list":
			if hasUI(initParams) {
				reply(m.ID, stub.ToolsUI)
			} else {
				reply(m.ID, stub.ToolsNoUI)
			}
		case "resources/list":
			reply(m.ID, stub.Resources)
		case "resources/templates/list":
			reply(m.ID, stub.Templates)
		case "resources/read":
			var rp struct {
				URI string `json:"uri"`
			}
			json.Unmarshal(m.Params, &rp)
			if rp.URI == uri {
				tracef("resources/read uri=%s answered setup", rp.URI)
				reply(m.ID, setupPanel(stub, asset))
			} else {
				tracef("resources/read uri=%s answered not-found", rp.URI)
				replyRPCErr(m.ID, -32602, "MCP error -32602: Resource "+rp.URI+" not found")
			}
		case "tools/call":
			var cp struct {
				Name      string `json:"name"`
				Arguments struct {
					Method string `json:"method"`
					URL    string `json:"url"`
				} `json:"arguments"`
			}
			json.Unmarshal(m.Params, &cp)
			// 試験用の記録：道具の名前、note_api の method と url、返した status（note_api 以外は返した種類）。
			api := func(status int, data any) {
				tracef("tools/call name=%s method=%s url=%s status=%d", cp.Name, cp.Arguments.Method, cp.Arguments.URL, status)
				reply(m.ID, toolResult(map[string]any{"status": status, "data": data}))
			}
			switch {
			case cp.Name == "note_api" && cp.Arguments.URL == launcherAPI+"start" && cp.Arguments.Method == "POST" && !panelHost(initParams):
				// パネルを出せる印（mimeTypes に text/html;profile=mcp-app）のないつなぎからは、取ってこない。本体（server/mcp.mjs の note_api）も同じつなぎを 403 'panel only' で断る。
				tracef("note_api start answered 403 (panel only)")
				api(403, map[string]any{"error": "panel only"})
			case cp.Name == "note_api" && cp.Arguments.URL == launcherAPI+"start" && cp.Arguments.Method == "POST":
				startData := start()
				tracef("note_api start answered 202")
				api(202, startData)
			case cp.Name == "note_api" && cp.Arguments.URL == launcherAPI+"status":
				api(200, current())
			case cp.Name == "note_api":
				api(503, map[string]any{"error": "NoteDock のサーバーをまだ取ってきていません"})
			case cp.Name == "open_note":
				tracef("tools/call name=open_note answered opened")
				reply(m.ID, toolResult(map[string]any{"opened": true})) // パネルを開かせる（仮のパネルにボタンがある）
			case cp.Name == "note_locate":
				tracef("tools/call name=note_locate answered outside")
				reply(m.ID, toolResult(map[string]any{"scope": "outside"})) // 編集できる扱いにしない
			default:
				tracef("tools/call name=%s answered error", cp.Name)
				reply(m.ID, toolError("NoteDock のサーバーをまだ取ってきていません"))
			}
		default:
			// server/discover を含む、知らない依頼。本体（Node の MCP SDK）と同じ答えを返す。
			replyRPCErr(m.ID, -32601, "Method not found")
		}
	}
	// Codex がつなぎを閉じた。
	finish(0, "つなぎが閉じました")
}

// 本体を起こし、Codex から受け取った initialize をそのまま渡し直してから、つなぎっぱなしにする。
// first は、入れ替えのきっかけになった依頼（本体に最初に渡す）。
func handoff(bin string, initLine []byte, initialized bool, first []byte, lines chan []byte) {
	cmd := exec.Command(bin, os.Args[1:]...)
	cmd.Stderr = os.Stderr
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		logf("サーバーを起動できません: %v", err)
		os.Exit(1)
	}
	tracef("本体に入れ替えます（pid=%d）", cmd.Process.Pid)
	// これからは、止めるように言われたら本体にも伝えて、本体が終わるのを待つ（準備中の片付けの係は外す）。
	signal.Stop(stubSig)
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		s := <-sig
		cleanMu.Lock()
		stopping = true
		cleanMu.Unlock()
		cmd.Process.Signal(s)
	}()
	br := bufio.NewReaderSize(stdout, 1<<20)
	var m map[string]json.RawMessage
	json.Unmarshal(initLine, &m)
	m["id"] = json.RawMessage(strconv.Quote(replayID))
	ib, _ := json.Marshal(m)
	stdin.Write(append(ib, '\n'))
	replayTimer := time.AfterFunc(30*time.Second, func() {
		logf("サーバーが30秒以内に initialize に答えません")
		cmd.Process.Kill()
	})
	for {
		l, err := br.ReadBytes('\n')
		if err != nil {
			if isStopping() {
				tracef("本体に入れ替える途中で止められたので終わります")
				os.Exit(143)
			}
			logf("サーバーが initialize に答えません: %v", err)
			os.Exit(1)
		}
		var r msg
		json.Unmarshal(l, &r)
		if string(r.ID) == strconv.Quote(replayID) {
			break
		}
	}
	replayTimer.Stop()
	// 本体の答えを Codex へ流す係を先に動かしてから、依頼を渡す。
	copied := make(chan struct{})
	go func() {
		io.Copy(os.Stdout, br)
		close(copied)
	}()
	// 本体が先に終わったら、こちらもすぐ終わる。
	go func() {
		<-copied
		cmd.Wait()
		code := 1
		if cmd.ProcessState != nil {
			code = cmd.ProcessState.ExitCode()
		}
		os.Exit(code)
	}()
	if initialized {
		stdin.Write([]byte("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n"))
	}
	stdin.Write(first)
	for b := range lines {
		if _, err := stdin.Write(b); err != nil {
			break
		}
	}
	stdin.Close()
	select {} // 本体が終わるのを待つ（上の係が終わらせる）
}
