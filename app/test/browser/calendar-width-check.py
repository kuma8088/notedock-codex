#!/usr/bin/env python3
"""右の列のカレンダーが、狭い幅でもはみ出さないかをChromiumで確かめる。

使い方: python3 -I test/browser/calendar-width-check.py [画像を置くフォルダー]
右の列の幅は、ふだん260px、狭い画面では clamp(150px, 36vw, 220px)（src/style.css）。
"""
import json, os, pathlib, subprocess, sys, tempfile
from playwright.sync_api import sync_playwright

# このファイルは <パッケージ>/test/browser/ にある。
pkg = pathlib.Path(__file__).resolve().parents[2]
# Windows では npx は npx.cmd という名前。
NPX = 'npx.cmd' if os.name == 'nt' else 'npx'
out = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else None
work = pathlib.Path(tempfile.mkdtemp(prefix='calendar-width-'))
subprocess.run([NPX, 'esbuild', 'test/browser/calendar-harness.mjs', '--bundle', '--format=esm',
                f'--outfile={work / "h.js"}', '--log-level=warning'], cwd=pkg, check=True)
css = (pkg / 'src' / 'style.css').read_text(encoding='utf-8')
script = (work / 'h.js').read_text(encoding='utf-8').replace('</script', '<\\/script')
(work / 'index.html').write_text(f'<!doctype html><meta charset=utf-8><style>{css}\nbody{{margin:0}} #side{{height:400px}}</style>'
                                 f'<div id=side><section id=calendar aria-label=カレンダー></section><nav id=files></nav></div>'
                                 f'<script type=module>{script}</script>', encoding='utf-8', newline='\n')
failures = 0
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={'width': 400, 'height': 420})
    page.goto((work / 'index.html').as_uri())
    page.wait_for_selector('.cal-grid')
    for width in [150, 180, 220, 260]:
        page.evaluate(f"document.getElementById('side').style.width = '{width}px'")
        r = page.evaluate("""() => { const c = document.getElementById('calendar'); const g = c.querySelector('.cal-grid');
          const side = document.getElementById('side').getBoundingClientRect();
          const over = [...c.querySelectorAll('button, span')].filter(e => e.getBoundingClientRect().right > side.right + 0.5).length;
          return { calendar: [c.scrollWidth, c.clientWidth], grid: [g.scrollWidth, g.clientWidth], outside: over } }""")
        ok = r['calendar'][0] <= r['calendar'][1] and r['outside'] == 0
        failures += not ok
        print(('ok   ' if ok else 'FAIL ') + f'{width}px ' + json.dumps(r))
        if out:
            out.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(out / f'calendar-{width}.png'), clip={'x': 0, 'y': 0, 'width': width + 20, 'height': 260})
    browser.close()
print('合格' if not failures else f'不合格 {failures}件')
sys.exit(1 if failures else 0)
