import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EditorSelection, EditorState } from '@codemirror/state'

import { CLEAR, SELECTION_DELAY_MS, contextFor, createAiContext, fitToHost, selectionOf } from '../src/ai-context.mjs'

// 時間を手で進められる時計。
function fakeTimers() {
  let now = 0
  let next = 1
  const pending = new Map()
  return {
    setTimeout(fn, ms) {
      const id = next++
      pending.set(id, { fn, at: now + ms })
      return id
    },
    clearTimeout(id) {
      pending.delete(id)
    },
    advance(ms) {
      now += ms
      for (const [id, { fn, at }] of [...pending]) {
        if (at <= now) {
          pending.delete(id)
          fn()
        }
      }
    },
  }
}

// slow: true のときは、送ったものを gate.release() するまで返さない（遅いホスト）。
function setup({ refuse = () => false, share = async () => true, slow = false, hostHas = () => false } = {}) {
  const sent = []
  const events = []
  const timers = fakeTimers()
  const waiting = []
  const ctx = createAiContext({
    send: async (params) => {
      sent.push(params)
      if (slow) await new Promise((resolve) => waiting.push(resolve))
      if (refuse(params)) throw new Error('no composer here')
    },
    confirmShare: share,
    onShareOff: () => events.push(['off']),
    onRefused: (reason, { cleared, mayRemain }) => events.push(['refused', reason, cleared, ...(mayRemain ? ['mayRemain'] : [])]),
    onAccepted: () => events.push(['accepted']),
    hostHasContext: hostHas,
    timers,
  })
  const release = async () => {
    while (waiting.length) waiting.shift()()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { ctx, sent, events, timers, release }
}

const textOf = (params) => params.content.map((block) => block.text).join('\n')
const notes = (sent) => sent.filter((params) => params.content.length).map((params) => params.structuredContent.notePath)

test('オフのあいだは、ノートを開いても範囲を選んでもノートの内容を送らない', async () => {
  const { ctx, sent, timers } = setup()
  await ctx.noteChanged('Daily/2026-11-22.md', '')
  ctx.selectionChanged('選んだ')
  timers.advance(SELECTION_DELAY_MS * 2)
  await ctx.idle()
  assert.ok(sent.every((params) => params.content.length === 0))
})

test('起動したときにオフと分かったら、空の内容で1回上書きする。同じ空の上書きは繰り返さない', async () => {
  const { ctx, sent } = setup()
  await ctx.setEnabled(false)
  await ctx.setEnabled(false)
  assert.deepEqual(sent, [CLEAR])
})

test('ホストに前の内容が残っていれば、空の上書きを送り直す', async () => {
  let has = false
  const { ctx, sent } = setup({ hostHas: () => has })
  await ctx.setEnabled(false)
  has = true
  await ctx.setEnabled(false)
  assert.deepEqual(sent, [CLEAR, CLEAR])
})

test('オンにすると今のノートをすぐ送り、ノートが替わるとすぐ送り直す', async () => {
  const { ctx, sent } = setup()
  await ctx.noteChanged('a/one.md')
  await ctx.setEnabled(true)
  assert.deepEqual(notes(sent), ['a/one.md'])
  assert.match(textOf(sent.at(-1)), /a\/one\.md/)
  assert.deepEqual(sent.at(-1).structuredContent, { notePath: 'a/one.md', outside: false })
  await ctx.noteChanged('b/two.md')
  assert.deepEqual(notes(sent), ['a/one.md', 'b/two.md'])
})

test('選ぶ範囲が変わったときは、止まってから少し間を置いて1回だけ送る。同じ行なら送らない', async () => {
  const { ctx, sent, timers } = setup()
  await ctx.setEnabled(true)
  await ctx.noteChanged('n.md')
  const before = sent.length
  ctx.selectionChanged('3')
  timers.advance(SELECTION_DELAY_MS - 1)
  ctx.selectionChanged('3-4')
  timers.advance(SELECTION_DELAY_MS - 1)
  await ctx.idle()
  assert.equal(sent.length, before)
  timers.advance(1)
  await ctx.idle()
  assert.equal(sent.length, before + 1)
  assert.deepEqual([sent.at(-1).structuredContent.fromLine, sent.at(-1).structuredContent.toLine], [3, 4])
  ctx.selectionChanged('3-4')
  timers.advance(SELECTION_DELAY_MS)
  await ctx.idle()
  assert.equal(sent.length, before + 1)
})

// 遅いホストの試験では、送り終わりを待つ前に必ず release する（待つと、release されず止まる）。
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
async function settle(env) {
  for (let i = 0; i < 10; i++) await env.release()
  await env.ctx.idle()
}

test('遅いホスト：送っている間に A→B→A と替えたら、最後は A のまま（B を送らない）', async () => {
  const env = setup({ slow: true })
  const { ctx, sent } = env
  ctx.setEnabled(false)
  await settle(env)
  ctx.noteChanged('A.md')
  ctx.setEnabled(true) // A を送っている途中
  await tick()
  ctx.noteChanged('B.md')
  ctx.noteChanged('A.md')
  await settle(env)
  assert.deepEqual(notes(sent), ['A.md'])
})

test('遅いホスト：送っている間に何度も替えたら、送り終えたあとに最新の1件だけを送る', async () => {
  const env = setup({ slow: true })
  const { ctx, sent } = env
  ctx.noteChanged('A.md')
  ctx.setEnabled(true)
  await tick()
  ctx.noteChanged('B.md')
  ctx.noteChanged('C.md')
  ctx.noteChanged('D.md')
  await settle(env)
  assert.equal(notes(sent).at(-1), 'D.md')
  assert.ok(!notes(sent).includes('B.md') && !notes(sent).includes('C.md'))
})

test('オンにしてすぐオフにしたら、送っている途中の内容のすぐ後に空の内容で上書きする', async () => {
  const env = setup({ slow: true })
  const { ctx, sent } = env
  ctx.noteChanged('A.md')
  await settle(env)
  ctx.setEnabled(true)
  await tick()
  ctx.setEnabled(false)
  await settle(env)
  assert.deepEqual(notes(sent), ['A.md'])
  assert.deepEqual(sent.at(-1), CLEAR)
})

test('ノートを閉じたときも、空の内容で上書きする', async () => {
  const { ctx, sent } = setup()
  await ctx.setEnabled(true)
  await ctx.noteChanged('n.md')
  await ctx.noteChanged(null)
  assert.deepEqual(sent.at(-1), CLEAR)
})

test('送る直前に共有の設定を確かめ、ほかのタブでオフにされていたら送らずに空の内容で上書きする', async () => {
  let on = true
  const { ctx, sent, events } = setup({ share: async () => on })
  await ctx.setEnabled(true)
  on = false
  await ctx.noteChanged('n.md')
  assert.deepEqual(notes(sent), [])
  assert.deepEqual(sent.at(-1), CLEAR)
  assert.ok(events.some(([kind]) => kind === 'off'))
  assert.equal(ctx.enabled, false)
})

test('共有の設定を確かめられないときは、ノートの内容を送らない', async () => {
  const { ctx, sent } = setup({ share: async () => { throw new Error('offline') } })
  await ctx.setEnabled(true)
  await ctx.noteChanged('n.md')
  assert.deepEqual(notes(sent), [])
})

test('選んでいる行は、場所と行の番号だけを伝え、本文は送らない', () => {
  const params = contextFor('日記/a.md', '12-18')
  assert.deepEqual(params.structuredContent, { notePath: '日記/a.md', outside: false, fromLine: 12, toLine: 18 })
  assert.match(textOf(params), /「日記\/a\.md」の 12〜18行目/)
  const one = contextFor('a.md', '5')
  assert.deepEqual(one.structuredContent, { notePath: 'a.md', outside: false, fromLine: 5, toLine: 5 })
  assert.match(textOf(one), /「a\.md」の 5行目/)
  assert.deepEqual(contextFor('a.md', '').structuredContent, { notePath: 'a.md', outside: false })
})

test('Vault の絶対パスも、「」で囲んで伝える。空白を含むパスでも壊れない。分からなければ今までどおり', () => {
  const root = '/Users/me/My Vault/Notes 2'
  const params = contextFor('日記/a.md', '12-18', root)
  assert.deepEqual(params.structuredContent, { notePath: '日記/a.md', outside: false, vaultRoot: root, fromLine: 12, toLine: 18 })
  assert.equal(
    textOf(params),
    `NoteDock で開いているノート：「日記/a.md」（Vault のフォルダー：「${root}」）の 12〜18行目を選んでいる。中身が要るときは、このファイルのその行を読む。`,
  )
  assert.equal(textOf(contextFor('a.md', '', root)), `NoteDock で開いているノート：「a.md」（Vault のフォルダー：「${root}」）`)
  assert.deepEqual(contextFor('a.md', '', root).structuredContent, { notePath: 'a.md', outside: false, vaultRoot: root })
  assert.equal(textOf(contextFor('a.md', '5', '')), 'NoteDock で開いているノート：「a.md」の 5行目を選んでいる。中身が要るときは、このファイルのその行を読む。')
  // フォルダーの外は、絶対パスも出さない。
  const outside = contextFor('__outside__/memo.md', '3', root)
  assert.deepEqual(outside.structuredContent, { notePath: 'memo.md', outside: true })
  assert.doesNotMatch(textOf(outside), /Users|Vault のフォルダー/)
})

test('createAiContext は vaultRoot を送る内容に入れる', async () => {
  const sent = []
  const ctx = createAiContext({ send: async (p) => void sent.push(p), vaultRoot: () => '/v r', timers: fakeTimers() })
  await ctx.setEnabled(true)
  await ctx.noteChanged('a.md', '2')
  assert.equal(sent.at(-1).structuredContent.vaultRoot, '/v r')
  assert.match(textOf(sent.at(-1)), /「\/v r」/)
})

test('選んでいる範囲を行の番号にする。行を丸ごと選んだときは次の行を入れない。何も選んでいなければ空', () => {
  const doc = '一\n二\n三\n四'
  const at = (from, to) => selectionOf(EditorState.create({ doc, selection: EditorSelection.single(from, to) }))
  assert.equal(at(0, 0), '')
  assert.equal(at(2, 3), '2')
  assert.equal(at(0, 6), '1-3')
  assert.equal(at(0, 4), '1-2') // 3行目の先頭で終わる
  assert.equal(at(2, 4), '2') // 2行目を丸ごと
})

test('フォルダーの外のノートは、ファイル名だけを伝え、選んでいる行は伝えない', () => {
  const params = contextFor('__outside__/memo.md', '3-4')
  assert.deepEqual(params.structuredContent, { notePath: 'memo.md', outside: true })
  assert.doesNotMatch(textOf(params), /__outside__|行目/)
})

test('ホストが受け取れる種類に合わせる：structuredContent がなければ外し、文字がなければ送れない', () => {
  const params = contextFor('n.md', '')
  assert.equal(fitToHost(params, undefined), params)
  assert.equal(fitToHost(params, { text: {}, structuredContent: {} }), params)
  assert.deepEqual(fitToHost(params, { text: {} }), { content: params.content })
  assert.equal(fitToHost(params, { image: {} }), null)
  assert.equal(fitToHost(CLEAR, { image: {} }), CLEAR)
})

test('ホストが断ったら、黙って捨てずに記録して知らせる。同じ内容は次のきっかけ（retry）で送り直す', async () => {
  const { ctx, sent, events } = setup({ refuse: (params) => params.content.length > 0 })
  await ctx.noteChanged('n.md')
  await ctx.setEnabled(true)
  assert.deepEqual(notes(sent), ['n.md'])
  assert.deepEqual(events.at(-1), ['refused', 'no composer here', false])
  assert.equal(ctx.refusals.at(-1).reason, 'no composer here')
  await ctx.noteChanged('n.md')
  assert.deepEqual(notes(sent), ['n.md'])
  await ctx.retry()
  assert.deepEqual(notes(sent), ['n.md', 'n.md'])
})

test('空の上書きが断られたら、消せなかったことを知らせ、retry で送り直す', async () => {
  const { ctx, sent, events } = setup({ refuse: (params) => params.content.length === 0 })
  await ctx.setEnabled(false)
  assert.deepEqual(events.at(-1), ['refused', 'no composer here', true])
  assert.equal(ctx.refusals.at(-1).cleared, true)
  await ctx.retry()
  assert.deepEqual(sent, [CLEAR, CLEAR])
})

test('受け取られたら、知らせを消すために onAccepted を呼ぶ', async () => {
  const { ctx, events } = setup()
  await ctx.setEnabled(true)
  assert.deepEqual(events, [['accepted']])
})

test('空の上書きが断られたあと、フォーカスがなくても、次のオフの確認やノートの切り替えで送り直す', async () => {
  let refuse = true
  const { ctx, sent } = setup({ refuse: (params) => refuse && params.content.length === 0 })
  await ctx.setEnabled(false)
  assert.deepEqual(sent, [CLEAR])
  refuse = false
  // 60秒おきの読み直しと同じ呼び方（オフのまま）。
  await ctx.setEnabled(false)
  assert.deepEqual(sent, [CLEAR, CLEAR])
  await ctx.setEnabled(false)
  assert.deepEqual(sent, [CLEAR, CLEAR])
})

test('空の上書きが断られたあと、ノートを替えたときも送り直す', async () => {
  let refuse = true
  const { ctx, sent } = setup({ refuse: (params) => refuse && params.content.length === 0 })
  await ctx.setEnabled(false)
  refuse = false
  await ctx.noteChanged('n.md')
  assert.deepEqual(sent, [CLEAR, CLEAR])
})

test('タブを閉じる前の知らせのあとは、オンにされてもノートの内容を送らない', async () => {
  const { ctx, sent } = setup()
  await ctx.setEnabled(true)
  await ctx.noteChanged('n.md')
  await ctx.close()
  assert.deepEqual(sent.at(-1), CLEAR)
  // 閉じる直前に出た読み直しが、あとから届いた場合。
  await ctx.setEnabled(true)
  await ctx.noteChanged('m.md')
  await ctx.retry()
  assert.deepEqual(notes(sent), ['n.md'])
  assert.deepEqual(sent.at(-1), CLEAR)
  assert.equal(ctx.closed, true)
})

test('送り終わる直前に入った最新の内容も取りこぼさない', async () => {
  const sent = []
  let ctx
  ctx = createAiContext({
    send: async (params) => {
      sent.push(params)
      // 送り終えるのと同時（同じ流れ）に、次の内容を頼む。
      if (params.structuredContent?.notePath === 'a.md') queueMicrotask(() => ctx.noteChanged('b.md'))
    },
  })
  await ctx.noteChanged('a.md')
  await ctx.setEnabled(true)
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  await ctx.idle()
  assert.equal(notes(sent).at(-1), 'b.md')
})

test('ホストが空の宣言（{}）をしたときは、文字だけ送る', () => {
  const params = contextFor('n.md', '')
  assert.deepEqual(fitToHost(params, {}), { content: params.content })
})

test('何も伝えていない画面で空の上書きを断られても、会話に残っているかもしれないとは言わない', async () => {
  const { ctx, events } = setup({ refuse: () => true })
  await ctx.setEnabled(false) // 起動したときの空の上書き
  assert.deepEqual(events.at(-1), ['refused', 'no composer here', true])
  assert.equal(ctx.refusals.at(-1).mayRemain, false)
})

test('内容が受け取られたあとで空の上書きを断られたら、会話に残っているかもしれないと伝える', async () => {
  const { ctx, events } = setup({ refuse: (params) => params.content.length === 0 })
  await ctx.noteChanged('n.md')
  await ctx.setEnabled(true)
  await ctx.setEnabled(false)
  assert.deepEqual(events.at(-1), ['refused', 'no composer here', true, 'mayRemain'])
})

test('ホストに内容が残っていれば、この画面で伝えていなくても、残っているかもしれないと伝える', async () => {
  const { ctx, events } = setup({ refuse: () => true, hostHas: () => true })
  await ctx.setEnabled(false)
  assert.deepEqual(events.at(-1), ['refused', 'no composer here', true, 'mayRemain'])
})
