import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createBackups } from '../server/backups.mjs'

const DAY = 24 * 60 * 60 * 1000
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'drafts-store-'))
// backups.mjs の folder(rel) と同じ名前の作り方
const folderOf = (dir, rel) => path.join(dir, crypto.createHash('sha1').update(rel).digest('hex').slice(0, 20))
const draftOf = (text, time = 1) => ({ text, baseText: '', baseHash: 'h', time, savedAt: 2 })

test('下書きを書いて読んで消せる', () => {
  const b = createBackups(tmp())
  const draft = { text: 'x', baseText: '', baseHash: 'h', time: 1, savedAt: 2 }
  b.writeDraft('notes/日記/2026-11-20.md', draft)
  assert.deepEqual(b.readDraft('notes/日記/2026-11-20.md'), draft)
  b.clearDraft('notes/日記/2026-11-20.md')
  assert.equal(b.readDraft('notes/日記/2026-11-20.md'), null)
  b.clearDraft('notes/日記/2026-11-20.md') // なくても例外を投げない
})

test('一時ファイルが残らず、権限は0600', () => {
  const dir = tmp()
  const b = createBackups(dir)
  b.writeDraft('a.md', draftOf('x'))
  const names = fs.readdirSync(folderOf(dir, 'a.md'))
  assert.ok(!names.some((n) => /^\.draft-.*\.tmp$/.test(n)))
  assert.equal(fs.statSync(path.join(folderOf(dir, 'a.md'), 'draft.json')).mode & 0o777, 0o600)
})

test('読めない下書きは null', () => {
  const dir = tmp()
  const b = createBackups(dir)
  b.writeDraft('a.md', draftOf('x'))
  const file = path.join(folderOf(dir, 'a.md'), 'draft.json')
  for (const body of ['not json', '', '123', 'null', '[]', '{"text":1,"baseText":""}', '{"text":"a","baseText":2}']) {
    fs.writeFileSync(file, body)
    assert.equal(b.readDraft('a.md'), null, body)
  }
  assert.equal(b.readDraft('none.md'), null)
})

test('それ以前に打った下書きだけ消える', () => {
  const dir = tmp()
  const b = createBackups(dir)
  b.writeDraft('a.md', draftOf('x', 100))
  assert.equal(b.clearDraftIfTypedBefore('a.md', 99), false)
  assert.notEqual(b.readDraft('a.md'), null)
  assert.equal(b.clearDraftIfTypedBefore('a.md', 100), true)
  assert.equal(b.readDraft('a.md'), null)
  const file = path.join(folderOf(dir, 'a.md'), 'draft.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ text: 'x', baseText: '', time: '1' }))
  assert.equal(b.clearDraftIfTypedBefore('a.md', 100), false)
  assert.ok(fs.existsSync(file))
  fs.writeFileSync(file, JSON.stringify({ text: 'x', baseText: '' }))
  assert.equal(b.clearDraftIfTypedBefore('a.md', 100), false)
  assert.ok(fs.existsSync(file))
  assert.equal(b.clearDraftIfTypedBefore('none.md', 100), false)
})

test('移動したら下書きも移り、移動先の古い下書きは消える', () => {
  const b = createBackups(tmp())
  b.writeDraft('A', draftOf('a'))
  b.writeDraft('B', draftOf('old'))
  b.rename('A', 'B')
  assert.equal(b.readDraft('B').text, 'a')
  assert.equal(b.readDraft('A'), null)

  b.writeDraft('D', draftOf('old'))
  b.rename('C', 'D')
  assert.equal(b.readDraft('D'), null)

  b.save('E', 'x', 'previous')
  b.writeDraft('F', draftOf('old'))
  b.rename('E', 'F')
  assert.equal(b.readDraft('F'), null)
})

test('30日たった下書きと1日たった一時ファイルを消す', () => {
  const dir = tmp()
  const b = createBackups(dir)
  b.writeDraft('old.md', draftOf('x'))
  b.writeDraft('new.md', draftOf('y'))
  const oldDir = folderOf(dir, 'old.md')
  const newDir = folderOf(dir, 'new.md')
  const ago = (days) => new Date(Date.now() - days * DAY)
  fs.utimesSync(path.join(oldDir, 'draft.json'), ago(31), ago(31))
  fs.utimesSync(path.join(newDir, 'draft.json'), ago(29), ago(29))
  fs.writeFileSync(path.join(oldDir, '.draft-x.tmp'), 'x')
  fs.utimesSync(path.join(oldDir, '.draft-x.tmp'), ago(2), ago(2))
  fs.writeFileSync(path.join(newDir, '.draft-y.tmp'), 'y')
  b.prune()
  assert.ok(!fs.existsSync(path.join(oldDir, 'draft.json')))
  assert.ok(!fs.existsSync(path.join(oldDir, '.draft-x.tmp')))
  assert.notEqual(b.readDraft('new.md'), null)
  assert.ok(fs.existsSync(path.join(newDir, '.draft-y.tmp')))
})
