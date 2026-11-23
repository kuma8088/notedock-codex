import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BIG_DRAFT_GAP_MS, BIG_NOTE_BYTES, createDraftSync, DRAFT_GAP_MS, isBig } from '../src/draft-sync.mjs'

const flush = () => new Promise((r) => setImmediate(r))

// send は呼ばれた順に控え、resolve を手で呼ぶまで返らない。
function harness() {
  const timers = []
  const sent = []
  const waiting = []
  const clock = { t: 1000 }
  const sync = createDraftSync({
    send: (op) => new Promise((resolve, reject) => {
      sent.push(op)
      waiting.push({ resolve, reject })
    }),
    schedule: (fn, ms) => { const timer = { fn, ms, off: false }; timers.push(timer); return timer },
    cancel: (timer) => { if (timer) timer.off = true },
    now: () => clock.t,
  })
  const finish = async (value = true) => { waiting.shift().resolve(value); await flush() }
  const fail = async () => { waiting.shift().reject(new Error('down')); await flush() }
  const tick = async () => {
    const timer = timers.find((t) => !t.off)
    if (!timer) return
    timer.off = true
    timer.fn()
    await flush()
  }
  const live = () => timers.filter((t) => !t.off)
  return { sync, sent, timers, clock, finish, fail, tick, live }
}

const d = (text, baseHash = 'h') => ({ text, baseHash })
const brief = (ops) => ops.map((o) => (o.kind === 'put' ? `put ${o.path} ${o.draft.text}` : `clear ${o.path}`))

test('同時に送るのは1つで、待っているのは一番新しい1つだけ', async () => {
  const h = harness()
  h.sync.put('a', d('a1'))
  h.sync.put('a', d('a2'))
  h.sync.put('a', d('a3'))
  assert.deepEqual(brief(h.sent), ['put a a1'])
  await h.finish()
  h.clock.t += DRAFT_GAP_MS
  await h.tick()
  assert.deepEqual(brief(h.sent), ['put a a1', 'put a a3'])
})

test('ノートAの送信中にBへ切り替えても、Aの最後の下書きが届く', async () => {
  const h = harness()
  h.sync.put('a', d('A1'))
  h.sync.put('a', d('A2'))
  h.sync.put('b', d('B1'))
  assert.deepEqual(brief(h.sent), ['put a A1', 'put b B1'])
  await h.finish()
  await h.finish()
  h.clock.t += DRAFT_GAP_MS
  await h.tick()
  assert.deepEqual(brief(h.sent), ['put a A1', 'put b B1', 'put a A2'])
})

test('書く途中で消したら、最後は消えている', async () => {
  const h = harness()
  h.sync.put('a', d('a1'))
  h.sync.put('a', d('a2'))
  h.sync.clear('a')
  await h.finish()
  assert.deepEqual(brief(h.sent), ['put a a1', 'clear a'])
  await h.finish()
  assert.equal(h.live().length, 0)
  assert.equal(h.sent.length, 2)
})

test('大きいノートは5秒あけ、消すときは待たない', async () => {
  const h = harness()
  const big = 'あ'.repeat(333_334)
  h.sync.put('a', d(big, '1'))
  await h.finish()
  h.sync.put('a', d(big, '2'))
  assert.equal(h.live().length, 1)
  assert.equal(h.live()[0].ms, BIG_DRAFT_GAP_MS)
  assert.equal(BIG_DRAFT_GAP_MS, 5000)
  h.sync.clear('a')
  assert.equal(h.live().length, 0)
  assert.deepEqual(brief(h.sent), ['put a ' + big, 'clear a'])
})

test('小さいノートの2回目は1秒あける。時間が過ぎていればすぐ送る', async () => {
  const h = harness()
  h.sync.put('a', d('a1'))
  assert.equal(h.live().length, 0)
  await h.finish()
  h.clock.t += 300
  h.sync.put('a', d('a2'))
  assert.equal(h.live()[0].ms, 700)
  h.clock.t += 700
  await h.tick()
  await h.finish()
  h.clock.t += 5000
  h.sync.put('a', d('a3'))
  assert.equal(h.sent.length, 3)
})

test('同じ中身は続けて送らない', async () => {
  const h = harness()
  h.sync.put('a', d('x', 'h1'))
  await h.finish()
  h.sync.put('a', d('x', 'h1'))
  assert.equal(h.sent.length, 1)
  assert.equal(h.live().length, 0)
  h.sync.put('a', d('x', 'h2'))
  h.clock.t += DRAFT_GAP_MS
  await h.tick()
  assert.equal(h.sent.length, 2)
})

test('失敗や消したあとは、同じ中身でも送る', async () => {
  const h = harness()
  h.sync.put('a', d('x'))
  await h.finish(false)
  h.clock.t += DRAFT_GAP_MS
  h.sync.put('a', d('x'))
  assert.equal(h.sent.length, 2)
  await h.fail()
  h.clock.t += DRAFT_GAP_MS
  h.sync.put('a', d('x'))
  assert.equal(h.sent.length, 3)
  await h.finish()
  h.sync.clear('a')
  await h.finish()
  h.clock.t += DRAFT_GAP_MS
  h.sync.put('a', d('x'))
  assert.equal(h.sent.length, 5)
  await h.finish()
  h.sync.forget('a')
  h.clock.t += DRAFT_GAP_MS
  h.sync.put('a', d('x'))
  assert.equal(h.sent.length, 6)
})

test('失敗しても、待っていた次の下書きは送る', async () => {
  const h = harness()
  h.sync.put('a', d('a1'))
  h.sync.put('a', d('a2'))
  await h.fail()
  h.clock.t += DRAFT_GAP_MS
  await h.tick()
  assert.deepEqual(brief(h.sent), ['put a a1', 'put a a2'])
})

test('消すのを待っているところへ put が来たら、消す、書くの順に送る', async () => {
  const h = harness()
  h.sync.put('a', d('a1'))
  h.sync.clear('a')
  h.sync.put('a', d('a2'))
  await h.finish()
  assert.deepEqual(brief(h.sent), ['put a a1', 'clear a'])
  await h.finish()
  h.clock.t += DRAFT_GAP_MS
  await h.tick()
  assert.deepEqual(brief(h.sent), ['put a a1', 'clear a', 'put a a2'])
})

test('保留中のノートは送らず、解除したあとから送る', async () => {
  const h = harness()
  h.sync.hold('a')
  assert.equal(h.sync.held('a'), true)
  h.sync.put('a', d('a1'))
  h.sync.clear('a')
  assert.equal(h.sent.length, 0)
  h.sync.release('a')
  assert.equal(h.sync.held('a'), false)
  assert.equal(h.sent.length, 0)
  h.sync.put('a', d('a2'))
  assert.deepEqual(brief(h.sent), ['put a a2'])
})

test('保留にすると、待っていた分とタイマーは捨てる。送信中の分は終わらせる', async () => {
  const h = harness()
  h.sync.put('a', d('a1'))
  await h.finish()
  h.sync.put('a', d('a2'))
  assert.equal(h.live().length, 1)
  h.sync.hold('a')
  assert.equal(h.live().length, 0)
  h.sync.release('a')
  h.sync.put('b', d('b1'))
  h.sync.put('b', d('b2'))
  h.sync.hold('b')
  await h.finish()
  assert.deepEqual(brief(h.sent), ['put a a1', 'put b b1'])
  assert.equal(h.live().length, 0)
})

test('isBig は1,000,000バイトの境目', () => {
  assert.equal(BIG_NOTE_BYTES, 1_000_000)
  assert.equal(isBig('あ'.repeat(333_333)), false)
  assert.equal(isBig('あ'.repeat(333_334)), true)
  assert.equal(isBig('a'.repeat(1_000_000)), false)
  assert.equal(isBig('a'.repeat(1_000_001)), true)
})

test('送信中に別の中身を挟んで元の中身へ戻したら、戻した分も送る', async () => {
  const h = harness()
  h.sync.put('a', d('x'))
  await h.finish()
  h.clock.t += DRAFT_GAP_MS
  h.sync.put('a', d('y'))
  h.sync.put('a', d('x'))
  await h.finish()
  h.clock.t += DRAFT_GAP_MS
  await h.tick()
  assert.deepEqual(brief(h.sent), ['put a x', 'put a y', 'put a x'])
})

test('送信中に消して同じ中身を書いたら、消したあとに送る', async () => {
  const h = harness()
  h.sync.put('a', d('x'))
  await h.finish()
  h.clock.t += DRAFT_GAP_MS
  h.sync.put('a', d('y'))
  h.sync.clear('a')
  h.sync.put('a', d('x'))
  await h.finish()
  await h.finish()
  h.clock.t += DRAFT_GAP_MS
  await h.tick()
  assert.deepEqual(brief(h.sent), ['put a x', 'put a y', 'clear a', 'put a x'])
})

test('保留にして解除したあとは、同じ中身でも送る', async () => {
  const h = harness()
  h.sync.put('a', d('x'))
  await h.finish()
  h.sync.hold('a')
  h.sync.release('a')
  h.clock.t += DRAFT_GAP_MS
  h.sync.put('a', d('x'))
  assert.deepEqual(brief(h.sent), ['put a x', 'put a x'])
})

test('保留中に送信が成功しても、解除後の同じ中身は送る', async () => {
  const h = harness()
  h.sync.put('a', d('x'))
  h.sync.hold('a')
  await h.finish()
  h.sync.release('a')
  h.clock.t += DRAFT_GAP_MS
  h.sync.put('a', d('x'))
  assert.equal(h.sent.length, 2)
})
