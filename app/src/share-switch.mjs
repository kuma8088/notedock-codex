// 「開いているノートをAIに伝える」のスイッチと、共有の設定（/api/share、どのタブからも同じ値）のやりとり。
// 画面の部品（ui）と、会話へ伝える仕組み（ai-context.mjs の createAiContext、attach で渡す）をつなぐ。
//
// - 読み直し（load）は通し番号を持ち、スイッチを押す前に出た古い結果や、保存中に届いた結果を使わない。
// - 送る直前の確認（confirmShare）は、「オフ」の結果だけを cacheMs のあいだ使い回す。「オン」は毎回確かめる
//   （ほかの画面でオフにされたことを、使い回しのせいで見落とさないため）。自分の画面で保存したら使い回しを捨てる。
// - オフの保存に失敗したら、この画面では送るのをやめて消し、retryMs おきに保存し直す（noticeAfter 回続けて失敗したら知らせる）。
//   保存し直しの途中で本人がスイッチを押したら、その保存し直しの結果は捨てる（押した操作の結果を優先する）。

export const SHARE_CACHE_MS = 3000
export const SHARE_OFF_RETRY_MS = 5000
export const SHARE_OFF_NOTICE_AFTER = 3
export const OFF_UNSAVED_NOTE = 'オフを保存できていません。この画面では会話に伝えていません'

// request(url, options) は { ok, data } を返す（投げることもある）。
// ui: getChecked(), setChecked(on), setDisabled(disabled), setNotice(kind, text または null), message(text)
// 知らせの種類（kind）: 'blocked'（この画面では伝えられない。送られない側）、'offUnsaved'（オフを保存できていない）。
// 'uncleared'（伝えた内容を消せなかった）は main.mjs が会話へ伝える仕組みの結果から出す。
export function createShareSwitch({
  request,
  ui,
  canCreate = () => true,
  timers = globalThis,
  now = () => Date.now(),
  cacheMs = SHARE_CACHE_MS,
  retryMs = SHARE_OFF_RETRY_MS,
  noticeAfter = SHARE_OFF_NOTICE_AFTER,
  onSaved = () => {}, // 保存できたとき（ほかのタブへ知らせるため）。引数は保存した値
  confirmOn = async () => true, // オンにする前の確かめ。false ならオンにしない
}) {
  let ai = null
  let readTicket = 0 // 読み直しの通し番号
  let saveTicket = 0 // 本人がスイッチを押した回の通し番号（保存し直しの古い結果を見分ける）
  let saving = false
  let pendingOff = false
  let offTries = 0
  let offTimer = null
  let retrying = false // 保存し直しの PUT が飛んでいる途中
  let cache = null
  let closed = false

  const disabled = () => !canCreate() || saving
  const stopRetry = () => {
    timers.clearTimeout(offTimer)
    offTimer = null
  }
  const put = async (on) => {
    try {
      return await request('/api/share', { method: 'PUT', body: JSON.stringify({ on }) })
    } catch {
      return null
    } finally {
      cache = null
    }
  }

  // 読んだ結果は、読んでいる間に本人がスイッチを押していなければ使い回しに入れる（押す前に出た古い結果を入れない）。
  async function readShare() {
    const ticket = saveTicket
    const result = await request('/api/share')
    if (!result.ok) throw new Error('share unreadable')
    const on = result.data?.on === true
    if (ticket === saveTicket && !saving) cache = { on, at: now() }
    return on
  }

  async function confirmShare() {
    if (pendingOff || closed) return false
    if (cache && !cache.on && now() - cache.at < cacheMs) return false
    return readShare()
  }

  async function apply(on) {
    ui.setChecked(on)
    if (!on) ui.setNotice('blocked', null)
    await ai?.setEnabled(on)
  }
  // オフの保存し直しが要るのに予約がなければ、予約する（どの道筋で終わっても、保存し直しの連鎖を切らさない）。
  const keepRetrying = () => {
    if (pendingOff && !closed && !offTimer) offTimer = timers.setTimeout(retrySaveOff, retryMs)
  }

  async function load() {
    if (closed) return
    if (pendingOff) {
      retrySaveOff()
      return
    }
    const ticket = ++readTicket
    let on
    try {
      on = await readShare()
    } catch {
      return
    }
    if (ticket !== readTicket || saving || pendingOff || closed) return
    await apply(on)
  }

  // オフの保存を、成功するまで間をおいて繰り返す。
  async function retrySaveOff() {
    // 予約は、ここで一度取り消す（予約から呼ばれたときは、その予約はもう終わっている）。
    stopRetry()
    // 保存し直しが飛んでいる途中なら、重ねて走らせない（終わったら、結果に応じて予約し直す）。
    if (retrying) return
    if (!pendingOff || closed) return
    const ticket = saveTicket
    retrying = true
    let saved
    try {
      saved = await put(false)
    } finally {
      retrying = false
    }
    // 待っている間に本人がスイッチを押した、オフの保存し直しが要らなくなった、閉じた：この結果は使わない。
    // ただし、まだ保存し直しが要るなら、予約は残す。
    if (!pendingOff || ticket !== saveTicket || closed) {
      keepRetrying()
      return
    }
    if (saved?.ok) {
      pendingOff = false
      offTries = 0
      ui.setNotice('offUnsaved', null)
      onSaved(saved.data?.on === true)
      await apply(saved.data?.on === true)
      return
    }
    offTries++
    if (offTries >= noticeAfter) ui.setNotice('offUnsaved', OFF_UNSAVED_NOTE)
    keepRetrying()
  }

  async function save() {
    const want = ui.getChecked()
    if (want) {
      let ok = false
      try {
        ok = await confirmOn()
      } catch {}
      if (!ok) {
        // 断ったら、表示をサーバーの値に合わせる（確かめの画面を出している間に、ほかのタブで変わっているかもしれない）。
        ui.setChecked(false)
        await load()
        return
      }
    }
    const ticket = ++saveTicket
    readTicket++ // 押す前に出た読み直しの結果は捨てる。
    stopRetry()
    saving = true
    ui.setDisabled(disabled())
    const saved = await put(want)
    saving = false
    ui.setDisabled(disabled())
    // 保存を待っている間に、もう一度押された：あとの操作に任せる（保存し直しが要るなら、予約は残す）。
    if (ticket !== saveTicket || closed) {
      keepRetrying()
      return
    }
    if (!saved?.ok) {
      if (want) {
        ui.setChecked(false)
        ui.message('「開いているノートをAIに伝える」を保存できませんでした。')
        // オフの保存し直しを待っていた途中なら、サーバーはまだオンかもしれない。オフ側を守るため、保存し直しを続ける。
        keepRetrying()
        return
      }
      // オフにしようとして保存できなかった：この画面では送るのをやめて消し、保存をやり直す。
      ui.setChecked(false)
      pendingOff = true
      offTries = 0
      ui.message('オフを保存できませんでした。この画面では会話に伝えるのをやめ、保存をやり直します。')
      await ai?.setEnabled(false)
      keepRetrying()
      return
    }
    pendingOff = false
    offTries = 0
    ui.setNotice('offUnsaved', null)
    onSaved(saved.data?.on === true)
    await apply(saved.data?.on === true)
  }

  return {
    attach(aiContext) {
      ai = aiContext
    },
    readShare,
    confirmShare,
    load,
    save,
    retrySaveOff,
    // タブを閉じる前。以後は読み直しも保存し直しもしない。
    close() {
      closed = true
      readTicket++
      saveTicket++
      stopRetry()
    },
    disabled,
    get saving() {
      return saving
    },
    get pendingOff() {
      return pendingOff
    },
  }
}
