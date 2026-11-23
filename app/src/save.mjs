import { mergeText } from './merge.mjs'

export const SAVE_DELAY_MS = 2000
const RETRY_MS = 3000
// サーバーから返事が来ないまま待ち続けないよう、保存はこの時間で打ち切って、もう一度試す。
// 打ち切ったあとで前の保存が届いても、次の保存は元の内容の照合で食い違いとして扱われ、内容は失われない。
export const WRITE_TIMEOUT_MS = 30_000
const DRAFT_GAP_MS = 1000

// 保存と外部変更の取り込みを担当する。画面には doc（読み書き）と status（知らせ）だけを通して触る。
export function createSaver({ doc, api, path, baseText, baseHash, onStatus, drafts, delay = SAVE_DELAY_MS, retry = RETRY_MS, schedule = setTimeout, cancel = clearTimeout, writeTimeout = WRITE_TIMEOUT_MS, typedAtAllowed = () => true }) {
  let base = baseText
  let hash = baseHash
  let timer = null
  let saving = false
  let again = false
  let stopped = null
  let conflictTheirs = null
  let pendingExternal = null
  let closed = false
  let inFlight = null
  let lastDraft = 0
  // 続けて打っている間、まだ下書きに入っていない入力を、前の下書きから1秒たったら残す予定。
  let draftTimer = null
  // 反映するか聞いている間の、残っていた入力。答えが出るまで保存領域のそれには触らない。
  let held = null
  // 「反映する」がぶつかったときの、その入力のもとの内容。次に開いたときも正しくぶつかるように残す。
  let draftBase = null
  // 最後に打った時刻。閉じたときや再試行では変えない。
  let typedAt = null

  // 最後に下書きを書こうとしたとき、書けたか。ブラウザーの保存場所に入りきらないと書けない。
  let draftKept = true
  // 保存を止めている間の最後の知らせ。下書きに書けたかが変わったら、同じ知らせを今の値で出し直す。
  let lastStopped = null
  // 返事が来ずに打ち切った保存で送った内容（続けて打ち切ったときは全部）。あとでどれかが書かれたと知らせが来たら、
  // 自分の入力として扱う。保存が成功したときと、画面を別の内容に替えたときに空にする。
  const abandoned = new Set()
  const status = (state, detail) => {
    lastStopped = ['conflict', 'removed', 'blocked', 'elsewhere'].includes(state) ? { state, detail, kept: draftKept } : null
    onStatus?.({ state, draftKept, ...detail })
  }
  // 止めている間、最後に知らせたときと下書きに書けたかが違えば、同じ知らせを今の値で出し直す。
  function refreshStopped() {
    if (stopped && lastStopped && lastStopped.kept !== draftKept) status(lastStopped.state, lastStopped.detail)
  }
  const dirty = () => doc.get() !== base

  function clearDraft() {
    if (held) return
    drafts?.remove(path)
    draftKept = true
  }

  function keepDraft() {
    if (held) return
    // 元の内容に戻っていれば、失うものはない。
    // time は最後に打った時刻（聞くときに出す）。savedAt は下書きを書き直した時刻（30日の期限はこれで数える）。
    draftKept = dirty() ? drafts?.set(path, { text: doc.get(), baseText: draftBase ?? base, baseHash: hash, time: typedAt ?? Date.now(), savedAt: Date.now() }) !== false : true
  }

  function arm(ms = delay) {
    if (closed) return
    if (timer) cancel(timer)
    timer = schedule(() => {
      timer = null
      save()
    }, ms)
  }

  function changed() {
    typedAt = Date.now()
    // 大きいノートで打つたびに全文を書かないよう、下書きは間を空けて残す。
    // 間の途中で打った分は、前の下書きから1秒たったときに残す（そのあとアプリが落ちても入っているように）。
    // 時計が戻ったとき（since が負）も、待たずにすぐ書く。
    const since = Date.now() - lastDraft
    if (since >= DRAFT_GAP_MS || since < 0) {
      if (draftTimer) {
        cancel(draftTimer)
        draftTimer = null
      }
      lastDraft = Date.now()
      keepDraft()
      refreshStopped()
    } else if (!draftTimer) {
      draftTimer = schedule(() => {
        draftTimer = null
        if (closed) return
        lastDraft = Date.now()
        keepDraft()
        refreshStopped()
      }, DRAFT_GAP_MS - since)
    }
    if (stopped) return
    status('dirty')
    arm()
  }

  async function save() {
    if (timer) {
      cancel(timer)
      timer = null
    }
    if (closed || stopped) return
    if (doc.holdSave?.()) {
      arm(500)
      return
    }
    if (saving) {
      again = true
      return
    }
    const text = doc.get()
    // 本文を取ったのと同じ時点の、最後に打った時刻。
    const sentTypedAt = typedAt
    if (text === base) {
      clearDraft()
      status('saved')
      return
    }
    saving = true
    status('saving')
    try {
      inFlight = withTimeout(api.write(path, text, hash, typedAtAllowed() && sentTypedAt != null ? sentTypedAt : undefined), writeTimeout)
      const result = await inFlight
      saving = false
      if (result.conflict) {
        // 閉じたときに最新の入力を下書きにしてあるので、古い内容で上書きしない。
        if (closed) return
        applyExternal(result.current, result.hash)
        // 編集中で取り込みを待っているときは、保存できていないことを見せておく。
        if (pendingExternal) status('dirty')
      } else {
        // 送っている間にぶつかって止めたなら、ファイルはもう外の内容になっている。元の内容を自分の内容にすると
        // 「失うものはない」と判定されてしまうので、元の内容は変えない（衝突を解くときに決め直す）。
        // 閉じたあとでも同じで、下書きは消さない（自分の内容が残っているのは下書きだけかもしれない）。
        if (stopped === 'conflict') {
          if (closed) return
          again = false
          keepDraft()
          refreshStopped()
          return
        }
        base = text
        hash = result.hash
        abandoned.clear()
        // ノートを切り替えたあとは、画面にあるのは別のノートなので触らない。
        if (closed) {
          if (drafts?.get(path)?.text === text) clearDraft()
          return
        }
        // 送っている間にほかの理由で保存を止めたなら、止めた知らせのままにする。「保存済み」と出したまま止めない。
        if (stopped) {
          again = false
          keepDraft()
          refreshStopped()
          return
        }
        if (doc.get() === base) {
          clearDraft()
          status('saved')
        } else {
          keepDraft()
          arm()
        }
      }
    } catch (error) {
      saving = false
      if (closed) return
      keepDraft()
      if (error.status === 403) {
        blocked()
        return
      }
      if (error.status === 412) {
        elsewhere()
        return
      }
      // 編集できるフォルダーが変わった（rootId が違う）。帯は出さず、未保存の小さな印のまま、少しあとで試し直す。
      // そのあいだにパネルが受け取り直す。同じフォルダーに戻れば、この試し直しで保存される。
      if (error.status === 423) {
        status('dirty')
        arm(retry)
        return
      }
      // 大きすぎて保存できない。繰り返しても同じなので、次に打つまで待つ（短くすれば保存できる）。
      // 送っている間に打った（減らした）ときは、今の内容でもう一度試す。
      if (error.status === 413) {
        if (again || doc.get() !== text) {
          again = false
          arm(0)
          return
        }
        status('toolarge')
        return
      }
      // 返事がない・つながらないときと、サーバーが保存を断ったときを分けて知らせる。どちらも少しあとで試し直す。
      if (error.timedOut) abandoned.add(text)
      if (Number.isInteger(error.status) && error.status >= 400) status('failed', { reason: error.code ?? null })
      else status('offline', { noReply: Boolean(error.timedOut) })
      arm(retry)
      return
    }
    if (again) {
      again = false
      save()
    }
  }

  function applyExternal(theirs, theirsHash) {
    if (closed) return
    if (doc.composing?.()) {
      pendingExternal = { theirs, theirsHash }
      return
    }
    if (stopped === 'elsewhere') return
    // 打ち切った自分の保存が、あとで書かれただけ。外の変更ではないので、合わせずに元の内容として続ける。
    if (abandoned.has(theirs) && !stopped) {
      abandoned.clear()
      base = theirs
      hash = theirsHash
      if (doc.get() === base) {
        clearDraft()
        status('saved')
      } else {
        keepDraft()
        status('dirty')
        arm(0)
      }
      return
    }
    // ファイルが戻ってきたら、止めていた保存を再開する。
    const resumed = stopped === 'removed' || stopped === 'blocked'
    if (resumed) stopped = null
    if (theirsHash === hash && theirs === base) {
      if (resumed && dirty()) {
        status('dirty')
        arm(0)
      } else if (resumed) {
        status('saved')
      }
      return
    }
    const mine = doc.get()
    if (mine === theirs) {
      base = theirs
      hash = theirsHash
      // 衝突で止めていたなら、もうぶつかっていないので止めるのをやめる（「保存済み」と出したまま止めない）。
      if (stopped === 'conflict') {
        stopped = null
        conflictTheirs = null
        draftBase = null
      }
      clearDraft()
      status('saved')
      return
    }
    if (stopped === 'conflict') {
      conflictTheirs = { text: theirs, hash: theirsHash }
      status('conflict', { theirs })
      return
    }
    const merged = mergeText(base, mine, theirs)
    if (merged.conflict) {
      if (timer) {
        cancel(timer)
        timer = null
      }
      stopped = 'conflict'
      conflictTheirs = { text: theirs, hash: theirsHash }
      api.backup(path, mine).catch(() => {})
      keepDraft()
      status('conflict', { theirs })
      return
    }
    // ファイルパネルのOverrideなどで消える内容も、戻せるように残す。
    if (merged.text !== mine) api.backup(path, mine).catch(() => {})
    base = theirs
    hash = theirsHash
    if (merged.text !== mine) doc.set(merged.text)
    if (merged.text === theirs) {
      clearDraft()
      status('updated')
    } else {
      keepDraft()
      status('dirty')
      arm(0)
    }
  }

  async function resolve(choice) {
    if (stopped !== 'conflict' || !conflictTheirs) return
    const { text: theirs, hash: theirsHash } = conflictTheirs
    const mine = doc.get()
    conflictTheirs = null
    draftBase = null
    stopped = null
    abandoned.clear()
    base = theirs
    hash = theirsHash
    if (choice === 'theirs') {
      await api.backup(path, mine).catch(() => {})
      if (mine !== theirs) doc.set(theirs)
      clearDraft()
      status('saved')
    } else {
      await api.backup(path, theirs).catch(() => {})
      status('dirty')
      arm(0)
    }
  }

  function removed() {
    if (stopped === 'elsewhere') return
    if (timer) {
      cancel(timer)
      timer = null
    }
    stopped = 'removed'
    api.backup(path, doc.get()).catch(() => {})
    keepDraft()
    status('removed')
  }

  function blocked() {
    if (stopped === 'elsewhere') return
    if (timer) {
      cancel(timer)
      timer = null
    }
    stopped = 'blocked'
    keepDraft()
    status('blocked')
  }

  // タブを開いたあとで、サーバーが別のフォルダーのものに変わった。ここの内容を向こうへ書かない。
  function elsewhere() {
    if (stopped === 'elsewhere') return
    if (timer) {
      cancel(timer)
      timer = null
    }
    stopped = 'elsewhere'
    pendingExternal = null
    keepDraft()
    status('elsewhere')
  }

  function compositionEnded() {
    if (pendingExternal) {
      const { theirs, theirsHash } = pendingExternal
      pendingExternal = null
      applyExternal(theirs, theirsHash)
    }
    if (!stopped && dirty()) arm()
  }

  // 保存されていない入力が残っているか。開いただけでは反映しない。
  // 反映したときの見本（同じ行がぶつかるときは null）を返す。今の内容と同じなら黙って消す。
  function checkDraft(draft) {
    if (!draft) return null
    if (draft.text === doc.get()) {
      clearDraft()
      return null
    }
    const merged = mergeText(draft.baseText, draft.text, base)
    held = draft
    return { draft, time: draft.time, conflict: merged.conflict, preview: merged.conflict ? null : merged.text, current: base }
  }

  function discardDraft() {
    held = null
    abandoned.clear()
    clearDraft()
  }

  function applyDraft(draft) {
    held = null
    return restoreDraft(draft)
  }

  // 「反映する」を選んだとき。今のファイルとまとめて保存する。同じ行がぶつかれば止めて選ばせる。
  function restoreDraft(draft) {
    if (!draft) return false
    if (draft.text === doc.get()) {
      clearDraft()
      return false
    }
    const merged = mergeText(draft.baseText, draft.text, base)
    if (merged.conflict) {
      doc.set(draft.text)
      stopped = 'conflict'
      conflictTheirs = { text: base, hash }
      draftBase = draft.baseText
      typedAt = draft.time ?? typedAt
      keepDraft()
      status('conflict', { theirs: base })
      return true
    }
    doc.set(merged.text)
    status('dirty')
    arm(0)
    return true
  }

  // バックアップの内容に戻す。戻す前の内容もバックアップに残す。
  async function restore(text) {
    if (closed) return false
    abandoned.clear()
    await api.backup(path, doc.get()).catch(() => {})
    // 控えを送っている間に別のノートへ移っていたら（このノートの保存係が閉じていたら）、戻さない。
    // 戻すと、移った先のノートの画面に、このノートの控えの中身が入ってしまう。
    if (closed) return false
    doc.set(text)
    if (!stopped) arm(0)
    return true
  }

  return {
    restore,
    changed,
    save,
    applyExternal,
    resolve,
    removed,
    compositionEnded,
    restoreDraft,
    applyDraft,
    checkDraft,
    discardDraft,
    blocked,
    elsewhere,
    isStopped: () => stopped,
    // 今の中身の元にした、保存されている中身のハッシュ（フォルダーを受け取り直すときに、同じ中身かを確かめる）。
    baseHash: () => hash,
    draftKept: () => draftKept,
    // 間を空けずに今すぐ下書きを書き、書けたかを返す。ノートを切り替える・閉じる前の確認に使う。
    keepNow() {
      if (held) return true
      keepDraft()
      refreshStopped()
      return draftKept
    },
    // ノートを切り替える・動かす前に、未保存の内容を保存しきる。保存できなければ下書きに残る。
    // 途中でほかの画面の変更を取り込んだら、まとめた内容も保存する。保存しきれたかを返す。
    async flush() {
      for (let i = 0; i < 3; i++) {
        if (saving) await inFlight?.catch(() => {})
        if (stopped || closed || !dirty()) break
        await save()
      }
      return !stopped && !dirty()
    },
    close() {
      keepDraft()
      closed = true
      if (timer) cancel(timer)
      if (draftTimer) {
        cancel(draftTimer)
        draftTimer = null
      }
    },
  }
}

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('no reply'), { timedOut: true })), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
