// パネルから下書きをサーバーへ送るキュー。DOMにもサーバーにも依存しない。
export const DRAFT_GAP_MS = 1000
export const BIG_DRAFT_GAP_MS = 5000
export const BIG_NOTE_BYTES = 1_000_000

// 1文字は最大3バイトなので、短い本文はバイト数を数えずに済ませる。
export function isBig(text) {
  if (text.length <= BIG_NOTE_BYTES / 3) return false
  return new TextEncoder().encode(text).length > BIG_NOTE_BYTES
}

export function createDraftSync({ send, schedule = setTimeout, cancel = clearTimeout, now = Date.now }) {
  const queues = new Map()

  function queue(path) {
    let q = queues.get(path)
    if (!q) {
      q = {
        inflight: false,
        held: false,
        lastStart: null, // 前の put を送り始めた時刻
        lastOk: null, // 最後に成功した put の { text, baseHash }
        gen: 0, // forget のたびに増やす
        clear: false, // 待っている clear
        put: null, // 待っている put（一番新しい1つ）
        timer: null,
      }
      queues.set(path, q)
    }
    return q
  }

  function stopTimer(q) {
    if (q.timer !== null) cancel(q.timer)
    q.timer = null
  }

  async function run(path, q, op) {
    q.inflight = true
    const gen = q.gen
    let ok = false
    try {
      ok = (await send(op)) === true
    } catch {
      ok = false
    }
    q.inflight = false
    if (op.kind === 'put' && ok && gen === q.gen) q.lastOk = { text: op.draft.text, baseHash: op.draft.baseHash }
    if (!ok) q.lastOk = null
    pump(path)
  }

  function pump(path) {
    const q = queue(path)
    if (q.inflight || q.held) return
    if (q.clear) {
      q.clear = false
      stopTimer(q)
      q.lastOk = null
      run(path, q, { kind: 'clear', path })
      return
    }
    if (!q.put) return
    if (q.lastOk && q.lastOk.text === q.put.text && q.lastOk.baseHash === q.put.baseHash) {
      q.put = null
      stopTimer(q)
      return
    }
    const gap = isBig(q.put.text) ? BIG_DRAFT_GAP_MS : DRAFT_GAP_MS
    const at = q.lastStart === null ? 0 : q.lastStart + gap
    const wait = at - now()
    if (wait > 0) {
      if (q.timer === null) {
        q.timer = schedule(() => {
          q.timer = null
          pump(path)
        }, wait)
      }
      return
    }
    stopTimer(q)
    const draft = q.put
    q.put = null
    q.lastStart = now()
    run(path, q, { kind: 'put', path, draft })
  }

  return {
    put(path, draft) {
      const q = queue(path)
      if (q.held) return
      const same = q.lastOk && q.lastOk.text === draft.text && q.lastOk.baseHash === draft.baseHash
      // 送信中や clear 待ちがあると、サーバーの中身は lastOk のままとは限らない。
      // そのときは待ち枠に入れ、送る直前にもう一度比べる。
      if (same && !q.inflight && !q.clear) {
        // サーバーは既に同じ中身。待っていた put だけ捨てる。
        q.put = null
        stopTimer(q)
        return
      }
      q.put = draft
      pump(path)
    },
    clear(path) {
      const q = queue(path)
      if (q.held) return
      q.put = null
      q.clear = true
      pump(path)
    },
    hold(path) {
      const q = queue(path)
      q.held = true
      q.put = null
      q.clear = false
      stopTimer(q)
      // forget と同じ。保留が明けたあとの同じ中身も送る。
      q.lastOk = null
      q.gen += 1
    },
    release(path) {
      queue(path).held = false
    },
    held(path) {
      return queue(path).held
    },
    forget(path) {
      const q = queue(path)
      q.lastOk = null
      q.gen += 1
    },
  }
}
