#!/usr/bin/env python3
"""長い項目が折り返したとき、2行目以降が記号のあとの本文にそろうかを、Chromiumで確かめる。

使い方: python3 -I test/browser/wrap-indent-check.py [画像を置くフォルダー]
確かめる項目は、ふつうの箇条書き、タブとスペースでの字下げ（入れ子）、チェック項目、番号付き。
引用の中の項目もそろうこと、カーソルが項目の行に入って記号が「-」のまま見えるときもそろうこと、ふつうの段落と引用の段落はそのままであること、
測り直しが止まること（時間をおいて2回測って同じ値、書き換えが続かない）、1行目の本文の位置が直す前と変わらないこと、
Ctrl+Space をエディターが使わないこと（Mac の入力ソースの切り替えの初期設定のため）も確かめる。
入れ子の縦の線がタブの区切りと一致すること、見出し・行間1.5と1.7・閲覧・ソース・広い幅でも2行目がそろうことも確かめる。
画像のフォルダーを渡すと、直す前（?off）と直したあとの画面、狭い幅、速いスクロールのあと、行間1.5と1.7、閲覧、ソース、広い幅の画面を残す。
"""
import json, os, pathlib, subprocess, sys, tempfile
from playwright.sync_api import sync_playwright

# このファイルは <パッケージ>/test/browser/ にある。
pkg = pathlib.Path(__file__).resolve().parents[2]
# Windows では npx は npx.cmd という名前。
NPX = 'npx.cmd' if os.name == 'nt' else 'npx'
out = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else None
work = pathlib.Path(tempfile.mkdtemp(prefix='wrap-indent-'))
subprocess.run([NPX, 'esbuild', 'test/browser/wrap-harness.mjs', '--bundle', '--format=esm',
                f'--outfile={work / "h.js"}', '--log-level=warning'], cwd=pkg, check=True)
css = (pkg / 'src' / 'style.css').read_text(encoding='utf-8')
script = (work / 'h.js').read_text(encoding='utf-8').replace('</script', '<\\/script')
(work / 'index.html').write_text(f'<!doctype html><meta charset=utf-8><style>{css}\nbody{{margin:0}} #ed{{width:520px;height:900px;display:flex}}</style>'
                                 f'<div id=ed></div><script type=module>{script}</script>', encoding='utf-8', newline='\n')

# 行ごとに、本文の始まりの左端と、折り返した2行目の最初の文字の左端を返す。
# mode が 'all' のときは、全部の行を1行ずつ画面の真ん中へスクロールしてから測る（画面の外の行は描かれていないため）。
# 'visible' のときはスクロールせず、画面に全部見えている行だけを測る。測れなかった行は missing に入れる。
MEASURE = r"""async (mode) => {
  const doc = view.state.doc, rows = [], missing = []
  const box = view.scrollDOM.getBoundingClientRect()
  const wait = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 120))))
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n)
    if (!line.text) continue
    const m = line.text.match(/^(?:[\t ]*>[\t ]?)*[\t ]*([-*+]|\d+[.)])[\t ]+(\[[ xX]\][\t ]+)?/)
    const quoted = line.text.startsWith('>')
    const q = !m && quoted ? line.text.match(/^(?:>[\t ]?)+/) : null
    const text = line.from + (m ? m[0].length : q ? q[0].length : 0)
    if (text >= line.to) continue
    if (mode === 'all') {
      view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'center' }) })
      await wait()
    } else {
      const s = view.coordsAtPos(line.from, 1), e = view.coordsAtPos(line.to, -1)
      if (!s || !e || s.top < box.top || e.bottom > box.bottom) continue
    }
    const first = view.coordsAtPos(text, 1)
    if (!first) { missing.push(n); continue }
    let second = null
    for (let pos = text + 1; pos < line.to; pos++) {
      const c = view.coordsAtPos(pos, 1)
      if (c && c.top > first.top + 5) { second = c; break }
    }
    const el = view.domAtPos(line.from).node
    const lineEl = (el.nodeType === 1 ? el : el.parentNode).closest('.cm-line')
    rows.push({ n, kind: m ? (quoted ? 'quote-list' : 'list') : quoted ? 'quote' : /^#{1,6} /.test(line.text) ? 'heading' : 'para', textLeft: first.left, lineLeft: lineEl.getBoundingClientRect().left,
                // 行の頭（引用の記号「>」が文字として見えているときの、2行目のそろう先）と、「>」が見えているか。
                startLeft: view.coordsAtPos(line.from, 1)?.left ?? null, raw: lineEl.textContent.startsWith('>'),
                wrapLeft: second ? second.left : null, hang: lineEl.classList.contains('cm-hang'), style: lineEl.getAttribute('style'), head: line.text.slice(0, 12) })
  }
  return { rows, missing }
}"""

failures = []
def measure_all():
    r = page.evaluate(MEASURE, 'all')
    check('全部の行を測れた（画面の外の行もスクロールして測る）', not r['missing'], r['missing'])
    return r['rows']
def check(name, ok, detail=None):
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else '  ' + json.dumps(detail, ensure_ascii=False)))
    if not ok: failures.append(name)

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={'width': 560, 'height': 900}, locale='ja-JP')
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))

    def shot(name, width=560):
        # 画面の上の端へ戻してから撮る。
        page.evaluate("() => { view.scrollDOM.scrollTop = 0 }")
        page.wait_for_timeout(300)
        out.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(out / name), clip={'x': 0, 'y': 0, 'width': width, 'height': 900})

    QUOTE_TAB = "() => { const d = view.state.doc; for (let n = 1; n <= d.lines; n++) if (d.line(n).text.startsWith('> \\t- ')) return n }"
    def cursor_on(n):
        page.evaluate("(n) => { const l = view.state.doc.line(n); view.focus(); view.dispatch({ selection: { anchor: l.to } }) }", n)
        page.wait_for_timeout(200)

    # 直す前の見た目（比べるため。合否には使わない）
    page.goto((work / 'index.html').as_uri() + '?off')
    page.wait_for_selector('.cm-line')
    page.wait_for_timeout(200)
    before = measure_all()
    off_lists = [r for r in before if r['kind'] == 'list' and r['wrapLeft'] is not None]
    check('（比較）仕組みを外すと、2行目が本文の始まりからずれる', any(abs(r['wrapLeft'] - r['textLeft']) > 4 for r in off_lists), off_lists)
    if out:
        shot('wrap-before.png')
    # 引用の中でタブで字下げした項目にカーソルを置いたとき（> が見える）の、直す前の1行目の位置。
    quote_tab = page.evaluate(QUOTE_TAB)
    cursor_on(quote_tab)
    before_quote = next(r for r in measure_all() if r['n'] == quote_tab)

    page.goto((work / 'index.html').as_uri())
    page.wait_for_selector('.cm-line.cm-hang')
    page.wait_for_timeout(200)

    def verify(label):
        rows = measure_all()
        lists = [r for r in rows if r['kind'] == 'list']
        wrapped = [r for r in lists if r['wrapLeft'] is not None]
        check(f'{label}: 折り返す項目が8つ以上ある', len(wrapped) >= 8, lists)
        bad = [r for r in wrapped if abs(r['wrapLeft'] - r['textLeft']) > 1]
        check(f'{label}: 項目の2行目以降が本文の始まりにそろう', not bad, bad)
        quoted = [r for r in rows if r['kind'] == 'quote-list' and r['wrapLeft'] is not None]
        check(f'{label}: 引用の中の項目が2つとも折り返す', len(quoted) == 2, quoted)
        bad = [r for r in quoted if abs(r['wrapLeft'] - r['textLeft']) > 1]
        check(f'{label}: 引用の中の項目も、2行目以降が本文の始まりにそろう', not bad, bad)
        # 段落と引用の段落は字下げを付けない。2行目のそろう先は、ふつうは本文の始まり。
        # 引用の記号「>」が文字として見えているとき（ソースの表示、カーソルがその行にあるとき）は、行の頭（「>」の位置）。
        para = [r for r in rows if r['kind'] in ('para', 'quote') and r['wrapLeft'] is not None]
        target = lambda r: r['startLeft'] if r['kind'] == 'quote' and r['raw'] else r['textLeft']
        bad = [r for r in para if r['hang'] or target(r) is None or abs(r['wrapLeft'] - target(r)) > 1]
        check(f'{label}: 段落と引用の段落は、字下げを付けない', len(para) == 2 and not bad, bad or para)
        # 測り直しが止まっている：時間をおいて測っても同じで、行の書き換えが続かない。
        changes = page.evaluate("""() => new Promise((done) => { let n = 0
          const watch = new MutationObserver((list) => { n += list.length })
          watch.observe(view.contentDOM, { attributes: true, subtree: true, attributeFilter: ['style', 'class'] })
          setTimeout(() => { watch.disconnect(); done(n) }, 600) })""")
        check(f'{label}: 0.6秒のあいだ、行の書き換えが起きない', changes == 0, changes)
        again = measure_all()
        diff = [(a['n'], a['textLeft'], b['textLeft'], a['wrapLeft'], b['wrapLeft'], a['style'], b['style'])
                for a, b in zip(rows, again) if a['textLeft'] != b['textLeft'] or a['wrapLeft'] != b['wrapLeft'] or a['style'] != b['style']]
        check(f'{label}: 時間をおいて2回測っても同じ位置と幅', not diff and len(rows) == len(again), diff)
        return rows

    rows = verify('はじめ')
    if out:
        shot('wrap-after.png')

    # 引用の中のタブの項目にカーソルを置いても、1行目の位置は直す前と同じ。
    cursor_on(quote_tab)
    after_quote = next(r for r in verify('カーソルが引用の中のタブの項目にあるとき') if r['n'] == quote_tab)
    check('カーソルが引用の中のタブの項目にあっても、1行目の本文の位置は直す前と変わらない',
          abs(before_quote['textLeft'] - after_quote['textLeft']) <= 1, [before_quote, after_quote])

    # 引用の段落にカーソルを置くと「>」が見える。そのときも字下げを付けず、2行目は行の頭にそろう。
    quote_para = page.evaluate("() => { const d = view.state.doc; for (let n = 1; n <= d.lines; n++) { const t = d.line(n).text; if (t.startsWith('> ') && !/^>[\\t ]*[-*+\\d]/.test(t)) return n } }")
    cursor_on(quote_para)
    seen = next(r for r in verify('カーソルが引用の段落にあるとき') if r['n'] == quote_para)
    check('カーソルが引用の段落にあるとき、「>」が見えている', seen['raw'], seen)

    # カーソルを入れ子の項目に入れると、記号が「-」のまま見える。そのときもそろう。
    page.evaluate("() => { const l = view.state.doc.line(5); view.focus(); view.dispatch({ selection: { anchor: l.to } }) }")
    page.wait_for_timeout(200)
    verify('カーソルが項目の行にあるとき')
    if out:
        shot('wrap-after-cursor.png')

    # 幅を変えても測り直す。
    page.evaluate("() => { document.getElementById('ed').style.width = '380px' }")
    page.wait_for_timeout(300)
    verify('幅を狭くしたあと')
    if out:
        shot('wrap-after-narrow.png', 420)

    # 1行目の本文の始まりは、仕組みがあってもなくても同じ位置（1行目は動かさない）。カーソルを入れる前の画面で比べる。
    moved = [(a['n'], a['textLeft'], b['textLeft']) for a, b in zip(before, rows) if abs(a['textLeft'] - b['textLeft']) > 1]
    check('1行目の本文の位置は、直す前と変わらない', not moved and len(before) == len(rows), moved)

    # 入れ子の縦の線が、タブの区切りと一致する。
    #  - タブ1つ分の幅（--tab-width）が、空白で字下げした項目の記号の位置の区切りと合う（記号は区切りの上にある）
    #  - 1行目の線（.cm-indent-guide）と、折り返した行の線（::before）の間隔が --tab-width で、線の始まりが本文の書き始め
    page.goto((work / 'index.html').as_uri())
    page.wait_for_selector('.cm-line.cm-hang-guide')
    page.wait_for_timeout(300)
    guides = page.evaluate(r"""() => {
      const tab = parseFloat(getComputedStyle(view.dom).getPropertyValue('--tab-width'))
      const doc = view.state.doc, rows = []
      for (let n = 1; n <= doc.lines; n++) {
        const line = doc.line(n)
        const m = line.text.match(/^([\t ]+)([-*+]|\d+[.)])[\t ]/)
        if (!m) continue
        const el = view.domAtPos(line.from).node
        const lineEl = (el.nodeType === 1 ? el : el.parentNode).closest('.cm-line')
        const cs = getComputedStyle(lineEl)
        const start = lineEl.getBoundingClientRect().left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) + parseFloat(cs.textIndent)
        const mark = view.coordsAtPos(line.from + m[1].length, 1).left - start
        const span = lineEl.querySelector('.cm-indent-guide')
        const before = getComputedStyle(lineEl, '::before')
        rows.push({ n, tab, mark, steps: mark / tab,
                    span: span ? [getComputedStyle(span).backgroundSize, span.getBoundingClientRect().left - start] : null,
                    after: lineEl.classList.contains('cm-hang-guide') ? [before.backgroundSize, parseFloat(before.left), parseFloat(cs.paddingLeft) + parseFloat(cs.textIndent)] : null })
      }
      return rows
    }""")
    check('縦の線を確かめる項目が5つ以上ある', len(guides) >= 5, guides)
    check('タブ1つ分の幅を測れている', all(g['tab'] > 0 for g in guides), guides)
    bad = [g for g in guides if abs(g['steps'] - round(g['steps'])) * g['tab'] > 1 or round(g['steps']) < 1]
    check('字下げした項目の記号が、タブの区切りの上にある', not bad, bad)
    bad = [g for g in guides if not g['span'] or not g['span'][0].startswith(f"{g['tab']}px") or abs(g['span'][1]) > 1]
    check('1行目の縦の線の間隔がタブ1つ分で、本文の書き始めから引かれる', not bad, bad)
    wrapped = [g for g in guides if g['after']]
    bad = [g for g in wrapped if not g['after'][0].startswith(f"{g['tab']}px") or abs(g['after'][1] - g['after'][2]) > 1]
    check('折り返した行の縦の線も、間隔がタブ1つ分で、本文の書き始めから引かれる', wrapped and not bad, wrapped)

    # 本文の行間（1.5 と 1.7 を本人が画像で選ぶ）、見出し、閲覧・ソースの表示、広い幅。どれでも2行目がそろうこと。
    for label, query, name, width in [
        ('見出しと行間1.5', '?headings', 'look-leading-1.5.png', 560),
        ('見出しと行間1.7', '?headings&leading=1.7', 'look-leading-1.7.png', 560),
        ('閲覧の表示', '?headings&mode=reading', 'look-reading.png', 560),
        ('ソースの表示', '?headings&mode=source', 'look-source.png', 560),
    ]:
        page.goto((work / 'index.html').as_uri() + query)
        page.wait_for_selector('.cm-line.cm-hang')
        page.wait_for_timeout(300)
        verify(label)
        if out:
            shot(name, width)
    # コードのかたまりとコールアウトの枠の左端が、本文の左端（段落の書き始め）とそろう。中の文字は枠の内側の決まった位置。
    page.goto((work / 'index.html').as_uri() + '?headings')
    page.wait_for_selector('.cm-line.cm-codeblock')
    page.wait_for_timeout(300)
    boxes = page.evaluate("""() => {
      const para = [...view.contentDOM.querySelectorAll('.cm-line')].find((el) => el.textContent === '本文の段落。')
      const text = view.coordsAtPos(view.posAtDOM(para, 0), 1).left
      const box = (sel) => [...view.contentDOM.querySelectorAll(sel)].map((el) => {
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el)
        return { left: r.left, inner: r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft), text: el.textContent.slice(0, 10) } })
      return { text, code: box('.cm-codeblock'), callout: box('.cm-callout') }
    }""")
    bad = [b for b in boxes['code'] + boxes['callout'] if abs(b['left'] - boxes['text']) > 1]
    check('コードのかたまりとコールアウトの枠の左端が、本文の左端とそろう', boxes['code'] and boxes['callout'] and not bad, boxes)
    bad = [b for b in boxes['code'] if abs(b['inner'] - boxes['text'] - 16) > 1] + [b for b in boxes['callout'] if abs(b['inner'] - boxes['text'] - 24) > 1]
    check('枠の中の文字は、コードが枠から16px、コールアウトが24px', not bad, boxes)
    # 閲覧の表示では、段落のすぐあとの見出しの上が 40px、編集の表示では 16px。先頭の見出しは 0。
    def heading_tops(query):
        page.goto((work / 'index.html').as_uri() + query)
        page.wait_for_selector('.cm-line.cm-heading')
        page.wait_for_timeout(200)
        return page.evaluate("""() => [...view.contentDOM.querySelectorAll('.cm-line.cm-heading')].map((el) => [el.textContent.slice(0, 12), parseFloat(getComputedStyle(el).paddingTop)])""")
    live, reading = heading_tops('?headings'), heading_tops('?headings&mode=reading')
    after = lambda tops: [t for name, t in tops if name.startswith('段落のあとの見出し')]
    check('先頭の見出しの上は 0（編集・閲覧とも）', live[0][1] == 0 and reading[0][1] == 0, [live, reading])
    check('段落のあとの見出しの上は、編集で 16px、閲覧で 40px', after(live) == [16] and after(reading) == [40], [live, reading])
    check('見出しのあとの見出しの上は、閲覧でも 16px', all(t == 16 for name, t in reading[1:] if not name.startswith('段落のあと')), reading)

    page.set_viewport_size({'width': 1300, 'height': 900})
    page.goto((work / 'index.html').as_uri() + '?headings')
    page.evaluate("() => { document.getElementById('ed').style.width = '1280px' }")
    page.wait_for_selector('.cm-line.cm-hang')
    page.wait_for_timeout(300)
    verify('広い幅')
    if out:
        shot('look-wide.png', 1300)
    page.set_viewport_size({'width': 560, 'height': 900})

    # 長いノートで、速く下へスクロールして止めたとき、そのあと速く上へ戻したときも、見えている行がそろう。
    page.goto((work / 'index.html').as_uri() + '?long')
    page.wait_for_selector('.cm-line.cm-hang')
    page.wait_for_timeout(200)
    fling = """async (step) => { for (let i = 0; i < 40; i++) { view.scrollDOM.scrollTop += step; await new Promise((d) => setTimeout(d, 30)) } }"""
    for label, step in [('速く下へスクロールしたあと', 600), ('速く上へ戻したあと', -600)]:
        page.evaluate(fling, step)
        page.wait_for_timeout(2000)
        r = page.evaluate(MEASURE, 'visible')
        seen = [x for x in r['rows'] if x['kind'] in ('list', 'quote-list') and x['wrapLeft'] is not None]
        check(f'{label}: 見えている折り返す項目が5つ以上ある', len(seen) >= 5, r['rows'])
        bad = [x for x in seen if abs(x['wrapLeft'] - x['textLeft']) > 1]
        check(f'{label}: 見えている項目の2行目以降が本文の始まりにそろう', not bad, bad)
        if out:
            page.screenshot(path=str(out / ('wrap-after-fling-down.png' if step > 0 else 'wrap-after-fling-up.png')), clip={'x': 0, 'y': 0, 'width': 560, 'height': 900})

    # Ctrl+Space をエディターが使わない（使うと Mac の入力ソースの切り替えとぶつかる）。
    prevented = page.evaluate("""() => { const e = new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, ctrlKey: true, bubbles: true, cancelable: true });
      view.contentDOM.dispatchEvent(e); return e.defaultPrevented }""")
    check('Ctrl+Space をエディターが使わない', prevented is False, prevented)

    check('ページのエラーがない', not errors, errors)
    browser.close()

print('合格' if not failures else f'不合格 {len(failures)}件')
sys.exit(1 if failures else 0)
