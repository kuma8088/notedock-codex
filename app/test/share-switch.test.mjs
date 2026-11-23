import assert from 'node:assert/strict'
import { test } from 'node:test'

import { OFF_UNSAVED_NOTE, SHARE_OFF_NOTICE_AFTER, SHARE_OFF_RETRY_MS, createShareSwitch } from '../src/share-switch.mjs'

function fakeTimers() {
  let next = 1
  const pending = new Map()
  return {
    setTimeout(fn) {
      const id = next++
      pending.set(id, fn)
      return id
    },
    clearTimeout(id) {
      pending.delete(id)
    },
    // 予約されている保存し直しを1回動かす。
    async fire() {
      const [id, fn] = [...pending][0] ?? []
      if (!fn) return false
      pending.delete(id)
      await fn()
      return true
    },
    get count() {
      return pending.size
    },
  }
}

// サーバーの代わり。PUT の結果は putResults から順に取り出す（'fail' は保存の失敗、'hold' は答えを待たせる）。
function setup({ putResults = [], confirmAnswer = () => true } = {}) {
  let stored = false
  const held = []
  const puts = []
  const request = async (url, options = {}) => {
    if ((options.method ?? 'GET') === 'GET') return { ok: true, data: { on: stored } }
    const body = JSON.parse(options.body)
    puts.push(body.on)
    const next = putResults.shift() ?? 'ok'
    if (next === 'hold') await new Promise((resolve) => held.push(resolve))
    if (next === 'fail' || next === 'hold-fail') return { ok: false, data: {} }
    stored = body.on
    return { ok: true, data: { on: stored } }
  }
  const ui = { checked: false, disabled: false, note: null, notices: {}, messages: [] }
  const timers = fakeTimers()
  const enabled = []
  const saves = []
  const sw = createShareSwitch({
    request,
    timers,
    onSaved: (on) => saves.push(on),
    confirmOn: async () => confirmAnswer(),
    ui: {
      getChecked: () => ui.checked,
      setChecked: (on) => { ui.checked = on },
      setDisabled: (d) => { ui.disabled = d },
      setNotice: (kind, text) => {
        if (text) ui.notices[kind] = text
        else delete ui.notices[kind]
        ui.note = ui.notices.offUnsaved ?? null
      },
      message: (text) => ui.messages.push(text),
    },
  })
  sw.attach({ setEnabled: async (on) => { enabled.push(on) } })
  const press = (on) => {
    ui.checked = on
    return sw.save()
  }
  const release = () => held.shift()?.()
  return { sw, ui, timers, enabled, puts, saves, press, release, stored: () => stored, setStored: (on) => { stored = on } }
}

test('オフの保存に失敗したら、この画面では送るのをやめ、間をおいて保存し直す。続けて失敗したら知らせる', async () => {
  const fails = Array(SHARE_OFF_NOTICE_AFTER + 1).fill('fail')
  const t = setup({ putResults: ['ok', ...fails] })
  await t.press(true)
  await t.press(false)
  assert.equal(t.ui.checked, false)
  assert.equal(t.sw.pendingOff, true)
  assert.deepEqual(t.enabled.at(-1), false)
  assert.equal(await t.sw.confirmShare(), false)
  assert.equal(t.timers.count, 1)
  for (let i = 1; i < SHARE_OFF_NOTICE_AFTER; i++) {
    await t.timers.fire()
    assert.equal(t.ui.note, null)
  }
  await t.timers.fire()
  assert.equal(t.ui.note, OFF_UNSAVED_NOTE)
  // 読み直しでも、オンに戻さない（保存し直しに回す）。
  await t.sw.load()
  assert.equal(t.ui.checked, false)
  // 保存できたら終わる。
  while (t.sw.pendingOff && (await t.timers.fire()));
  assert.equal(t.sw.pendingOff, false)
  assert.equal(t.stored(), false)
  assert.equal(t.timers.count, 0)
})

test('保存し直しの途中で本人がオンに押し直したら、古い保存し直しの結果（成功）でオフに戻さない', async () => {
  const t = setup({ putResults: ['ok', 'fail', 'hold', 'ok'] })
  await t.press(true)
  await t.press(false) // 失敗。保存し直しを予約
  const retry = t.timers.fire() // 保存し直しの PUT が飛んでいる途中
  await new Promise((resolve) => setTimeout(resolve, 0))
  await t.press(true) // 本人がオンに押し直す（成功）
  assert.equal(t.ui.checked, true)
  t.release() // 古い保存し直しが成功で返る
  await retry
  assert.equal(t.ui.checked, true)
  assert.equal(t.enabled.at(-1), true)
  assert.equal(t.timers.count, 0)
})

test('保存し直しの途中で本人がオンに押し直したら、古い保存し直しの結果（失敗）で予約し直さない', async () => {
  const t = setup({ putResults: ['ok', 'fail', 'hold-fail', 'ok'] })
  await t.press(true)
  await t.press(false)
  const retry = t.timers.fire()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await t.press(true)
  t.release()
  await retry
  assert.equal(t.ui.checked, true)
  assert.equal(t.sw.pendingOff, false)
  assert.equal(t.timers.count, 0)
  assert.equal(t.ui.note, null)
})

test('オンの保存に失敗したら、スイッチをオフに戻して知らせる', async () => {
  const t = setup({ putResults: ['fail'] })
  await t.press(true)
  assert.equal(t.ui.checked, false)
  assert.equal(t.ui.messages.length, 1)
  assert.equal(t.timers.count, 0)
})

test('保存の途中はスイッチを押せず、終わったら戻る', async () => {
  const t = setup({ putResults: ['hold'] })
  const saving = t.press(true)
  await new Promise((resolve) => setTimeout(resolve, 0)) // オンにする前の確かめのあと
  assert.equal(t.ui.disabled, true)
  t.release()
  await saving
  assert.equal(t.ui.disabled, false)
})

test('押す前に出た読み直しの結果は使わない', async () => {
  const t = setup({ putResults: ['ok'] })
  const reading = t.sw.load() // オフを読みに行く
  await t.press(true)
  await reading
  assert.equal(t.ui.checked, true)
})

test('閉じたあとは、保存し直しも読み直しもしない', async () => {
  const t = setup({ putResults: ['ok', 'fail'] })
  await t.press(true)
  await t.press(false)
  t.sw.close()
  assert.equal(t.timers.count, 0)
  const before = t.puts.length
  await t.sw.retrySaveOff()
  await t.sw.load()
  assert.equal(t.puts.length, before)
  assert.equal(await t.sw.confirmShare(), false)
})

test('送る直前の確認は、「オン」を使い回さず毎回確かめる（ほかの画面でオフにされたら、すぐ分かる）', async () => {
  const t = setup({ putResults: ['ok'] })
  await t.press(true)
  assert.equal(await t.sw.confirmShare(), true)
  t.setStored(false) // ほかの画面でオフにした
  assert.equal(await t.sw.confirmShare(), false)
})

test('「オフ」は少しのあいだ使い回し、自分の画面で保存したら捨てる', async () => {
  const t = setup({ putResults: ['ok'] })
  assert.equal(await t.sw.confirmShare(), false)
  t.setStored(true) // 使い回しのあいだはオフのまま（送らない側）
  assert.equal(await t.sw.confirmShare(), false)
  await t.press(true)
  assert.equal(await t.sw.confirmShare(), true)
})

test('オフの保存し直しを待つ途中でオンに押し直し、その保存も失敗したら、オフの保存し直しを続ける', async () => {
  const t = setup({ putResults: ['ok', 'fail', 'fail', 'ok'] })
  await t.press(true)
  await t.press(false) // オフの保存に失敗：保存し直しを予約
  await t.press(true) // オンの保存にも失敗
  assert.equal(t.ui.checked, false)
  assert.equal(t.sw.pendingOff, true)
  assert.equal(t.timers.count, 1)
  assert.equal(await t.sw.confirmShare(), false)
  // 読み直しでもオンに戻らない（サーバーはオンのまま）。
  await t.sw.load()
  assert.equal(t.ui.checked, false)
  while (t.sw.pendingOff && (await t.timers.fire()));
  assert.equal(t.stored(), false)
})

test('保存し直しの PUT が飛んでいる途中に読み直しが来ても、保存し直しを重ねて走らせない', async () => {
  const t = setup({ putResults: ['ok', 'fail', 'hold'] })
  await t.press(true)
  await t.press(false)
  const retry = t.timers.fire()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const before = t.puts.length
  await t.sw.load() // フォーカスや60秒おきの読み直し
  await t.sw.retrySaveOff()
  assert.equal(t.puts.length, before)
  t.release()
  await retry
  assert.equal(t.sw.pendingOff, false)
})

test('古い保存し直し（オフ）が押し直し（オン）より後にサーバーへ届いても、次の読み直しで表示をサーバーに合わせる', async () => {
  const t = setup({ putResults: ['ok', 'fail', 'ok'] })
  await t.press(true)
  await t.press(false)
  await t.press(true)
  assert.equal(t.ui.checked, true)
  t.setStored(false) // 遅れて届いたオフの保存
  await t.sw.load()
  assert.equal(t.ui.checked, false)
  assert.equal(t.enabled.at(-1), false)
})

test('オフの保存し直しの知らせは、保存できるまで残り、ほかの知らせが消えても消えない', async () => {
  const t = setup({ putResults: ['ok', 'fail', 'fail', 'fail', 'fail', 'fail', 'ok'] })
  await t.press(true)
  await t.press(false)
  for (let i = 0; i < SHARE_OFF_NOTICE_AFTER; i++) await t.timers.fire()
  assert.equal(t.ui.notices.offUnsaved, OFF_UNSAVED_NOTE)
  // 読み直し（オフ）で「伝えられない」の知らせを消しても、オフを保存できていない知らせは残る。
  t.ui.notices.blocked = 'この画面では会話にノートを伝えられません'
  await t.timers.fire()
  assert.equal(t.ui.notices.offUnsaved, OFF_UNSAVED_NOTE)
  while (t.sw.pendingOff && (await t.timers.fire()));
  assert.equal(t.ui.notices.offUnsaved, undefined)
})

test('押し直しの保存が返らないあいだに保存し直しの予約が来ても、予約が切れない', async () => {
  const t = setup({ putResults: ['ok', 'fail', 'hold', 'fail', 'ok'] })
  await t.press(true)
  await t.press(false) // 失敗：保存し直しを予約
  const retry = t.timers.fire() // 保存し直しの PUT が返らない
  await new Promise((resolve) => setTimeout(resolve, 0))
  await t.press(true) // オンの保存も失敗：予約し直す
  assert.equal(t.timers.count, 1)
  await t.timers.fire() // 予約が来たが、前の保存し直しがまだ飛んでいる
  t.release() // 古い保存し直しが返る（押し直しより古いので使わない）
  await retry
  assert.equal(t.sw.pendingOff, true)
  assert.equal(t.timers.count, 1)
  while (t.sw.pendingOff && (await t.timers.fire()));
  assert.equal(t.stored(), false)
})

test('押す前に出た読み直し（オフ）が、押した保存（オン）より後に返っても、使い回しに入れない', async () => {
  const t = setup({ putResults: ['ok'] })
  const reading = t.sw.readShare() // オフを読みに行く（まだ返らない扱い）
  await t.press(true)
  await reading
  assert.equal(await t.sw.confirmShare(), true)
})

test('保存できたときだけ、ほかのタブへ知らせる（保存し直しで保存できたときも）', async () => {
  const t = setup({ putResults: ['ok', 'fail', 'fail', 'ok'] })
  await t.press(true)
  assert.deepEqual(t.saves, [true])
  await t.press(false) // 失敗：知らせない
  assert.deepEqual(t.saves, [true])
  await t.timers.fire() // 保存し直しも失敗
  assert.deepEqual(t.saves, [true])
  await t.timers.fire() // 保存し直しで保存できた
  assert.deepEqual(t.saves, [true, false])
})

test('オンにする前に確かめ、断られたらオンにせず保存もしない。オフにするときは確かめない', async () => {
  let answer = false
  const t = setup({ putResults: ['ok', 'ok'], confirmAnswer: () => answer })
  await t.press(true)
  assert.equal(t.ui.checked, false)
  assert.deepEqual(t.puts, [])
  answer = true
  await t.press(true)
  assert.equal(t.ui.checked, true)
  answer = false
  await t.press(false)
  assert.equal(t.ui.checked, false)
  assert.deepEqual(t.puts, [true, false])
})

test('確かめの画面で断ったら、読み直して表示をサーバーの値に合わせる', async () => {
  const t = setup({ confirmAnswer: () => false })
  t.setStored(true) // 確かめの画面を出している間に、ほかのタブでオンにされていた
  await t.press(true)
  assert.equal(t.ui.checked, true)
  assert.deepEqual(t.puts, [])
  assert.equal(t.enabled.at(-1), true)
})
