#!/usr/bin/env python3
"""エディターの画面を、Chromium で実際に動かして確かめる（保存できないときの帯、確認の画面、画像、ゴミ箱、下書き、サーバーの下書き）。

使い方: python3 -I test/browser/panel-check.py [画像を置くフォルダー]
必要なもの: Python版のPlaywrightとChromium、このパッケージの node_modules（npm install のあと）。
試し用のノートは、試すたびに一時的なフォルダーに作る。実際のノートには触らない。
"""
import json, os, pathlib, shutil, subprocess, sys, tempfile, threading, time, urllib.parse, urllib.request
from playwright.sync_api import sync_playwright

here = pathlib.Path(__file__).resolve().parent
shots = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else None
fails = []
def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)))
    if not ok: fails.append(name)

def shot(page, name):
    if shots:
        shots.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(shots / name))

def wait_ready(srv, seconds=60):
    # サーバーが「ready <番号>」と出すのを待つ。出さずに終わったり、時間がかかりすぎたりしたら止める。
    result = []
    reader = threading.Thread(target=lambda: result.append(srv.stdout.readline()), daemon=True)
    reader.start()
    reader.join(seconds)
    line = result[0].split() if result else []
    if len(line) != 2 or line[0] != 'ready':
        raise RuntimeError(f'試験用のサーバーが立ち上がりませんでした: {result}')
    return line[1]

# env は試験用のサーバーに足す環境変数（DRAFT_DELAY_MS など）。prepare は、サーバーを立ち上げる前に Vault を整える。
# ゴミ箱は、Mac のゴミ箱ではなく、一時的なフォルダー（NOTEDOCK_TRASH_DIR）へ向ける。
def run(force, fn, init=None, env=None, prepare=None):
    work = pathlib.Path(tempfile.mkdtemp(prefix='panel-check-'))
    vault, bak = work / 'vault', work / 'bak'
    (vault / 'notes').mkdir(parents=True)
    (work / 'trash').mkdir()
    (vault / 'notes' / 'memo.md').write_text('# メモ\n\n本文\n', encoding='utf-8', newline='\n')
    (vault / 'notes' / 'drop.md').write_text('# 消す\n', encoding='utf-8', newline='\n')
    if prepare: prepare(vault)
    srv = subprocess.Popen(['node', str(here / 'panel-server.mjs'), str(vault), str(bak)], stdout=subprocess.PIPE, text=True,
                           env={**os.environ, 'FORCE': force, 'NOTEDOCK_TRASH_DIR': str(work / 'trash'), **(env or {})}, cwd=str(here.parent.parent))
    try:
        port = wait_ready(srv)
        with sync_playwright() as p:
            b = p.chromium.launch(); page = b.new_page(viewport={'width': 900, 'height': 600}, locale='ja-JP')
            errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
            page.add_init_script("window.FIRST_NOTE = 'notes/memo.md'")
            if init: page.add_init_script(init)
            page.goto(f'http://127.0.0.1:{port}/')
            page.wait_for_selector('.cm-content', timeout=15000)
            fn(page, vault, bak)
            check(f'画面のエラーがない（{force}、{fn.__name__}）', not errors, errors)
            b.close()
    finally:
        srv.terminate()
        try:
            srv.wait(timeout=10)
        except subprocess.TimeoutExpired:
            srv.kill()
        shutil.rmtree(work, ignore_errors=True)

def toolarge(page, vault, bak):
    page.click('#modes >> text=編集')
    page.wait_for_timeout(300)
    page.click('.cm-content')
    page.keyboard.press('End')
    # 実際に20MBを超える本文を貼る（サーバーに送る前に、画面の側で断るはず）。
    page.evaluate("""() => {
      const data = new DataTransfer(); data.setData('text/plain', 'a'.repeat(20 * 1024 * 1024 + 10))
      document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }""")
    page.wait_for_function("document.getElementById('status').dataset.state === 'toolarge'", timeout=30000)
    banner = page.inner_text('#banner')
    check('保存できないと、20MBの上限と下書きのことが出る', '20MB' in banner and '下書き' in banner, banner)
    check('状態の欄に「大きすぎて保存できません」', '大きすぎて保存できません' in page.inner_text('#status'), page.inner_text('#status'))
    check('帯は、閉じると消えることを伝える', '消えます' in banner, banner)
    shot(page, '1-toolarge.png')
    page.locator('.files-row', has_text='drop.md').first.click()
    page.wait_for_selector('dialog.note-ask', timeout=10000)
    ask = page.inner_text('dialog.note-ask')
    check('保存できないまま別のノートを開こうとすると、確かめる', '消えます' in ask, ask)
    shot(page, '1b-switch.png')
    page.click('dialog.note-ask >> text=やめる')
    page.wait_for_timeout(500)
    check('やめると、今のノートと入力が残る', 'memo.md' in page.inner_text('header') and page.evaluate("document.querySelector('.cm-content').textContent.includes('aaaa')"))

def image(page, vault, bak):
    page.click('#modes >> text=編集')
    page.wait_for_timeout(300)
    page.click('.cm-content')
    page.evaluate("""() => {
      const file = new File([new Uint8Array(25 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })
      const data = new DataTransfer(); data.items.add(file)
      document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }""")
    page.wait_for_timeout(800)
    text = page.inner_text('body')
    check('大きすぎる画像は、25MBまでと出る', '25MBまで' in text)
    check('画像のファイルは作られない', not (vault / 'attachments').exists())
    shot(page, '2-image.png')

def trash(page, vault, bak):
    row = page.locator('.files-row', has_text='drop.md')
    if not row.count():
        page.click('#toggle-files') if page.locator('#toggle-files').count() else None
    row = page.locator('.files-row', has_text='drop.md').first
    row.click(button='right')
    page.click('text=ゴミ箱に入れる')
    page.click('dialog.note-ask >> text=ゴミ箱に入れる')
    page.wait_for_timeout(800)
    text = page.inner_text('body')
    check('ゴミ箱のコマンドがないと、その理由とFinderで消す案内が出る', '/usr/bin/trash' in text and 'Finder' in text)
    check('ノートは消えていない', (vault / 'notes' / 'drop.md').exists())
    shot(page, '3-trash.png')

def other409(page, vault, bak):
    page.click('#modes >> text=編集')
    page.wait_for_timeout(300)
    page.click('.cm-content')
    page.keyboard.press('End'); page.keyboard.type('z')
    # 保存が返ってくるまで待ってから確かめる（待たずに見ると、保存の前の状態で通ってしまう）。
    page.wait_for_function("['failed', 'offline', 'saved', 'updated', 'conflict'].includes(document.getElementById('status').dataset.state)", timeout=15000)
    state = page.evaluate("document.getElementById('status').dataset.state")
    check('衝突ではない 409 は「保存に失敗」とし、保存済みにも衝突にもしない', state == 'failed', state)

FULL = """(() => { const real = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (String(k).startsWith('draft:')) throw new DOMException('full', 'QuotaExceededError'); return real.call(this, k, v) } })()"""

def offline_full(page, vault, bak):
    page.click('#modes >> text=編集')
    page.wait_for_timeout(300)
    page.click('.cm-content')
    page.keyboard.press('End'); page.keyboard.type('q')
    page.wait_for_function("document.getElementById('status').dataset.state === 'failed'", timeout=15000)
    banner = page.inner_text('#banner')
    check('サーバーで失敗したときは「保存に失敗」と出し、「つながりません」と言わない', '保存に失敗' in banner and 'つながりません' not in banner, banner)
    check('下書きに書けないと、帯でそれを知らせる', '下書きにも残せていません' in banner, banner)
    shot(page, '4-offline-full.png')
    page.locator('.files-row', has_text='drop.md').first.click()
    page.wait_for_selector('dialog.note-ask', timeout=15000)
    ask = page.inner_text('dialog.note-ask')
    check('下書きに書けないまま別のノートを開こうとすると、確かめる', '下書きにも残せていません' in ask, ask)
    shot(page, '4b-switch.png')
    page.click('dialog.note-ask >> text=やめる')
    page.wait_for_timeout(500)
    check('やめると、入力が残る', 'q' in page.inner_text('.cm-content'))

def offline_ok(page, vault, bak):
    page.click('#modes >> text=編集')
    page.wait_for_timeout(300)
    page.click('.cm-content')
    page.keyboard.press('End'); page.keyboard.type('q')
    page.wait_for_function("document.getElementById('status').dataset.state === 'failed'", timeout=15000)
    banner = page.inner_text('#banner')
    check('下書きに書けたときは、下書きの断りを出さない', '下書きにも残せていません' not in banner and '保存に失敗' in banner, banner)
    check('「チャットへ」のボタンはない', page.locator('#to-chat').count() == 0)
    shot(page, '5-failed.png')

OLD_DRAFTS = """(() => { if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1'); const day = 86400000; localStorage.setItem('draft:other:old.md', JSON.stringify({ text: 'old', time: Date.now() - 40 * day })); localStorage.setItem('draft:other:new.md', JSON.stringify({ text: 'new', time: Date.now() - 2 * day })) })()"""

def drafts(page, vault, bak):
    page.wait_for_timeout(500)
    keys = page.evaluate("Object.keys(localStorage).filter((k) => k.startsWith('draft:other:'))")
    check('30日より前の下書きは片付け、新しい下書きは残す', keys == ['draft:other:new.md'], keys)

# --- サーバーの下書き ---
MEMO = '# メモ\n\n本文\n'

def root_id(page):
    return page.evaluate("fetch('/api/health').then((r) => r.json()).then((d) => d.rootId)")

def put_server_draft(page, path, draft):
    # パネルと同じ形で、サーバーに下書きを置く。ブラウザーを通さずに送る
    # （ブラウザーは、同じ場所への問い合わせの応答を待っている間、次の送信を待たせることがあるため）。
    origin = page.url.split('/', 3)[:3]
    base = '/'.join(origin)
    with urllib.request.urlopen(base + '/api/health') as r:
        root = json.load(r)['rootId']
    req = urllib.request.Request(f"{base}/api/draft?path={urllib.parse.quote(path, safe='')}&root={root}", method='PUT',
                                 data=json.dumps({'draft': draft}).encode('utf-8'), headers={'content-type': 'application/json', 'x-note-editor': '1'})
    with urllib.request.urlopen(req) as r:
        return json.load(r).get('ok') is True

def draft_of(text, base, ago=0):
    at = time.time() * 1000 - ago
    return {'text': text, 'baseText': base, 'time': at, 'savedAt': at}

def draft_files(bak):
    return list(bak.rglob('draft.json')) if bak.exists() else []

def draft_texts(bak):
    texts = []
    for file in draft_files(bak):
        try:
            texts.append(json.loads(file.read_text(encoding='utf-8')).get('text', ''))
        except (OSError, ValueError):
            pass
    return texts

def conflicts(bak):
    return list(bak.rglob('conflict-*.md')) if bak.exists() else []

def until(page, fn, seconds):
    # 画面を止めずに、条件がそろうまで待つ。そろったかを返す。
    end = time.time() + seconds
    while True:
        if fn(): return True
        if time.time() >= end: return False
        page.wait_for_timeout(100)

def local_draft(page, key):
    return page.evaluate("(key) => localStorage.getItem(key)", key)

def start_edit(page):
    page.click('#modes >> text=編集')
    page.wait_for_timeout(300)
    page.click('.cm-content')
    page.keyboard.press('End')

def wait_saved(page, vault, typed):
    page.wait_for_function("document.getElementById('status').dataset.state === 'saved'", timeout=15000)
    return until(page, lambda: (vault / 'notes' / 'memo.md').read_text(encoding='utf-8').endswith(typed), 5)

def asking(page):
    return page.locator('dialog.note-ask[open]').count() > 0

def server_draft(page, vault, bak):
    key = f'draft:{root_id(page)}:notes/memo.md'
    page.evaluate("([key, value]) => localStorage.setItem(key, value)", [key, json.dumps(draft_of(MEMO + '古い下書き\n', MEMO, ago=60000))])
    check('サーバーに下書きを置ける', put_server_draft(page, 'notes/memo.md', draft_of(MEMO + '新しい下書き\n', MEMO)))
    page.reload()
    page.wait_for_selector('dialog.note-ask[open]', timeout=15000)
    ask = page.inner_text('dialog.note-ask[open]')
    check('サーバーの下書きのほうが新しいと、「反映しますか？」が出る', '反映しますか' in ask, ask)
    page.click('dialog.note-ask[open] >> text=内容を見る')
    page.wait_for_selector('#compare[open]', timeout=5000)
    mine = page.inner_text('#compare-mine')
    check('「内容を見る」で、サーバーの新しい下書きが出る', '新しい下書き' in mine and '古い下書き' not in mine, mine)
    check('使ったサーバーの下書きを、localStorage にも入れ直す', '新しい下書き' in (local_draft(page, key) or ''), local_draft(page, key))
    shot(page, '6-server-draft.png')

def saved_clears(page, vault, bak):
    start_edit(page)
    page.keyboard.type('x')
    check('打つと、サーバーに下書き（draft.json）ができる', until(page, lambda: draft_files(bak), 1.5), draft_files(bak))
    check('打った分が保存される', wait_saved(page, vault, 'x'))
    check('保存されると、draft.json が消える', until(page, lambda: not draft_files(bak), 5), draft_files(bak))

def draft_slow(page, vault, bak):
    before = len(conflicts(bak))
    check('サーバーに下書きを置ける', put_server_draft(page, 'notes/memo.md', draft_of(MEMO + '遅れて届く下書き\n', MEMO)))
    started = time.time()
    page.reload()
    page.wait_for_selector('.cm-content', timeout=15000)
    opened = time.time() - started
    check('下書きの応答が来なくても、約3秒で開く', 2.0 <= opened <= 7.0, opened)
    check('タイムアウトしたら、確認は出さない', not asking(page))
    start_edit(page)
    page.keyboard.type('y')
    check('打った分が保存される', wait_saved(page, vault, 'y'))
    early = time.time() - started
    check('10秒になる前は、保存のあとも draft.json が残っている', early < 9.5 and '遅れて届く下書き' in ''.join(draft_texts(bak)), (early, draft_texts(bak)))
    settled = until(page, lambda: len(conflicts(bak)) == before + 1 and not draft_files(bak), max(1.0, started + 17 - time.time()))
    check('10秒を過ぎると、遅れて届いた下書きが履歴に1つ増え、draft.json は消える', settled, (len(conflicts(bak)) - before, draft_texts(bak)))
    kept = [file.read_text(encoding='utf-8') for file in conflicts(bak)]
    check('履歴に残ったのは、遅れて届いた下書き', any('遅れて届く下書き' in text for text in kept), kept)
    check('localStorage には下書きがない', local_draft(page, f'draft:{root_id(page)}:notes/memo.md') is None)

def backup_fail(page, vault, bak):
    before = len(conflicts(bak))
    check('サーバーに下書きを置ける', put_server_draft(page, 'notes/memo.md', draft_of(MEMO + '残すべき下書き\n', MEMO)))
    started = time.time()
    page.reload()
    page.wait_for_selector('.cm-content', timeout=15000)
    start_edit(page)
    page.keyboard.type('w')
    check('打った分が保存される', wait_saved(page, vault, 'w'))
    page.wait_for_timeout(max(0, (started + 13 - time.time()) * 1000))
    check('履歴に残せないと、遅れて届いた下書き（draft.json）はそのまま残る', any('残すべき下書き' in text for text in draft_texts(bak)), draft_texts(bak))
    check('履歴に残せないときは、履歴も増えない', len(conflicts(bak)) == before, len(conflicts(bak)) - before)

def switch_back(page, vault, bak):
    check('サーバーに下書きを置ける', put_server_draft(page, 'notes/drop.md', draft_of('# 消す\n捨てる下書き\n', '# 消す\n')))
    page.locator('.files-row', has_text='drop.md').first.click()
    page.locator('.files-row', has_text='memo.md').first.click()
    page.wait_for_timeout(4000)
    check('memo.md に戻っている', page.evaluate("document.title") == 'memo', page.evaluate("document.title"))
    seen = page.inner_text('.cm-content')
    if asking(page):
        seen += page.inner_text('dialog.note-ask[open]')
        page.click('dialog.note-ask[open] >> text=内容を見る')
        page.wait_for_selector('#compare[open]', timeout=5000)
        seen += page.inner_text('#compare-mine')
    check('memo.md の確認や本文に、drop.md の下書きが出ない', '捨てる下書き' not in seen, seen)

def reopen_same(page, vault, bak):
    start_edit(page)
    page.keyboard.type('r')
    check('打つと、サーバーに下書き（draft.json）ができる', until(page, lambda: draft_files(bak), 1.5), draft_files(bak))
    page.locator('.files-row', has_text='memo.md').first.click()
    page.wait_for_timeout(2500)
    check('保存の前に同じノートを開き直しても、「反映しますか？」が出ない', not asking(page), page.inner_text('body')[:200])
    check('打った分は保存されている', (vault / 'notes' / 'memo.md').read_text(encoding='utf-8').endswith('r'))

def bom_note(vault):
    (vault / 'notes' / 'bom.md').write_bytes('﻿# BOM付き\n'.encode('utf-8'))

def readonly_slow(page, vault, bak):
    before = len(conflicts(bak))
    check('サーバーに下書きを置ける', put_server_draft(page, 'notes/bom.md', draft_of('# BOM付き\n打ちかけ\n', '# BOM付き\n')))
    started = time.time()
    page.locator('.files-row', has_text='bom.md').first.click()
    page.wait_for_function("document.getElementById('status').dataset.state === 'readonly'", timeout=15000)
    opened = time.time() - started
    check('編集できないノートは、下書きの応答を待たずに開く', opened < 2.5, opened)
    page.wait_for_timeout(max(0, (started + 12 - time.time()) * 1000))
    check('10秒を過ぎても、編集できないノートの draft.json は残る', any('打ちかけ' in text for text in draft_texts(bak)), draft_texts(bak))
    check('編集できないノートでは、履歴も増えない', len(conflicts(bak)) == before, len(conflicts(bak)) - before)
    check('編集できないノートでは、確認も出ない', not asking(page))

def move_trash_keys(page, vault, bak):
    root = root_id(page)
    old_key, new_key = f'draft:{root}:notes/drop.md', f'draft:{root}:drop.md'
    moved = json.dumps(draft_of('# 消す\n移す下書き\n', '# 消す\n'))
    page.evaluate("([a, b, value, stale]) => { localStorage.setItem(a, value); localStorage.setItem(b, stale) }",
                  [old_key, new_key, moved, json.dumps(draft_of('前からあった古い下書き\n', ''))])
    page.locator('.files-row', has_text='drop.md').first.click(button='right')
    page.get_by_text('移動', exact=True).last.click()
    page.locator('dialog.note-ask[open]').last.locator('.place-crumb').first.click()
    page.locator('dialog.note-ask[open]').last.get_by_role('button', name='ここへ動かす').click()
    check('ノートを一番上のフォルダーへ移せる', until(page, lambda: (vault / 'drop.md').exists(), 10))
    check('移動すると、下書きは新しいパスのキーに移る', until(page, lambda: local_draft(page, old_key) is None and local_draft(page, new_key) == moved, 5),
          (local_draft(page, old_key), local_draft(page, new_key)))
    until(page, lambda: page.locator('.files-row', has_text='drop.md').count() > 0, 10)
    page.locator('.files-row', has_text='drop.md').first.click(button='right')
    page.get_by_text('ゴミ箱に入れる', exact=True).last.click()
    page.click('dialog.note-ask[open] >> text=ゴミ箱に入れる')
    check('ゴミ箱に入れられる', until(page, lambda: not (vault / 'drop.md').exists(), 10))
    check('ゴミ箱に入れると、下書きのキーも消える', until(page, lambda: local_draft(page, new_key) is None, 5), local_draft(page, new_key))

def readonly_reopen(page, vault, bak):
    # 編集できない状態で開いたノートが編集できるようになり、同じノートを開き直したときは、サーバーの下書きを使う。
    page.locator('.files-row', has_text='bom.md').first.click()
    page.wait_for_function("document.getElementById('status').dataset.state === 'readonly'", timeout=15000)
    check('サーバーに下書きを置ける', put_server_draft(page, 'notes/bom.md', draft_of('# BOM付き\n打ちかけ\n', '# BOM付き\n')))
    (vault / 'notes' / 'bom.md').write_text('# BOM付き\n', encoding='utf-8', newline='\n')
    page.wait_for_timeout(500)
    page.locator('.files-row', has_text='bom.md').first.click()
    page.wait_for_function("document.getElementById('status').dataset.state !== 'readonly'", timeout=15000)
    try:
        page.wait_for_selector('dialog.note-ask[open]', timeout=8000)
    except Exception:
        pass
    check('編集できる状態で開き直すと、「反映しますか？」が出る', asking(page))
    if asking(page):
        page.click('dialog.note-ask[open] >> text=内容を見る')
        page.wait_for_selector('#compare[open]', timeout=5000)
        mine = page.inner_text('#compare-mine')
        check('「内容を見る」で、サーバーの下書きが出る', '打ちかけ' in mine, mine)

def trash_typed(page, vault, bak):
    # ゴミ箱に入れている間に打った分が、ゴミ箱に入れたノートの下書きとしてサーバーに残らない。
    page.locator('.files-row', has_text='drop.md').first.click()
    page.wait_for_function("document.title === 'drop'", timeout=15000)
    start_edit(page)
    page.keyboard.type('a')
    page.locator('.files-row', has_text='drop.md').first.click(button='right')
    page.get_by_text('ゴミ箱に入れる', exact=True).last.click()
    page.click('dialog.note-ask[open] >> text=ゴミ箱に入れる')
    # ゴミ箱の応答が遅れている間に打つ。
    check('ゴミ箱に入れられる', until(page, lambda: not (vault / 'notes' / 'drop.md').exists(), 10))
    page.click('.cm-content')
    page.keyboard.type('bc')
    page.wait_for_timeout(4000)
    check('ゴミ箱に入れたあと、そのノートの draft.json は残らない', not draft_files(bak), draft_texts(bak))
    check('ゴミ箱に入れたあと、そのノートの下書きのキーも残らない', local_draft(page, f'draft:{root_id(page)}:notes/drop.md') is None)

def case_rename(page, vault, bak):
    # 大文字と小文字だけを変える名前の変更では、移った先の draft.json を消さない。
    root = root_id(page)
    value = json.dumps(draft_of('# 消す\n残す下書き\n', '# 消す\n'))
    page.evaluate("([key, value]) => localStorage.setItem(key, value)", [f'draft:{root}:notes/drop.md', value])
    check('サーバーに下書きを置ける', put_server_draft(page, 'notes/drop.md', json.loads(value)))
    page.locator('.files-row', has_text='drop.md').first.click(button='right')
    page.get_by_text('名前を変える', exact=True).last.click()
    page.locator('dialog.note-ask[open] input[type=text]').last.fill('Drop')
    page.locator('dialog.note-ask[open]').last.get_by_role('button', name='決定').click()
    check('大文字と小文字だけを変えられる', until(page, lambda: 'Drop.md' in os.listdir(vault / 'notes'), 10), os.listdir(vault / 'notes'))
    page.wait_for_timeout(2000)
    check('大文字と小文字だけを変えても、draft.json は残る', any('残す下書き' in text for text in draft_texts(bak)), draft_texts(bak))
    check('下書きのキーは新しい名前に移る', local_draft(page, f'draft:{root}:notes/Drop.md') == value, local_draft(page, f'draft:{root}:notes/Drop.md'))

def move_open_locked(page, vault, bak):
    # 開いているノートを動かしたあと、新しいパスで開き終わるまでは打てない。古いパスに下書きが残らない。
    page.locator('.files-row', has_text='drop.md').first.click()
    page.wait_for_function("document.title === 'drop'", timeout=15000)
    start_edit(page)
    page.locator('.files-row', has_text='drop.md').first.click(button='right')
    page.get_by_text('移動', exact=True).last.click()
    page.locator('dialog.note-ask[open]').last.locator('.place-crumb').first.click()
    page.locator('dialog.note-ask[open]').last.get_by_role('button', name='ここへ動かす').click()
    check('開いているノートを一番上のフォルダーへ移せる', until(page, lambda: (vault / 'drop.md').exists(), 10))
    # 新しいパスで開くのは、下書きの応答を待つ間（DRAFT_DELAY_MS）は終わらない。その間に打つ。
    locked = page.evaluate("document.querySelector('.cm-content').contentEditable")
    check('移動のあと開き終わるまでは、編集できない', locked == 'false', locked)
    page.click('.cm-content')
    page.keyboard.type('zz')
    page.wait_for_timeout(4500)
    # 開き直すと閲覧で開くので、「編集」に切り替えて、止めていたのが解けたかを見る。
    page.click('#modes >> text=編集')
    page.wait_for_timeout(300)
    check('開き終わると、また編集できる', page.evaluate("document.querySelector('.cm-content').contentEditable") == 'true')
    check('打った分は、古いノートに入らない', 'zz' not in page.inner_text('.cm-content'), page.inner_text('.cm-content'))
    check('古いパスに draft.json が残らない', not draft_files(bak), draft_texts(bak))
    check('古いパスの下書きのキーも残らない', local_draft(page, f'draft:{root_id(page)}:notes/drop.md') is None)

def query_retry(page, vault, bak):
    # 開いたときの下書きの問い合わせが失敗しても、保存できたあとにもう一度問い合わせて、保留を解く。
    before = len(conflicts(bak))
    check('サーバーに下書きを置ける', put_server_draft(page, 'notes/memo.md', draft_of(MEMO + '残っていた下書き\n', MEMO)))
    start_edit(page)
    page.keyboard.type('q')
    check('打った分が保存される', wait_saved(page, vault, 'q'))
    synced = until(page, lambda: not draft_files(bak) and len(conflicts(bak)) == before + 1, 5)
    check('保存のあと問い合わせ直し、残っていた下書きは履歴に残して draft.json を消す', synced, (draft_texts(bak), len(conflicts(bak)) - before))
    page.keyboard.type('p')
    check('保留が解けて、また下書きをサーバーへ送る', until(page, lambda: any(text.endswith('qp') for text in draft_texts(bak)), 1.5), draft_texts(bak))

def other_root(page, vault, bak):
    # サーバーが別の Vault のものに変わっていたら、打つたびに下書きを送り続けない。
    sent = []
    page.on('request', lambda r: sent.append(r.url) if r.method == 'PUT' and '/api/draft?' in r.url else None)
    start_edit(page)
    for key in 'abc':
        page.keyboard.type(key)
        page.wait_for_timeout(1500)
    check('別の Vault だと断られたら、そのあとは下書きを送らない', len(sent) == 1, len(sent))

run('none', drafts, OLD_DRAFTS)
run('none', toolarge)
run('500', offline_full, FULL)
run('500', offline_ok)
run('409', other409)
run('none', image)
run('501', trash)
run('none', server_draft)
run('none', saved_clears)
run('none', draft_slow, env={'DRAFT_DELAY_MS': '10000'})
run('backupfail', backup_fail, env={'DRAFT_DELAY_MS': '10000'})
run('none', switch_back, env={'DRAFT_DELAY_MS': '1500'})
run('none', reopen_same)
run('none', readonly_slow, env={'DRAFT_DELAY_MS': '10000'}, prepare=bom_note)
run('none', move_trash_keys)
run('none', readonly_reopen, prepare=bom_note)
run('none', trash_typed, env={'TRASH_DELAY_MS': '2000'})
run('none', case_rename)
run('none', move_open_locked, env={'DRAFT_DELAY_MS': '2500'})
run('none', query_retry, env={'DRAFT_FAIL': '1'})
run('otherroot', other_root)
print('合格' if not fails else '不合格: ' + ', '.join(fails))
sys.exit(1 if fails else 0)
