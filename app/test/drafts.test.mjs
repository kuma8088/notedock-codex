import assert from 'node:assert/strict'
import { test } from 'node:test'

import { draftQuestion, expiredDraftKeys, draftAge, newerDraft, lateDraftAction, settleLateDraft, draftKeyChanges, trashedDraftKeys } from '../src/drafts.mjs'

test('入力した日時を添えて聞く', () => {
  const time = new Date(2026, 10, 8, 14, 5).getTime()
  assert.equal(draftQuestion(time), '保存されていない入力があります（11月8日 14:05 に入力）。反映しますか？')
})

test('日時が分からないときは、日時を出さずに聞く', () => {
  assert.equal(draftQuestion(undefined), '保存されていない入力があります。反映しますか？')
})

test('30日より前の下書きと、壊れた下書きを、片付ける対象として選ぶ', () => {
  const DAY = 24 * 60 * 60 * 1000
  const now = Date.UTC(2026, 10, 15)
  const entries = [
    ['draft:v:a.md', JSON.stringify({ text: 'a', time: now - 31 * DAY })],
    ['draft:v:b.md', JSON.stringify({ text: 'b', time: now - 29 * DAY })],
    ['draft:w:c.md', JSON.stringify({ text: 'c' })],
    ['draft:v:d.md', '{broken'],
    ['recent:v', JSON.stringify(['a.md'])],
  ]
  assert.deepEqual(expiredDraftKeys(entries, now), ['draft:v:a.md', 'draft:v:d.md'])
})

test('下書きの期限は、最後に下書きを書き直した時刻から数える', () => {
  const DAY = 24 * 60 * 60 * 1000
  const now = Date.UTC(2026, 10, 15)
  const entries = [['draft:v:a.md', JSON.stringify({ text: 'a', time: now - 40 * DAY, savedAt: now - 2 * DAY })]]
  assert.deepEqual(expiredDraftKeys(entries, now), [])
})

test('新しいほうの下書きを選ぶ', () => {
  assert.equal(newerDraft({ savedAt: 2 }, { savedAt: 3 }).savedAt, 3)
  assert.equal(newerDraft({ time: 5 }, { savedAt: 3 }).time, 5)
  assert.equal(newerDraft({ savedAt: 1 }, null).savedAt, 1)
  assert.equal(newerDraft(null, { savedAt: 1 }).savedAt, 1)
  assert.equal(newerDraft(null, null), null)
  const a = { savedAt: 4, text: 'a' }
  assert.equal(newerDraft(a, { savedAt: 4, text: 'b' }), a, '同じなら local')
  assert.equal(draftAge(null), -Infinity)
  assert.equal(draftAge({}), -Infinity)
})

test('遅れて届いた下書きの扱い', () => {
  assert.equal(lateDraftAction({ savedAt: 5, text: 'a' }, null), 'start')
  assert.equal(lateDraftAction({ savedAt: 5, text: 'a' }, { savedAt: 4, text: 'b' }), 'start')
  assert.equal(lateDraftAction({ savedAt: 5, text: 'a' }, { savedAt: 5, text: 'b' }), 'start')
  assert.equal(lateDraftAction({ savedAt: 5, text: 'a' }, { savedAt: 6, text: 'a' }), 'start')
  assert.equal(lateDraftAction({ savedAt: 5, text: 'a' }, { savedAt: 6, text: 'b' }), 'backup')
  assert.equal(lateDraftAction(null, { savedAt: 1, text: 'b' }), 'backup')
})

test('履歴に残すのに失敗したら保留のまま', async () => {
  const late = { savedAt: 1, text: 'b' }
  assert.equal(await settleLateDraft({ used: null, late, backup: async () => false }), 'keep')
  assert.equal(await settleLateDraft({ used: null, late, backup: async () => { throw new Error('x') } }), 'keep')
  assert.equal(await settleLateDraft({ used: null, late, backup: async () => true }), 'release')
  let called = 0
  const backup = async () => { called++; return true }
  assert.equal(await settleLateDraft({ used: { savedAt: 5, text: 'a' }, late: null, backup }), 'release')
  assert.equal(await settleLateDraft({ used: { savedAt: 5, text: 'a' }, late: { savedAt: 4, text: 'b' }, backup }), 'release')
  assert.equal(called, 0)
})

test('移動とゴミ箱の下書きのキー', () => {
  const p = 'draft:v:'
  const keys = [p + 'notes/a.md', p + 'notes/ab.md', p + 'notes/sub/c.md', p + 'other.md', 'draft:w:notes/a.md', p + 'archive/notes/a.md', p + 'archive/notes/z.md', p + 'archive/a.md']
  const one = draftKeyChanges(keys, p, 'notes/a.md', 'archive/a.md')
  assert.deepEqual(one.move, [[p + 'notes/a.md', p + 'archive/a.md']])
  assert.deepEqual(one.remove, [])
  const dir = draftKeyChanges(keys, p, 'notes', 'archive/notes')
  assert.deepEqual(dir.move, [
    [p + 'notes/a.md', p + 'archive/notes/a.md'],
    [p + 'notes/ab.md', p + 'archive/notes/ab.md'],
    [p + 'notes/sub/c.md', p + 'archive/notes/sub/c.md'],
  ])
  assert.deepEqual(dir.remove, [p + 'archive/notes/z.md'])
  assert.deepEqual(trashedDraftKeys(keys, p, 'notes'), [p + 'notes/a.md', p + 'notes/ab.md', p + 'notes/sub/c.md'])
  assert.deepEqual(trashedDraftKeys(keys, p, 'notes/a.md'), [p + 'notes/a.md'])
})
