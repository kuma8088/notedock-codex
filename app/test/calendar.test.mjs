import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calendarModel, shiftMonth } from '../src/calendar.mjs'

const none = { days: [], weeks: [], month: false, quarter: false, year: false }

test('2026年11月は10月26日の月曜から6週分を並べる', () => {
  const m = calendarModel('2026-11', '2026-11-08', null, none)
  assert.equal(m.title, '2026年11月')
  // 月・四半期・年のボタンの行はやめた。月のノートは見出しの「2026年11月」から開く。
  assert.equal(m.monthLabel, undefined)
  assert.equal(m.quarterLabel, undefined)
  assert.equal(m.yearLabel, undefined)
  assert.equal(m.monthDate, '2026-11-01')
  assert.equal(m.weeks.length, 6)
  assert.equal(m.weeks[0].days[0].date, '2026-10-26')
  assert.equal(m.weeks[5].days[6].date, '2026-12-06')
  assert.equal(m.weeks[0].name, '2026-W44')
  assert.equal(m.weeks[0].label, '44')
  assert.equal(m.weeks[0].date, '2026-10-26')
  assert.equal(m.weeks[0].days[0].inMonth, false)
  assert.equal(m.weeks[1].days[0].inMonth, true)
  assert.equal(m.weeks[1].days[0].day, 2)
})

test('2027年1月の最初の週は2026-W53', () => {
  const m = calendarModel('2027-01', '2027-01-05', null, none)
  assert.equal(m.weeks[0].name, '2026-W53')
  assert.equal(m.weeks[0].label, '53')
  assert.equal(m.title, '2027年1月')
  assert.equal(m.monthDate, '2027-01-01')
})

test('今日・開いている日・ノートがある日に印が付く', () => {
  const m = calendarModel('2026-11', '2026-11-08', '2026-11-10', {
    days: ['2026-11-03'], weeks: ['2026-W45'], month: true, quarter: false, year: true,
  })
  const all = m.weeks.flatMap((w) => w.days)
  const by = (d) => all.find((x) => x.date === d)
  assert.equal(by('2026-11-08').isToday, true)
  assert.equal(by('2026-11-09').isToday, false)
  assert.equal(by('2026-11-10').isOpen, true)
  assert.equal(by('2026-11-08').isOpen, false)
  assert.equal(by('2026-11-03').hasNote, true)
  assert.equal(by('2026-11-04').hasNote, false)
  assert.equal(m.weeks.find((w) => w.name === '2026-W45').hasNote, true)
  assert.equal(m.weeks[0].hasNote, false)
  assert.equal(m.hasMonth, true)
  assert.equal(m.hasQuarter, undefined)
  assert.equal(m.hasYear, undefined)
})

test('existingが空でも動く', () => {
  const m = calendarModel('2026-11', '2026-11-08', null, undefined)
  assert.equal(m.hasMonth, false)
  assert.equal(m.weeks[0].hasNote, false)
})

test('月を前後に動かす', () => {
  assert.equal(shiftMonth('2026-12', 1), '2027-01')
  assert.equal(shiftMonth('2026-01', -1), '2025-12')
  assert.equal(shiftMonth('2026-11', 0), '2026-11')
  assert.equal(shiftMonth('2026-11', 14), '2028-01')
  assert.throws(() => shiftMonth('2026-13', 1))
})
