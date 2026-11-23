// 日付のノート（デイリー・週・月・四半期・年）の置き場所・名前・上の期間を決める。
// DOMにもNodeにも頼らない。日付はDate.UTCとgetUTC…だけで計算する。

export const PERIODS = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly']

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 86400000

const pad = (n, w = 2) => String(n).padStart(w, '0')
const toMs = (y, m, d) => Date.UTC(y, m - 1, d)
const fmt = (ms) => {
  const t = new Date(ms)
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}
const parse = (date) => {
  const m = DATE_RE.exec(date)
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
}

export function isValidDate(date) {
  if (typeof date !== 'string') return false
  const m = DATE_RE.exec(date)
  if (!m) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const t = new Date(toMs(y, mo, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}

function mustBeDate(date) {
  if (!isValidDate(date)) throw new Error(`日付の形が正しくありません：${date}`)
}

// 月曜が先頭の曜日番号（月0〜日6）
const weekdayIndex = (ms) => (new Date(ms).getUTCDay() + 6) % 7

export function isoWeek(date) {
  mustBeDate(date)
  const { y, m, d } = parse(date)
  const ms = toMs(y, m, d)
  const thursday = ms + (3 - weekdayIndex(ms)) * DAY_MS
  const year = new Date(thursday).getUTCFullYear()
  const dayOfYear = Math.round((thursday - toMs(year, 1, 1)) / DAY_MS) + 1
  return { year, week: Math.floor((dayOfYear - 1) / 7) + 1 }
}

const quarterOf = (month) => Math.floor((month - 1) / 3) + 1
const weekName = ({ year, week }) => `${pad(year, 4)}-W${pad(week)}`

export function periodInfo(period, date) {
  mustBeDate(date)
  const { y, m, d } = parse(date)
  const ms = toMs(y, m, d)
  const Y = pad(y, 4)
  const monthName = `${Y}-${pad(m)}`
  const quarterName = `${Y}-Q${quarterOf(m)}`
  if (period === 'daily') {
    return { name: date, folder: `${Y}/Daily`, start: date, parents: [weekName(isoWeek(date)), monthName, quarterName, Y] }
  }
  if (period === 'weekly') {
    const wk = isoWeek(date)
    const monday = ms - weekdayIndex(ms) * DAY_MS
    const th = new Date(monday + 3 * DAY_MS)
    const ty = pad(th.getUTCFullYear(), 4)
    const tm = th.getUTCMonth() + 1
    return {
      name: weekName(wk),
      folder: `${pad(wk.year, 4)}/Weekly`,
      start: fmt(monday),
      parents: [`${ty}-${pad(tm)}`, `${ty}-Q${quarterOf(tm)}`, ty],
    }
  }
  if (period === 'monthly') {
    return { name: monthName, folder: `${Y}/Monthly`, start: `${monthName}-01`, parents: [quarterName, Y] }
  }
  if (period === 'quarterly') {
    return { name: quarterName, folder: `${Y}/Quarterly`, start: `${Y}-${pad((quarterOf(m) - 1) * 3 + 1)}-01`, parents: [Y] }
  }
  if (period === 'yearly') {
    return { name: Y, folder: Y, start: `${Y}-01-01`, parents: [] }
  }
  throw new Error(`期間の種類が正しくありません：${period}`)
}

export function notePath(periodicRoot, period, date) {
  const { name, folder } = periodInfo(period, date)
  return `${periodicRoot}/${folder}/${name}.md`
}

export function monthGrid(month) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month) || !isValidDate(`${month}-01`)) {
    throw new Error(`月の形が正しくありません：${month}`)
  }
  const first = toMs(Number(month.slice(0, 4)), Number(month.slice(5)), 1)
  const start = first - weekdayIndex(first) * DAY_MS
  const days = []
  for (let i = 0; i < 42; i++) days.push(fmt(start + i * DAY_MS))
  const weeks = []
  for (let w = 0; w < 6; w++) weeks.push({ name: weekName(isoWeek(days[w * 7])), start: days[w * 7] })
  return { days, weeks }
}

// ---- ひな形 ----

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
// 長い並びを先に並べる（左から順に最初に当たったものを使う）
const TOKENS = ['YYYY', 'GGGG', 'MMMM', 'dddd', 'YY', 'MMM', 'ddd', 'MM', 'WW', 'DD', 'HH', 'mm', 'ss', 'M', 'D', 'W', 'Q']

export function formatDate(date, time, format) {
  mustBeDate(date)
  const { y, m, d } = parse(date)
  const [hh, mm] = String(time).split(':')
  const iso = isoWeek(date)
  const dayName = DAY_NAMES[weekdayIndex(toMs(y, m, d))]
  const monthName = MONTH_NAMES[m - 1]
  const value = {
    YYYY: pad(y, 4),
    YY: pad(y % 100),
    MMMM: monthName,
    MMM: monthName.slice(0, 3),
    MM: pad(m),
    M: String(m),
    dddd: dayName,
    ddd: dayName.slice(0, 3),
    GGGG: pad(iso.year, 4),
    WW: pad(iso.week),
    W: String(iso.week),
    DD: pad(d),
    D: String(d),
    HH: pad(Number(hh)),
    mm: pad(Number(mm)),
    ss: '00',
    Q: String(quarterOf(m)),
  }
  let out = ''
  let i = 0
  while (i < format.length) {
    if (format[i] === '[') {
      const close = format.indexOf(']', i + 1)
      if (close !== -1) {
        out += format.slice(i + 1, close)
        i = close + 1
        continue
      }
    }
    const token = TOKENS.find((t) => format.startsWith(t, i))
    if (token) {
      out += value[token]
      i += token.length
    } else {
      out += format[i]
      i += 1
    }
  }
  return out
}

// {{time}}に使う日付はtimeDate（なければdate）。ほかの{{ }}は残す。
export function renderTemplate(text, { date, time, title, timeDate = date }) {
  return text.replace(/\{\{(date|time)(?::([^}]*))?\}\}|\{\{title\}\}/g, (all, kind, fmtStr) => {
    if (kind === 'date') return fmtStr === undefined ? date : formatDate(date, time, fmtStr)
    if (kind === 'time') return fmtStr === undefined ? time : formatDate(timeDate, time, fmtStr)
    return title
  })
}

export function insertParentLinks(text, parents) {
  if (!parents || parents.length === 0) return text
  const line = parents.map((p) => `[[${p}]]`).join(' ')
  if (text.startsWith('---\n')) {
    let pos = 4
    while (pos <= text.length) {
      let end = text.indexOf('\n', pos)
      if (end === -1) end = text.length
      if (text.slice(pos, end) === '---') {
        const head = text.slice(0, end)
        const rest = text.slice(end + 1)
        return `${head}\n${line}\n\n${rest}`
      }
      pos = end + 1
    }
  }
  return `${line}\n\n${text}`
}

export function buildNote({ period, date, now, template }) {
  const info = periodInfo(period, date)
  const time = now.slice(11, 16)
  const nowDate = now.slice(0, 10)
  const text = renderTemplate(template || '', { date: info.start, time, title: info.name, timeDate: nowDate })
  return insertParentLinks(text, info.parents)
}
