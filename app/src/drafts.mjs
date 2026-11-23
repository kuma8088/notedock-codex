// 保存されていない入力が残っていたときの問いかけ。入力した日時があれば添える。
export function draftQuestion(time) {
  if (!Number.isFinite(time)) return '保存されていない入力があります。反映しますか？'
  const at = new Date(time)
  const hh = String(at.getHours()).padStart(2, '0')
  const mm = String(at.getMinutes()).padStart(2, '0')
  return `保存されていない入力があります（${at.getMonth() + 1}月${at.getDate()}日 ${hh}:${mm} に入力）。反映しますか？`
}

// 下書きは、最後に書き直してから30日で片付ける（前の形の下書きは、入力した日時で数える）。
// 日時が分からない下書きは、判断できないので残す。読めない下書きは片付ける。
export const DRAFT_DAYS = 30
export function expiredDraftKeys(entries, now = Date.now(), maxAge = DRAFT_DAYS * 24 * 60 * 60 * 1000) {
  return entries.filter(([key, raw]) => {
    if (!key.startsWith('draft:')) return false
    let draft
    try {
      draft = JSON.parse(raw)
    } catch {
      return true
    }
    const at = Number.isFinite(draft?.savedAt) ? draft.savedAt : draft?.time
    return Number.isFinite(at) && now - at > maxAge
  }).map(([key]) => key)
}

// 下書きの新しさ。書き直した時刻、なければ入力した時刻。どちらもなければ最も古い扱い。
export function draftAge(draft) {
  if (Number.isFinite(draft?.savedAt)) return draft.savedAt
  if (Number.isFinite(draft?.time)) return draft.time
  return -Infinity
}

// この端末の下書きとサーバーの下書きのうち、新しいほう。同じならこの端末のほう。
export function newerDraft(local, server) {
  if (!local) return server ?? null
  if (!server) return local
  return draftAge(server) > draftAge(local) ? server : local
}

// 遅れて届いた下書きをどうするか。使った下書きより古い・同じ中身なら捨ててよい（start）。
// それ以外は、失わないよう履歴に残す（backup）。
export function lateDraftAction(used, late) {
  if (!late) return 'start'
  if (used && (draftAge(late) <= draftAge(used) || late.text === used.text)) return 'start'
  return 'backup'
}

// 遅れて届いた下書きの後始末。履歴に残せたときだけ手放す。失敗や例外のときは保留のまま。
export async function settleLateDraft({ used, late, backup }) {
  if (lateDraftAction(used, late) === 'start') return 'release'
  try {
    return (await backup(late.text)) === true ? 'release' : 'keep'
  } catch {
    return 'keep'
  }
}

const underPath = (path, base) => path === base || path.startsWith(base + '/')

// ノートやフォルダーを移動したときの、下書きのキーの付け替え。
// 移動先に前からあった下書きで、付け替え先にならないものは古いので消す。
export function draftKeyChanges(keys, prefix, from, to) {
  const move = []
  const targets = new Set()
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue
    const path = key.slice(prefix.length)
    if (!underPath(path, from)) continue
    const next = prefix + to + path.slice(from.length)
    move.push([key, next])
    targets.add(next)
  }
  const remove = keys.filter((key) => key.startsWith(prefix) && underPath(key.slice(prefix.length), to) && !targets.has(key))
  return { move, remove }
}

// ゴミ箱に入れたノートやフォルダーの下書きのキー。
export function trashedDraftKeys(keys, prefix, item) {
  return keys.filter((key) => key.startsWith(prefix) && underPath(key.slice(prefix.length), item))
}
