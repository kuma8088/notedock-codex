// 安全のための小さな修正：大きさの上限、一時ファイル、ゴミ箱のコマンドがないとき。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createCore } from '../server/core.mjs'
import { trashItem } from '../server/fileops.mjs'
import { MAX_NOTE_BYTES } from '../server/notes.mjs'

const editable = { editable: true, opened: null }

function setup(files = { 'a.md': 'x\n' }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'limits-root-')))
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'limits-aux-'))
  const core = createCore({ root, backupDir })
  const call = (method, url, body) => core.request(method, url, body, editable)
  const files_ = (dir) => fs.readdirSync(dir, { recursive: true }).filter((n) => fs.statSync(path.join(dir, n)).isFile())
  return { root, backupDir, call, files: files_ }
}

test('20MBを超える本文は保存せず、控えも残さず、ノートも変えない', () => {
  const { root, backupDir, call, files } = setup()
  const { data: note } = call('GET', '/api/note?path=a.md')
  const before = files(backupDir).length
  const big = 'あ'.repeat(Math.floor(MAX_NOTE_BYTES / 3) + 1)
  assert.equal(call('PUT', '/api/note?path=a.md', { text: big, baseHash: note.hash }).status, 413)
  assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'x\n')
  assert.equal(files(backupDir).length, before)
  // 上限ちょうどは保存できる。
  const edge = 'a'.repeat(MAX_NOTE_BYTES)
  assert.equal(call('PUT', '/api/note?path=a.md', { text: edge, baseHash: note.hash }).status, 200)
})

test('20MBを超えるノートは、初めから編集できない状態で開く', () => {
  const { root, call } = setup()
  fs.writeFileSync(path.join(root, 'big.md'), Buffer.alloc(MAX_NOTE_BYTES + 1, 0x61))
  const { status, data } = call('GET', '/api/note?path=big.md')
  assert.equal(status, 200)
  assert.equal(data.editable, false)
  assert.equal(data.reason, 'too-large')
  assert.equal(call('PUT', '/api/note?path=big.md', { text: 'a', baseHash: data.hash }).status, 403)
})

test('保存の一時ファイルは推測できない名前で、同じ名前があれば作らずに作る', () => {
  const { root, call } = setup()
  const { data: note } = call('GET', '/api/note?path=a.md')
  const real = fs.openSync
  const opened = []
  fs.openSync = (file, flags, mode) => {
    if (String(file).endsWith('.tmp')) opened.push([path.basename(String(file)), flags])
    return real(file, flags, mode)
  }
  try {
    assert.equal(call('PUT', '/api/note?path=a.md', { text: 'y\n', baseHash: note.hash }).status, 200)
  } finally {
    fs.openSync = real
  }
  assert.equal(opened.length, 1)
  assert.match(opened[0][0], /^\.a\.md\.[0-9a-f]{16}\.tmp$/)
  assert.equal(opened[0][1], 'wx', '同じ名前があれば書かない')
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.endsWith('.tmp')), [])
  assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'y\n')
})

test('一時ファイルに書いている途中で失敗しても、一時ファイルを残さず、ノートも変えない', () => {
  const { root, call } = setup()
  const { data: note } = call('GET', '/api/note?path=a.md')
  const real = fs.writeFileSync
  fs.writeFileSync = (file, data, options) => {
    if (typeof file === 'number') throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
    return real(file, data, options)
  }
  let result
  try {
    result = call('PUT', '/api/note?path=a.md', { text: 'y\n', baseHash: note.hash })
  } finally {
    fs.writeFileSync = real
  }
  assert.equal(result.status, 500)
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.endsWith('.tmp')), [])
  assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'x\n')
})

test('一時ファイルの名前がぶつかっても、衝突（409）とは答えず、ほかのファイルを消さない', () => {
  const { root, call } = setup()
  const { data: note } = call('GET', '/api/note?path=a.md')
  const real = fs.openSync
  fs.openSync = (file, flags, mode) => {
    if (String(file).endsWith('.tmp')) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
    return real(file, flags, mode)
  }
  let result
  try {
    result = call('PUT', '/api/note?path=a.md', { text: 'y\n', baseHash: note.hash })
  } finally {
    fs.openSync = real
  }
  assert.equal(result.status, 500)
  assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'x\n')
})

test('外から20MBを超えたノートへの保存は「編集できない」と答え、ノートを変えない', () => {
  const { root, call } = setup()
  const { data: note } = call('GET', '/api/note?path=a.md')
  fs.closeSync(fs.openSync(path.join(root, 'a.md'), 'w'))
  fs.truncateSync(path.join(root, 'a.md'), 100 * 1024 * 1024 + 1)
  assert.equal(call('PUT', '/api/note?path=a.md', { text: 'y', baseHash: note.hash }).status, 403)
  assert.equal(fs.statSync(path.join(root, 'a.md')).size, 100 * 1024 * 1024 + 1)
})

test('100MBを超えるファイルは、読み込む前に断る', () => {
  const { root, call } = setup()
  fs.mkdirSync(path.join(root, 'img'))
  // 中身を書かずに大きさだけ決める（ディスクはほとんど使わない）。
  fs.closeSync(fs.openSync(path.join(root, 'img/huge.png'), 'w'))
  fs.truncateSync(path.join(root, 'img/huge.png'), 100 * 1024 * 1024 + 1)
  fs.closeSync(fs.openSync(path.join(root, 'huge.md'), 'w'))
  fs.truncateSync(path.join(root, 'huge.md'), 100 * 1024 * 1024 + 1)
  assert.equal(call('GET', '/api/file?path=img/huge.png').status, 413)
  assert.equal(call('GET', '/api/note?path=huge.md').status, 413)
})

test('衝突の控えも、本文がないか大きすぎれば受け付けない', () => {
  const { backupDir, call, files } = setup()
  const before = files(backupDir).length
  assert.equal(call('POST', '/api/backup?path=a.md', {}).status, 400)
  assert.equal(call('POST', '/api/backup?path=a.md', { text: 'a'.repeat(MAX_NOTE_BYTES + 1) }).status, 413)
  assert.equal(files(backupDir).length, before)
  assert.equal(call('POST', '/api/backup?path=a.md', { text: 'mine' }).status, 200)
})

test('大きすぎる画像は、元の形に戻す前に断り、何も作らない', () => {
  const { root, call } = setup()
  const tooBig = 'A'.repeat(Math.ceil((25 * 1024 * 1024) / 3) * 4 + 8)
  assert.equal(call('POST', '/api/attachment?name=pic.png', { base64: tooBig }).status, 413)
  assert.equal(call('POST', '/api/attachment?name=pic.png', {}).status, 400)
  assert.equal(fs.existsSync(path.join(root, 'attachments')), false)
  assert.equal(call('POST', '/api/attachment?name=pic.png', { base64: 'AA==' }).status, 201)
})

test('ゴミ箱のコマンドがないMacでは、消さずに理由を返す', () => {
  const { root } = setup({ 'a/x.md': '1' })
  const ran = []
  assert.throws(() => trashItem(root, 'a/x.md', { run: (...args) => ran.push(args), exists: () => false, platform: 'darwin' }),
    (error) => error.status === 501 && error.message === 'no trash command')
  assert.deepEqual(ran, [])
  assert.equal(fs.readFileSync(path.join(root, 'a/x.md'), 'utf8'), '1')
})

test('ファイルの操作のエラーは、種類だけを返し、ファイルの場所を画面に送らない', () => {
  const { root, call } = setup()
  const { data: note } = call('GET', '/api/note?path=a.md')
  const real = fs.renameSync
  fs.renameSync = () => { throw Object.assign(new Error(`EACCES: permission denied, rename '${root}/x' -> '${root}/a.md'`), { code: 'EACCES', syscall: 'rename' }) }
  let result
  try {
    result = call('PUT', '/api/note?path=a.md', { text: 'y\n', baseHash: note.hash })
  } finally {
    fs.renameSync = real
  }
  assert.equal(result.status, 500)
  assert.deepEqual(result.data, { error: 'EACCES', code: 'EACCES' })
  assert.ok(!JSON.stringify(result.data).includes(root))
})

test('ゴミ箱のコマンドが失敗したときは、場所の入らない理由で止める', () => {
  const { root } = setup({ 'a/x.md': '1' })
  const failing = () => { throw Object.assign(new Error(`Command failed: /usr/bin/trash ${root}/a/x.md`), { status: 1 }) }
  assert.throws(() => trashItem(root, 'a/x.md', { run: failing, exists: () => true, platform: 'darwin' }),
    (error) => error.message === 'trash failed' && !error.message.includes(root) && error.status === undefined)
  assert.equal(fs.readFileSync(path.join(root, 'a/x.md'), 'utf8'), '1')
})

test('数字の status を持つが HTTP の番号ではないエラーは、500 として返し、文を画面に送らない', () => {
  const { root, call } = setup()
  const { data: note } = call('GET', '/api/note?path=a.md')
  const real = fs.renameSync
  fs.renameSync = () => { throw Object.assign(new Error(`Command failed: ${root}/a.md`), { status: 1 }) }
  let result
  try {
    result = call('PUT', '/api/note?path=a.md', { text: 'y\n', baseHash: note.hash })
  } finally {
    fs.renameSync = real
  }
  assert.equal(result.status, 500)
  assert.ok(!JSON.stringify(result.data).includes(root))
})
