import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createBackups } from '../server/backups.mjs'
import { createFolder, listFolders, moveItem, planMove, trashItem } from '../server/fileops.mjs'

function vault(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fileops-')))
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  return root
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8')

test('フォルダーの一覧は、中身がないフォルダーも、どんな名前のフォルダーも出し、隠しフォルダーは出さない', () => {
  const root = vault({ 'a/x.md': '', '.obsidian/c.json': '{}', 'node_modules/m.md': '' })
  fs.mkdirSync(path.join(root, 'empty/inner'), { recursive: true })
  fs.mkdirSync(path.join(root, 'archives'))
  assert.deepEqual(listFolders(root), ['a', 'archives', 'empty', 'empty/inner'])
})

test('フォルダーを作る。すでにあるときと、上のフォルダーがないときは断る', () => {
  const root = vault({ 'a/x.md': '' })
  createFolder(root, 'a/new')
  assert.ok(fs.statSync(path.join(root, 'a/new')).isDirectory())
  assert.throws(() => createFolder(root, 'a/new'), { code: 'EEXIST' })
  assert.throws(() => createFolder(root, 'none/new'), { code: 'ENOENT' })
  assert.throws(() => createFolder(root, '.hidden'), /path not allowed/)
})

test('動かす前に、リンクを書き換えるノートを数える', () => {
  const root = vault({ 'a/x.md': '[上](../top.md)', 'top.md': '[[x]] [行く](a/x.md)', 'b/z.md': '[行く](../a/x.md)', 'c/none.md': 'なし' })
  const plan = planMove(root, 'a/x.md', 'b/x.md')
  assert.deepEqual(plan.changes.map((c) => c.from).sort(), ['b/z.md', 'top.md'], '動かしたノートの中の ../top.md は、b/ からでも同じ書き方で着くので変えない')
})

test('ノートを動かして、リンクを書き換え、前の本文をバックアップに残す', () => {
  const root = vault({ 'a/x.md': '[上](../top.md)', 'top.md': '[行く](a/x.md)', 'b/z.md': '' })
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileops-bak-'))
  const backups = createBackups(backupDir)
  const result = moveItem(root, 'a/x.md', 'b/x.md', { rewrite: true, backups })
  assert.equal(result.rewritten, 1)
  assert.ok(!fs.existsSync(path.join(root, 'a/x.md')))
  assert.equal(read(root, 'b/x.md'), '[上](../top.md)')
  assert.equal(read(root, 'top.md'), '[行く](b/x.md)')
  const kept = backups.list('top.md')
  assert.ok(kept.some((entry) => backups.read('top.md', entry.id) === '[行く](a/x.md)'), '書き換える前の本文が残っている')
})

test('書き換えないと選んだら、ノートだけを動かす', () => {
  const root = vault({ 'a/x.md': '[上](../top.md)', 'top.md': '[行く](a/x.md)', 'b/z.md': '' })
  moveItem(root, 'a/x.md', 'b/x.md', { rewrite: false })
  assert.equal(read(root, 'top.md'), '[行く](a/x.md)')
  assert.ok(fs.existsSync(path.join(root, 'b/x.md')))
})

test('フォルダーを動かすと、中のノートもリンクも一緒に直る', () => {
  const root = vault({ 'a/x.md': '[隣](y.md) [上](../top.md)', 'a/y.md': '', 'top.md': '[x](a/x.md)', 'b/z.md': '' })
  const result = moveItem(root, 'a', 'b/a', { rewrite: true })
  assert.equal(result.rewritten, 2)
  assert.equal(read(root, 'b/a/x.md'), '[隣](y.md) [上](../../top.md)')
  assert.equal(read(root, 'top.md'), '[x](b/a/x.md)')
})

test('行き先にすでに同じ名前があるとき、自分の中へ動かすとき、上のフォルダーがないときは断る', () => {
  const root = vault({ 'a/x.md': '', 'b/x.md': '' })
  assert.throws(() => moveItem(root, 'a/x.md', 'b/x.md', { rewrite: false }), { code: 'EEXIST' })
  assert.throws(() => moveItem(root, 'a', 'a/sub/a', { rewrite: false }), /path not allowed/)
  assert.throws(() => moveItem(root, 'a/x.md', 'none/x.md', { rewrite: false }), { code: 'ENOENT' })
  assert.throws(() => moveItem(root, 'a/x.md', 'b/.x.md', { rewrite: false }), /path not allowed/)
  assert.ok(fs.existsSync(path.join(root, 'a/x.md')))
})

test('大文字と小文字だけの名前の変更もできる', () => {
  const root = vault({ 'a/memo.md': '' })
  moveItem(root, 'a/memo.md', 'a/Memo.md', { rewrite: false })
  assert.deepEqual(fs.readdirSync(path.join(root, 'a')), ['Memo.md'])
})

test('ゴミ箱に移す。同じ名前があれば名前を変えて残す', () => {
  const root = vault({ 'a/x.md': '1', 'b/x.md': '2' })
  const trash = fs.mkdtempSync(path.join(os.tmpdir(), 'fileops-trash-'))
  const first = trashItem(root, 'a/x.md', { trashDir: trash })
  const second = trashItem(root, 'b/x.md', { trashDir: trash })
  assert.equal(path.basename(first), 'x.md')
  assert.notEqual(path.basename(second), 'x.md')
  assert.equal(fs.readFileSync(second, 'utf8'), '2')
  assert.ok(!fs.existsSync(path.join(root, 'a/x.md')))
  assert.throws(() => trashItem(root, '.obsidian', { trashDir: trash }), /path not allowed/)
})

test('別のファイルがあるところへは、大文字と小文字が違うだけの名前でも動かさない', () => {
  const root = vault({ 'a/x.md': '1', 'b/X.md': '2' })
  assert.throws(() => moveItem(root, 'a/x.md', 'b/x.md', { rewrite: false }), { code: 'EEXIST' })
  assert.equal(read(root, 'b/X.md'), '2')
})

test('書き換えられない形のノート（改行がCRLF）は飛ばさず、名前を返す', () => {
  const root = vault({ 'a/x.md': '', 'top.md': '[行く](a/x.md)\r\n', 'ok.md': '[行く](a/x.md)', 'b/z.md': '' })
  const plan = planMove(root, 'a/x.md', 'b/x.md')
  assert.deepEqual(plan.changes.map((c) => c.from), ['ok.md'])
  assert.deepEqual(plan.blocked, ['top.md'])
  const result = moveItem(root, 'a/x.md', 'b/x.md', { rewrite: true })
  assert.equal(result.rewritten, 1)
  assert.deepEqual(result.skipped, ['top.md'])
  assert.equal(read(root, 'top.md'), '[行く](a/x.md)\r\n')
})

test('動かしたノートの履歴も、新しい場所へ移す', () => {
  const root = vault({ 'a/x.md': '本文', 'b/z.md': '' })
  const backups = createBackups(fs.mkdtempSync(path.join(os.tmpdir(), 'fileops-bak-')))
  backups.save('a/x.md', '前の本文', 'previous')
  moveItem(root, 'a/x.md', 'b/x.md', { rewrite: true, backups })
  assert.equal(backups.list('b/x.md').length, 1)
  assert.equal(backups.list('a/x.md').length, 0)
})

test('画像などノート以外だけが入ったフォルダーも、何も入っていないフォルダーも出す', () => {
  const root = vault({ '図/a.png': 'png', 'mix/x.md': '', 'mix/b.png': 'png', 'deep/img/c.png': 'png' })
  fs.mkdirSync(path.join(root, '空'))
  fs.mkdirSync(path.join(root, 'deep/空の下'), { recursive: true })
  assert.deepEqual(listFolders(root), ['deep', 'deep/img', 'deep/空の下', 'mix', '図', '空'])
})

test('ゴミ箱へは、Macのtrashコマンドで移す（Finderの「戻す」が使える）', () => {
  const root = vault({ 'a/x.md': '1' })
  const calls = []
  trashItem(root, 'a/x.md', { run: (cmd, args) => { calls.push([cmd, args]); fs.rmSync(path.join(root, 'a/x.md')) } })
  assert.deepEqual(calls, [['/usr/bin/trash', [path.join(root, 'a/x.md')]]])
})

test('読めないノートは黙って飛ばさず、書き換えられないノートとして名前を返す', () => {
  const root = vault({ 'a/x.md': '', 'top.md': '[行く](a/x.md)', 'b/z.md': '' })
  fs.mkdirSync(path.join(root, 'dir.md'))
  fs.writeFileSync(path.join(root, 'locked.md'), '[行く](a/x.md)')
  fs.chmodSync(path.join(root, 'locked.md'), 0o000)
  const plan = planMove(root, 'a/x.md', 'b/x.md')
  fs.chmodSync(path.join(root, 'locked.md'), 0o644)
  assert.deepEqual(plan.blocked, ['locked.md'])
})

test('trashコマンドが動いても元の場所に残っていたら、移せなかったと知らせる', () => {
  const root = vault({ 'a/x.md': '1' })
  assert.throws(() => trashItem(root, 'a/x.md', { run: () => {} }), /still there/)
  assert.ok(fs.existsSync(path.join(root, 'a/x.md')))
})

test('別の場所を指すフォルダー（シンボリックリンク）は出さない', () => {
  const root = vault({ 'a/x.md': '' })
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fileops-out-'))
  fs.symlinkSync(outside, path.join(root, 'link'))
  assert.deepEqual(listFolders(root), ['a'])
})

test('Windowsでは、Vaultの一番上の .trash へ移す。同じ名前があれば名前を変えて残す', () => {
  const root = vault({ 'a/x.md': '1', 'b/x.md': '2', 'c/y.md': '3' })
  const run = () => { throw new Error('should not run a command') }
  trashItem(root, 'a/x.md', { run, platform: 'win32' })
  trashItem(root, 'b/x.md', { run, platform: 'win32' })
  trashItem(root, 'c', { run, platform: 'win32' })
  assert.deepEqual(fs.readdirSync(path.join(root, '.trash')).sort(), ['c', 'x 2.md', 'x.md'])
  assert.equal(fs.readFileSync(path.join(root, '.trash', 'x.md'), 'utf8'), '1')
  assert.equal(fs.readFileSync(path.join(root, '.trash', 'x 2.md'), 'utf8'), '2')
  assert.equal(fs.readFileSync(path.join(root, '.trash', 'c', 'y.md'), 'utf8'), '3')
  assert.ok(!fs.existsSync(path.join(root, 'a/x.md')))
  // .trash は一覧に出ず、エディターからは開けない
  assert.ok(!listFolders(root).includes('.trash'))
  assert.throws(() => trashItem(root, '.trash/x.md', { run, platform: 'win32' }), /path not allowed/)
})

test('Windowsで .trash がVaultの外を指すリンクなら、移さずに断る', () => {
  const root = vault({ 'a/x.md': '1' })
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fileops-outside-'))
  fs.symlinkSync(outside, path.join(root, '.trash'))
  assert.throws(() => trashItem(root, 'a/x.md', { platform: 'win32' }), /path not allowed/)
  assert.ok(fs.existsSync(path.join(root, 'a/x.md')))
  assert.deepEqual(fs.readdirSync(outside), [])
})

test('Windowsで .trash がファイルなら、移さずに断る', () => {
  const root = vault({ 'a/x.md': '1', '.trash': 'not a folder' })
  assert.throws(() => trashItem(root, 'a/x.md', { platform: 'win32' }), /path not allowed/)
  assert.ok(fs.existsSync(path.join(root, 'a/x.md')))
})

test('Macで trash コマンドが失敗したときは、今までどおりその失敗を知らせる', () => {
  const root = vault({ 'a/x.md': '1' })
  assert.throws(() => trashItem(root, 'a/x.md', { run: () => { throw new Error('trash failed') }, platform: 'darwin' }), /trash failed/)
})

test('ゴミ箱の置き場に大文字小文字だけ違う名前やフォルダーの同じ名前があっても、上書きせずに名前を変えて残す', () => {
  const root = vault({ 'a/X.md': 'new', 'b/c/y.md': 'inner' })
  const trash = fs.mkdtempSync(path.join(os.tmpdir(), 'fileops-trash-'))
  fs.writeFileSync(path.join(trash, 'x.md'), 'old')
  fs.mkdirSync(path.join(trash, 'c'))
  fs.writeFileSync(path.join(trash, 'c', 'keep.md'), 'keep')
  trashItem(root, 'a/X.md', { trashDir: trash })
  trashItem(root, 'b/c', { trashDir: trash })
  const names = fs.readdirSync(trash).sort()
  // 大文字小文字を区別しないファイルシステム（Mac、Windows）では X 2.md、区別するなら X.md になる
  const moved = names.find((name) => name !== 'x.md' && name.toLowerCase().startsWith('x'))
  assert.equal(fs.readFileSync(path.join(trash, moved), 'utf8'), 'new')
  assert.equal(fs.readFileSync(path.join(trash, 'x.md'), 'utf8'), 'old')
  assert.equal(fs.readFileSync(path.join(trash, 'c', 'keep.md'), 'utf8'), 'keep')
  assert.equal(fs.readFileSync(path.join(trash, 'c 2', 'y.md'), 'utf8'), 'inner')
})

test('ゴミ箱の置き場へ移せなかったときは、元のファイルを残し、押さえた空のファイルも残さない', () => {
  const root = vault({ 'a/x.md': '1' })
  const trash = fs.mkdtempSync(path.join(os.tmpdir(), 'fileops-trash-'))
  fs.chmodSync(path.join(root, 'a'), 0o555)
  try {
    assert.throws(() => trashItem(root, 'a/x.md', { trashDir: trash }))
  } finally {
    fs.chmodSync(path.join(root, 'a'), 0o755)
  }
  assert.equal(fs.readFileSync(path.join(root, 'a/x.md'), 'utf8'), '1')
  assert.deepEqual(fs.readdirSync(trash), [])
})
