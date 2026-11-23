#!/usr/bin/env python3
"""「開いているノートをAIに伝える」を、ビルドした本物のパネル（dist/panel.html）と、Codexアプリの代わりのページ
（test/browser/host-harness.mjs）で、Chromium を使って確かめる。

使い方: python3 -I test/browser/ai-context-check.py
先に npm run build を実行しておく（npm run test:browser は、このテストの前にビルドする）。
確かめること:
- 起動したときにオフなら、空の内容で1回上書きする
- スイッチを押すと保存され（/api/share）、ホストへノートの場所と選んだ行の番号が届く（本文は届かない）
- 標準の宣言（文字と structuredContent）、文字だけの宣言、OpenAI の印だけ、のどの受け方でも届く。文字だけなら structuredContent を外す
- 受けないホスト・断るホストでは「この画面では会話にノートを伝えられません」、空の上書きを断られたら「会話に伝えた内容を消せませんでした」
- 読み直し（フォーカス）とスイッチを押すのが重なっても、スイッチの表示が保存した値と合う
- 2つの画面で、片方でオフにすると、もう片方もノートの内容を送らず、空の内容で上書きする
- タブを閉じる前の知らせで、空の内容で上書きし、そのあとは読み直しや操作があってもノートの内容を送らない
- 空の上書きを断られたあと、フォーカスがなくてもノートを替えたときに送り直す
"""
import json, os, pathlib, shutil, subprocess, sys, tempfile, threading, time
from playwright.sync_api import sync_playwright

here = pathlib.Path(__file__).resolve().parent
pkg = here.parent.parent
panel_file = pkg / 'dist' / 'panel.html'
fails = []

def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:500]))
    if not ok: fails.append(name)

def wait_ready(srv, seconds=90):
    result = []
    reader = threading.Thread(target=lambda: result.append(srv.stdout.readline()), daemon=True)
    reader.start()
    reader.join(seconds)
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

def until(fn, seconds=15, what=''):
    end = time.time() + seconds
    while time.time() < end:
        try:
            value = fn()
        except Exception:
            value = None
        if value:
            return value
        time.sleep(0.1)
    raise TimeoutError(f'待ちきれませんでした: {what}')

def ctx(page):
    return page.evaluate('window.__ctx')

def notes_sent(page):
    return [u.get('structuredContent', {}).get('notePath') or u['content'][0]['text'] for u in ctx(page) if u.get('content')]

def is_clear(update):
    return not update.get('content')

def open_tab(context, port, mode):
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(f'http://127.0.0.1:{port}/?ctx={mode}')
    frame = panel_frame(page)
    P = page.frame_locator('#panel')
    until(lambda: frame.evaluate("document.querySelector('#files .files-row')"), 30, 'ファイルの一覧')
    return page, frame, P, errors

def open_note(P, frame, name):
    # フォルダーの行を押すと開閉が切り替わるので、目当てのノートがもう見えていれば押さない。
    visible = frame.evaluate(f"[...document.querySelectorAll('#files .files-row')].some((r) => r.textContent.includes({json.dumps(name)}))")
    if not visible:
        P.locator('#files .files-row', has_text='notes').first.click()
    until(lambda: frame.evaluate(f"[...document.querySelectorAll('#files .files-row')].some((r) => r.textContent.includes({json.dumps(name)}))"), what='フォルダーを開く')
    P.locator('#files .files-row', has_text=name).first.click()
    until(lambda: frame.evaluate(f"document.getElementById('note-path')?.textContent.includes({json.dumps(name.removesuffix('.md'))})"), what=f'{name} を開く')

def share_on(frame):
    return frame.evaluate("(async () => (await (await fetch('/api/share')).json()).on)()")

def press_switch(P, frame):
    # オンにするときは確かめの画面が出るので、「オンにする」を押す。
    # オフにするときに出るほかの画面（「消せませんでした」など）と取り違えないよう、押す前の状態で見分ける。
    turning_on = frame.evaluate("document.getElementById('ai-share-on').getAttribute('aria-pressed') !== 'true'")
    P.locator('#ai-share-on').click()
    time.sleep(0.2)
    if turning_on and frame.evaluate("Boolean(document.querySelector('dialog[open]'))"):
        text = frame.evaluate("document.querySelector('dialog[open]').textContent")
        check('オンにする前の確かめの画面に、ほかのタブの分が残ることがあると書いてある', 'ほかのタブの分は、そのタブを表示したときに消えることがあります' in text, text)
        P.locator('dialog[open] button', has_text='オンにする').click()

def switch(P, frame, on):
    box = P.locator('#ai-share-on')
    if (box.get_attribute('aria-pressed') == 'true') != on:
        press_switch(P, frame)
    until(lambda: share_on(frame) == on and not frame.evaluate("document.getElementById('ai-share-on').disabled"), what='スイッチの保存')

def note_text(frame):
    # 知らせは、スイッチのボタンの data-note（右上の小さな印）と title に出る。
    return frame.evaluate("document.getElementById('ai-share-on').dataset.note ?? ''")

def main():
    if not panel_file.exists():
        print('dist/panel.html がありません。先に npm run build を実行してください。')
        return 1
    work = pathlib.Path(tempfile.mkdtemp(prefix='ai-context-'))
    vault = work / 'vault'
    (vault / 'notes').mkdir(parents=True)
    for name in ['memo.md', 'other.md']:
        (vault / 'notes' / name).write_text(f'# {name}\n\n選ぶための文です。\n', encoding='utf-8', newline='\n')
    env = {**os.environ, 'NOTEDOCK_TRASH_DIR': str(work / 'trash')}
    srv = subprocess.Popen(['node', str(here / 'host-server.mjs'), str(vault), str(work / 'bak'), str(panel_file)],
                           stdout=subprocess.PIPE, text=True, env=env, cwd=str(pkg))
    try:
        port = wait_ready(srv)
        with sync_playwright() as p:
            browser = p.chromium.launch()
            context = browser.new_context(viewport={'width': 1200, 'height': 760}, locale='ja-JP')

            # 1. 起動したときにオフなら、空の内容で1回だけ上書きする。
            page, frame, P, errors = open_tab(context, port, 'standard')
            until(lambda: ctx(page), what='起動時の上書き')
            time.sleep(0.5)
            check('起動したときにオフなら、空の内容で1回だけ上書きする', [is_clear(u) for u in ctx(page)] == [True], ctx(page))

            # 2. スイッチを押すと保存され、ノートの場所と選んだ行の番号が届く。
            open_note(P, frame, 'memo.md')
            check('オフのあいだは、ノートを開いても内容を送らない', notes_sent(page) == [], ctx(page))
            switch(P, frame, True)
            until(lambda: notes_sent(page), what='オンにしたあとの送信')
            last = ctx(page)[-1]
            check('オンにすると、ノートの場所が structuredContent と文字の両方で届く',
                  last.get('structuredContent', {}).get('notePath') == 'notes/memo.md' and 'notes/memo.md' in last['content'][0]['text'], last)
            root0 = frame.evaluate("(async () => (await (await fetch('/api/health')).json()).rootPaths[0])()")
            check('オンにしたあとの内容に、試験用サーバーの Vault の場所が vaultRoot と文（「」つき）の両方で入る',
                  bool(root0) and last.get('structuredContent', {}).get('vaultRoot') == root0 and f'「{root0}」' in last['content'][0]['text'], [root0, last])
            frame.evaluate("(() => { const v = window.noteEditor.getView(); const l = v.state.doc.line(3); v.dispatch({ selection: { anchor: l.from, head: l.to } }) })()")
            until(lambda: ctx(page)[-1].get('structuredContent', {}).get('fromLine') == 3, what='選んだ行の番号の送信')
            last = ctx(page)[-1]
            check('選んだ行の番号が、少し間を置いて届き、本文は届かない',
                  last['structuredContent'].get('toLine') == 3 and '3行目' in last['content'][0]['text'] and '選ぶための文です' not in json.dumps(last, ensure_ascii=False), last)

            # 2b. 選んでいる行を書き換えで消したら（選び直さずに）、行番号のない内容で送り直す。
            frame.evaluate("(() => { const v = window.noteEditor.getView(); const l = v.state.doc.line(3); window.__lineText = v.state.doc.sliceString(l.from, l.to); v.dispatch({ changes: { from: l.from, to: l.to } }) })()")
            until(lambda: ctx(page)[-1].get('structuredContent', {}).get('fromLine') is None and not is_clear(ctx(page)[-1]), what='選択が消えたあとの送り直し')
            last = ctx(page)[-1]
            check('選んだ行を書き換えで消すと、行番号のない内容で送り直す（古い行番号が残らない）',
                  'fromLine' not in last['structuredContent'] and '行目' not in last['content'][0]['text'], last)
            frame.evaluate("(() => { const v = window.noteEditor.getView(); const l = v.state.doc.line(3); v.dispatch({ changes: { from: l.from, insert: window.__lineText } }) })()")
            time.sleep(0.7)

            # 3. 読み直しとスイッチを押すのが重なっても、表示と保存した値が合う。
            for _ in range(3):
                frame.evaluate("window.dispatchEvent(new Event('focus'))")
                press_switch(P, frame)
                frame.evaluate("window.dispatchEvent(new Event('focus'))")
                time.sleep(0.6)
                shown, saved = frame.evaluate("document.getElementById('ai-share-on').getAttribute('aria-pressed') === 'true'"), share_on(frame)
                check('読み直しとスイッチが重なっても、スイッチの表示が保存した値と合う', shown == saved, (shown, saved))
            switch(P, frame, True)

            # 4. 2つの画面：片方でオフにすると、もう片方もノートの内容を送らず、空の内容で上書きする。
            page2, frame2, P2, errors2 = open_tab(context, port, 'standard')
            until(lambda: frame2.evaluate("document.getElementById('ai-share-on').getAttribute('aria-pressed') === 'true'"), what='2つ目の画面がオン')
            # 数え始めは操作の前に控える（ほかのタブへの知らせが速く、操作の直後にはもう届いていることがある）。
            before = len(ctx(page))
            switch(P2, frame2, False)
            frame.evaluate("window.dispatchEvent(new Event('focus'))")
            until(lambda: len(ctx(page)) > before and is_clear(ctx(page)[-1]), what='1つ目の画面の空の上書き')
            check('ほかの画面でオフにすると、戻ってきたときに空の内容で上書きする', is_clear(ctx(page)[-1]), ctx(page)[before:])
            check('ほかの画面でオフにすると、スイッチの表示もオフになる', not frame.evaluate("document.getElementById('ai-share-on').getAttribute('aria-pressed') === 'true'"))
            # 読み直す前にノートを替えても、送る直前に確かめるので、内容は送らない。
            switch(P2, frame2, True)
            frame.evaluate("window.dispatchEvent(new Event('focus'))")
            until(lambda: frame.evaluate("document.getElementById('ai-share-on').getAttribute('aria-pressed') === 'true'"), what='1つ目の画面がオンに戻る')
            switch(P2, frame2, False)
            before = len(ctx(page))
            open_note(P, frame, 'other.md')
            time.sleep(0.8)
            check('ほかの画面でオフにされたあとは、ノートを替えても内容を送らない', all(is_clear(u) for u in ctx(page)[before:]), ctx(page)[before:])

            # ほかのタブからの知らせだけで（フォーカスなしで）、空の上書きが出る。
            def page1_on():
                return frame.evaluate("document.getElementById('ai-share-on').getAttribute('aria-pressed') === 'true'")
            # 操作の前に件数と時刻を控え（mark）、それより後に空の上書きが届くのを待つ（wait_clear）。
            def mark():
                return len(ctx(page)), time.time()
            def wait_clear(since, seconds, what):
                before, start = since
                try:
                    until(lambda: len(ctx(page)) > before and is_clear(ctx(page)[-1]), seconds, what)
                    return time.time() - start
                except TimeoutError:
                    return None
            # (a) BroadcastChannel：もう1つの画面のスイッチでオフにする。4秒おきの読み直しより早く届くこと。
            switch(P2, frame2, True)
            until(page1_on, 8, '1つ目の画面がオンになる（知らせか読み直しで）')
            time.sleep(0.5)
            since = mark()
            press_switch(P2, frame2)
            took = wait_clear(since, 2.5, 'BroadcastChannel の知らせでの空の上書き')
            check('ほかのタブの知らせ（BroadcastChannel）だけで、フォーカスなしに空の上書きが出る（4秒より早い）', took is not None, took)
            # (b) storage イベント：サーバーをオフにしてから localStorage に書く（BroadcastChannel は使わない）。
            switch(P2, frame2, True)
            until(page1_on, 8, '1つ目の画面がオンに戻る')
            time.sleep(0.5)
            since = mark()
            frame2.evaluate("""(async () => {
              const { rootId } = await (await fetch('/api/health')).json()
              // 書き込みには、パネルと同じく rootId を添える（サーバーは書き込みのたびに照合する）。
              await fetch('/api/share', { method: 'PUT', headers: { 'x-note-root': rootId }, body: JSON.stringify({ on: false }) })
              localStorage.setItem('notedock-share:' + rootId, JSON.stringify({ on: false, at: Date.now() }))
            })()""")
            took = wait_clear(since, 2.5, 'storage イベントでの空の上書き')
            check('ほかのタブの知らせ（storage イベント）だけで、フォーカスなしに空の上書きが出る（4秒より早い）', took is not None, took)
            # (c) 4秒おきの読み直し：知らせを出さずに、サーバーだけオフにする。
            # (b) ではサーバーだけをオフにしたので、2つ目の画面が読み直してボタンがオフになるのを待ってから押す。
            until(lambda: frame2.evaluate("document.getElementById('ai-share-on').getAttribute('aria-pressed') !== 'true'"), 8, '2つ目の画面のボタンがオフになる')
            switch(P2, frame2, True)
            until(page1_on, 8, '1つ目の画面がオンに戻る')
            time.sleep(0.5)
            since = mark()
            frame2.evaluate("(async () => { const { rootId } = await (await fetch('/api/health')).json(); await fetch('/api/share', { method: 'PUT', headers: { 'x-note-root': rootId }, body: JSON.stringify({ on: false }) }) })()")
            took = wait_clear(since, 7, '4秒おきの読み直しでの空の上書き')
            check('知らせがなくても、オンの間の4秒おきの読み直しで、フォーカスなしに空の上書きが出る', took is not None, took)
            page2.close()

            # 5. タブを閉じる前の知らせで、空の内容で上書きする。
            switch(P, frame, True)
            until(lambda: not is_clear(ctx(page)[-1]), what='オンの送信')
            page.evaluate('window.__teardown()')
            until(lambda: is_clear(ctx(page)[-1]), what='閉じる前の上書き')
            check('タブを閉じる前に、空の内容で上書きする', True)
            # 閉じたあとに読み直し（フォーカス）や範囲の選び直しがあっても、ノートの内容を送り直さない。
            before = len(ctx(page))
            frame.evaluate("window.dispatchEvent(new Event('focus'))")
            frame.evaluate("(() => { const v = window.noteEditor.getView(); v.dispatch({ selection: { anchor: 0, head: 3 } }) })()")
            time.sleep(1.2)
            check('タブを閉じる前の知らせのあとは、ノートの内容を送らない', all(is_clear(u) for u in ctx(page)[before:]), ctx(page)[before:])
            check('画面のエラーがない（標準の受け方）', not errors and not errors2, errors + errors2)
            page.close()

            # 6. 受け方の違い（共有の設定はオンのまま）。
            for mode, expect in [('textonly', 'text'), ('openai', 'both')]:
                page, frame, P, errors = open_tab(context, port, mode)
                open_note(P, frame, 'memo.md')
                until(lambda: notes_sent(page), what=f'{mode} の送信')
                last = ctx(page)[-1]
                ok = ('structuredContent' not in last) if expect == 'text' else last.get('structuredContent', {}).get('notePath') == 'notes/memo.md'
                check(f'受け方 {mode} でも届く（{"文字だけ" if expect == "text" else "OpenAI の経路"}）', ok and 'notes/memo.md' in last['content'][0]['text'], last)
                check(f'受け方 {mode} では、知らせを出さない', note_text(frame) == '', note_text(frame))
                page.close()

            for mode, message in [('none', 'この画面では会話にノートを伝えられません'), ('refuse', 'この画面では会話にノートを伝えられません')]:
                page, frame, P, errors = open_tab(context, port, mode)
                open_note(P, frame, 'memo.md')
                until(lambda: note_text(frame), what=f'{mode} の知らせ')
                check(f'受け方 {mode} では「{message}」と出る', note_text(frame) == message, note_text(frame))
                # 何も伝えていない画面なので、「残っているかもしれない」の知らせも確かめの画面も出さない（起動したときの空の上書きを断られても）。
                quiet = frame.evaluate("({ alert: document.getElementById('status-alert').hidden ? '' : document.getElementById('status-alert').textContent, dialogs: document.querySelectorAll('dialog[open]').length })")
                check(f'受け方 {mode} では、「⚠」の知らせも確かめの画面も出ない', quiet == {'alert': '', 'dialogs': 0}, quiet)
                logs = page.evaluate('window.__logs')
                check(f'受け方 {mode} では、断られたことをホストのログに残す', any('refused' in str(l.get('data')) for l in logs), logs)
                page.close()

            page, frame, P, errors = open_tab(context, port, 'refuseclear')
            open_note(P, frame, 'memo.md')
            until(lambda: notes_sent(page), what='送信')
            switch(P, frame, False)
            until(lambda: note_text(frame), what='消せなかった知らせ')
            check('空の上書きを断られたら「会話に伝えた内容を消せませんでした」と出る', note_text(frame) == '会話に伝えた内容を消せませんでした', note_text(frame))
            alert = frame.evaluate("(() => { const a = document.getElementById('status-alert'); return { text: a.hidden ? '' : a.textContent, title: a.title, role: a.getAttribute('role') } })()")
            check('消せなかったときは、状態の欄の先頭に短い知らせが文字で出る（全文は title、読み上げの対象）',
                  alert['text'] == '⚠ AIに残存の恐れ' and '会話に伝えた内容を消せませんでした' in alert['title'] and alert['role'] == 'status', alert)
            # 知らせを出した状態で、どの幅でも「⚠」の知らせが切れない（欄の中に収まり、欄の右端より内側）。
            for width in [1200, 760, 540, 420, 360]:
                page.set_viewport_size({'width': width, 'height': 760})
                time.sleep(0.3)
                fit = frame.evaluate("""(() => { const a = document.getElementById('status-alert'), s = document.getElementById('status')
                  const ar = a.getBoundingClientRect(), sr = s.getBoundingClientRect()
                  return { shown: !a.hidden, scroll: a.scrollWidth, client: a.clientWidth, alertRight: ar.right, statusRight: sr.right, statusScroll: s.scrollWidth, statusClient: s.clientWidth } })()""")
                ok = fit['shown'] and fit['scroll'] <= fit['client'] and fit['alertRight'] <= fit['statusRight'] + 0.5
                check(f'{width}px でも「⚠」の知らせが切れない', ok, fit)
            page.set_viewport_size({'width': 1200, 'height': 760})
            time.sleep(0.2)
            # 保存の状態が変わっても、知らせの文は書き換えない（読み直させない）。
            frame.evaluate("window.__alertChanges = 0; new MutationObserver(() => window.__alertChanges++).observe(document.getElementById('status-alert'), { childList: true, characterData: true, subtree: true })")
            frame.evaluate("(() => { const v = window.noteEditor.getView(); v.dispatch({ changes: { from: v.state.doc.length, insert: ' ' } }) })()")
            time.sleep(1.5)
            check('保存の状態が変わっても、知らせの文は書き換わらない', frame.evaluate('window.__alertChanges') == 0, frame.evaluate('window.__alertChanges'))
            # 確かめの画面が出ていれば閉じる。
            frame.evaluate("document.querySelectorAll('dialog[open]').forEach((d) => d.close())")
            before = len(ctx(page))
            frame.evaluate("window.dispatchEvent(new Event('focus'))")
            until(lambda: len(ctx(page)) > before, what='空の上書きの送り直し')
            check('戻ってきたとき、空の上書きを送り直す', is_clear(ctx(page)[-1]), ctx(page)[before:])
            # フォーカスがなくても、ノートを替えたときに空の上書きを送り直す。
            before = len(ctx(page))
            open_note(P, frame, 'other.md')
            until(lambda: len(ctx(page)) > before, what='ノートを替えたときの送り直し')
            check('フォーカスがなくても、ノートを替えたときに空の上書きを送り直す', all(is_clear(u) for u in ctx(page)[before:]), ctx(page)[before:])
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
