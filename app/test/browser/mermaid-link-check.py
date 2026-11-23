#!/usr/bin/env python3
"""Mermaid の図に書いたリンクが、描いた図に残らないことを、Chromiumで確かめる。

使い方: python3 -I test/browser/mermaid-link-check.py
必要なもの: Python版のPlaywrightとChromium、app の node_modules。
リンクを取り除く前は、Codexアプリで図の中のリンクを押すと、アプリの中のブラウザーで外のページが開いた。
"""
import json, os, pathlib, subprocess, sys, tempfile
from playwright.sync_api import sync_playwright

pkg = pathlib.Path(__file__).resolve().parents[2]
NPX = 'npx.cmd' if os.name == 'nt' else 'npx'
work = pathlib.Path(tempfile.mkdtemp(prefix='mermaid-link-'))
# 図の部品も含めて1つのファイルにまとめる（分けると、読み込みが途中で失敗することがあった）。
subprocess.run([NPX, 'esbuild', 'test/browser/mermaid-harness.mjs', '--bundle', '--format=esm',
                f'--outfile={work / "h.js"}', '--log-level=warning'], cwd=pkg, check=True)
script = (work / 'h.js').read_text(encoding='utf-8').replace('</script', '<\\/script')
# 本物のパネルと同じ通信の制限を入れる（src/panel-csp.json）。
policy = json.loads((pkg / 'src/panel-csp.json').read_text(encoding='utf-8'))['policy']
meta = f'<meta http-equiv="Content-Security-Policy" content="{policy}">' if policy else ''
(work / 'index.html').write_text(f'<!doctype html><meta charset=utf-8>{meta}<div id=out></div><script type=module>{script}</script>',
                                 encoding='utf-8', newline='\n')

failures = []
def check(name, ok, detail=None):
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else '  ' + json.dumps(detail, ensure_ascii=False)))
    if not ok: failures.append(name)

url = (work / 'index.html').as_uri()

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(locale='ja-JP')
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    # テスト用のアドレスへの読み込みのうち、通信の制限（CSP）で止められなかったものを数える。
    # 止められたものも request としては見えるので、失敗の理由で見分ける。
    probes = []
    blocked = []
    page.on('requestfailed', lambda r: blocked.append(r.url) if 'probe.example.com' in r.url and 'csp' in (r.failure or '').lower() else None)
    page.on('request', lambda r: probes.append(r.url) if 'probe.example.com' in r.url else None)
    def unblocked():
        rest = list(probes)
        for url in blocked:
            if url in rest:
                rest.remove(url)
        return rest
    page.on('popup', lambda p: probes.append('popup ' + p.url))
    violations = []
    page.on('console', lambda m: violations.append(m.text) if 'Content Security Policy' in m.text and 'probe.example.com' not in m.text else None)
    page.goto(url)
    # 通信の制限で eval が使えないので、wait_for_function ではなく、外から何度も確かめて待つ。
    import time
    deadline = time.time() + 30
    while page.evaluate("document.querySelectorAll('.cm-mermaid svg, .cm-mermaid-error').length") < 11:
        if time.time() > deadline:
            raise SystemExit('図が描き終わりませんでした')
        page.wait_for_timeout(200)
    page.wait_for_timeout(1500)
    check('開いただけでは、テスト用のアドレスへの通信が出ない（図の画像、図の色や形の設定）', unblocked() == [], {'requests': probes, 'blocked': blocked})
    # 要求がそもそも出なかったのではなく、制限で止められたことを、それぞれ確かめる。
    for url in ['https://probe.example.com/img.png', 'https://probe.example.com/theme.png']:
        check(f'{url} は、通信の制限で止められた', url in blocked, {'requests': probes, 'blocked': blocked})
    check('elk: ELK の配置の図が、通信の制限の下でも描けている', page.evaluate("!!document.querySelector('.cm-mermaid[data-name=elk] svg') && document.querySelector('.cm-mermaid[data-name=elk] svg').textContent.includes('ELKの箱')"),
          page.evaluate("document.querySelector('.cm-mermaid[data-name=elk]').textContent.slice(0, 200)"))
    for name in ['imgNode', 'themeCss']:
        # 外の画像を読み込めないので、画像つきの箱は「図を描けません」になってもよい。何かが表示されていればよい。
        drawn = page.evaluate(f"!!document.querySelector('.cm-mermaid[data-name={name}] svg, .cm-mermaid[data-name={name}] .cm-mermaid-error')")
        check(f'{name}: 図か、描けない理由が表示される', drawn, page.evaluate(f"document.querySelector('.cm-mermaid[data-name={name}]').textContent.slice(0, 200)"))
    for name in ['flowHref', 'flowShort', 'classLink', 'jsUrl', 'seqLink', 'stateClick', 'kanban']:
        info = page.evaluate("""(name) => {
          const box = document.querySelector(`.cm-mermaid[data-name="${name}"]`)
          const svg = box.querySelector('svg')
          if (!svg) return { error: box.textContent }
          const hrefs = []
          for (const el of svg.querySelectorAll('*')) {
            for (const attr of el.attributes) {
              if (attr.localName === 'href' && !attr.value.startsWith('#')) hrefs.push(el.localName + ' ' + attr.value)
            }
          }
          return { anchors: svg.querySelectorAll('a').length, hrefs }
        }""", name)
        check(f'{name}: 図が描けている', 'error' not in info, info)
        if 'error' in info: continue
        check(f'{name}: 図の中にリンク（a）がない', info['anchors'] == 0, info)
        check(f'{name}: 図の中に外を指す href がない', info['hrefs'] == [], info)
    # 箱の位置と大きさ（図の左上からの位置）が、リンクなしの同じ図と同じか。
    boxes = page.evaluate("""() => ['flowHref', 'flowPlain'].map((name) => {
      const svg = document.querySelector(`.cm-mermaid[data-name="${name}"] svg`)
      const base = svg.getBoundingClientRect()
      return [...svg.querySelectorAll('g.node')].map((g) => {
        const r = g.getBoundingClientRect()
        return [g.textContent.trim(), Math.round(r.left - base.left), Math.round(r.top - base.top), Math.round(r.width), Math.round(r.height)]
      }).sort()
    })""")
    check('flowHref: リンクを取り除いても、箱の位置と大きさはリンクなしの図と同じ', boxes[0] == boxes[1] and len(boxes[0]) == 2, boxes)
    check('flowHref: 箱の文字は残っている', 'リンクつきの箱' in page.evaluate("document.querySelector('.cm-mermaid[data-name=flowHref] svg').textContent"))
    # 図の中の文字を、図ごとに画面に出してから実際に押してみる。どこへも移らず、テスト用のアドレスへの通信も出ない。
    start = page.url
    for name in ['flowHref', 'flowShort', 'classLink', 'jsUrl', 'seqLink', 'stateClick', 'kanban']:
        texts = page.locator(f'.cm-mermaid[data-name="{name}"] svg text')
        clicked = 0
        for i in range(min(texts.count(), 30)):
            try:
                texts.nth(i).click(force=True, timeout=2000)
                clicked += 1
            except Exception:
                pass
            if page.url != start:
                break
        check(f'{name}: 図の中の文字を1つ以上押せた', clicked >= 1, clicked)
        if page.url != start:
            break
    page.wait_for_timeout(500)
    check('図を押しても、ほかのページへ移らない', page.url == start, page.url)
    check('図を押しても、テスト用のアドレスへの通信も新しいタブも出ない', unblocked() == [], {'requests': probes, 'blocked': blocked})
    # 描けなかった図のエラーの絵（Syntax error in text）が、図の枠の外に残っていない。
    leftover = page.evaluate("""() => [...document.body.querySelectorAll('svg, div[id^=dnote], div[id^=d]')]
      .filter((n) => !n.closest('.cm-mermaid'))
      .map((n) => (n.id || n.localName) + ' ' + (n.getAttribute('aria-roledescription') || '') + ' ' + n.textContent.slice(0, 40))""")
    check('描けなかった図のエラーの絵が、図の枠の外に残っていない', leftover == [], leftover)
    check('画面のエラーがない', errors == [], errors)
    check('テスト用のアドレスのほかに、通信の制限で止められたものがない', violations == [], violations)
    browser.close()
import shutil
shutil.rmtree(work, ignore_errors=True)
sys.exit(1 if failures else 0)
