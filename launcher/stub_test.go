package main

// 道具の一覧などの写し（stub.json）が本体の答えと同じかを確かめる（AI に見せない印も含めて、準備中の答えが本体とずれていないことを確かめる）。
// AI に見せない印（_meta.ui.visibility）を含めて、JSON の中身で比べる。
// 本体と stub.json の場所を環境変数で渡したときだけ動く：
//   NOTEDOCK_REAL_SERVER=<本体> NOTEDOCK_STUB=<stub.json> go test -run Stub -v

import (
	"bufio"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

type rpcConn struct {
	t   *testing.T
	cmd *exec.Cmd
	in  *json.Encoder
	out *bufio.Reader
	n   int
}

func dial(t *testing.T, bin string, env []string) *rpcConn {
	cmd := exec.Command(bin)
	cmd.Env = env
	in, _ := cmd.StdinPipe()
	out, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { in.Close(); cmd.Process.Kill(); cmd.Wait() })
	return &rpcConn{t: t, cmd: cmd, in: json.NewEncoder(in), out: bufio.NewReaderSize(out, 1<<24)}
}

func (c *rpcConn) call(method string, params any) map[string]any {
	c.n++
	c.in.Encode(map[string]any{"jsonrpc": "2.0", "id": c.n, "method": method, "params": params})
	for {
		l, err := c.out.ReadBytes('\n')
		if err != nil {
			c.t.Fatalf("%s: %v", method, err)
		}
		var m map[string]any
		json.Unmarshal(l, &m)
		if id, ok := m["id"].(float64); ok && int(id) == c.n {
			return m
		}
	}
}

func (c *rpcConn) notify(method string) {
	c.in.Encode(map[string]any{"jsonrpc": "2.0", "method": method})
}

var uiCaps = map[string]any{"extensions": map[string]any{"io.modelcontextprotocol/ui": map[string]any{"mimeTypes": []string{"text/html;profile=mcp-app"}}}}

// どちらの相手にも同じ問い合わせをして、答えを集める。
func answers(t *testing.T, bin string, env []string) map[string]any {
	got := map[string]any{}
	for _, caps := range []struct {
		name string
		v    any
	}{{"ui", uiCaps}, {"noui", map[string]any{}}} {
		c := dial(t, bin, env)
		got["discover_"+caps.name] = c.call("server/discover", map[string]any{})["error"]
		init := c.call("initialize", map[string]any{"protocolVersion": "2025-06-18", "capabilities": caps.v, "clientInfo": map[string]any{"name": "t", "version": "0"}})
		got["initialize_"+caps.name] = init["result"]
		c.notify("notifications/initialized")
		got["tools_"+caps.name] = c.call("tools/list", map[string]any{})["result"]
		got["resources_"+caps.name] = c.call("resources/list", map[string]any{})["result"]
		got["templates_"+caps.name] = c.call("resources/templates/list", map[string]any{})["result"]
		got["unknown_"+caps.name] = c.call("no/such/method", map[string]any{})["error"]
		r := c.call("resources/read", map[string]any{"uri": "ui://notedock/panel.html"})
		item := r["result"].(map[string]any)["contents"].([]any)[0].(map[string]any)
		delete(item, "text")
		got["panel_meta_"+caps.name] = item
	}
	for _, v := range []string{"2025-11-25", "2025-03-26", "2024-11-05", "1999-01-01"} {
		c := dial(t, bin, env)
		got["initialize_"+v] = c.call("initialize", map[string]any{"protocolVersion": v, "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "t", "version": "0"}})["result"]
	}
	return got
}

func TestStubMatchesServer(t *testing.T) {
	real, stubPath := os.Getenv("NOTEDOCK_REAL_SERVER"), os.Getenv("NOTEDOCK_STUB")
	if real == "" || stubPath == "" {
		t.Skip("NOTEDOCK_REAL_SERVER と NOTEDOCK_STUB を渡したときだけ動く")
	}
	tmp := t.TempDir()
	os.MkdirAll(filepath.Join(tmp, "vault"), 0o700)
	env := []string{"HOME=" + tmp, "PATH=/usr/bin:/bin", "NOTE_ROOT=" + filepath.Join(tmp, "vault"), "NOTE_BACKUP_DIR=" + filepath.Join(tmp, "backup"), "NOTEDOCK_SERVER_DIR=" + filepath.Join(tmp, "sd")}

	// 起動用のプログラムを作り、stub.json と、取ってこられない release.json を並べる（ずっと準備中のまま）。
	plug := filepath.Join(tmp, "bin")
	os.MkdirAll(plug, 0o700)
	launcher := filepath.Join(plug, "notedock")
	if out, err := exec.Command("go", "build", "-o", launcher, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}
	b, err := os.ReadFile(stubPath)
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(plug, "stub.json"), b, 0o600)
	os.WriteFile(filepath.Join(plug, "release.json"), []byte(`{"version":"0.0.0-test","base_url":"http://127.0.0.1:1/","assets":{"darwin-arm64":{"file":"x","size":1,"sha256":"00"},"darwin-amd64":{"file":"x","size":1,"sha256":"00"},"windows-amd64":{"file":"x.exe","size":1,"sha256":"00"},"windows-arm64":{"file":"x.exe","size":1,"sha256":"00"}}}`), 0o600)

	want := answers(t, real, env)
	for k, w := range want {
		if w == nil && !(len(k) > 8 && (k[:8] == "discover" || k[:7] == "unknown")) {
			t.Fatalf("本体の答え %s が空（本体が動いていない）", k)
		}
	}
	got := answers(t, launcher, env)
	for k, w := range want {
		if !reflect.DeepEqual(w, got[k]) {
			wb, _ := json.Marshal(w)
			gb, _ := json.Marshal(got[k])
			t.Errorf("%s が違う\n本体:   %s\n写し:   %s", k, wb, gb)
		}
	}
	// AI に見せない印を、念のため名前で確かめる（本体の答えそのものが変わったときに気づくため）。
	vis := map[string]any{}
	for _, tool := range want["tools_ui"].(map[string]any)["tools"].([]any) {
		m := tool.(map[string]any)
		meta, _ := m["_meta"].(map[string]any)
		ui, _ := meta["ui"].(map[string]any)
		vis[m["name"].(string)] = ui["visibility"]
	}
	t.Logf("visibility: %v", vis)
	if vis["note_api"] == nil || vis["note_locate"] == nil || vis["open_note"] != nil {
		t.Errorf("AI に見せない印が想定と違う: %v", vis)
	}
}
