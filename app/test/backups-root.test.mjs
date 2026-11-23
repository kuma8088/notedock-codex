import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createCore } from '../server/core.mjs'

// 控えを、どのフォルダーのノートかで分ける。
// 2つのフォルダーに同じ名前のノートがあっても、「履歴」にほかのフォルダーの中身が出ないように。

const scope = { editable: true, opened: null }

function makeRoot(prefix, text) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  fs.writeFileSync(path.join(root, 'a.md'), text)
  return root
}

function save(core, text) {
  const got = core.request('GET', '/api/note?path=a.md', undefined, scope)
  const put = core.request('PUT', '/api/note?path=a.md', { text, baseHash: got.data.hash }, scope)
  assert.equal(put.status, 200)
}

const history = (core) => core.request('GET', '/api/backups?path=a.md', undefined, scope).data.backups
const readBackup = (core, id) => core.request('GET', `/api/backup?path=a.md&id=${encodeURIComponent(id)}`, undefined, scope)

test('2つのフォルダーの同じ名前のノートは、控えが混ざらない', () => {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bak-'))
  const one = createCore({ root: makeRoot('root-one-', 'ONE\n'), backupDir })
  const two = createCore({ root: makeRoot('root-two-', 'TWO\n'), backupDir })
  save(one, 'ONE changed\n')
  save(two, 'TWO changed\n')
  const texts = (core) => history(core).map((entry) => readBackup(core, entry.id).data.text)
  assert.ok(texts(one).length > 0)
  assert.ok(texts(one).every((text) => text.startsWith('ONE')), JSON.stringify(texts(one)))
  assert.ok(texts(two).every((text) => text.startsWith('TWO')), JSON.stringify(texts(two)))
  // ほかのフォルダーの控えの名前を指定しても、ほかのフォルダーの中身は読めない
  for (const entry of history(two)) {
    const got = readBackup(one, entry.id)
    assert.ok(got.status === 404 || got.data.text.startsWith('ONE'), JSON.stringify(got))
  }
})

test('控えは、フォルダーごとの目印（rootId）の下に置く', () => {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bak-'))
  const core = createCore({ root: makeRoot('root-id-', 'X\n'), backupDir })
  save(core, 'Y\n')
  assert.deepEqual(fs.readdirSync(backupDir), [core.rootId])
})

test('前の置き方（目印なし）の控えは、新しい「履歴」には出さず、期限が来たら片付ける', () => {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bak-'))
  // 前の置き方は、控えの場所の直下に、ノートの場所から作った名前のフォルダーを置いていた
  const legacy = path.join(backupDir, crypto.createHash('sha1').update('a.md').digest('hex').slice(0, 20))
  fs.mkdirSync(legacy)
  fs.writeFileSync(path.join(legacy, '_path.txt'), 'a.md')
  const old = Date.now() - 30 * 24 * 60 * 60 * 1000
  const fresh = Date.now() - 60 * 1000
  fs.writeFileSync(path.join(legacy, `snapshot-${old}-1.md`), 'OLD\n')
  fs.writeFileSync(path.join(legacy, `snapshot-${fresh}-2.md`), 'FRESH\n')
  const core = createCore({ root: makeRoot('root-legacy-', 'X\n'), backupDir })
  core.prune()
  assert.deepEqual(history(core), [])
  assert.deepEqual(fs.readdirSync(legacy).sort(), ['_path.txt', `snapshot-${fresh}-2.md`])
})

test('同じノートを大文字小文字の違う名前で開いても、控えは同じ「履歴」に入る（大文字小文字を区別しないドライブ）', () => {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bak-'))
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'root-case-')))
  fs.mkdirSync(path.join(root, 'Notes'))
  fs.writeFileSync(path.join(root, 'Notes', 'Guide.md'), 'v1\n')
  const probe = path.join(root, 'notes', 'guide.md')
  if (!fs.existsSync(probe)) return // 大文字小文字を区別するドライブでは試せない
  const core = createCore({ root, backupDir })
  const saveAs = (rel, text) => {
    const got = core.request('GET', `/api/note?path=${encodeURIComponent(rel)}`, undefined, scope)
    assert.equal(core.request('PUT', `/api/note?path=${encodeURIComponent(rel)}`, { text, baseHash: got.data.hash }, scope).status, 200)
  }
  saveAs('notes/guide.md', 'v2\n')
  saveAs('Notes/Guide.md', 'v3\n')
  const list = (rel) => core.request('GET', `/api/backups?path=${encodeURIComponent(rel)}`, undefined, scope).data.backups
  assert.equal(list('Notes/Guide.md').length, list('NOTES/GUIDE.md').length)
  assert.ok(list('Notes/Guide.md').length >= 2)
})

test('濁点の書き方が違う名前で開いても、控えは同じ「履歴」に入る', () => {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bak-'))
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'root-nfd-')))
  const nfc = 'ガイド.md'.normalize('NFC')
  const nfd = 'ガイド.md'.normalize('NFD')
  fs.writeFileSync(path.join(root, nfc), 'v1\n')
  if (!fs.existsSync(path.join(root, nfd))) return // 書き方の違いを区別するドライブでは試せない
  const core = createCore({ root, backupDir })
  const got = core.request('GET', `/api/note?path=${encodeURIComponent(nfd)}`, undefined, scope)
  core.request('PUT', `/api/note?path=${encodeURIComponent(nfd)}`, { text: 'v2\n', baseHash: got.data.hash }, scope)
  const list = (rel) => core.request('GET', `/api/backups?path=${encodeURIComponent(rel)}`, undefined, scope).data.backups
  assert.ok(list(nfc).length >= 1)
  assert.equal(list(nfc).length, list(nfd).length)
})

test('フォルダーの目印は、設定の大文字小文字の書き方やリンクを通しても同じ', () => {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bak-'))
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'root-spell-')))
  const root = path.join(parent, 'Vault')
  fs.mkdirSync(root)
  const id = createCore({ root, backupDir }).rootId
  const link = path.join(parent, 'link')
  fs.symlinkSync(root, link)
  assert.equal(createCore({ root: link, backupDir }).rootId, id)
  if (fs.existsSync(path.join(parent, 'vault'))) assert.equal(createCore({ root: path.join(parent, 'vault'), backupDir }).rootId, id)
})

test('ほかのフォルダーの目印の下の古い控えも、期限が来たら片付け、空になったフォルダーも消す。新しい控えは残す', () => {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bak-'))
  const old = Date.now() - 30 * 24 * 60 * 60 * 1000
  const orphan = path.join(backupDir, 'abcdefabcdefabcd', '0123456789abcdef0123')
  fs.mkdirSync(orphan, { recursive: true })
  fs.writeFileSync(path.join(orphan, '_path.txt'), 'gone.md')
  fs.writeFileSync(path.join(orphan, `snapshot-${old}-1.md`), 'OLD\n')
  const core = createCore({ root: makeRoot('root-orphan-', 'X\n'), backupDir })
  save(core, 'Y\n')
  core.prune()
  assert.ok(!fs.existsSync(path.join(backupDir, 'abcdefabcdefabcd')))
  assert.ok(history(core).length > 0)
  assert.deepEqual(fs.readdirSync(backupDir), [core.rootId])
})

test('ノートを動かすと、履歴も新しい場所へ移る（目印の下で）', () => {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bak-'))
  const root = makeRoot('root-move-', 'X\n')
  fs.mkdirSync(path.join(root, 'sub'))
  const core = createCore({ root, backupDir })
  save(core, 'Y\n')
  const before = history(core).length
  assert.equal(core.request('POST', '/api/move', { from: 'a.md', to: 'sub/a.md', rewrite: false }, scope).status, 200)
  const moved = core.request('GET', '/api/backups?path=sub/a.md', undefined, scope).data.backups
  assert.equal(moved.length, before)
})

test('大文字小文字だけを変える名前の変更でも、履歴は新しい名前についてくる（ノートとフォルダー）', () => {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bak-'))
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'root-recase-')))
  fs.writeFileSync(path.join(root, 'note.md'), 'v1\n')
  fs.mkdirSync(path.join(root, 'dir'))
  fs.writeFileSync(path.join(root, 'dir', 'x.md'), 'v1\n')
  if (!fs.existsSync(path.join(root, 'NOTE.md'))) return // 大文字小文字を区別するドライブでは試せない
  const core = createCore({ root, backupDir })
  const saveAt = (rel, text) => {
    const got = core.request('GET', `/api/note?path=${encodeURIComponent(rel)}`, undefined, scope)
    assert.equal(core.request('PUT', `/api/note?path=${encodeURIComponent(rel)}`, { text, baseHash: got.data.hash }, scope).status, 200)
  }
  const list = (rel) => core.request('GET', `/api/backups?path=${encodeURIComponent(rel)}`, undefined, scope).data.backups
  saveAt('note.md', 'v2\n')
  saveAt('dir/x.md', 'v2\n')
  const noteBefore = list('note.md').length
  const dirBefore = list('dir/x.md').length
  assert.ok(noteBefore > 0 && dirBefore > 0)
  assert.equal(core.request('POST', '/api/move', { from: 'note.md', to: 'Note.md', rewrite: false }, scope).status, 200)
  assert.equal(core.request('POST', '/api/move', { from: 'dir', to: 'Dir', rewrite: false }, scope).status, 200)
  assert.equal(list('Note.md').length, noteBefore)
  assert.equal(list('Dir/x.md').length, dirBefore)
})

test('片付けの途中でフォルダーが消えても（もう1つのエディターが同時に片付けた）、止まらない', async () => {
  const { createBackups } = await import('../server/backups.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bak-'))
  const old = Date.now() - 30 * 24 * 60 * 60 * 1000
  for (const name of ['aaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbb']) {
    fs.mkdirSync(path.join(dir, name))
    fs.writeFileSync(path.join(dir, name, '_path.txt'), `${name}.md`)
    fs.writeFileSync(path.join(dir, name, `snapshot-${old}-1.md`), 'OLD\n')
  }
  // 1つ目を片付けている途中で、2つ目が消えたことにする
  const realRm = fs.rmSync
  let first = true
  fs.rmSync = (target, options) => {
    if (first) {
      first = false
      realRm(path.join(dir, 'bbbbbbbbbbbbbbbbbbbb'), { recursive: true, force: true })
    }
    return realRm(target, options)
  }
  try {
    assert.doesNotThrow(() => createBackups(dir).prune())
  } finally {
    fs.rmSync = realRm
  }
})

test('片付けの途中で、ほかのサーバーが同じノートの控えを書いても、その控えを消さない', async () => {
  const { createBackups } = await import('../server/backups.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-race-'))
  const folder = path.join(dir, 'note')
  fs.mkdirSync(folder)
  fs.writeFileSync(path.join(folder, '_path.txt'), 'a.md')
  const fresh = path.join(folder, `previous-${Date.now()}-1.md`)
  // 片付けが「_path.txt だけ」と読んだ直後に、ほかのサーバーが控えを書いた、という順番を作る。
  const realReaddir = fs.readdirSync
  let injected = false
  let reads = 0
  fs.readdirSync = (target, ...rest) => {
    const names = realReaddir(target, ...rest)
    // 2回目は、期限切れを消したあとで「残りは _path.txt だけか」を見る読み込み。
    if (target === folder && ++reads === 2 && names.length === 1) {
      injected = true
      fs.writeFileSync(fresh, 'new')
    }
    return names
  }
  try {
    createBackups(dir).prune()
  } finally {
    fs.readdirSync = realReaddir
  }
  assert.equal(injected, true)
  assert.equal(fs.readFileSync(fresh, 'utf8'), 'new')
})

test('中身が空になったノートの控えのフォルダーも片付ける', async () => {
  const { createBackups } = await import('../server/backups.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-empty-'))
  fs.mkdirSync(path.join(dir, 'empty'))
  createBackups(dir).prune()
  assert.equal(fs.existsSync(path.join(dir, 'empty')), false)
})

test('控えを書く直前に、ほかのサーバーがそのフォルダーを片付けても、作り直して書く', async () => {
  const { createBackups } = await import('../server/backups.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'save-race-'))
  const store = createBackups(dir)
  const realWrite = fs.writeFileSync
  let removed = false
  fs.writeFileSync = (file, ...rest) => {
    if (!removed && typeof file === 'string' && /previous-\d+-\d+\.md$/.test(file)) {
      removed = true
      fs.rmSync(path.dirname(file), { recursive: true, force: true })
    }
    return realWrite(file, ...rest)
  }
  try {
    store.save('a.md', 'text', 'previous')
  } finally {
    fs.writeFileSync = realWrite
  }
  assert.equal(removed, true)
  assert.deepEqual(store.list('a.md').map((b) => b.kind), ['previous'])
})

test('いちばん新しい控えを読み比べる直前に、それが片付けられても、保存は止まらない', async () => {
  const { createBackups } = await import('../server/backups.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'save-compare-'))
  const store = createBackups(dir)
  store.save('a.md', 'one', 'previous')
  const realRead = fs.readFileSync
  let gone = false
  fs.readFileSync = (file, ...rest) => {
    if (!gone && typeof file === 'string' && /previous-\d+-\d+\.md$/.test(file)) {
      gone = true
      throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    }
    return realRead(file, ...rest)
  }
  try {
    assert.doesNotThrow(() => store.save('a.md', 'two', 'previous'))
  } finally {
    fs.readFileSync = realRead
  }
  assert.equal(gone, true)
})
