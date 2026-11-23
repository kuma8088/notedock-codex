import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mergeText, minimalChange } from '../src/merge.mjs'
import { createSaver, SAVE_DELAY_MS } from '../src/save.mjs'

test('別々の行の変更は両方残る', () => {
  const base = 'a\nb\nc\nd\ne\n'
  const mine = 'A\nb\nc\nd\ne\n'
  const theirs = 'a\nb\nc\nd\nE\n'
  assert.deepEqual(mergeText(base, mine, theirs), { conflict: false, text: 'A\nb\nc\nd\nE\n' })
})

test('隣の行の変更も両方残る', () => {
  assert.deepEqual(mergeText('a\nb\nc\n', 'A\nb\nc\n', 'a\nB\nc\n'), { conflict: false, text: 'A\nB\nc\n' })
  assert.deepEqual(mergeText('a\nb\n', 'x\na\nb\n', 'a\nb\ny\n'), { conflict: false, text: 'x\na\nb\ny\n' })
})

test('同じ場所への別々の追加は止める', () => {
  assert.equal(mergeText('a\nb\n', 'a\nX\nb\n', 'a\nY\nb\n').conflict, true)
  assert.equal(mergeText('a\nb\nc\n', 'a\nc\n', 'a\nB\nc\n').conflict, true)
})

test('末尾の改行の有無を保つ', () => {
  assert.equal(mergeText('a\nb', 'A\nb', 'a\nB').text, 'A\nB')
})

test('同じ行の変更は止める', () => {
  assert.equal(mergeText('a\nb\n', 'x\nb\n', 'y\nb\n').conflict, true)
})

test('同じ変更はぶつからない', () => {
  assert.deepEqual(mergeText('a\n', 'b\n', 'b\n'), { conflict: false, text: 'b\n' })
})

test('差し替えは変わった部分だけ', () => {
  assert.deepEqual(minimalChange('abcdef', 'abXdef'), { from: 2, to: 3, insert: 'X' })
  assert.equal(minimalChange('a', 'a'), null)
})

function harness(initial = 'one\n', options = {}) {
  const timers = []
  const events = []
  const writes = []
  const backups = []
  const draftStore = new Map()
  const state = { text: initial, composing: false, fail: false, conflict: null, hash: 'h0' }
  const doc = {
    get: () => state.text,
    set: (text) => { state.text = text },
    composing: () => state.composing,
    // 実際の変換中だけ保存を待つ。表のマスの編集中は、確定した本文なら保存してよい。
    holdSave: () => (state.holdSave === undefined ? state.composing : state.holdSave),
  }
  const api = {
    write: async (path, text, hash) => {
      writes.push({ text, hash })
      if (state.fail) throw new Error('down')
      if (state.conflict) {
        const value = state.conflict
        state.conflict = null
        return { conflict: true, current: value.text, hash: value.hash }
      }
      return { conflict: false, hash: `h${writes.length}` }
    },
    backup: async (path, text) => {
      if (state.backupFail) throw new Error('gone')
      backups.push(text)
    },
  }
  const drafts = {
    set: (path, draft) => {
      if (state.draftFull) return false
      draftStore.set(path, draft)
      return true
    },
    remove: (path) => draftStore.delete(path),
    get: (path) => draftStore.get(path),
  }
  const saver = createSaver({
    doc, api, path: 'a.md', baseText: initial, baseHash: 'h0', drafts, ...options,
    onStatus: (e) => events.push(e),
    schedule: (fn, ms) => {
      const t = { fn, ms }
      timers.push(t)
      return t
    },
    cancel: (t) => {
      const i = timers.indexOf(t)
      if (i >= 0) timers.splice(i, 1)
    },
  })
  const tick = async () => {
    const t = timers.shift()
    if (t) t.fn()
    await new Promise((r) => setImmediate(r))
  }
  return { saver, state, timers, events, writes, backups, tick, draftStore, setWrite: (fn) => { api.write = fn } }
}

const lastState = (events) => events.at(-1)?.state

// 前の下書きから1秒以上たってから打ったことにする（下書きを残す予定を作らずに、すぐ下書きに書く）。
function typeLater(saver) {
  const realNow = Date.now
  Date.now = () => realNow() + 5000
  try {
    saver.changed()
  } finally {
    Date.now = realNow
  }
}

test('入力してから2秒で保存する', async () => {
  const h = harness()
  h.state.text = 'two\n'
  h.saver.changed()
  assert.equal(h.timers[0].ms, SAVE_DELAY_MS)
  assert.equal(SAVE_DELAY_MS, 2000)
  await h.tick()
  assert.deepEqual(h.writes, [{ text: 'two\n', hash: 'h0' }])
  assert.equal(lastState(h.events), 'saved')
  assert.equal(h.draftStore.size, 0)
})

test('開いただけでは保存しない', async () => {
  const h = harness()
  await h.saver.save()
  assert.equal(h.writes.length, 0)
})

test('外部の変更で消える内容はバックアップに残す', async () => {
  const h = harness('saved\n')
  h.saver.applyExternal('override\n', 'h9')
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(h.backups, ['saved\n'])
  assert.equal(h.state.text, 'override\n')
})

test('バックアップの内容に戻すと保存され、戻す前の内容も残る', async () => {
  const h = harness('now\n')
  await h.saver.restore('old\n')
  assert.equal(h.state.text, 'old\n')
  assert.deepEqual(h.backups, ['now\n'])
  while (h.timers.length) await h.tick()
  assert.equal(h.writes.at(-1).text, 'old\n')
})

test('控えを送っている間に別のノートへ移ったら、戻さない（移った先の画面に入れない）', async () => {
  const h = harness('now\n')
  let release
  const gate = new Promise((r) => { release = r })
  const original = h.saver
  // 控えの送信が終わる前に、このノートの保存係が閉じる（別のノートを開いた）
  const pending = original.restore('old\n')
  original.close()
  release()
  await gate
  const result = await pending
  assert.equal(result, false)
  assert.equal(h.state.text, 'now\n')
})

test('閉じた保存係では、戻すことも控えを送ることもしない', async () => {
  const h = harness('now\n')
  h.saver.close()
  assert.equal(await h.saver.restore('old\n'), false)
  assert.equal(h.state.text, 'now\n')
  assert.deepEqual(h.backups, [])
})

test('ノートを切り替える前に保存しきる', async () => {
  const h = harness('a\n')
  h.state.text = 'b\n'
  h.saver.changed()
  await h.saver.flush()
  assert.equal(h.writes.at(-1).text, 'b\n')
  assert.equal(h.draftStore.size, 0)
})

test('保存の途中でノートを切り替えても、別のノートの内容を下書きにしない', async () => {
  const h = harness('a\n')
  h.state.text = 'b\n'
  h.saver.changed()
  const pending = h.saver.save()
  h.saver.close()
  h.state.text = 'OTHER NOTE'
  await pending
  assert.equal(h.draftStore.size, 0)
  assert.equal(h.timers.length, 0)
})

test('保存が断られたら再試行せず止める', async () => {
  const h = harness('a\n')
  h.state.text = 'b\n'
  const write = async () => { throw Object.assign(new Error('not editable'), { status: 403 }) }
  h.setWrite(write)
  h.saver.changed()
  await h.tick()
  assert.equal(lastState(h.events), 'blocked')
  assert.equal(h.timers.length, 0)
  assert.equal(h.draftStore.get('a.md').text, 'b\n')
})

test('編集していないときの外部の変更はそのまま画面に出す', () => {
  const h = harness('a\n')
  h.saver.applyExternal('b\n', 'h9')
  assert.equal(h.state.text, 'b\n')
  assert.equal(h.timers.length, 0, '受け取っただけでは書き戻さない')
})

test('編集中に別の行が変わると合わせて保存する', async () => {
  const h = harness('a\nb\nc\nd\ne\n')
  h.state.text = 'A\nb\nc\nd\ne\n'
  h.saver.changed()
  h.saver.applyExternal('a\nb\nc\nd\nE\n', 'h9')
  assert.equal(h.state.text, 'A\nb\nc\nd\nE\n')
  while (h.timers.length) await h.tick()
  assert.deepEqual(h.writes, [{ text: 'A\nb\nc\nd\nE\n', hash: 'h9' }])
})

test('同じ行がぶつかると止まり、どちらも失わない', async () => {
  const h = harness('a\n')
  h.state.text = 'mine\n'
  h.saver.changed()
  h.saver.applyExternal('theirs\n', 'h9')
  assert.equal(lastState(h.events), 'conflict')
  assert.equal(h.state.text, 'mine\n', '画面の内容は消えない')
  assert.equal(h.timers.length, 0, '自動保存は止まる')
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(h.backups, ['mine\n'])
  h.state.text = 'mine2\n'
  typeLater(h.saver)
  assert.equal(h.timers.length, 0, '止まっている間は保存しない')
  await h.saver.resolve('mine')
  assert.ok(h.backups.includes('theirs\n'), '選ばなかった方を残す')
  while (h.timers.length) await h.tick()
  assert.deepEqual(h.writes.at(-1), { text: 'mine2\n', hash: 'h9' })
})

test('ファイルの内容を選ぶと自分の内容はバックアップに残る', async () => {
  const h = harness('a\n')
  h.state.text = 'mine\n'
  h.saver.changed()
  h.saver.applyExternal('theirs\n', 'h9')
  await h.saver.resolve('theirs')
  assert.equal(h.state.text, 'theirs\n')
  assert.ok(h.backups.includes('mine\n'))
  assert.equal(h.writes.length, 0)
})

test('保存時に先を越されていたら合わせ直す', async () => {
  const h = harness('a\nb\nc\nd\ne\n')
  h.state.text = 'A\nb\nc\nd\ne\n'
  h.state.conflict = { text: 'a\nb\nc\nd\nE\n', hash: 'h9' }
  h.saver.changed()
  while (h.timers.length) await h.tick()
  assert.equal(h.state.text, 'A\nb\nc\nd\nE\n')
  assert.equal(h.writes.at(-1).text, 'A\nb\nc\nd\nE\n')
})

test('自分の保存の知らせでは何も変えない', async () => {
  const h = harness('a\n')
  h.state.text = 'b\n'
  h.saver.changed()
  await h.tick()
  h.saver.applyExternal('b\n', 'h1')
  assert.equal(h.state.text, 'b\n')
  assert.equal(h.timers.length, 0)
})

test('サーバーが止まると下書きを残して再試行する', async () => {
  const h = harness('a\n')
  h.state.fail = true
  h.state.text = 'b\n'
  h.saver.changed()
  await h.tick()
  assert.equal(lastState(h.events), 'offline')
  assert.equal(h.draftStore.get('a.md').text, 'b\n')
  assert.equal(h.timers.length, 1)
  h.state.fail = false
  await h.tick()
  assert.equal(lastState(h.events), 'saved')
  assert.equal(h.draftStore.size, 0)
})

test('変換中は保存も外部の反映も待つ', async () => {
  const h = harness('a\nb\nc\n')
  h.state.composing = true
  h.state.text = 'aあ\nb\nc\n'
  h.saver.changed()
  await h.tick()
  assert.equal(h.writes.length, 0)
  h.saver.applyExternal('a\nb\nC\n', 'h9')
  assert.equal(h.state.text, 'aあ\nb\nc\n')
  h.state.composing = false
  h.saver.compositionEnded()
  assert.equal(h.state.text, 'aあ\nb\nC\n')
})

test('欄に戻ったあとに入力中の終わりが届いても、外の変更はまだ反映しない', async () => {
  // ノートの情報の欄でEnterを押すと、いったん欄から外れてすぐ戻る。外れたときの知らせが遅れて届く。
  const h = harness('a\nb\nc\n')
  h.state.composing = true
  h.saver.applyExternal('a\nb\nC\n', 'h9')
  assert.equal(h.state.text, 'a\nb\nc\n')
  h.saver.compositionEnded()
  assert.equal(h.state.text, 'a\nb\nc\n')
  h.state.composing = false
  h.saver.compositionEnded()
  assert.equal(h.state.text, 'a\nb\nC\n')
})

// サーバーは、もうないノートの控えを断る（控えの前にノートを読むため）。画面の内容は下書きにだけ残る。
test('ノートが消えたら止めて、画面の内容を下書きに残す', async () => {
  const h = harness('a\n')
  h.state.backupFail = true
  h.state.text = 'b\n'
  h.saver.changed()
  h.draftStore.clear()
  h.saver.removed()
  await new Promise((r) => setImmediate(r))
  assert.equal(lastState(h.events), 'removed')
  assert.deepEqual(h.backups, [])
  assert.equal(h.draftStore.get('a.md')?.text, 'b\n')
  assert.equal(h.timers.length, 0)
})

// 動かす・ゴミ箱に入れる前の保存でぶつかったら、止まっていることが分かる。画面側はそれを見て断る。
test('保存しきる途中で同じ行がぶつかったら、止まったと分かり入力は下書きに残る', async () => {
  const h = harness('a\n')
  h.state.text = 'mine\n'
  h.saver.changed()
  h.draftStore.clear()
  h.state.conflict = { text: 'theirs\n', hash: 'h9' }
  assert.equal(await h.saver.flush(), false)
  assert.equal(h.saver.isStopped(), 'conflict')
  assert.equal(h.state.text, 'mine\n')
  assert.equal(h.draftStore.get('a.md')?.text, 'mine\n')
})

test('残っていた下書きを今のファイルと合わせて戻す', () => {
  const h = harness('a\nb\nc\nd\nE\n')
  const restored = h.saver.restoreDraft({ text: 'A\nb\nc\nd\ne\n', baseText: 'a\nb\nc\nd\ne\n' })
  assert.equal(restored, true)
  assert.equal(h.state.text, 'A\nb\nc\nd\nE\n')
})

test('下書きがぶつかるときは止めて両方残す', () => {
  const h = harness('theirs\n')
  h.saver.restoreDraft({ text: 'mine\n', baseText: 'old\n' })
  assert.equal(h.state.text, 'mine\n')
  assert.equal(lastState(h.events), 'conflict')
  assert.equal(h.saver.isStopped(), 'conflict')
})

test('消えたあとに戻ったら、保存を再開する', async () => {
  const h = harness('one\n')
  h.saver.removed()
  assert.equal(h.saver.isStopped(), 'removed')
  h.state.text = 'one\nmine\n'
  h.saver.changed()
  h.saver.applyExternal('one\n', 'h0')
  assert.equal(h.saver.isStopped(), null)
  assert.equal(lastState(h.events), 'dirty')
  await h.tick()
  await h.tick()
  assert.equal(h.writes.at(-1).text, 'one\nmine\n')
})

test('編集できない形に変わってから戻ったら、合成して保存を再開する', async () => {
  const h = harness('a\nb\nc\n')
  h.saver.blocked()
  h.state.text = 'A\nb\nc\n'
  h.saver.changed()
  h.saver.applyExternal('a\nb\nC\n', 'h9')
  assert.equal(h.saver.isStopped(), null)
  assert.equal(h.state.text, 'A\nb\nC\n')
  await h.tick()
  assert.deepEqual(h.writes.at(-1), { text: 'A\nb\nC\n', hash: 'h9' })
})

test('保存中に閉じても、最後の入力が下書きに残る', async () => {
  const h = harness('one\n')
  let finish
  h.setWrite(() => new Promise((resolve) => { finish = resolve }))
  h.state.text = 'two\n'
  h.saver.changed()
  await h.tick()
  h.state.text = 'three\n'
  h.saver.close()
  assert.equal(h.draftStore.get('a.md').text, 'three\n')
  finish({ conflict: false, hash: 'h1' })
  await new Promise((r) => setImmediate(r))
  assert.equal(h.draftStore.get('a.md').text, 'three\n', '保存したものと違う下書きは消さない')
})

test('保存中に閉じて保存が失敗しても、最後の入力を上書きしない', async () => {
  const h = harness('one\n')
  let fail
  h.setWrite(() => new Promise((_, reject) => { fail = reject }))
  h.state.text = 'two\n'
  h.saver.changed()
  await h.tick()
  h.state.text = 'three\n'
  h.saver.close()
  fail(new Error('down'))
  await new Promise((r) => setImmediate(r))
  assert.equal(h.draftStore.get('a.md').text, 'three\n')
})

test('保存中に閉じて同じ内容が保存できたら、下書きを消す', async () => {
  const h = harness('one\n')
  let finish
  h.setWrite(() => new Promise((resolve) => { finish = resolve }))
  h.state.text = 'two\n'
  h.saver.changed()
  await h.tick()
  h.saver.close()
  finish({ conflict: false, hash: 'h1' })
  await new Promise((r) => setImmediate(r))
  assert.equal(h.draftStore.size, 0)
})

test('サーバーが別のVaultに変わったら止まり、外の変更でも再開しない', async () => {
  const h = harness('one\n')
  h.setWrite(async () => {
    throw Object.assign(new Error('other vault'), { status: 412 })
  })
  h.state.text = 'two\n'
  h.saver.changed()
  await h.tick()
  assert.equal(h.saver.isStopped(), 'elsewhere')
  assert.equal(lastState(h.events), 'elsewhere')
  assert.equal(h.timers.length, 0, '書き込みを繰り返さない')
  h.saver.applyExternal('other\n', 'h9')
  assert.equal(h.saver.isStopped(), 'elsewhere')
  assert.equal(h.state.text, 'two\n')
  assert.equal(h.draftStore.get('a.md').text, 'two\n')
})

test('別のVaultの知らせが何度来ても、知らせ直さない', () => {
  const h = harness('one\n')
  h.saver.elsewhere()
  h.saver.elsewhere()
  assert.equal(h.events.filter((e) => e.state === 'elsewhere').length, 1)
})

test('今の内容と同じ下書きは、戻さずに消す', () => {
  const h = harness('one\n')
  h.draftStore.set('a.md', { text: 'one\n', baseText: 'zero\n' })
  assert.equal(h.saver.restoreDraft(h.draftStore.get('a.md')), false)
  assert.equal(h.draftStore.size, 0)
})

test('表のマスの編集中も保存は進め、外部の変更だけ待つ', async () => {
  const h = harness('one\n')
  h.state.composing = true
  h.state.holdSave = false
  h.state.text = 'two\n'
  h.saver.changed()
  await h.tick()
  assert.equal(h.writes.at(-1)?.text, 'two\n')
  assert.equal(lastState(h.events), 'saved')
  h.saver.applyExternal('other\n', 'h9')
  assert.equal(h.state.text, 'two\n', '編集中は画面を変えない')
  h.state.composing = false
  h.saver.compositionEnded()
  assert.equal(h.state.text, 'other\n', '保存済みなので、編集が終われば外部の内容を取り込む')
  assert.equal(h.saver.isStopped(), null)
})

// 保存されていない入力は、開いただけでは反映しない。先に聞いてから反映する。
test('保存されていない入力は、開いただけでは反映も保存もしない', () => {
  const h = harness('a\nb\nc\nd\nE\n')
  const draft = { text: 'A\nb\nc\nd\ne\n', baseText: 'a\nb\nc\nd\ne\n', time: 1 }
  h.draftStore.set('a.md', draft)
  const pending = h.saver.checkDraft(draft)
  assert.equal(pending.conflict, false)
  assert.equal(pending.preview, 'A\nb\nc\nd\nE\n')
  assert.equal(pending.time, 1)
  assert.equal(h.state.text, 'a\nb\nc\nd\nE\n')
  assert.equal(h.timers.length, 0)
  assert.equal(h.writes.length, 0)
  assert.equal(h.draftStore.size, 1)
})

test('同じ行がぶつかる入力は、反映したときの見本を作らない', () => {
  const h = harness('theirs\n')
  const pending = h.saver.checkDraft({ text: 'mine\n', baseText: 'old\n' })
  assert.equal(pending.conflict, true)
  assert.equal(pending.preview, null)
  assert.equal(h.state.text, 'theirs\n')
})

test('今の内容と同じ入力は、聞かずに消す', () => {
  const h = harness('one\n')
  h.draftStore.set('a.md', { text: 'one\n', baseText: 'zero\n' })
  assert.equal(h.saver.checkDraft(h.draftStore.get('a.md')), null)
  assert.equal(h.saver.checkDraft(undefined), null)
  assert.equal(h.draftStore.size, 0)
})

test('「反映する」で今のノートとまとめて保存する', () => {
  const h = harness('a\nb\nc\nd\nE\n')
  assert.equal(h.saver.applyDraft({ text: 'A\nb\nc\nd\ne\n', baseText: 'a\nb\nc\nd\ne\n' }), true)
  assert.equal(h.state.text, 'A\nb\nc\nd\nE\n')
  assert.equal(h.timers[0].ms, 0)
})

test('「反映しない」で入力を捨て、ノートはそのまま', () => {
  const h = harness('one\n')
  h.draftStore.set('a.md', { text: 'two\n', baseText: 'one\n' })
  h.saver.discardDraft()
  assert.equal(h.draftStore.size, 0)
  assert.equal(h.state.text, 'one\n')
  assert.equal(h.timers.length, 0)
})

// 聞いている間と、ぶつかったあとに、残っていた入力を失わない。
test('聞いている間は、外の変更が来ても残っていた入力を消さない', () => {
  const h = harness('a\nb\nc\n')
  const draft = { text: 'A\nb\nc\n', baseText: 'a\nb\nc\n', time: 1 }
  h.draftStore.set('a.md', draft)
  assert.ok(h.saver.checkDraft(draft))
  h.saver.applyExternal('a\nb\nC\n', 'h9')
  assert.deepEqual(h.draftStore.get('a.md'), draft)
  h.saver.close()
  assert.deepEqual(h.draftStore.get('a.md'), draft)
})

test('聞いている間に打っても、残っていた入力を上書きしない', () => {
  const h = harness('a\n')
  const draft = { text: 'A\n', baseText: 'a\n', time: 1 }
  h.draftStore.set('a.md', draft)
  h.saver.checkDraft(draft)
  h.state.text = 'a\nnew\n'
  h.saver.changed()
  assert.deepEqual(h.draftStore.get('a.md'), draft)
})

test('「反映する」がぶつかったまま閉じても、次に開くとまたぶつかる', () => {
  const h = harness('X\nb\nc\nAI\n')
  const draft = { text: 'MINE\nb\nc\n', baseText: 'a\nb\nc\n', time: 1 }
  h.draftStore.set('a.md', draft)
  h.saver.checkDraft(draft)
  h.saver.applyDraft(draft)
  assert.equal(h.saver.isStopped(), 'conflict')
  h.saver.close()
  const kept = h.draftStore.get('a.md')
  assert.equal(kept.baseText, 'a\nb\nc\n')
  const again = harness('X\nb\nc\nAI\n')
  assert.equal(again.saver.checkDraft(kept).conflict, true)
})

test('入力した時刻は、打ったときだけ変わる', async () => {
  const realNow = Date.now
  let now = 1000
  Date.now = () => now
  try {
    const h = harness('one\n')
    h.state.text = 'two\n'
    h.saver.changed()
    assert.equal(h.draftStore.get('a.md').time, 1000)
    now = 99000
    h.saver.close()
    assert.equal(h.draftStore.get('a.md').time, 1000)
  } finally {
    Date.now = realNow
  }
})

// 続けて打っている最中にアプリが落ちても、最後の入力が1秒ほどで下書きに入っているようにする。
test('続けて打った最後の入力も、1秒ほどで下書きに残す', async () => {
  const realNow = Date.now
  let now = 1000
  Date.now = () => now
  try {
    const h = harness('one\n')
    h.state.text = 'two\n'
    h.saver.changed()
    assert.equal(h.draftStore.get('a.md').text, 'two\n')
    now = 1400
    h.state.text = 'three\n'
    h.saver.changed()
    // 前の下書きから1秒たっていないので、この時点ではまだ書かない。
    assert.equal(h.draftStore.get('a.md').text, 'two\n')
    const draftTimer = h.timers.find((t) => t.ms !== SAVE_DELAY_MS)
    assert.ok(draftTimer, '最後の入力を下書きに残す予定がない')
    assert.equal(draftTimer.ms, 600)
    now = 2000
    draftTimer.fn()
    assert.equal(h.draftStore.get('a.md').text, 'three\n')
    assert.equal(h.draftStore.get('a.md').time, 1400)
  } finally {
    Date.now = realNow
  }
})

test('続けて打っても、下書きを残す予定は1つだけにする', () => {
  const realNow = Date.now
  let now = 1000
  Date.now = () => now
  try {
    const h = harness('one\n')
    for (const [t, text] of [[1000, 'a\n'], [1200, 'b\n'], [1500, 'c\n'], [1800, 'd\n']]) {
      now = t
      h.state.text = text
      h.saver.changed()
    }
    assert.equal(h.timers.filter((t) => t.ms !== SAVE_DELAY_MS).length, 1)
  } finally {
    Date.now = realNow
  }
})

test('閉じたあとは、残す予定だった下書きを書かない（画面は別のノート）', () => {
  const realNow = Date.now
  let now = 1000
  Date.now = () => now
  try {
    const h = harness('one\n')
    h.state.text = 'two\n'
    h.saver.changed()
    now = 1400
    h.state.text = 'three\n'
    h.saver.changed()
    h.saver.close()
    assert.equal(h.draftStore.get('a.md').text, 'three\n')
    assert.equal(h.timers.length, 0, '閉じたのに予定が残っている')
  } finally {
    Date.now = realNow
  }
})

// 下書きを残す予定を、保存の予定と分けて取り出す（保存の予定は SAVE_DELAY_MS で入る）。
const draftTimers = (h) => h.timers.filter((t) => t.ms !== SAVE_DELAY_MS)

function withClock(fn) {
  const realNow = Date.now
  const clock = { now: 1000 }
  Date.now = () => clock.now
  try {
    return fn(clock)
  } finally {
    Date.now = realNow
  }
}

test('残す予定が、閉じたあとで動いても、画面にある別のノートを下書きにしない', () => withClock((clock) => {
  const h = harness('one\n')
  h.state.text = 'two\n'
  h.saver.changed()
  clock.now = 1400
  h.state.text = 'three\n'
  h.saver.changed()
  const [draftTimer] = draftTimers(h)
  h.saver.close()
  h.state.text = 'other note\n'
  clock.now = 2000
  draftTimer.fn()
  assert.equal(h.draftStore.get('a.md').text, 'three\n')
}))

test('保存できたあとで残す予定が動いても、消した下書きを戻さない', async () => {
  await withClock(async (clock) => {
    const h = harness('one\n')
    h.state.text = 'two\n'
    h.saver.changed()
    clock.now = 1400
    h.state.text = 'three\n'
    h.saver.changed()
    const [draftTimer] = draftTimers(h)
    await h.saver.flush()
    assert.equal(h.draftStore.size, 0)
    clock.now = 2000
    draftTimer.fn()
    assert.equal(h.draftStore.size, 0)
  })
})

test('残す予定が動いたあとに打つと、次の予定はそこから1秒後', () => withClock((clock) => {
  const h = harness('one\n')
  h.state.text = 'a\n'
  h.saver.changed()
  clock.now = 1400
  h.state.text = 'b\n'
  h.saver.changed()
  clock.now = 2000
  draftTimers(h)[0].fn()
  h.timers.splice(h.timers.indexOf(draftTimers(h)[0]), 1)
  clock.now = 2300
  h.state.text = 'c\n'
  h.saver.changed()
  assert.deepEqual(draftTimers(h).map((t) => t.ms), [700])
}))

test('1秒たってから打つと、残っていた予定を取り消して、すぐ下書きに書く', () => withClock((clock) => {
  const h = harness('one\n')
  h.state.text = 'a\n'
  h.saver.changed()
  clock.now = 1400
  h.state.text = 'b\n'
  h.saver.changed()
  assert.equal(draftTimers(h).length, 1)
  // 予定が遅れているうちに、前の下書きから1秒を過ぎて打った。
  clock.now = 2500
  h.state.text = 'c\n'
  h.saver.changed()
  assert.equal(draftTimers(h).length, 0)
  assert.equal(h.draftStore.get('a.md').text, 'c\n')
}))

test('時計が戻っても、下書きを長く待たせない', () => withClock((clock) => {
  const h = harness('one\n')
  clock.now = 600_000
  h.state.text = 'a\n'
  h.saver.changed()
  // 時計が10分戻った。
  clock.now = 1000
  h.state.text = 'b\n'
  h.saver.changed()
  assert.ok(draftTimers(h).every((t) => t.ms <= 1000), JSON.stringify(draftTimers(h).map((t) => t.ms)))
  assert.equal(h.draftStore.get('a.md').text, 'b\n')
}))

// 保存しきる途中でほかの画面の別の行の変更を取り込んだら、まとめた内容も保存しきってから返す。
test('保存しきる途中で別の行の変更を取り込んだら、まとめた内容まで保存する', async () => {
  const h = harness('a\nb\nc\n')
  h.state.text = 'A\nb\nc\n'
  h.saver.changed()
  h.state.conflict = { text: 'a\nb\nC\n', hash: 'h9' }
  assert.equal(await h.saver.flush(), true)
  assert.equal(h.state.text, 'A\nb\nC\n')
  assert.equal(h.writes.at(-1).text, 'A\nb\nC\n')
  assert.equal(h.saver.isStopped(), null)
})

test('保存しきれなかったら、保存しきれていないと返す', async () => {
  const h = harness('a\n')
  h.state.text = 'b\n'
  h.saver.changed()
  h.state.fail = true
  assert.equal(await h.saver.flush(), false)
})

test('大きすぎて保存できないときは、繰り返さずに知らせ、次に打てばまた保存する', async () => {
  const h = harness('one\n')
  let calls = 0
  h.setWrite(async () => {
    calls += 1
    throw Object.assign(new Error('too large'), { status: 413 })
  })
  h.state.text = 'two\n'
  h.saver.changed()
  await h.tick()
  assert.equal(lastState(h.events), 'toolarge')
  assert.equal(h.timers.length, 0, '書き込みを繰り返さない')
  assert.equal(h.saver.isStopped(), null)
  assert.equal(h.draftStore.get('a.md').text, 'two\n')
  h.setWrite(async () => ({ conflict: false, hash: 'h2' }))
  h.state.text = 'tw\n'
  typeLater(h.saver)
  await h.tick()
  assert.equal(lastState(h.events), 'saved')
  assert.equal(calls, 1)
})

test('大きすぎる保存を送っている間に減らしたら、今の内容でもう一度保存する', async () => {
  const h = harness('one\n')
  let finish
  h.setWrite(() => new Promise((resolve, reject) => { finish = reject }))
  h.state.text = 'big\n'
  h.saver.changed()
  await h.tick()
  h.state.text = 'small\n'
  finish(Object.assign(new Error('too large'), { status: 413 }))
  await new Promise((r) => setImmediate(r))
  assert.notEqual(lastState(h.events), 'toolarge')
  assert.equal(h.timers.length, 1, 'もう一度保存する')
  h.setWrite(async (_path, text) => ({ conflict: false, hash: `h-${text}` }))
  await h.tick()
  assert.equal(lastState(h.events), 'saved')
})

test('下書きに入りきらないときは、そのことを知らせに含め、保存できれば元に戻す', async () => {
  const h = harness('one\n')
  h.state.draftFull = true
  h.setWrite(async () => { throw Object.assign(new Error('offline'), { status: 0 }) })
  h.state.text = 'two\n'
  h.saver.changed()
  await h.tick()
  const last = h.events.at(-1)
  assert.equal(last.state, 'offline')
  assert.equal(last.draftKept, false)
  assert.equal(h.saver.draftKept(), false)
  assert.equal(h.draftStore.size, 0)
  // 下書きに書けないままでも、保存できれば失うものはないので元に戻る。
  h.setWrite(async () => ({ conflict: false, hash: 'h2' }))
  await h.tick()
  assert.equal(lastState(h.events), 'saved')
  assert.equal(h.saver.draftKept(), true)
})

test('下書きに書けたときは、知らせにもそう含める', async () => {
  const h = harness('one\n')
  h.setWrite(async () => { throw Object.assign(new Error('offline'), { status: 0 }) })
  h.state.text = 'two\n'
  h.saver.changed()
  await h.tick()
  assert.equal(h.events.at(-1).draftKept, true)
  assert.equal(h.draftStore.get('a.md').text, 'two\n')
})

test('保存を止めている間に下書きに書けなくなったら、止めた知らせを今の値で出し直す', async () => {
  const h = harness('one\n')
  h.state.text = 'two\n'
  h.saver.changed()
  h.saver.blocked()
  assert.equal(h.events.at(-1).state, 'blocked')
  assert.equal(h.events.at(-1).draftKept, true)
  h.state.draftFull = true
  h.state.text = 'three\n'
  // 下書きは間を空けて書くので、少し待ったことにする。
  const realNow = Date.now
  Date.now = () => realNow() + 5000
  try {
    h.saver.changed()
  } finally {
    Date.now = realNow
  }
  assert.equal(h.events.at(-1).state, 'blocked')
  assert.equal(h.events.at(-1).draftKept, false)
})

test('今すぐ下書きを書く口は、間を空けずに書いて結果を返す', () => {
  const h = harness('one\n')
  h.state.text = 'two\n'
  h.saver.changed()
  h.state.text = 'two and more\n'
  h.state.draftFull = true
  assert.equal(h.saver.keepNow(), false)
  h.state.draftFull = false
  assert.equal(h.saver.keepNow(), true)
  assert.equal(h.draftStore.get('a.md').text, 'two and more\n')
})

test('元の内容に戻したら、下書きに書けなくても失うものはないとする', () => {
  const h = harness('one\n')
  h.state.draftFull = true
  h.state.text = 'two\n'
  assert.equal(h.saver.keepNow(), false)
  h.state.text = 'one\n'
  assert.equal(h.saver.keepNow(), true)
})

test('今すぐ下書きを書いたときに書けなくなっても、止めた知らせを出し直し、次に打っても正しいまま', () => {
  const h = harness('one\n')
  h.state.text = 'two\n'
  h.saver.changed()
  h.saver.blocked()
  assert.equal(h.events.at(-1).draftKept, true)
  h.state.draftFull = true
  h.state.text = 'big\n'
  assert.equal(h.saver.keepNow(), false)
  assert.equal(h.events.at(-1).state, 'blocked')
  assert.equal(h.events.at(-1).draftKept, false)
  // 書けるようになったら、また出し直す。
  h.state.draftFull = false
  assert.equal(h.saver.keepNow(), true)
  assert.equal(h.events.at(-1).draftKept, true)
})

test('衝突で止めている間に外の内容が自分の内容と同じになったら、止めるのをやめ、そのあとの入力も保存する', async () => {
  const h = harness('a\n')
  h.state.text = 'mine\n'
  h.saver.changed()
  h.state.conflict = { text: 'theirs\n', hash: 'h9' }
  assert.equal(await h.saver.flush(), false)
  assert.equal(h.saver.isStopped(), 'conflict')
  h.saver.applyExternal('mine\n', 'h10')
  assert.equal(lastState(h.events), 'saved')
  assert.equal(h.saver.isStopped(), null, '「保存済み」と出すなら、保存を止めたままにしない')
  h.state.text = 'mine more\n'
  h.saver.changed()
  while (h.timers.length) await h.tick()
  assert.equal(h.writes.at(-1).text, 'mine more\n')
  assert.equal(lastState(h.events), 'saved')
})

test('保存を送っている間に衝突で止まったら、あとから成功が返っても「保存済み」にせず、止めたままにする', async () => {
  const h = harness('a\nb\nc\n')
  let finish
  h.setWrite(() => new Promise((resolve) => { finish = resolve }))
  h.state.text = 'a\nB\nc\n'
  h.saver.changed()
  await h.tick()
  // 送っている間に、同じ行が外で変わった知らせが届き、衝突で止まる。
  h.saver.applyExternal('a\nX\nc\n', 'h9')
  assert.equal(h.saver.isStopped(), 'conflict')
  finish({ conflict: false, hash: 'h1' })
  await new Promise((r) => setImmediate(r))
  assert.equal(h.saver.isStopped(), 'conflict')
  assert.equal(lastState(h.events), 'conflict', '止めたままなら「保存済み」と出さない')
  // ファイルはもう外の内容なので、自分の内容は失いうるものとして扱う（下書きに書けなければ確認が出る）。
  h.state.draftFull = true
  assert.equal(h.saver.keepNow(), false)
})

test('衝突で止めたまま閉じたあとで、送っていた保存の成功が返っても、下書きを消さない', async () => {
  const h = harness('a\nb\nc\n')
  let finish
  h.setWrite(() => new Promise((resolve) => { finish = resolve }))
  h.state.text = 'a\nB\nc\n'
  h.saver.changed()
  await h.tick()
  h.saver.applyExternal('a\nX\nc\n', 'h9')
  h.saver.close()
  assert.equal(h.draftStore.get('a.md').text, 'a\nB\nc\n')
  finish({ conflict: false, hash: 'h1' })
  await new Promise((r) => setImmediate(r))
  assert.equal(h.draftStore.get('a.md')?.text, 'a\nB\nc\n')
})

test('サーバーで保存に失敗したときは「つながりません」ではなく理由を知らせ、少しあとで試し直す', async () => {
  const h = harness('one\n')
  h.setWrite(async () => { throw Object.assign(new Error('EACCES'), { status: 500, code: 'EACCES' }) })
  h.state.text = 'two\n'
  h.saver.changed()
  await h.tick()
  assert.equal(lastState(h.events), 'failed')
  assert.equal(h.events.at(-1).reason, 'EACCES')
  assert.equal(h.timers.length, 1, '試し直す')
})

test('サーバーから返事が来ない保存は打ち切って、返事がないと知らせ、試し直す', async () => {
  const h = harness('one\n', { writeTimeout: 20 })
  h.setWrite(() => new Promise(() => {}))
  h.state.text = 'two\n'
  h.saver.changed()
  await h.tick()
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(lastState(h.events), 'offline')
  assert.equal(h.events.at(-1).noReply, true)
  assert.equal(h.timers.length, 1, '試し直す')
})

test('打ち切った保存があとで届いても、続けて打った自分の入力と食い違いにせず、そのまま保存を続ける', async () => {
  const h = harness('a\nb\nc\n', { writeTimeout: 20 })
  h.setWrite(() => new Promise(() => {}))
  h.state.text = 'a\nB\nc\n'
  h.saver.changed()
  await h.tick()
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(lastState(h.events), 'offline')
  // 返事を待つ間に、同じ行を打ち続けた。
  h.state.text = 'a\nBB\nc\n'
  h.saver.changed()
  // 打ち切った保存が、あとでサーバーに書かれ、その知らせが届いた。
  h.saver.applyExternal('a\nB\nc\n', 'hB')
  assert.notEqual(h.saver.isStopped(), 'conflict')
  assert.equal(h.state.text, 'a\nBB\nc\n')
  h.setWrite(async (_path, text, baseHash) => ({ conflict: false, hash: `ok-${baseHash}-${text.length}` }))
  while (h.timers.length) await h.tick()
  assert.equal(lastState(h.events), 'saved')
})

test('400番台で保存に失敗したときも「つながりません」ではなく失敗として知らせる', async () => {
  const h = harness('one\n')
  h.setWrite(async () => { throw Object.assign(new Error('bad'), { status: 400 }) })
  h.state.text = 'two\n'
  h.saver.changed()
  await h.tick()
  assert.equal(lastState(h.events), 'failed')
})

test('打ち切りが2回続いたあとで、1回目の保存が届いても、自分の入力どうしで食い違いにしない', async () => {
  const h = harness('a\nb\nc\n', { writeTimeout: 20 })
  h.setWrite(() => new Promise(() => {}))
  h.state.text = 'a\nB1\nc\n'
  h.saver.changed()
  await h.tick()
  await new Promise((r) => setTimeout(r, 60))
  h.state.text = 'a\nB2\nc\n'
  h.saver.changed()
  while (h.timers.length) {
    await h.tick()
    await new Promise((r) => setTimeout(r, 60))
    if (lastState(h.events) === 'offline' && h.timers.length === 1) break
  }
  // サーバーが動き出して、1回目の保存（B1）だけが書かれた知らせが届く。
  h.state.text = 'a\nB3\nc\n'
  h.saver.changed()
  h.saver.applyExternal('a\nB1\nc\n', 'hB1')
  assert.notEqual(h.saver.isStopped(), 'conflict')
  assert.equal(h.state.text, 'a\nB3\nc\n')
})

test('下書きには、書き直した時刻も入れる（期限はこれで数える）', () => {
  const h = harness('one\n')
  h.state.text = 'two\n'
  const before = Date.now()
  h.saver.changed()
  const draft = h.draftStore.get('a.md')
  assert.ok(draft.savedAt >= before)
})

test('保存に typedAt を付け、許されないときは付けない', async () => {
  const run = async (options) => {
    const h = harness('a\n', options)
    const args = []
    h.setWrite(async (...a) => { args.push(a); return { conflict: false, hash: 'h1' } })
    h.state.text = 'b\n'
    h.saver.changed()
    await h.tick()
    return args[0][3]
  }
  assert.equal(typeof await run({}), 'number')
  assert.equal(await run({ typedAtAllowed: () => false }), undefined)
})
