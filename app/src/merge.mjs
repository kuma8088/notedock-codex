import { diffIndices } from 'node-diff3'

function hunks(base, side) {
  return diffIndices(base, side).map((hunk) => ({
    start: hunk.buffer1[0],
    end: hunk.buffer1[0] + hunk.buffer1[1],
    lines: side.slice(hunk.buffer2[0], hunk.buffer2[0] + hunk.buffer2[1]),
  }))
}

const sameHunk = (a, b) => a.start === b.start && a.end === b.end && a.lines.join('\n') === b.lines.join('\n')

function collide(a, b) {
  if (a.start === a.end && b.start === b.end) return a.start === b.start
  if (a.start === a.end) return a.start > b.start && a.start < b.end
  if (b.start === b.end) return b.start > a.start && b.start < a.end
  return a.start < b.end && b.start < a.end
}

// 行ごとの3者合成。隣の行でも別の行なら合わせ、同じ行を両方が変えていたら conflict を返す。
export function mergeText(base, mine, theirs) {
  if (mine === theirs) return { conflict: false, text: mine }
  if (base === mine) return { conflict: false, text: theirs }
  if (base === theirs) return { conflict: false, text: mine }
  const baseLines = base.split('\n')
  const ours = hunks(baseLines, mine.split('\n'))
  const other = hunks(baseLines, theirs.split('\n'))
  const merged = [...ours]
  for (const hunk of other) {
    if (ours.some((candidate) => sameHunk(candidate, hunk))) continue
    if (ours.some((candidate) => collide(candidate, hunk))) return { conflict: true, text: null }
    merged.push(hunk)
  }
  merged.sort((a, b) => a.start - b.start || a.end - b.end)
  const out = []
  let at = 0
  for (const hunk of merged) {
    out.push(...baseLines.slice(at, hunk.start), ...hunk.lines)
    at = hunk.end
  }
  out.push(...baseLines.slice(at))
  return { conflict: false, text: out.join('\n') }
}

// 変わった部分だけの差し替えにする。カーソルの位置を保つため。
export function minimalChange(from, to) {
  if (from === to) return null
  let start = 0
  const max = Math.min(from.length, to.length)
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start += 1
  let endFrom = from.length
  let endTo = to.length
  while (endFrom > start && endTo > start && from.charCodeAt(endFrom - 1) === to.charCodeAt(endTo - 1)) {
    endFrom -= 1
    endTo -= 1
  }
  return { from: start, to: endFrom, insert: to.slice(start, endTo) }
}
