#!/usr/bin/env python3
"""本体を取ってくる前に、前に読んだ本物のパネルが出た場面を、ビルドした本物のパネル（dist/panel.html）で確かめる。

Codexアプリの代わりのページ（test/browser/host-harness.mjs）が、起動用のプログラム（準備中の係）のまねをする（?launcher=）。
- stale：パネルは status を聞き、state が返ったので、パネルを読み直して仮のパネル（見本）と入れ替える。受け取っていた
  tool-input を渡し直す。判定の前に、ノートの場所・読み書き・下書きの依頼を出さない。
- hang：status に答えがない。5秒で打ち切り、今までどおりノートを開いて編集できる。

使い方: python3 -I test/browser/launcher-swap-check.py [画像を置くフォルダー]
先に npm run build を実行しておく（npm run test:browser は、この試験の前にビルドする）。
"""
import json, os, pathlib, shutil, subprocess, sys, tempfile, threading, time
from playwright.sync_api import sync_playwright

here = pathlib.Path(__file__).resolve().parent
pkg = here.parent.parent
shots = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else None
panel_file = pkg / 'dist' / 'panel.html'
fails = []
NOTE = '# 入れ替えの試験\n\nこのノートが開いていれば、今までどおり。\n'

def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:400]))
    if not ok: fails.append(name)

def shot(page, name):
    if shots:
        shots.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(shots / name))

def wait_ready(srv, seconds=90):
    result = []
    reader = threading.Thread(target=lambda: result.append(srv.stdout.readline()), daemon=True)
    reader.start(); reader.join(seconds)
    line = result[0].split() if result else []
    if len(line) != 2 or line[0] != 'ready':
        raise RuntimeError(f'テスト用のサーバーが立ち上がりませんでした: {result}')
    return line[1]

def panel_frame(page, seconds=30):
    end = time.time() + seconds
    while time.time() < end:
        for frame in page.frames:
            if frame.url.endswith('/panel.html'):
                return frame
        time.sleep(0.1)
    raise RuntimeError('パネルが開きませんでした')

def until(frame, js, seconds=15):
    end = time.time() + seconds
    while time.time() < end:
        try:
            value = frame.evaluate(js)
        except Exception:
            value = None
        if value:
            return value
        time.sleep(0.1)
    return None

IS_SETUP = "!!document.querySelector('meta[name=notedock-setup]')"
EDITABLE = "!!document.querySelector('.cm-content[contenteditable=true]')"

def run(mode, fn):
    work = pathlib.Path(tempfile.mkdtemp(prefix='launcher-swap-'))
    vault = work / 'vault'; vault.mkdir()
    (vault / 'a.md').write_text(NOTE, encoding='utf-8', newline='\n')
    bak = work / 'bak'; trash = work / 'trash'; trash.mkdir()
    env = {**os.environ, 'NOTEDOCK_TRASH_DIR': str(trash), 'HOST_NO_DEFAULT_TAB': '1'}
    srv = subprocess.Popen(['node', str(here / 'host-server.mjs'), str(vault), str(bak), str(panel_file)], stdout=subprocess.PIPE, text=True, env=env, cwd=str(pkg))
    try:
        port = wait_ready(srv)
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(viewport={'width': 900, 'height': 640})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{port}/?file=a.md&launcher={mode}')
            fn(page, panel_frame(page), {'vault': vault, 'bak': bak, 'errors': errors})
            browser.close()
    finally:
        srv.terminate(); srv.wait(10)
        shutil.rmtree(work, ignore_errors=True)

def stale(page, frame, ctx):
    t0 = time.time()
    check('stale：仮のパネルに替わる', until(frame, IS_SETUP, 15))
    check('stale：受け取っていた tool-input を渡し直す', until(frame, "document.getElementById('setup')?.dataset.file === 'a.md'", 10), frame.evaluate("document.body.outerHTML.slice(0, 300)"))
    check('stale：仮のパネルの ui/initialize が済む', frame.evaluate("document.getElementById('setup').dataset.init") == '1')
    time.sleep(2.5)  # 渡し直しの最後（2秒）と、残った処理がないかを見る
    calls = page.evaluate('window.__calls')
    api = [c for c in calls if c.get('name') == 'note_api']
    check('stale：status は1回だけ聞く', [c['url'] for c in api] == ['/api/launcher/status'], calls)
    check('stale：パネルを1回読み直す', [c for c in calls if 'read' in c] == [{'read': 'ui://notedock/panel.html'}], calls)
    check('stale：判定の前後で、ノートの場所・読み書き・下書きの依頼を出さない', not any(c.get('name') == 'note_locate' or (c.get('name') == 'note_api' and c['url'] != '/api/launcher/status') for c in calls), calls)
    check('stale：書き込みの依頼がない', not any(c.get('method') in ('PUT', 'POST') for c in calls), calls)
    check('stale：host は tool-input を1回だけ送った（仮のパネルが受けたのは、パネルが渡し直したもの）', page.evaluate('window.__toolInputs') == 1 and page.evaluate('window.__inits') >= 2, [page.evaluate('window.__toolInputs'), page.evaluate('window.__inits')])
    check('stale：編集できる画面にならない', not frame.evaluate(EDITABLE))
    check('stale：下書きを書いていない', not (ctx['bak'].exists() and any(p.is_file() for p in ctx['bak'].rglob('*'))), list(ctx['bak'].rglob('*')) if ctx['bak'].exists() else [])
    check('stale：ノートは変わらない', (ctx['vault'] / 'a.md').read_text(encoding='utf-8') == NOTE)
    check('stale：画面のエラーがない', not ctx['errors'], ctx['errors'])
    shot(page, 'launcher-stale-to-setup.png')

def hang(page, frame, ctx):
    t0 = time.time()
    shown = until(frame, "document.body && document.body.innerText.includes('このノートが開いていれば')", 20)
    took = time.time() - t0
    check('hang：status に答えがなくても、ノートが開く', shown)
    check('hang：時間切れまで待ってから開く（4秒より後）', took > 4, round(took, 1))
    check('hang：仮のパネルには替わらない', not frame.evaluate(IS_SETUP))
    calls = page.evaluate('window.__calls')
    check('hang：読み直さない', not any('read' in c and c['read'] == 'ui://notedock/panel.html' for c in calls), calls)
    first_other = next((i for i, c in enumerate(calls) if not (c.get('name') == 'note_api' and c.get('url') == '/api/launcher/status')), None)
    check('hang：最初の依頼は status', calls and calls[0].get('url') == '/api/launcher/status', calls[:3])
    frame.get_by_role('button', name='編集', exact=True).click(timeout=10000)
    check('hang：編集できる', until(frame, EDITABLE, 10))
    check('hang：読むだけの知らせが出ない', '読むだけ' not in frame.inner_text('body'))
    check('hang：画面のエラーがない', not ctx['errors'], ctx['errors'])
    shot(page, 'launcher-hang-real.png')

run('stale', stale)
run('hang', hang)
print('合格' if not fails else f'不合格: {len(fails)}')
sys.exit(1 if fails else 0)
