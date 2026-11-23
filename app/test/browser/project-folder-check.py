#!/usr/bin/env python3
"""編集できるフォルダーの決め方を、ビルドした本物のパネル（dist/panel.html）で確かめる。

Codexアプリの代わりのページ（test/browser/host-harness.mjs）と、本物のサーバー（server/mcp.mjs）をつなぐ
test/browser/host-server.mjs を使う。会話の作業フォルダー（codex/sandbox-state の sandboxCwd）は、試験の途中で変えられる。
場面：プロジェクトの会話・プロジェクトなし・会話の前（/）・使ったことのあるフォルダー・NOTE_ROOT・リンク・広すぎる・worktree・
切り替え（読むだけ → 編集できる、黙って）・rootId が変わる。
ホームの代わりに一時的なフォルダーを使う（HOST_HOME）。本物のホーム・控えには触らない。

使い方: python3 -I test/browser/project-folder-check.py [画像を置くフォルダー]
先に npm run build を実行しておく（npm run test:browser は、この試験の前にビルドする）。
"""
import hashlib, json, os, pathlib, shutil, subprocess, sys, tempfile, threading, time, urllib.request
from playwright.sync_api import sync_playwright

here = pathlib.Path(__file__).resolve().parent
pkg = here.parent.parent
shots = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else None
panel_file = pkg / 'dist' / 'panel.html'
fails = []

def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:400]))
    if not ok: fails.append(name)

def shot(page, name):
    if shots:
        shots.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(shots / name))

def root_id(folder):
    return hashlib.sha256(os.path.realpath(folder).encode()).hexdigest()[:16]

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

def until(frame, js, seconds=15, what=''):
    end = time.time() + seconds
    value = None
    while time.time() < end:
        try:
            value = frame.evaluate(js)
        except Exception:
            value = None
        if value:
            return value
        time.sleep(0.1)
    raise TimeoutError(f'待ちきれませんでした: {what or js}')

def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8', newline='\n')
    return path

STATE = "document.getElementById('status').dataset.state"
BANNER = "(() => { const b = document.getElementById('banner'); return b.hidden ? '' : b.textContent })()"
STATUS_TEXT = "document.getElementById('status-text').textContent"

def scenario(name, prepare, fn, note_root=False, sandbox=None):
    work = pathlib.Path(tempfile.mkdtemp(prefix='project-folder-'))
    home = work / 'home'
    home.mkdir()
    vault = home / 'srv' / 'vault'
    vault.mkdir(parents=True)
    bak = work / 'bak'
    trash = work / 'trash'
    trash.mkdir()
    ctx = {'work': work, 'home': home, 'vault': vault, 'bak': bak}
    file = prepare(ctx)
    env = {**os.environ, 'NOTEDOCK_TRASH_DIR': str(trash), 'HOST_HOME': str(home), 'HOST_NO_DEFAULT_TAB': '1'}
    if not note_root: env['HOST_NO_NOTE_ROOT'] = '1'
    if sandbox: env['HOST_SANDBOX'] = str(sandbox(ctx)) if callable(sandbox) else sandbox
    srv = subprocess.Popen(['node', str(here / 'host-server.mjs'), str(vault), str(bak), str(panel_file)], stdout=subprocess.PIPE, text=True, env=env, cwd=str(pkg))
    try:
        port = wait_ready(srv)
        def set_sandbox(cwd):
            body = json.dumps({'cwd': None if cwd is None else str(cwd)}).encode()
            urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{port}/sandbox', data=body, method='POST')).read()
        ctx['set_sandbox'] = set_sandbox
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={'width': 1000, 'height': 640}, locale='ja-JP')
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{port}/?' + urllib.parse.urlencode({'file': str(file)}))
            frame = panel_frame(page)
            until(frame, "document.querySelector('.cm-content')", seconds=30, what='本文')
            until(frame, STATE, what='状態')
            ctx.update(page=page, frame=frame, P=page.frame_locator('#panel'))
            try:
                fn(ctx)
            except Exception as error:
                check(f'{name}：最後まで進む', False, repr(error))
                shot(page, f'pf-fail-{len(fails)}.png')
            check(f'{name}：画面のエラーがない', not errors, errors)
            browser.close()
    finally:
        srv.terminate()
        try:
            srv.wait(timeout=10)
        except subprocess.TimeoutExpired:
            srv.kill()
        shutil.rmtree(work, ignore_errors=True)

def type_and_save(ctx, text, note):
    P, page, frame = ctx['P'], ctx['page'], ctx['frame']
    P.locator('#modes').get_by_text('編集').click()
    P.locator('.cm-content').click()
    page.keyboard.press('ControlOrMeta+End')
    page.keyboard.type(text)
    end = time.time() + 10
    while time.time() < end:
        if text in note.read_text(encoding='utf-8') and frame.evaluate(STATE) == 'saved':
            return True
        time.sleep(0.1)
    return False

def editable(ctx, label):
    frame = ctx['frame']
    state = frame.evaluate(STATE)
    check(f'{label}：編集できる（保存済み）', state == 'saved', state)
    check(f'{label}：帯の説明は出ない', frame.evaluate(BANNER) == '', frame.evaluate(BANNER))

def view_only(ctx, label):
    frame = ctx['frame']
    state = frame.evaluate(STATE)
    check(f'{label}：読むだけ（状態の欄に小さな印「読むだけ」）', state == 'viewonly' and frame.evaluate(STATUS_TEXT) == '読むだけ', (state, frame.evaluate(STATUS_TEXT)))
    check(f'{label}：帯の説明は出ない', frame.evaluate(BANNER) == '', frame.evaluate(BANNER))
    check(f'{label}：ファイル欄にフォルダーの中を出さない', frame.evaluate("document.querySelectorAll('#files .files-row').length") == 0)

# 1. プロジェクトの会話：sandboxCwd の中のノートを編集し、保存すると記録を書く。
def project_prepare(ctx):
    return write(ctx['home'] / 'srv' / 'project' / 'docs' / 'n.md', '# プロジェクト\n\n本文\n')
def project_run(ctx):
    editable(ctx, 'プロジェクトの会話')
    shot(ctx['page'], 'pf-1-project-editable.png')
    note = ctx['home'] / 'srv' / 'project' / 'docs' / 'n.md'
    check('プロジェクトの会話：打った文字が保存される', type_and_save(ctx, '追記', note))
    record = ctx['bak'] / 'settings' / f"{root_id(ctx['home'] / 'srv' / 'project')}.root.json"
    check('プロジェクトの会話：保存すると「使ったことがある」の記録を書く', record.exists())

# 2. プロジェクトなし：作業フォルダーの中の .md は編集できる。外のノートは読むだけ。
def nowork_prepare(ctx):
    write(ctx['home'] / 'Documents' / 'Codex' / '2026-11-23' / 'talk' / 'memo.md', '# メモ\n')
    return write(ctx['vault'] / 'Home.md', '# ホーム\n\n本文\n')
def nowork_run(ctx):
    view_only(ctx, 'プロジェクトなしの会話で作業フォルダーの外のノート')
    shot(ctx['page'], 'pf-2-viewonly.png')
def nowork_inside_prepare(ctx):
    return write(ctx['home'] / 'Documents' / 'Codex' / '2026-11-23' / 'talk' / 'memo.md', '# メモ\n')
def nowork_inside_run(ctx):
    editable(ctx, 'プロジェクトなしの会話で作業フォルダーの中の .md')

# 3. 会話の前（/）で、使ったことがない → 読むだけ。フォルダーが届いたら黙って切り替わる。
def before_prepare(ctx):
    return write(ctx['vault'] / 'sub' / 'Home.md', '# ホーム\n\n' + '\n'.join(f'行{i}' for i in range(80)) + '\n')
def before_run(ctx):
    frame, page = ctx['frame'], ctx['page']
    view_only(ctx, '会話の前（/）')
    before_name = frame.evaluate("document.getElementById('note-path').textContent")
    # 会話が始まり、会話のフォルダーが届く。キーを押すと確かめが走る（そのキーは入らない）。
    ctx['set_sandbox'](ctx['vault'])
    frame.evaluate("document.querySelector('.cm-scroller').scrollTop = 400")
    page.keyboard.press('a')
    until(frame, f"{STATE} === 'saved'", seconds=10, what='黙って切り替わる')
    check('切り替え：会話が始まりフォルダーが届くと、黙って編集できる状態に切り替わる', frame.evaluate(STATE) == 'saved')
    check('切り替え：帯の説明は出ない', frame.evaluate(BANNER) == '', frame.evaluate(BANNER))
    check('切り替え：確かめの画面（ダイアログ）は出ない', not frame.evaluate("Boolean(document.querySelector('dialog[open]'))"))
    check('切り替え：最初のキーは本文に入らない', (ctx['vault'] / 'sub' / 'Home.md').read_text(encoding='utf-8').startswith('# ホーム\n\n行0'))
    check('切り替え：ファイル欄にフォルダーの中が出る', until(frame, "document.querySelectorAll('#files .files-row').length > 0", what='ファイル欄'))
    print('     切り替え前の名前:', before_name, ' 後:', frame.evaluate("document.getElementById('note-path').textContent"))
    shot(page, 'pf-3-switched.png')
    check('切り替え：次のキーから入り、保存される', type_and_save(ctx, '切り替えのあと', ctx['vault'] / 'sub' / 'Home.md'))

def before_timer_run(ctx):
    frame = ctx['frame']
    view_only(ctx, '会話の前（時計の確かめ）')
    ctx['set_sandbox'](ctx['vault'])
    # キーもフォーカスもなしで、読むだけのあいだの時計で切り替わる。
    until(frame, f"{STATE} === 'saved'", seconds=10, what='時計で切り替わる')
    check('切り替え：キーを押さなくても、読むだけのあいだの時計で切り替わる', frame.evaluate(STATE) == 'saved')

# 4. 使ったことのあるフォルダー：会話の前でも編集できる。
def used_prepare(ctx):
    settings = ctx['bak'] / 'settings'
    settings.mkdir(parents=True)
    (settings / f"{root_id(ctx['vault'])}.json").write_text('{}', encoding='utf-8')
    return write(ctx['vault'] / 'n.md', '# 使ったことのあるフォルダー\n')
def used_run(ctx):
    editable(ctx, '使ったことのあるフォルダー（会話の前）')

# 5. NOTE_ROOT：会話の前でも編集できる。
def noteroot_prepare(ctx):
    return write(ctx['vault'] / 'n.md', '# NOTE_ROOT\n')
def noteroot_run(ctx):
    editable(ctx, 'NOTE_ROOT（会話の前）')

# 6. リンク：実体側の sandboxCwd、リンク側の道で開いたノート。
def link_prepare(ctx):
    real = ctx['home'] / 'Library' / 'CloudStorage' / 'Dropbox-a'
    write(real / 'Vault' / 'n.md', '# リンク\n')
    (ctx['home'] / 'Dropbox').symlink_to(real)
    return ctx['home'] / 'Dropbox' / 'Vault' / 'n.md'
def link_run(ctx):
    editable(ctx, 'リンク（sandboxCwd は実体側、ノートはリンク側の道）')
    check('リンク：保存される', type_and_save(ctx, 'リンク越し', ctx['home'] / 'Library' / 'CloudStorage' / 'Dropbox-a' / 'Vault' / 'n.md'))

# 7. 広すぎる：ホームそのものが会話のフォルダー。
def broad_prepare(ctx):
    return write(ctx['home'] / 'notes' / 'n.md', '# 広すぎる\n')
def broad_run(ctx):
    view_only(ctx, '広すぎる（会話のフォルダーがホーム）')

# 8. worktree：個々の worktree は認め、worktrees のすぐ下は断る。
def worktree_prepare(ctx):
    return write(ctx['home'] / '.codex' / 'worktrees' / 'a1b2' / 'repo' / 'README.md', '# worktree\n')
def worktree_run(ctx):
    editable(ctx, 'worktree（~/.codex/worktrees/a1b2/repo）')
def worktree_broad_run(ctx):
    view_only(ctx, 'worktree のすぐ上（~/.codex/worktrees/a1b2）')

# 9. rootId が変わる：内側の会話で開いたまま、外側の会話のフォルダーが届く。
def rootid_prepare(ctx):
    return write(ctx['vault'] / 'inner' / 'n.md', '# 内側\n\n本文\n')
def rootid_run(ctx):
    frame = ctx['frame']
    editable(ctx, 'rootId が変わる前（内側）')
    crumb_before = frame.evaluate("document.getElementById('note-path').textContent")
    ctx['set_sandbox'](ctx['vault'])
    until(frame, "[...document.querySelectorAll('#files .files-row')].some((r) => r.textContent.includes('inner'))", seconds=10, what='受け取り直し')
    check('rootId が変わる：外側のフォルダーで受け取り直す（ファイル欄に inner が出る）', frame.evaluate("[...document.querySelectorAll('#files .files-row')].some((r) => r.textContent.includes('inner'))"))
    check('rootId が変わる：帯の説明は出ない', frame.evaluate(BANNER) == '', frame.evaluate(BANNER))
    check('rootId が変わる：保存済みのまま', frame.evaluate(STATE) == 'saved', frame.evaluate(STATE))
    print('     受け取り直す前:', crumb_before, ' 後:', frame.evaluate("document.getElementById('note-path').textContent"))
    shot(ctx['page'], 'pf-9-rootid.png')
    check('rootId が変わる：受け取り直したあとも保存できる', type_and_save(ctx, '外側で', ctx['vault'] / 'inner' / 'n.md'))
    record = ctx['bak'] / 'settings' / f"{root_id(ctx['vault'])}.root.json"
    check('rootId が変わる：外側で保存したので、外側の記録を書く', record.exists())

# 10. rootId が変わる：タブのノートから、ファイル欄で別のノートに移っていても、同じノートに留まり、タブのノートを上書きしない。
def rootid_other_prepare(ctx):
    write(ctx['vault'] / 'inner' / 'other.md', '# 別のノート\n\n本文\n')
    return write(ctx['vault'] / 'inner' / 'n.md', '# タブのノート\n\n本文\n')
def rootid_other_run(ctx):
    frame, P = ctx['frame'], ctx['P']
    P.locator('#files .files-row', has_text='other.md').first.click()
    until(frame, "document.getElementById('note-path')?.textContent.includes('other')", what='別のノートを開く')
    ctx['set_sandbox'](ctx['vault'])
    until(frame, "[...document.querySelectorAll('#files .files-row')].some((r) => r.textContent.includes('inner'))", seconds=10, what='受け取り直し')
    path_text = frame.evaluate("document.getElementById('note-path').textContent")
    check('rootId が変わる（別のノートを開いていた）：開いていたノートのまま受け取り直す', 'other' in path_text and 'inner' in path_text, path_text)
    check('rootId が変わる（別のノートを開いていた）：タブのノートは書き換わらない', (ctx['vault'] / 'inner' / 'n.md').read_text(encoding='utf-8') == '# タブのノート\n\n本文\n')
    check('rootId が変わる（別のノートを開いていた）：受け取り直したあとも保存できる', type_and_save(ctx, '別のノートに', ctx['vault'] / 'inner' / 'other.md'))
    check('rootId が変わる（別のノートを開いていた）：保存してもタブのノートは書き換わらない', (ctx['vault'] / 'inner' / 'n.md').read_text(encoding='utf-8') == '# タブのノート\n\n本文\n')

# 11. 編集できる → 読むだけ → 戻る：帯は出さず、打った中身を覚えたまま、戻れば保存する。
def back_prepare(ctx):
    return write(ctx['home'] / 'srv' / 'project' / 'n.md', '# 行き来\n\n本文\n')
def back_run(ctx):
    frame, P, page = ctx['frame'], ctx['P'], ctx['page']
    project = ctx['home'] / 'srv' / 'project'
    note = project / 'n.md'
    editable(ctx, '編集できる → 読むだけ（はじめ）')
    P.locator('#modes').get_by_text('編集').click()
    P.locator('.cm-content').click()
    page.keyboard.press('ControlOrMeta+End')
    ctx['set_sandbox']('/')
    page.keyboard.type('覚えておく')
    time.sleep(2.5)
    state = frame.evaluate(STATE)
    check('編集できる → 読むだけ：保存は通らず、未保存の小さな印のまま', state in ('dirty', 'saving') and '覚えておく' not in note.read_text(encoding='utf-8'), state)
    check('編集できる → 読むだけ：帯の説明は出ない', frame.evaluate(BANNER) == '', frame.evaluate(BANNER))
    shot(page, 'pf-11-unsaved.png')
    ctx['set_sandbox'](project)
    end = time.time() + 10
    while time.time() < end and '覚えておく' not in note.read_text(encoding='utf-8'):
        time.sleep(0.2)
    check('編集できる → 読むだけ → 戻る：戻れば、覚えていた中身を保存する', '覚えておく' in note.read_text(encoding='utf-8'))

def main():
    if not panel_file.exists():
        print('dist/panel.html がありません。先に npm run build を実行してください。')
        return 1
    scenario('プロジェクトの会話', project_prepare, project_run, sandbox=lambda c: c['home'] / 'srv' / 'project')
    scenario('プロジェクトなし（外）', nowork_prepare, nowork_run, sandbox=lambda c: c['home'] / 'Documents' / 'Codex' / '2026-11-23' / 'talk')
    scenario('プロジェクトなし（中）', nowork_inside_prepare, nowork_inside_run, sandbox=lambda c: c['home'] / 'Documents' / 'Codex' / '2026-11-23' / 'talk')
    scenario('会話の前（キー）', before_prepare, before_run, sandbox='/')
    scenario('会話の前（時計）', before_prepare, before_timer_run, sandbox='/')
    scenario('使ったことのあるフォルダー', used_prepare, used_run, sandbox='/')
    scenario('NOTE_ROOT', noteroot_prepare, noteroot_run, note_root=True, sandbox='/')
    scenario('リンク', link_prepare, link_run, sandbox=lambda c: c['home'] / 'Library' / 'CloudStorage' / 'Dropbox-a' / 'Vault')
    scenario('広すぎる', broad_prepare, broad_run, sandbox=lambda c: c['home'])
    scenario('worktree', worktree_prepare, worktree_run, sandbox=lambda c: c['home'] / '.codex' / 'worktrees' / 'a1b2' / 'repo')
    scenario('worktree のすぐ上', worktree_prepare, worktree_broad_run, sandbox=lambda c: c['home'] / '.codex' / 'worktrees' / 'a1b2')
    scenario('rootId が変わる', rootid_prepare, rootid_run, sandbox=lambda c: c['vault'] / 'inner')
    scenario('rootId が変わる（別のノート）', rootid_other_prepare, rootid_other_run, sandbox=lambda c: c['vault'] / 'inner')
    scenario('編集できる → 読むだけ → 戻る', back_prepare, back_run, sandbox=lambda c: c['home'] / 'srv' / 'project')
    print('合格' if not fails else '不合格: ' + ', '.join(fails))
    return 1 if fails else 0

import urllib.parse
sys.exit(main())
