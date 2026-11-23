import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createCore } from '../server/core.mjs'
import { MAX_NOTE_BYTES } from '../server/notes.mjs'

// 書きかけの下書きの API と、保存・ゴミ箱・移動との連動。

const scope = { editable: true, opened: null }

function setup(files = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'draft-root-')))
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), text)
  }
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-bak-'))
  const core = createCore({ root, backupDir })
  return { root, core }
}

const draftOf = (time, text = 'T') => ({ text, baseText: 'B', baseHash: 'h', time, savedAt: time })
const put = (core, rel, draft, root = core.rootId, sc = scope) =>
  core.request('PUT', `/api/draft?path=${encodeURIComponent(rel)}&root=${root}`, { draft }, sc)
const get = (core, rel, root = core.rootId) => core.request('GET', `/api/draft?path=${encodeURIComponent(rel)}&root=${root}`, undefined, scope)
const clear = (core, rel, root = core.rootId, sc = scope) =>
  core.request('POST', `/api/draft/clear?path=${encodeURIComponent(rel)}&root=${root}`, undefined, sc)

function withTrashDir(dir, fn) {
  const before = process.env.NOTEDOCK_TRASH_DIR
  process.env.NOTEDOCK_TRASH_DIR = dir
  try {
    fn()
  } finally {
    if (before === undefined) delete process.env.NOTEDOCK_TRASH_DIR
    else process.env.NOTEDOCK_TRASH_DIR = before
  }
}

test('下書きを書いて読んで消せる（API）', () => {
  const { core } = setup({ 'notes/a.md': 'A\n' })
  const draft = draftOf(100, 'hello')
  assert.deepEqual(put(core, 'notes/a.md', draft).data, { ok: true })
  assert.deepEqual(get(core, 'notes/a.md').data, { draft })
  assert.deepEqual(clear(core, 'notes/a.md').data, { ok: true })
  assert.deepEqual(get(core, 'notes/a.md').data, { draft: null })
})

test('不正なパスは400', () => {
  const { core } = setup({ 'notes/a.md': 'A\n' })
  for (const rel of ['.obsidian/x.md', 'a.txt', '../x.md']) {
    assert.equal(get(core, rel).status, 400, rel)
    assert.equal(put(core, rel, draftOf(1)).status, 400, rel)
    assert.equal(clear(core, rel).status, 400, rel)
  }
  const q = `root=${core.rootId}`
  assert.equal(core.request('GET', `/api/draft?${q}`, undefined, scope).status, 400)
  assert.equal(core.request('PUT', `/api/draft?${q}`, { draft: draftOf(1) }, scope).status, 400)
  assert.equal(core.request('POST', `/api/draft/clear?${q}`, undefined, scope).status, 400)
})

test('root が違えば書かず、読めば null', () => {
  const { core } = setup({ 'notes/a.md': 'A\n' })
  const other = put(core, 'notes/a.md', draftOf(1), 'other')
  assert.equal(other.status, 200)
  assert.deepEqual(other.data, { ok: false, reason: 'other-root' })
  assert.deepEqual(get(core, 'notes/a.md').data, { draft: null })
  put(core, 'notes/a.md', draftOf(2))
  assert.deepEqual(get(core, 'notes/a.md', 'other').data, { draft: null })
  assert.deepEqual(clear(core, 'notes/a.md', 'other').data, { ok: false, reason: 'other-root' })
  assert.equal(get(core, 'notes/a.md').data.draft.time, 2)
})

test('書き込めないタブからは拒否する', () => {
  const { core } = setup({ 'notes/a.md': 'A\n' })
  const readOnly = { editable: false, opened: null }
  assert.equal(put(core, 'notes/a.md', draftOf(1), core.rootId, readOnly).status, 403)
  assert.equal(clear(core, 'notes/a.md', core.rootId, readOnly).status, 403)
})

test('ノートがなくても、BOM付きでも下書きを書ける', () => {
  const { core } = setup({ 'notes/bom.md': '﻿B\n' })
  assert.equal(put(core, 'notes/none.md', draftOf(1)).status, 200)
  assert.equal(put(core, 'notes/bom.md', draftOf(1)).status, 200)
  assert.equal(get(core, 'notes/none.md').data.draft.time, 1)
})

test('中身が不正なら400', () => {
  const { core } = setup({ 'notes/a.md': 'A\n' })
  const bad = [
    { ...draftOf(1), text: 5 },
    { text: 'x', baseHash: 'h', time: 1 },
    { ...draftOf(1), text: 'a'.repeat(MAX_NOTE_BYTES + 1) },
    { ...draftOf(1), baseText: 'a'.repeat(MAX_NOTE_BYTES + 1) },
    { ...draftOf(1), time: 'x' },
    { ...draftOf(1), savedAt: '1' },
    { ...draftOf(1), time: null },
    null,
    'x',
  ]
  for (const draft of bad) assert.equal(put(core, 'notes/a.md', draft).status, 400)
  assert.equal(core.request('PUT', `/api/draft?path=notes/a.md&root=${core.rootId}`, {}, scope).status, 400)
  assert.deepEqual(get(core, 'notes/a.md').data, { draft: null })
})

test('時刻が数でも、有限でなければ400（JSONの外から呼ばれたとき）', () => {
  const { core } = setup({ 'notes/a.md': 'A\n' })
  assert.equal(put(core, 'notes/a.md', { ...draftOf(1), time: Infinity }).status, 400)
  assert.equal(put(core, 'notes/a.md', { ...draftOf(1), savedAt: NaN }).status, 400)
})

test('下書きは決まった項目だけを残す。時刻はなくてもよい', () => {
  const { core } = setup({ 'notes/a.md': 'A\n' })
  assert.equal(put(core, 'notes/a.md', { ...draftOf(5), extra: 'x', nested: { a: 1 } }).status, 200)
  assert.deepEqual(get(core, 'notes/a.md').data.draft, draftOf(5))
  assert.equal(put(core, 'notes/a.md', { text: 't', baseText: 'b' }).status, 200)
  assert.deepEqual(get(core, 'notes/a.md').data.draft, { text: 't', baseText: 'b' })
})

test('ノートを新しく作ると、同じパスに残っていた下書きを消す', () => {
  const { core } = setup({})
  assert.equal(put(core, 'notes/gone.md', draftOf(1, 'old')).status, 200)
  assert.equal(core.request('POST', '/api/note?path=notes%2Fgone.md', undefined, scope).status, 201)
  assert.deepEqual(get(core, 'notes/gone.md').data, { draft: null })
})

test('保存したとき、それ以前に打った下書きは消え、あとの下書きは残る', () => {
  const { core } = setup({ 'notes/a.md': 'A\n' })
  const saveNote = (text, extra) => {
    const got = core.request('GET', '/api/note?path=notes/a.md', undefined, scope)
    return core.request('PUT', '/api/note?path=notes/a.md', { text, baseHash: got.data.hash, ...extra }, scope)
  }
  put(core, 'notes/a.md', draftOf(100))
  assert.equal(saveNote('A1\n', { typedAt: 100 }).status, 200)
  assert.deepEqual(get(core, 'notes/a.md').data, { draft: null })
  put(core, 'notes/a.md', draftOf(200))
  assert.equal(saveNote('A2\n', { typedAt: 150 }).status, 200)
  assert.equal(get(core, 'notes/a.md').data.draft.time, 200)
  assert.equal(saveNote('A3\n').status, 200)
  assert.equal(get(core, 'notes/a.md').data.draft.time, 200)
})

test('リンクの書き換えの保存では下書きを消さない', () => {
  const { core } = setup({ 'notes/a.md': '[b](b.md)\n', 'notes/b.md': 'B\n' })
  put(core, 'notes/a.md', draftOf(100))
  const moved = core.request('POST', '/api/move', { from: 'notes/b.md', to: 'notes/c.md', rewrite: true }, scope)
  assert.equal(moved.status, 200)
  assert.equal(fs.readFileSync(path.join(setupRoot(core), 'notes/a.md'), 'utf8').includes('c.md'), true)
  assert.equal(get(core, 'notes/a.md').data.draft.time, 100)
})

function setupRoot(core) {
  return core.request('GET', '/api/health', undefined, scope).data.rootPaths[0]
}

test('ノートとフォルダーをゴミ箱に入れたら下書きが消え、失敗したら残る', () => {
  const { core } = setup({ 'notes/a.md': 'A\n', 'notes/sub/b.md': 'B\n', 'notes/keep.md': 'K\n' })
  const trash = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-trash-'))
  for (const rel of ['notes/a.md', 'notes/sub/b.md', 'notes/keep.md']) put(core, rel, draftOf(1))
  withTrashDir(trash, () => {
    assert.equal(core.request('POST', '/api/trash?path=notes/a.md', undefined, scope).status, 200)
    assert.equal(core.request('POST', '/api/trash?path=notes/sub', undefined, scope).status, 200)
  })
  assert.deepEqual(get(core, 'notes/a.md').data, { draft: null })
  assert.deepEqual(get(core, 'notes/sub/b.md').data, { draft: null })
  assert.equal(get(core, 'notes/keep.md').data.draft.time, 1)
  // 失敗したら残る
  withTrashDir(path.join(trash, 'ない', '場所'), () => {
    const res = core.request('POST', '/api/trash?path=notes/keep.md', undefined, scope)
    assert.notEqual(res.status, 200)
  })
  assert.equal(get(core, 'notes/keep.md').data.draft.time, 1)
})

test('日本語のパスのノートを移動しても下書きが移る', () => {
  const { core, root } = setup({ 'notes/日記/x.md': 'X\n' })
  fs.mkdirSync(path.join(root, 'notes/にっき'))
  put(core, 'notes/日記/x.md', draftOf(7))
  const moved = core.request('POST', '/api/move', { from: 'notes/日記/x.md', to: 'notes/にっき/y.md' }, scope)
  assert.equal(moved.status, 200)
  assert.equal(get(core, 'notes/にっき/y.md').data.draft.time, 7)
  assert.deepEqual(get(core, 'notes/日記/x.md').data, { draft: null })
})
