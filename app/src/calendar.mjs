// カレンダーに何を出すかを決める。DOMにもNodeにも頼らない。
import { monthGrid } from './periodic.mjs'

export function calendarModel(month, today, openDate, existing) {
  const { days, weeks } = monthGrid(month)
  const ex = existing || {}
  const hasDay = new Set(ex.days || [])
  const hasWeek = new Set(ex.weeks || [])
  const year = Number(month.slice(0, 4))
  const m = Number(month.slice(5))
  return {
    // 見出しの「2026年11月」を押すと、その月のノートを開く。
    title: `${year}年${m}月`,
    monthDate: `${month}-01`,
    hasMonth: Boolean(ex.month),
    weeks: weeks.map((w, i) => ({
      name: w.name,
      // 週番号は数字だけ出す。列の見出しが「W」。
      label: String(Number(w.name.slice(-2))),
      date: w.start,
      hasNote: hasWeek.has(w.name),
      days: days.slice(i * 7, i * 7 + 7).map((date) => ({
        date,
        day: Number(date.slice(8)),
        inMonth: date.startsWith(`${month}-`),
        isToday: date === today,
        isOpen: date === openDate,
        hasNote: hasDay.has(date),
      })),
    })),
  }
}

export function shiftMonth(month, delta) {
  monthGrid(month)
  const n = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5)) - 1) + delta
  const y = Math.floor(n / 12)
  return `${String(y).padStart(4, '0')}-${String((n % 12 + 12) % 12 + 1).padStart(2, '0')}`
}
