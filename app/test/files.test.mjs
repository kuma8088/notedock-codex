import assert from 'node:assert/strict'
import { test } from 'node:test'

import { absolutePath, addRecentDir, ancestorsOf, breadcrumbParts, buildTree, checkNewNote, childFolders, searchFolders, defaultNoteDir, linkTargetFromPaste, newNotePath, noteFolders, resolvePasted, holdsPath, linkedNoteLines, touchesStoppedNote } from '../src/files.mjs'

test('フォルダーを先に、名前の順に並べる', () => {
  const tree = buildTree(['b.md', 'z/2.md', 'a/x.md', 'z/10.md', 'a/sub/y.md'])
  assert.deepEqual(tree.folders.map((f) => f.name), ['a', 'z'])
  assert.deepEqual(tree.files.map((f) => f.name), ['b.md'])
  assert.deepEqual(tree.folders[0].folders[0].files, [{ name: 'y.md', path: 'a/sub/y.md' }])
  assert.equal(tree.folders[0].folders[0].path, 'a/sub')
  assert.deepEqual(tree.folders[1].files.map((f) => f.name), ['2.md', '10.md'], '数字は数の順')
})

test('ノートの上のフォルダーを順に返す', () => {
  assert.deepEqual(ancestorsOf('a/b/c.md'), ['a', 'a/b'])
  assert.deepEqual(ancestorsOf('c.md'), [])
})

test('貼り付けたパスをVaultの中のノートへ直す', () => {
  const root = ['/Users/x/Vault']
  const notes = ['projects/a/README.md', 'projects/b/README.md', 'Home.md', 'docs/日本語 メモ.md']
  assert.equal(resolvePasted('projects/a/README.md', root, notes), 'projects/a/README.md')
  assert.equal(resolvePasted('/Users/x/Vault/projects/b/README.md', root, notes), 'projects/b/README.md')
  assert.equal(resolvePasted(' "/Users/x/Vault/Home.md" ', root, notes), 'Home.md')
  assert.equal(resolvePasted('file:///Users/x/Vault/docs/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%E3%83%A1%E3%83%A2.md', root, notes), 'docs/日本語 メモ.md')
  assert.equal(resolvePasted('/Users/x/Vault/Home.md:12', root, notes), 'Home.md', '行番号が付いていてもよい')
  assert.equal(resolvePasted('a/README.md', root, notes), 'projects/a/README.md', '途中からでも1つに決まれば開く')
  assert.equal(resolvePasted('README.md', root, notes), null, '1つに決まらなければ開かない')
  assert.equal(resolvePasted('/etc/passwd', root, notes), null)
  assert.equal(resolvePasted('メモ', root, notes), null, 'パスでなければ何もしない')
  assert.equal(resolvePasted('Home.md\nprojects/a/README.md', root, notes), null, '何行もある文字はパスとして扱わない')
  assert.equal(resolvePasted('Home.md\n', root, notes), 'Home.md', '末尾の改行はかまわない')
  assert.equal(resolvePasted('docs/日本語 メモ.md'.normalize('NFD'), root, notes), 'docs/日本語 メモ.md', '濁点の持ち方が違っても開く')
  assert.equal(resolvePasted('/Users/x/Vault/docs/日本語 メモ.md'.normalize('NFD'), root, ['docs/日本語 メモ.md'.normalize('NFD')]), 'docs/日本語 メモ.md'.normalize('NFD'), 'ファイル名の側が分解された形でも開く')
  // テスト用のコピーでは、元のVaultのパスを貼っても同じ場所のノートを開く。
  assert.equal(resolvePasted('/Users/x/Vault/Home.md', ['/tmp/copy', '/Users/x/Vault'], notes), 'Home.md')
  assert.equal(resolvePasted('/tmp/copy/Home.md', ['/tmp/copy', '/Users/x/Vault'], notes), 'Home.md')
  assert.equal(resolvePasted('/tmp/other/Home.md', ['/tmp/copy', '/Users/x/Vault'], notes), null)
  // セッションのフォルダーから見た相対パス。
  assert.equal(resolvePasted('../a/README.md', root, notes), 'projects/a/README.md')
  assert.equal(resolvePasted('./projects/b/README.md', root, notes), 'projects/b/README.md')
  assert.equal(resolvePasted('../README.md', root, notes), null, '1つに決まらなければ開かない')
  assert.equal(resolvePasted('../Home.md', root, ['Home.md', 'a/Home.md']), null, '上へ戻るパスは、一番上のノートも候補に入れて1つに決まるときだけ開く')
  assert.equal(resolvePasted('../../x/z.md', root, ['x/z.md']), 'x/z.md')
  assert.equal(resolvePasted('/Users/x/Vault/../secret.md', root, notes), null)
})

test('入力した名前から新しいノートの場所を作る', () => {
  assert.equal(newNotePath('メモ', 'Inbox'), 'Inbox/メモ.md')
  assert.equal(newNotePath('  メモ.md ', 'Inbox'), 'Inbox/メモ.md', '前後の空白と拡張子は付け直す')
  assert.equal(newNotePath('メモ.MD', 'Inbox'), 'Inbox/メモ.md')
  assert.equal(newNotePath('a:b\\c', 'Inbox'), 'Inbox/a-b-c.md', 'ファイル名に使えない文字は置き換える')
  assert.equal(newNotePath('', 'Inbox'), null)
  assert.equal(newNotePath('   ', 'Inbox'), null)
  assert.equal(newNotePath('.md', 'Inbox'), null, '名前が残らなければ作らない')
  assert.equal(newNotePath('.隠し', 'Inbox'), null, '点で始まる名前はサーバーが断るので出さない')
  assert.equal(newNotePath('a/b', 'Inbox'), null, 'パスのように見える文字からは作らない')
})

test('同じ場所に同じ名前のノートがあるときは、新しく作ると出さない', () => {
  const notes = ['Inbox/Memo.md', 'Inbox/がぎ.md'.normalize('NFD'), 'other/別.md']
  assert.equal(newNotePath('Memo', 'Inbox', notes), null)
  assert.equal(newNotePath('memo', 'Inbox', notes), null, 'Macでは大文字と小文字を区別しない')
  assert.equal(newNotePath('がぎ', 'Inbox', notes), null, '濁点の持ち方が違っても同じノート')
  assert.equal(newNotePath('別', 'Inbox', notes), 'Inbox/別.md', 'ほかのフォルダーの同じ名前は別のノート')
})

test('一番上のフォルダーに作るときは、先頭に「/」を付けない', () => {
  assert.equal(newNotePath('メモ', ''), 'メモ.md')
  assert.equal(newNotePath('メモ', '', ['メモ.md']), null)
})

test('新しいノートを置ける場所は、ノートのあるフォルダーとその上のフォルダー', () => {
  const notes = ['top.md', '日記/2026/11/今日.md', '日記/まとめ.md', 'b/x.md']
  assert.deepEqual(noteFolders(notes), ['', 'b', '日記', '日記/2026', '日記/2026/11'])
  assert.deepEqual(noteFolders([]), [''], 'ノートがなくても一番上には置ける')
})

test('最初に選んでおく場所は、いま開いているノートのフォルダー', () => {
  const folders = ['', '日記', '日記/2026']
  assert.equal(defaultNoteDir('日記/2026/今日.md', folders), '日記/2026')
  assert.equal(defaultNoteDir('top.md', folders), '', '一番上のノートなら一番上')
  assert.equal(defaultNoteDir('データ/今日.md'.normalize('NFD'), ['', 'データ']), 'データ', '濁点の持ち方が違っても同じフォルダー')
  assert.equal(defaultNoteDir(null, folders), '', 'ノートを開いていなければ一番上')
  assert.equal(defaultNoteDir('__outside__/x.md', folders), '', 'フォルダーの外のノートなら一番上')
  assert.equal(defaultNoteDir('消えたフォルダー/old.md', folders), '', '一覧にないフォルダーのノートなら一番上')
})

test('名前と場所を確かめて、作るノートか、作れない理由を返す', () => {
  const notes = ['日記/メモ.md']
  assert.deepEqual(checkNewNote(' 新しい ', '日記', notes), { path: '日記/新しい.md' })
  assert.deepEqual(checkNewNote('', '日記', notes), { error: '名前を入れてください。' })
  assert.deepEqual(checkNewNote('a/b', '日記', notes), { error: '名前に「/」は使えません。場所は下で選んでください。' })
  assert.deepEqual(checkNewNote('.隠し', '日記', notes), { error: '点で始まる名前は使えません。' })
  assert.deepEqual(checkNewNote('メモ', '日記', notes), { error: 'この場所には同じ名前のノートがあります。' })
  assert.deepEqual(checkNewNote('メモ', '', notes), { path: 'メモ.md' })
})

test('今のノートのパスを、フォルダーの場所からその場で作る', () => {
  assert.equal(absolutePath(['/Users/a/notes'], '日記/今日.md'), '/Users/a/notes/日記/今日.md')
  assert.equal(absolutePath([], '日記/今日.md'), null, 'フォルダーの場所が分からなければ作らない')
  assert.equal(absolutePath(['/Users/a/notes'], '__outside__/外.md'), null, 'フォルダーの外のノートは作らない')
  assert.equal(absolutePath(['/Users/a/notes'], null), null)
})

test('リンクの括弧の中に貼った絶対パスは、今のノートからの相対パスに直す', () => {
  const where = { rootPaths: ['/Users/me/vault'], notes: ['日記/x.md', 'a/b.md', 'メモ (1).md'], currentPath: 'a/b.md' }
  assert.equal(linkTargetFromPaste('見て [a](', '/Users/me/vault/日記/x.md', where), '../日記/x.md')
  assert.equal(linkTargetFromPaste('[a](', 'file:///Users/me/vault/日記/x.md', where), '../日記/x.md')
  assert.equal(linkTargetFromPaste('[a](', '/Users/me/vault/メモ (1).md', where), '../メモ%20%281%29.md', '空白や括弧は書き換える')
})

test('リンクの括弧の外や、フォルダーの外のパスは、そのまま貼る', () => {
  const where = { rootPaths: ['/Users/me/vault'], notes: ['日記/x.md'], currentPath: 'a/b.md' }
  assert.equal(linkTargetFromPaste('ふつうの文 ', '/Users/me/vault/日記/x.md', where), null)
  assert.equal(linkTargetFromPaste('[a](done) ', '/Users/me/vault/日記/x.md', where), null)
  assert.equal(linkTargetFromPaste('[a](', '/Users/other/x.md', where), null)
  assert.equal(linkTargetFromPaste('[a](', '日記/x.md', where), null, '相対パスは書いたとおりに残す')
  assert.equal(linkTargetFromPaste('[a](', '/Users/me/vault/ない.md', where), null)
})

test('パンくずリストは、一番上のフォルダー、途中のフォルダー、ノートの名前の順に並べる', () => {
  assert.deepEqual(breadcrumbParts('日記/2026/今日.md', 'notes'), [
    { label: 'notes', folder: '' },
    { label: '日記', folder: '日記' },
    { label: '2026', folder: '日記/2026' },
    { label: '今日.md', folder: null },
  ])
  assert.deepEqual(breadcrumbParts('top.md', 'notes'), [{ label: 'notes', folder: '' }, { label: 'top.md', folder: null }])
})

test('フォルダーの外のノートは、名前だけを出して、フォルダーへは動かない', () => {
  assert.deepEqual(breadcrumbParts('__outside__/x.md', 'notes'), [{ label: 'x.md', folder: null }])
  assert.deepEqual(breadcrumbParts(null, 'notes'), [])
})

test('場所選びでは、今いる場所の1つ下のフォルダーだけを並べる', () => {
  const folders = ['', 'a', 'a/b', 'a/b/c', 'a/d', 'z']
  assert.deepEqual(childFolders(folders, ''), ['a', 'z'])
  assert.deepEqual(childFolders(folders, 'a'), ['a/b', 'a/d'])
  assert.deepEqual(childFolders(folders, 'a/b/c'), [], 'いちばん下なら空')
})

test('フォルダーの名前で、どの階層からでも探す', () => {
  const folders = ['', 'Periodic', 'Periodic/FY2021', 'Periodic/FY2021/2021-05', 'projects', 'projects/2021-05-memo', 'データ']
  assert.deepEqual(searchFolders(folders, '2021-05'), ['Periodic/FY2021/2021-05', 'projects/2021-05-memo'])
  assert.deepEqual(searchFolders(folders, 'fy2021'), ['Periodic/FY2021'], '大文字と小文字を区別しない')
  assert.deepEqual(searchFolders(folders, 'データ'.normalize('NFD')), ['データ'], '濁点の持ち方が違っても見つける')
  assert.deepEqual(searchFolders(folders, '  '), [], '空なら何も出さない')
  assert.deepEqual(searchFolders(folders, 'periodic'), ['Periodic'], 'フォルダーの名前に含むものだけ。上のフォルダーの名前では出さない')
})

test('最近ノートを作った場所は、新しい順に5つまで残す', () => {
  assert.deepEqual(addRecentDir([], 'a'), ['a'])
  assert.deepEqual(addRecentDir(['a', 'b'], 'b'), ['b', 'a'], '同じ場所は先頭へ動かす')
  assert.deepEqual(addRecentDir(['1', '2', '3', '4', '5'], '6'), ['6', '1', '2', '3', '4'])
  assert.deepEqual(addRecentDir(['a'], ''), ['', 'a'], '一番上も残す')
})

test('ファイル欄の木には、中身のないフォルダーも入れる', () => {
  const tree = buildTree(['a/x.md'], ['a', 'a/空', 'z', 'z/中'])
  assert.deepEqual(tree.folders.map((f) => f.name), ['a', 'z'])
  assert.deepEqual(tree.folders[0].folders.map((f) => f.path), ['a/空'])
  assert.deepEqual(tree.folders[1].folders.map((f) => f.path), ['z/中'])
  assert.deepEqual(tree.folders[1].files, [])
})

// 自動保存を止めている間に開いているノートを動かすと、未保存の入力が画面から消える。
test('自動保存を止めている間は、開いているノートとそれが入っているフォルダーを動かさない', () => {
  assert.equal(touchesStoppedNote('a/b.md', 'a/b.md', 'conflict'), true)
  assert.equal(touchesStoppedNote('a/b.md', 'a', 'conflict'), true)
  assert.equal(touchesStoppedNote('a/b.md', 'a', 'removed'), true)
  assert.equal(touchesStoppedNote('a/b.md', 'ab', 'conflict'), false, '名前の前が同じだけのフォルダーは別')
  assert.equal(touchesStoppedNote('a/b.md', 'c.md', 'conflict'), false)
  assert.equal(touchesStoppedNote('a/b.md', 'a/b.md', null), false)
  assert.equal(touchesStoppedNote(null, 'a/b.md', 'conflict'), false)
  assert.equal(touchesStoppedNote('A/B.md', 'a', 'conflict'), true, '大文字と小文字の違いは同じとみなす（Macのフォルダーと同じ）')
  assert.equal(touchesStoppedNote('テ\u3099ータ/b.md', 'データ', 'conflict'), true, '濁点の持ち方の違いは同じとみなす')
})

test('開いているノートを含むかは、綴りの違いを同じとみなし、止まっていなくても判定する', () => {
  assert.equal(holdsPath('A/B.md', 'a/b.md'), true)
  assert.equal(holdsPath('a/b.md', 'ab'), false)
  assert.equal(holdsPath(null, 'a'), false)
})

// リンクを書き換える前に、どのノートを書き換えるかを名前で見せる。
test('リンクを書き換えるノートを名前で並べ、多いときは残りの件数を出す', () => {
  assert.deepEqual(linkedNoteLines(['a.md', 'b/c.md']), ['リンクを書き換えるノート（2件）：', 'a.md', 'b/c.md'])
  const many = Array.from({ length: 12 }, (_, i) => `n${i}.md`)
  const lines = linkedNoteLines(many)
  assert.equal(lines[0], 'リンクを書き換えるノート（12件）：')
  assert.equal(lines.length, 1 + 10 + 1)
  assert.equal(lines.at(-1), 'ほか2件')
  assert.deepEqual(linkedNoteLines([]), [])
})
