#!/usr/bin/env python3
"""開けない画像があるノートを開いても、ノートの中身が変わらないことを、Chromiumで確かめる。

使い方: python3 -I test/browser/image-error-check.py
必要なもの: Python版のPlaywrightとChromium、app の node_modules。
開けない画像の知らせが本文に書き込まれた問題の再発を防ぐ。
"""
import json, os, pathlib, subprocess, sys, tempfile
from playwright.sync_api import sync_playwright

# このファイルは <パッケージ>/test/browser/ にある。
pkg = pathlib.Path(__file__).resolve().parents[2]
# Windows では npx は npx.cmd という名前。
NPX = 'npx.cmd' if os.name == 'nt' else 'npx'
work = pathlib.Path(tempfile.mkdtemp(prefix='image-error-'))
subprocess.run([NPX, 'esbuild', 'test/browser/image-harness.mjs', '--bundle', '--format=esm',
                f'--outfile={work / "h.js"}', '--log-level=warning'], cwd=pkg, check=True)
script = (work / 'h.js').read_text(encoding='utf-8').replace('</script', '<\\/script')
(work / 'index.html').write_text(f'<!doctype html><meta charset=utf-8><div id=ed></div><div id=read></div><script type=module>{script}</script>', encoding='utf-8', newline='\n')

# どの版で走らせたかを残す。
try:
    head = subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], cwd=pkg, capture_output=True, text=True).stdout.strip()
except OSError:
    head = ''  # git がなくても試験は続ける。どの版で走らせたかの記録が残らないだけ。
import hashlib
print('git', head, 'widgets.mjs', hashlib.sha256((pkg / 'src/widgets.mjs').read_bytes()).hexdigest()[:16])

failures = []
def check(name, ok, detail=None):
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else '  ' + json.dumps(detail, ensure_ascii=False)))
    if not ok: failures.append(name)

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(locale='ja-JP')
    page.goto((work / 'index.html').as_uri())
    page.wait_for_function('window.view')
    page.wait_for_timeout(1500)
    doc = page.evaluate('view.state.doc.toString()')
    check('開けない画像があっても、ノートの中身は変わらない', doc == page.evaluate('window.original'), {'doc': doc})
    shown = page.evaluate("[...document.querySelectorAll('.cm-image-missing')].map((n) => n.textContent)")
    check('本文の画像に「画像を開けません」と出る', any(t.startswith('画像を開けません') for t in shown), shown)
    # 画面をスクロールさせたり描き直したりしても変わらない
    page.evaluate("view.dispatch({ selection: { anchor: view.state.doc.length } })")
    page.wait_for_timeout(800)
    check('カーソルを動かしたあとも、ノートの中身は変わらない', page.evaluate('view.state.doc.toString() === window.original'))
    check('閲覧表示でも、開けない画像でノートの中身は変わらない', page.evaluate('reading.state.doc.toString() === window.original'),
          page.evaluate('reading.state.doc.toString()'))
    browser.close()
sys.exit(1 if failures else 0)
