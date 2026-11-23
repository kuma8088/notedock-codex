package main

// ボタンからの取得（note_api の POST <launcherAPI>start）は、パネルを出せる印を送ったつなぎからだけ受け付ける。
// 印がなければ 403 で断り、取得（HTTP GET）も印のファイルも作らない。

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"
)

func startGate(t *testing.T, caps any) (status float64, gets int32, stateDir string) {
	var n int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&n, 1)
		http.Error(w, "no", http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)

	tmp := t.TempDir()
	plug := filepath.Join(tmp, "bin")
	os.MkdirAll(plug, 0o700)
	launcher := filepath.Join(plug, "notedock")
	if out, err := exec.Command("go", "build", "-o", launcher, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}
	os.WriteFile(filepath.Join(plug, "stub.json"), []byte(`{"supported_protocol_versions":["2025-06-18"],"initialize":{"capabilities":{},"serverInfo":{"name":"t","version":"0"}},"tools_list_ui":{"tools":[]},"tools_list_no_ui":{"tools":[]},"resources_list":{"resources":[]},"resource_templates_list":{"resourceTemplates":[]},"panel_resource":{"uri":"ui://notedock/panel.html","mimeType":"text/html;profile=mcp-app"}}`), 0o600)
	key := runtime.GOOS + "-" + runtime.GOARCH
	os.WriteFile(filepath.Join(plug, "release.json"), []byte(`{"version":"0.0.0-test","base_url":"`+srv.URL+`/","assets":{"`+key+`":{"file":"x","size":1,"sha256":"00"}}}`), 0o600)

	stateDir = filepath.Join(tmp, "sd")
	env := []string{"HOME=" + tmp, "PATH=/usr/bin:/bin", "NOTEDOCK_SERVER_DIR=" + stateDir}
	c := dial(t, launcher, env)
	c.call("initialize", map[string]any{"protocolVersion": "2025-06-18", "capabilities": caps, "clientInfo": map[string]any{"name": "t", "version": "0"}})
	c.notify("notifications/initialized")
	r := c.call("tools/call", map[string]any{"name": "note_api", "arguments": map[string]any{"method": "POST", "url": launcherAPI + "start"}})
	sc := r["result"].(map[string]any)["structuredContent"].(map[string]any)
	status = sc["status"].(float64)
	if status == 403 {
		if e := sc["data"].(map[string]any)["error"]; e != "panel only" {
			t.Errorf("403 の中身が本体と違う: %v", e)
		}
	}
	// 取得が始まるなら、少し待てば GET が来る。来ないことを確かめるので、短くても待つ。
	time.Sleep(1500 * time.Millisecond)
	return status, atomic.LoadInt32(&n), stateDir
}

func TestStartRefusedWithoutUI(t *testing.T) {
	status, gets, sd := startGate(t, map[string]any{})
	if status != 403 {
		t.Errorf("印なしの start は 403 のはず: %v", status)
	}
	if gets != 0 {
		t.Errorf("取得（GET）が %d 回あった", gets)
	}
	if _, err := os.Stat(sd); err == nil {
		t.Errorf("印のファイル・フォルダーが作られた: %s", sd)
	}
}

func TestStartRefusedWithWeakUI(t *testing.T) {
	for name, ui := range map[string]any{
		"empty":    map[string]any{},
		"null":     nil,
		"textonly": map[string]any{"mimeTypes": []string{"text/plain"}},
		"notarray": map[string]any{"mimeTypes": "text/html;profile=mcp-app"},
	} {
		t.Run(name, func(t *testing.T) {
			caps := map[string]any{"extensions": map[string]any{"io.modelcontextprotocol/ui": ui}}
			status, gets, sd := startGate(t, caps)
			if status != 403 {
				t.Errorf("start は 403 のはず: %v", status)
			}
			if gets != 0 {
				t.Errorf("取得（GET）が %d 回あった", gets)
			}
			if _, err := os.Stat(sd); err == nil {
				t.Errorf("印のファイル・フォルダーが作られた: %s", sd)
			}
		})
	}
}

func TestStartAcceptedWithOtherExtension(t *testing.T) {
	caps := map[string]any{"extensions": map[string]any{
		"io.modelcontextprotocol/ui": map[string]any{"mimeTypes": []string{"text/html;profile=mcp-app"}},
		"x/y":                        true,
		"x/z":                        map[string]any{"mimeTypes": "not-array"},
	}}
	status, gets, _ := startGate(t, caps)
	if status != 202 {
		t.Errorf("正しい印があれば、別の拡張がどんな値でも 202 のはず: %v", status)
	}
	if gets == 0 {
		t.Errorf("取得（GET）が始まっていない")
	}
}

func TestStartAcceptedWithUI(t *testing.T) {
	status, gets, _ := startGate(t, uiCaps)
	if status != 202 {
		t.Errorf("印ありの start は 202 のはず: %v", status)
	}
	if gets == 0 {
		t.Errorf("取得（GET）が始まっていない")
	}
}
