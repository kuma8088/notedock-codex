#!/usr/bin/env python3
"""ノートの情報の欄でEnterを押したときの動きを、Chromiumで確かめる。

使い方: python3 -I test/browser/props-enter-check.py
必要なもの: Python版のPlaywrightとChromium、app の node_modules。
日本語入力そのものは、ここでは確かめない（実際のアプリで確かめる）。
"""
import json, os, pathlib, subprocess, sys, tempfile
from playwright.sync_api import sync_playwright

# このファイルは <パッケージ>/test/browser/ にある。
pkg = pathlib.Path(__file__).resolve().parents[2]
# Windows では npx は npx.cmd という名前。
NPX = 'npx.cmd' if os.name == 'nt' else 'npx'
work = pathlib.Path(tempfile.mkdtemp(prefix='props-enter-'))
subprocess.run([NPX, 'esbuild', 'test/browser/props-harness.mjs', '--bundle', '--format=esm',
                f'--outfile={work / "h.js"}', '--log-level=warning'], cwd=pkg, check=True)
script = (work / 'h.js').read_text(encoding='utf-8').replace('</script', '<\\/script')
(work / 'index.html').write_text(f'<!doctype html><meta charset=utf-8><div id=ed></div><button id=away>away</button><script type=module>{script}</script>', encoding='utf-8', newline='\n')

failures = []
def check(name, ok, detail):
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else '  ' + json.dumps(detail, ensure_ascii=False)))
    if not ok: failures.append(name)

with sync_playwright() as p:
    browser = p.chromium.launch()
    # 日本語の設定で動かす（日付の欄は年・月・日の順になる）。
    page = browser.new_page(locale='ja-JP')
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    # 一瞬出てすぐ閉じたエラーの画面も数えられるよう、ページを開く前から dialog の追加を見張る。
    page.add_init_script("""window.__dialogs = [];
      new MutationObserver((list) => { for (const m of list) for (const n of m.addedNodes)
        if (n.tagName === 'DIALOG') window.__dialogs.push(n.textContent) })
        .observe(document, { childList: true, subtree: true })""")
    page.goto((work / 'index.html').as_uri())
    page.wait_for_selector('.cm-props-value')
    def now():
        return page.evaluate("""() => { const a = document.activeElement; return {
          cls: a.className || a.tagName, label: a.getAttribute && a.getAttribute('aria-label'), value: a.value ?? null,
          caret: a.selectionStart ?? null, doc: view.state.doc.toString() } }""")
    title = 'input.cm-props-value[aria-label="title"]'

    # 1. 値を変えてEnter: ノートに入り、カーソルは同じ欄の最後に残る
    page.click(title); page.keyboard.press('End'); page.keyboard.type('X'); page.keyboard.press('Enter')
    s = now()
    check('値を変えてEnterすると反映される', 'title: はじめX\n' in s['doc'], s)
    check('値を変えてEnterしても同じ欄にカーソルが残る', s['label'] == 'title' and s['caret'] == len('はじめX'), s)

    # 2. そのまま続けて打てる
    page.keyboard.type('Y'); page.keyboard.press('Enter')
    s = now()
    check('続けて打ってEnterしても反映され、欄に残る', 'title: はじめXY\n' in s['doc'] and s['label'] == 'title', s)

    # 3. 変えずにEnter: ノートは変わらず、欄に残る
    before = s['doc']; page.keyboard.press('Enter'); s = now()
    check('変えずにEnterしてもノートは変わらず欄に残る', s['doc'] == before and s['label'] == 'title', s)

    # 4. 項目の名前を変えてEnter: 新しい名前の欄に残る
    page.click('input.cm-props-key >> nth=0'); page.keyboard.press('End'); page.keyboard.type('2'); page.keyboard.press('Enter')
    s = now()
    check('項目の名前を変えてEnterすると反映され、名前の欄に残る',
          'title2: はじめXY\n' in s['doc'] and 'cm-props-key' in s['cls'] and s['value'] == 'title2', s)

    # 5. ほかを押して欄から出たときも反映され、カーソルは押した先へ行く
    page.click('input.cm-props-value[aria-label="title2"]'); page.keyboard.press('End'); page.keyboard.type('Z')
    page.click('#away'); s = now()
    line = next((l for l in s['doc'].split('\n') if l.startswith('title2:')), '')
    check('欄の外を押すと反映され、カーソルを欄へ戻さない', line.endswith('Z') and s['cls'] == 'BUTTON', s)

    # 6. タグ（カンマ区切り）でも同じ
    page.click('input.cm-props-value[aria-label="tags"]'); page.keyboard.press('End'); page.keyboard.type(', c'); page.keyboard.press('Enter')
    s = now()
    check('タグの欄でもEnterで反映され、欄に残る', 'tags: a, b, c' in s['doc'].replace('[', '').replace(']', '') or '- c' in s['doc'], s)
    check('タグの欄でEnterしても欄に残る', s['label'] == 'tags', s)

    # 7. 日本語を入力して確定したあとのEnter: 1回だけ反映し、欄に残る（変換の確定そのものは実際のアプリで確かめる）
    page.evaluate("""() => { const orig = view.dispatch.bind(view); window.__changes = 0;
      view.dispatch = (...a) => { const before = view.state.doc; orig(...a); if (view.state.doc !== before) window.__changes++ } }""")
    page.click('input.cm-props-value[aria-label="title2"]'); page.keyboard.press('End')
    cdp = page.context.new_cdp_session(page)
    cdp.send('Input.imeSetComposition', {'text': 'にほん', 'selectionStart': 3, 'selectionEnd': 3})
    cdp.send('Input.insertText', {'text': 'にほん'})
    page.keyboard.press('Enter'); page.wait_for_timeout(300)
    s = now(); count = page.evaluate('window.__changes')
    line = next((l for l in s['doc'].split('\n') if l.startswith('title2:')), '')
    check('日本語の確定のあとのEnterで反映される', line.endswith('にほん'), s)
    check('日本語の確定のあとのEnterでも欄に残る', s['label'] == 'title2', s)
    check('日本語の確定のあとのEnterで書き換えは1回だけ', count == 1, {'changes': count})

    # 8. 日付の欄: 打っている途中では書き込まず、カーソルも残る。Enterで書き込んで欄に残る
    def prop(key):
        return next((l for l in now()['doc'].split('\n') if l.startswith(key + ':')), '')
    page.focus('input.cm-props-value[aria-label="date"]')
    page.keyboard.type('2')
    s = now()
    check('日付の欄: 年の1文字目では書き込まない', prop('date') == 'date: 2026-01-02', s)
    check('日付の欄: 打っている途中もカーソルが残る', s['label'] == 'date', s)
    page.keyboard.type('028'); page.keyboard.press('ArrowRight'); page.keyboard.type('03'); page.keyboard.type('04'); page.keyboard.press('Enter'); s = now()
    check('日付の欄: Enterで書き込む', prop('date') == 'date: 2028-03-04', s)
    check('日付の欄: Enterのあとも欄に残る', s['label'] == 'date', s)

    # 9. 日付の欄: 欄の外を押すと書き込む
    page.keyboard.press('ArrowUp')
    page.click('#away'); s = now()
    check('日付の欄: 欄の外を押すと書き込む', prop('date') == 'date: 2029-03-04', s)

    # 10. 日付の欄: 途中まで消した（不完全な）まま出ても、元の日付を消さない
    page.focus('input.cm-props-value[aria-label="date"]')
    page.keyboard.press('Backspace')
    page.click('#away'); s = now()
    check('日付の欄: 不完全なまま出ても日付を消さない', prop('date') == 'date: 2029-03-04', s)

    # 11. 日時の欄: 何も変えずに出入りしても書き方（空白区切り）を変えない
    page.focus('input.cm-props-value[aria-label="when"]'); page.click('#away')
    page.focus('input.cm-props-value[aria-label="when"]'); page.keyboard.press('Enter'); s = now()
    check('日時の欄: 変えなければ書き換えない', prop('when') == 'when: 2026-01-02 10:00', s)
    check('日時の欄: Enterのあとも欄に残る', s['label'] == 'when', s)

    # 12. 日時の欄: 変えたら、元と同じ空白区切りで書く
    page.keyboard.press('ArrowUp'); page.keyboard.press('Enter'); s = now()
    check('日時の欄: 変えたら空白区切りで書く', prop('when').startswith('when: ') and ' ' in prop('when')[6:] and 'T' not in prop('when') and prop('when') != 'when: 2026-01-02 10:00', s)

    # 13. 数の欄: 上下の矢印では書き込まず、Enterで書き込む
    page.focus('input.cm-props-value[aria-label="count"]')
    page.keyboard.press('ArrowUp'); page.keyboard.press('ArrowUp'); s = now()
    check('数の欄: 矢印では書き込まない', prop('count') == 'count: 3', s)
    check('数の欄: 矢印のあともカーソルが残る', s['label'] == 'count', s)
    page.keyboard.press('Enter'); s = now()
    check('数の欄: Enterで書き込み欄に残る', prop('count') == 'count: 5' and s['label'] == 'count', s)

    # 14. 日付の欄: カーソルが欄にないまま値が変わったとき（カレンダーで選んだときなど）はすぐ書き込む
    page.click('#away')
    page.evaluate("""() => { const i = document.querySelector('input.cm-props-value[aria-label="date"]');
      i.value = '2030-05-06'; i.dispatchEvent(new Event('change', { bubbles: true })) }""")
    s = now()
    check('日付の欄: カーソルがないまま変わったらすぐ書き込む', prop('date') == 'date: 2030-05-06', s)

    # 15. 日付の欄: カーソルを欄に置いたまま、キーを押さずに値が変わったとき（カレンダーで選んだとき）
    #     1回だけ書き込み、ページのエラーを出さない
    page.focus('input.cm-props-value[aria-label="date"]')
    before_errors = len(errors)
    page.evaluate("""() => { window.__changes = 0
      const i = document.querySelector('input.cm-props-value[aria-label="date"]');
      i.value = '2031-07-08'; i.dispatchEvent(new Event('change', { bubbles: true })) }""")
    s = now(); count = page.evaluate('window.__changes')
    check('日付の欄: 欄にいたままカレンダーで選ぶと書き込む', prop('date') == 'date: 2031-07-08', s)
    check('日付の欄: 欄にいたままカレンダーで選んでも書き込みは1回', count == 1, {'changes': count})
    check('日付の欄: 欄にいたままカレンダーで選んでもエラーを出さない', len(errors) == before_errors, errors[before_errors:])

    # どの操作でも「内容が変わったので…」の画面が出ていない
    dialogs = page.evaluate('window.__dialogs')
    check('エラーの画面が出ていない', not dialogs, dialogs)
    check('ページのエラーが出ていない', not errors, errors)
    browser.close()

print('合格' if not failures else f'不合格 {len(failures)}件')
sys.exit(1 if failures else 0)
