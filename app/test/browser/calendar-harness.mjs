// 右の列のカレンダーだけを描く試験用のページ。test/browser/calendar-width-check.py が組み立てて使う。
import { calendarModel } from '../../src/calendar.mjs'
import { buildCalendar } from '../../src/calendar-view.mjs'

const has = { periodicRoot: 'Periodic', days: ['2026-11-07', '2026-11-10'], weeks: ['2026-W46'], month: true, quarter: false, year: false }
const model = calendarModel('2026-11', '2026-11-07', '2026-11-10', has)
document.getElementById('calendar').replaceChildren(...buildCalendar(model, { open: () => {}, go: () => {} }))
