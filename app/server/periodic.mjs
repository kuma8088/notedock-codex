import fs from 'node:fs'
import path from 'node:path'

import { PERIODS, buildNote, isValidDate, monthGrid, notePath } from '../src/periodic.mjs'
import { createNote } from './notes.mjs'
import { resolveFolderPath, resolveNotePath } from './paths.mjs'

export class BadRequest extends Error {
  constructor(message) {
    super(message)
    this.status = 400
  }
}

const bad = (message) => ({ error: 'bad-settings', message })

// 置き場とひな形は、フォルダーごとの設定（vault-settings.mjs）から受け取る。
// 設定がなければ、どこにも作らない。
const YEAR_FOLDERS = ['Quarterly', 'Monthly', 'Weekly', 'Daily']

function exists(vaultRoot, rel) {
  try {
    return fs.lstatSync(resolveNotePath(vaultRoot, rel)).isFile()
  } catch {
    return false
  }
}

export function checkNow(now) {
  if (typeof now !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(now) || !isValidDate(now.slice(0, 10))) {
    throw new BadRequest('nowの形が正しくありません')
  }
  const hour = Number(now.slice(11, 13))
  const minute = Number(now.slice(14, 16))
  if (hour > 23 || minute > 59) throw new BadRequest('nowの形が正しくありません')
}

export function checkRequestShape({ period, date, now }) {
  if (!PERIODS.includes(period)) throw new BadRequest('periodが正しくありません')
  if (typeof date !== 'string' || !isValidDate(date)) throw new BadRequest('dateが正しくありません')
  checkNow(now)
}

// loadPeriodic() は { root, templates } を返す。置き場が決まっていなければ、理由をつけて止める（409）。
export function openPeriodic(vaultRoot, request, loadPeriodic) {
  const body = request && typeof request === 'object' ? request : {}
  checkRequestShape(body)
  const { period, date, now } = body
  const { root: periodicRoot, templates } = loadPeriodic()
  // あるかどうかは、決まった場所（例：<置き場>/2026/Daily/2026-11-08.md）だけで見る。
  // なければ、足りないフォルダーごと作る（createNote）。
  const expected = notePath(periodicRoot, period, date)
  if (body.dryRun === true) return exists(vaultRoot, expected) ? { path: expected, exists: true } : { path: null, exists: false }
  // まず、その年のフォルダー（Quarterly・Monthly・Weekly・Daily）があるかを確かめ、なければまとめて作る。
  // 年のフォルダーは、年のノートならその親、それ以外はもう1つ上。週はISOの年に入る。
  const yearDir = period === 'yearly' ? path.posix.dirname(expected) : path.posix.dirname(path.posix.dirname(expected))
  for (const sub of YEAR_FOLDERS) fs.mkdirSync(resolveFolderPath(vaultRoot, `${yearDir}/${sub}`), { recursive: true })
  // 次に、決まった場所にノートがあるかを確かめる。あれば開くだけ。
  if (exists(vaultRoot, expected)) return { path: expected, created: false }
  let template = ''
  if (templates[period]) {
    try {
      // Windowsで作ったひな形（改行が CRLF、先頭に BOM）からでも、編集できるノートになるようにそろえる。
      template = fs.readFileSync(resolveNotePath(vaultRoot, templates[period]), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
    } catch {
      const body = bad(`ひな形を読めません：${templates[period]}`)
      throw Object.assign(new Error(body.message), { status: 409, body })
    }
  }
  const text = buildNote({ period, date, now, template })
  try {
    createNote(vaultRoot, expected, text)
  } catch (error) {
    if (error.code === 'EEXIST') return { path: expected, created: false }
    throw error
  }
  return { path: expected, created: true }
}

// periodic が null（置き場が決まっていない）なら { disabled: true }。画面はカレンダーの代わりに案内を出す。
export function periodicMonth(vaultRoot, month, periodic) {
  let grid
  try {
    grid = monthGrid(month)
  } catch {
    throw new BadRequest('monthの形が正しくありません')
  }
  if (!periodic) return { disabled: true }
  const periodicRoot = periodic.root
  const has = (period, date) => exists(vaultRoot, notePath(periodicRoot, period, date))
  const first = `${month}-01`
  return {
    periodicRoot,
    days: grid.days.filter((day) => has('daily', day)),
    weeks: grid.weeks.filter((week) => has('weekly', week.start)).map((week) => week.name),
    month: has('monthly', first),
    quarter: has('quarterly', first),
    year: has('yearly', first),
  }
}
