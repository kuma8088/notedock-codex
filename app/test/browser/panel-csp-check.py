#!/usr/bin/env python3
"""ビルドした本物のパネル（dist/panel.html。通信の制限が入っている）を、Codexアプリの代わりのページの中で動かし、
ふだん使う機能が、通信の制限に止められずに動くかを Chromium で確かめる。

使い方: python3 -I test/browser/panel-csp-check.py [画像を置くフォルダー]
先に npm run build を実行しておく（npm run test:browser は、このテストの前にビルドする）。
パネルとは postMessage だけでやりとりする（test/browser/host-harness.mjs）。道具の呼び出しは、本物のエディターの
サーバー（server/mcp.mjs）へ渡す（test/browser/host-server.mjs）。テスト用のノートは、一時的なフォルダーに作る。
ゴミ箱は、Mac のゴミ箱ではなく、一時的なフォルダーへ向ける（NOTEDOCK_TRASH_DIR）。
"""
import base64, datetime, json, os, pathlib, re, shutil, struct, subprocess, sys, tempfile, threading, time, zlib
from playwright.sync_api import sync_playwright

here = pathlib.Path(__file__).resolve().parent
pkg = here.parent.parent
shots = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else None
panel_file = pkg / 'dist' / 'panel.html'
policy = json.loads((pkg / 'src' / 'panel-csp.json').read_text(encoding='utf-8'))['policy']
fails = []
# ページを読み込み直すと、パネルの中の違反の記録が消えるので、その前に取り出しておく。
kept_violations = []

def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:400]))
    if not ok: fails.append(name)

def shot(page, name):
    if shots:
        shots.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(shots / name))

def png(width=4, height=3, rgb=(200, 40, 40)):
    # 小さな本物の PNG を作る（画像として読み込めることを確かめるため）。
    row = b'\x00' + bytes(rgb) * width
    chunk = lambda kind, data: struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(row * height)) + chunk(b'IEND', b'')

RICH = """# 色々

数式 $E=mc^2$ と、ブロックの数式。

$$
\\int_0^1 x\\,dx
$$

```mermaid
flowchart LR
  A[はじめ] --> B[おわり]
```

```js
const answer = 42
```

```pug
div.box
  p= message
```

> [!note]
> コールアウトの中身

==ハイライト== と #タグ

| 列1 | 列2 |
|---|---|
| a | b |

![絵](../attachments/pic.png)

![外の絵](https://csp-img-probe.example.com/a.png)

[外のリンク](https://csp-link-probe.example.com/x)

[[memo]]
"""

PROPS = '---\ntitle: はじめ\n---\n\n| 列1 | 列2 |\n|---|---|\n| a | b |\n\n本文\n'

def make_vault(work):
    vault = work / 'vault'
    for folder in ['notes', 'other', 'attachments']:
        (vault / folder).mkdir(parents=True)
    files = {
        'notes/memo.md': '# メモ\n\n本文\n',
        'notes/rich.md': RICH,
        'notes/drop.md': '# 動かして消す\n',
        'other/keep.md': '# 残す\n',
        'notes/props.md': PROPS,
    }
    for rel, text in files.items():
        (vault / rel).write_text(text, encoding='utf-8', newline='\n')
    (vault / 'attachments' / 'pic.png').write_bytes(png())
    return vault

def wait_ready(srv, seconds=90):
    result = []
    reader = threading.Thread(target=lambda: result.append(srv.stdout.readline()), daemon=True)
    reader.start()
    reader.join(seconds)
    line = result[0].split() if result else []
    if len(line) != 2 or line[0] != 'ready':
        raise RuntimeError(f'テスト用のサーバーが立ち上がりませんでした: {result}')
    return line[1]

# 通信の制限に止められたものを、パネルの中で記録する（Playwright が差し込むので、制限には止められない）。
WATCH = """(() => {
  if (!location.pathname.endsWith('/panel.html')) return
  window.__csp = []
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__csp.push({ directive: e.effectiveDirective, blocked: e.blockedURI, sample: e.sample, source: e.sourceFile, line: e.lineNumber })
  })
})()"""

def panel_frame(page, seconds=30):
    end = time.time() + seconds
    while time.time() < end:
        for frame in page.frames:
            if frame.url.endswith('/panel.html'):
                return frame
        time.sleep(0.1)
    raise RuntimeError('パネルが開きませんでした')

def until(frame, js, seconds=15, what=''):
    # ページの外から繰り返し確かめて待つ（wait_for_function は、ページの中で文字列を実行するので、制限に止められる）。
    end = time.time() + seconds
    value = None
    while time.time() < end:
        try:
            value = frame.evaluate(js)
        except Exception as error:
            value = None
        if value:
            return value
        time.sleep(0.1)
    raise TimeoutError(f'待ちきれませんでした: {what or js}')

def until_path(check_fn, seconds=15, what=''):
    end = time.time() + seconds
    while time.time() < end:
        if check_fn():
            return True
        time.sleep(0.1)
    raise TimeoutError(f'待ちきれませんでした: {what}')

def row(P, name):
    return P.locator('#files .files-row', has_text=name).first

def open_from_files(P, frame, name, path):
    row(P, name).click()
    until(frame, f"document.getElementById('note-path')?.textContent.includes({json.dumps(path.split('/')[-1].removesuffix('.md'))})", what=f'{path} を開く')
    until(frame, "document.querySelector('.cm-content')", what='本文')

def menu(P, name, label):
    row(P, name).click(button='right')
    P.get_by_text(label, exact=True).last.click()

def ask(P):
    return P.locator('dialog.note-ask[open]').last

def wait_saved(frame):
    return until(frame, "['saved', 'failed', 'offline', 'conflict', 'toolarge'].includes(document.getElementById('status').dataset.state) && document.getElementById('status').dataset.state", what='保存')

def run_left_rail(page, port, vault, trash):
    page.goto(f'http://127.0.0.1:{port}/')
    frame = panel_frame(page)
    P = page.frame_locator('#panel')
    until(frame, "document.querySelector('#files .files-row')", seconds=30, what='ファイルの一覧')
    check('パネルに、決めたとおりの通信の制限が入っている', frame.evaluate("document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]')?.content") == policy)

    for folder in ['notes', 'other', 'attachments']:
        row(P, folder).click()
    until(frame, "[...document.querySelectorAll('#files .files-row')].some((r) => r.textContent.includes('rich.md'))", what='フォルダーを開く')

    # いろいろな書き方のノートを、閲覧の画面で表示する。
    open_from_files(P, frame, 'rich.md', 'notes/rich.md')
    until(frame, "document.querySelector('.cm-content .katex')", what='数式')
    check('数式（KaTeX）が表示される', frame.evaluate("document.querySelectorAll('.cm-content .katex').length") >= 2)
    until(frame, "document.querySelector('.cm-content svg g.node')", seconds=20, what='Mermaid の図')
    check('Mermaid の図が描ける', frame.evaluate("document.querySelectorAll('.cm-content svg g.node').length") == 2)
    # 本文の下のほうは、画面に近づくまで描かれないので、いちばん下まで送る。
    frame.evaluate("document.querySelector('.cm-scroller').scrollTop = 1e6")
    image = until(frame, "(() => { const i = [...document.querySelectorAll('.cm-content img')].find((x) => x.complete && x.naturalWidth > 0); return i && { src: i.src.slice(0, 22), w: i.naturalWidth } })()", what='フォルダーの中の画像')
    check('フォルダーの中の画像が、data: の形で表示される', image['src'].startswith('data:image/png') and image['w'] == 4, image)
    outside = until(frame, "[...document.querySelectorAll('.cm-content .cm-image-missing')].map((e) => e.textContent).join('|')", what='外の画像')
    check('ネット上の画像は読み込まず、「画像を開けません」と出る', outside == '画像を開けません: 外の絵', outside)
    check('コールアウトが表示される', frame.evaluate("Boolean(document.querySelector('.cm-content .cm-callout-note'))"))
    colored = frame.evaluate("""(() => { const lines = [...document.querySelectorAll('.cm-content .cm-line')];
      const classes = (needle) => { const line = lines.find((l) => l.textContent.includes(needle)); return line ? [...line.querySelectorAll('span')].map((s) => s.className).filter(Boolean) : null };
      return { js: classes('const answer'), pug: classes('div.box') } })()""")
    check('コードの色づけ（JavaScript）が付く', bool(colored['js']), colored)
    print('     Pug の行の部品:', colored['pug'])
    shot(page, 'csp-1-rich.png')
    # 開けない画像の知らせが、本文に書き込まれないこと（前に起きた不具合）。編集の画面に切り替えて、少し待つ。
    P.locator('#modes').get_by_text('編集').click()
    until(frame, "document.querySelector('.cm-content .cm-image-missing')", what='編集の画面の外の画像')
    time.sleep(1.5)
    check('開けない画像があっても、編集の画面でノートが書き換わらない', (vault / 'notes' / 'rich.md').read_text(encoding='utf-8') == RICH)
    P.locator('#modes').get_by_text('閲覧').click()

    # 外へのリンクは、Codexアプリに開いてもらう（パネルの中では開かない）。
    P.locator('.cm-content').get_by_text('外のリンク').click()
    end = time.time() + 5
    while time.time() < end and not page.evaluate('window.__links.length'):
        time.sleep(0.1)
    links = page.evaluate('window.__links')
    check('外へのリンクは、パネルの中で開かず、Codexアプリへ渡す', links == ['https://csp-link-probe.example.com/x'] and frame.url.endswith('/panel.html') and len(page.context.pages) == 1, links)

    # 内部リンクで別のノートへ移る。
    P.locator('.cm-content').get_by_text('memo', exact=True).click()
    until(frame, "document.getElementById('note-path')?.textContent.includes('memo')", what='内部リンク')
    check('内部リンクで別のノートが開く', 'memo' in frame.evaluate("document.getElementById('note-path').textContent"))

    # 編集して保存する。
    P.locator('#modes').get_by_text('編集').click()
    P.locator('.cm-content').click()
    page.keyboard.press('ControlOrMeta+End')
    page.keyboard.type('追記')
    state = wait_saved(frame)
    check('編集すると保存される', state == 'saved' and '追記' in (vault / 'notes' / 'memo.md').read_text(encoding='utf-8'), state)

    # 画像を貼り付ける。
    frame.evaluate("""(b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const data = new DataTransfer(); data.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }))
      document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }""", base64.b64encode(png(5, 5, (30, 160, 60))).decode())
    # 画像の置き場を決めていないので、Vault の一番上の attachments に入る。
    until_path(lambda: len(list((vault / 'attachments').glob('*.png'))) == 2, what='貼り付けた画像のファイル')
    pasted = [p.name for p in (vault / 'attachments').glob('*.png') if p.name != 'pic.png']
    # 画像のファイルができたあと、リンクが本文に入って保存されるまで待つ（保存の状態は、前の編集の「保存済み」のままのことがある）。
    until_path(lambda: pasted and pasted[0] in (vault / 'notes' / 'memo.md').read_text(encoding='utf-8'), what='貼り付けた画像のリンクの保存')
    note = (vault / 'notes' / 'memo.md').read_text(encoding='utf-8')
    check('貼り付けた画像が、フォルダーに保存され、ノートにリンクが入る', len(pasted) == 1 and pasted[0] in note, (pasted, note[-120:]))
    P.locator('#modes').get_by_text('閲覧').click()
    shown = until(frame, "(() => { const i = [...document.querySelectorAll('.cm-content img')].find((x) => x.complete && x.naturalWidth === 5); return i && i.src.slice(0, 22) })()", what='貼り付けた画像の表示')
    check('貼り付けた画像が、data: の形で表示される', shown.startswith('data:image/png'), shown)
    shot(page, 'csp-2-pasted.png')

    # 履歴（控え）を開いて、1つ選ぶ。
    page.frame_locator('#panel').locator('#open-history').click()
    until(frame, "document.getElementById('history').open && document.querySelectorAll('#history-list li').length", what='履歴の一覧')
    P.locator('#history-list li').first.click()
    text = until(frame, "document.getElementById('history-text').textContent", what='控えの中身')
    check('「履歴」で控えを選ぶと、中身が出る', 'メモ' in text, text[:80])
    shot(page, 'csp-3-history.png')
    P.locator('#history-close').click()

    # カレンダーから今日のノートを作り、「今日のノート」のボタンでも開く。
    if frame.evaluate("document.getElementById('calendar').hidden"):
        P.locator('#toggle-calendar').click()
    until(frame, "document.querySelector('#calendar .cal-today')", what='カレンダー')
    P.locator('#calendar .cal-today').click()
    try:
        until(frame, "document.querySelector('dialog.note-ask[open]') || document.getElementById('note-path').textContent.match(/\\d{4}-\\d{2}-\\d{2}/)", what='日のノート')
    except TimeoutError:
        pass
    if frame.evaluate("Boolean(document.querySelector('dialog.note-ask[open]'))"):
        ask(P).get_by_role('button', name='作る').click()
    today = datetime.date.today().isoformat()
    daily = vault / 'periodic' / today[:4] / 'Daily' / f'{today}.md'
    until_path(daily.exists, what='日のノートのファイル')
    check('カレンダーから日のノートを作れる', daily.exists())
    shot(page, 'csp-4-calendar.png')
    open_from_files(P, frame, 'keep.md', 'other/keep.md')
    check('「今日のノート」のボタンが出る', not frame.evaluate("document.getElementById('today-note').hidden"))
    P.locator('#today-note').click()
    until(frame, f"document.getElementById('note-path').textContent.includes('{today}')", what='今日のノート')
    check('「今日のノート」のボタンで開ける', True)

    # ノートを探して開く。
    P.locator('#open-note').click()
    until(frame, "document.getElementById('switcher').open", what='探す画面')
    P.locator('#switcher-input').fill('keep')
    until(frame, "document.querySelectorAll('#switcher-list li').length", what='探した結果')
    page.keyboard.press('Enter')
    until(frame, "document.getElementById('note-path').textContent.includes('keep')", what='探して開く')
    check('ノートを探して開ける', True)

    # 新しいノートを作る。
    P.locator('#new-note').click()
    ask(P).locator('input[type=text]').fill('作ったノート')
    ask(P).get_by_role('button', name='作る').click()
    until_path(lambda: (vault / 'other' / '作ったノート.md').exists(), what='新しいノート')
    check('新しいノートを作れる', True)

    # 名前を変える（リンクも書き換える）。
    menu(P, 'memo.md', '名前を変える')
    ask(P).locator('input[type=text]').fill('memo2')
    ask(P).get_by_role('button', name='決定').click()
    ask(P).get_by_role('button', name='書き換えて変える').click()
    until_path(lambda: (vault / 'notes' / 'memo2.md').exists(), what='名前を変えたノート')
    until_path(lambda: '[[memo2]]' in (vault / 'notes' / 'rich.md').read_text(encoding='utf-8'), what='リンクの書き換え')
    check('名前を変えると、リンクも書き換わる', not (vault / 'notes' / 'memo.md').exists())

    # 移動する。
    menu(P, 'drop.md', '移動')
    ask(P).locator('.place-crumb').first.click()
    ask(P).locator('.place-row', has_text='other').click()
    ask(P).get_by_role('button', name='ここへ動かす').click()
    until_path(lambda: (vault / 'other' / 'drop.md').exists(), what='移動')
    check('ノートを別のフォルダーへ移動できる', not (vault / 'notes' / 'drop.md').exists())

    # ゴミ箱に入れる。
    until(frame, "[...document.querySelectorAll('#files .files-row')].some((r) => r.textContent.includes('drop.md'))", what='移動したノートの行')
    menu(P, 'drop.md', 'ゴミ箱に入れる')
    ask(P).get_by_role('button', name='ゴミ箱に入れる').click()
    until_path(lambda: (trash / 'drop.md').exists(), what='ゴミ箱')
    check('ゴミ箱に入れられる', not (vault / 'other' / 'drop.md').exists())

    # 設定の画面を開いて閉じる。
    P.locator('#open-settings').click()
    until(frame, "document.querySelector('dialog.note-ask[open]')", what='設定の画面')
    check('「設定」の画面が開く', '日付ごとのノート' in ask(P).inner_text())
    shot(page, 'csp-5-settings.png')
    ask(P).get_by_role('button', name='やめる').click()
    return frame

def run_file_tab(page, port, vault):
    page.goto(f'http://127.0.0.1:{port}/?file=other/keep.md')
    frame = panel_frame(page)
    until(frame, "document.getElementById('note-path')?.textContent.includes('keep')", seconds=30, what='ファイルから開いたタブ')
    until(frame, "document.querySelector('.cm-content')", what='本文')
    P = page.frame_locator('#panel')
    P.locator('#modes').get_by_text('編集').click()
    P.locator('.cm-content').click()
    page.keyboard.press('ControlOrMeta+End')
    page.keyboard.type('タブから')
    state = wait_saved(frame)
    check('ファイルから開いたタブでも、編集すると保存される', state == 'saved' and 'タブから' in (vault / 'other' / 'keep.md').read_text(encoding='utf-8'), state)
    return frame

def run_more(page, port, vault):
    page.goto(f'http://127.0.0.1:{port}/')
    frame = panel_frame(page)
    P = page.frame_locator('#panel')
    until(frame, "document.querySelector('#files .files-row')", seconds=30, what='ファイルの一覧')
    if not frame.evaluate("[...document.querySelectorAll('#files .files-row')].some((r) => r.textContent.includes('props.md'))"):
        row(P, 'notes').click()
    props = vault / 'notes' / 'props.md'
    read = lambda: props.read_text(encoding='utf-8')
    open_from_files(P, frame, 'props.md', 'notes/props.md')
    P.locator('#modes').get_by_text('編集').click()

    # ノートの情報の欄を編集する（閉じていれば、見出しを押して開く）。
    until(frame, "document.querySelector('.cm-props-head')", what='ノートの情報の欄')
    if not frame.evaluate("Boolean(document.querySelector('input.cm-props-value'))"):
        P.locator('.cm-props-head').click()
    P.locator('input.cm-props-value[aria-label="title"]').click()
    page.keyboard.press('End'); page.keyboard.type('X'); page.keyboard.press('Enter')
    until_path(lambda: 'title: はじめX\n' in read(), what='情報の欄の保存')
    check('ノートの情報の欄を編集すると保存される', True)

    # 表のマスを編集する（Tab で次のマスへ移ると、書き戻される）。
    P.locator('td[data-row="2"][data-col="0"]').click()
    page.keyboard.type('Y'); page.keyboard.press('Tab'); page.keyboard.press('Escape')
    until_path(lambda: '| aY |' in read() or '| aY|' in read(), what='表のマスの保存')
    check('表のマスを編集すると保存される', True)

    # パスをコピーする。
    P.locator('#copy-path').click()
    until(frame, "document.getElementById('status').textContent.includes('コピーしました') || document.querySelector('dialog.note-ask[open]')", what='パスのコピー')
    copied = page.evaluate('navigator.clipboard.readText()')
    check('「パスをコピー」で、ノートの場所がコピーされる', copied == os.path.realpath(props), copied)

    # 「履歴」から、編集する前の控えに戻す。
    P.locator('#open-history').click()
    until(frame, "document.getElementById('history').open && document.querySelectorAll('#history-list li').length", what='履歴の一覧')
    items = P.locator('#history-list li')
    restored = False
    for index in range(items.count()):
        items.nth(index).click()
        text = until(frame, "document.getElementById('history-text').textContent", what='控えの中身')
        if text == PROPS:
            P.locator('#history-restore').click()
            restored = True
            break
    until_path(lambda: read() == PROPS, what='控えに戻した保存')
    check('「履歴」から編集する前の控えに戻せる', restored and read() == PROPS)

    # 「設定」で画像の置き場を other に変えて保存し、貼り付けた画像がそこに入る。
    P.locator('#open-settings').click()
    until(frame, "document.querySelector('dialog.note-ask[open]')", what='設定の画面')
    ask(P).get_by_role('button', name='選ぶ').first.click()
    until(frame, "document.querySelectorAll('dialog.note-ask[open]').length === 2", what='場所選び')
    ask(P).locator('.place-row', has_text='other').click()
    ask(P).get_by_role('button', name='ここにする').click()
    until(frame, "document.querySelectorAll('dialog.note-ask[open]').length === 1", what='設定の画面に戻る')
    ask(P).get_by_role('button', name='保存').click()
    until(frame, "!document.querySelector('dialog.note-ask[open]')", what='設定の保存')
    P.locator('.cm-content').click()
    page.keyboard.press('ControlOrMeta+End')
    frame.evaluate("""(b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const data = new DataTransfer(); data.items.add(new File([bytes], 'set.png', { type: 'image/png' }))
      document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }""", base64.b64encode(png(6, 6)).decode())
    until_path(lambda: list((vault / 'other').glob('set-*.png')), what='設定した置き場への画像')
    check('「設定」で画像の置き場を変えて保存すると、貼り付けた画像がそこに入る', True)
    until_path(lambda: 'other/set-' in read(), what='画像のリンクの保存')

    # カレンダーから、週と月のノートを作る。
    if frame.evaluate("document.getElementById('calendar').hidden"):
        P.locator('#toggle-calendar').click()
    until(frame, "document.querySelector('#calendar .cal-week')", what='カレンダー')
    def make_periodic(selector, folder):
        before = set((vault / 'periodic').rglob('*.md')) if (vault / 'periodic').exists() else set()
        P.locator(selector).first.click()
        try:
            until(frame, "document.querySelector('dialog.note-ask[open]')", seconds=3, what='作るかの確認')
            ask(P).get_by_role('button', name='作る').click()
        except TimeoutError:
            pass
        until_path(lambda: any(folder in p.parts for p in set((vault / 'periodic').rglob('*.md')) - before), what=f'{folder} のノート')
        return [p.relative_to(vault).as_posix() for p in set((vault / 'periodic').rglob('*.md')) - before]
    weekly = make_periodic('#calendar .cal-week', 'Weekly')
    check('カレンダーから週のノートを作れる', bool(weekly), weekly)
    monthly = make_periodic('#calendar .cal-title', 'Monthly')
    check('カレンダーから月のノートを作れる', bool(monthly), monthly)

    # フォルダーを作り、名前を変える。
    menu(P, 'other', 'この中に新しいフォルダー')
    ask(P).locator('input[type=text]').fill('sub')
    ask(P).get_by_role('button', name='決定').click()
    until_path(lambda: (vault / 'other' / 'sub').is_dir(), what='新しいフォルダー')
    until(frame, "[...document.querySelectorAll('#files .files-row')].some((r) => r.textContent.trim().startsWith('sub') || r.textContent.includes('sub'))", what='フォルダーの行')
    menu(P, 'sub', '名前を変える')
    ask(P).locator('input[type=text]').fill('sub2')
    ask(P).get_by_role('button', name='決定').click()
    until_path(lambda: (vault / 'other' / 'sub2').is_dir(), what='フォルダーの名前の変更')
    check('フォルダーを作り、名前を変えられる', not (vault / 'other' / 'sub').exists())

    # 保存できなかった入力を、下書きから戻す（Codexアプリの代わりのページで、保存をわざと失敗させる）。
    open_from_files(P, frame, 'props.md', 'notes/props.md')
    if frame.evaluate("!document.querySelector('.cm-props-value') || document.getElementById('modes').querySelector('[aria-pressed=\"true\"]')?.textContent !== '編集'"):
        P.locator('#modes').get_by_text('編集').click()
    page.evaluate('window.__failWrites = true')
    P.locator('.cm-content').click()
    page.keyboard.press('ControlOrMeta+End')
    page.keyboard.type('下書き')
    until(frame, "document.getElementById('status').dataset.state === 'failed'", what='保存の失敗')
    check('保存をわざと失敗させると「保存に失敗」になり、ファイルは変わらない', '下書き' not in read())
    kept_violations.extend(frame.evaluate('window.__csp'))
    page.reload()
    frame = panel_frame(page)
    P = page.frame_locator('#panel')
    until(frame, "document.querySelector('#files .files-row')", seconds=30, what='読み込み直したあとの一覧')
    if not frame.evaluate("document.getElementById('note-path')?.textContent.includes('props')"):
        if not frame.evaluate("[...document.querySelectorAll('#files .files-row')].some((r) => r.textContent.includes('props.md'))"):
            row(P, 'notes').click()
        row(P, 'props.md').click()
    until(frame, "[...document.querySelectorAll('dialog.note-ask[open]')].some((d) => d.textContent.includes('反映'))", what='下書きの確認')
    ask(P).get_by_role('button', name='反映する').click()
    until_path(lambda: '下書き' in read(), what='下書きの反映')
    check('下書きを反映すると、保存される', True)
    shot(page, 'csp-6-more.png')
    return frame

def main():
    if not panel_file.exists():
        print('dist/panel.html がありません。先に npm run build を実行してください。')
        return 1
    work = pathlib.Path(tempfile.mkdtemp(prefix='panel-csp-'))
    vault, trash = make_vault(work), work / 'trash'
    trash.mkdir()
    env = {**os.environ, 'NOTEDOCK_TRASH_DIR': str(trash), 'HOST_SETTINGS': json.dumps({'attachmentDir': None, 'periodic': {'root': 'periodic'}})}
    srv = subprocess.Popen(['node', str(here / 'host-server.mjs'), str(vault), str(work / 'bak'), str(panel_file)],
                           stdout=subprocess.PIPE, text=True, env=env, cwd=str(pkg))
    try:
        port = wait_ready(srv)
        with sync_playwright() as p:
            browser = p.chromium.launch()
            context = browser.new_context(viewport={'width': 1200, 'height': 760}, locale='ja-JP')
            context.grant_permissions(['clipboard-read', 'clipboard-write'], origin=f'http://127.0.0.1:{port}')
            context.add_init_script(WATCH)
            page = context.new_page()
            errors, refused, blocked = [], [], []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: refused.append(m.text) if 'Content Security Policy' in m.text else None)
            page.on('requestfailed', lambda r: blocked.append((r.url[:120], r.failure)) if 'csp' in (r.failure or '').lower() else None)
            for name, step in [('ファイルなしで開いたタブ', lambda: run_left_rail(page, port, vault, trash)), ('ファイルから開いたタブ', lambda: run_file_tab(page, port, vault)),
                               ('ほかの機能', lambda: run_more(page, port, vault))]:
                try:
                    frame = step()
                except Exception as error:
                    check(f'{name}の操作が最後まで進む', False, repr(error))
                    shot(page, f'csp-fail-{len(fails)}.png')
                    frame = panel_frame(page)
                violations = kept_violations + frame.evaluate('window.__csp')
                kept_violations.clear()
                check(f'{name}で、通信の制限に止められたものがない', violations == [] and not refused and not blocked, {'violations': violations, 'console': refused, 'requests': blocked})
                refused.clear(); blocked.clear()
            # 見張りが効いていることを確かめる（わざと外の画像を読ませ、止められて記録されるか）。
            frame.evaluate("new Image().src = 'https://csp-watch-probe.example.com/p.png'")
            end = time.time() + 5
            while time.time() < end and not frame.evaluate('window.__csp.length'):
                time.sleep(0.1)
            caught = frame.evaluate('window.__csp')
            check('見張りが効いている（わざと読ませた外の画像が、制限に止められて記録される）', any('csp-watch-probe' in c['blocked'] and c['directive'] == 'img-src' for c in caught), caught)
            check('画面のエラーがない', not errors, errors)
            browser.close()
    finally:
        srv.terminate()
        try:
            srv.wait(timeout=10)
        except subprocess.TimeoutExpired:
            srv.kill()
        shutil.rmtree(work, ignore_errors=True)
    print('合格' if not fails else '不合格: ' + ', '.join(fails))
    return 1 if fails else 0

sys.exit(main())
