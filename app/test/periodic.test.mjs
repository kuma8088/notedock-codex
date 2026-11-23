import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { buildNote, formatDate, insertParentLinks, isValidDate, monthGrid, notePath, periodInfo, renderTemplate } from '../src/periodic.mjs'

const cases = JSON.parse(readFileSync(new URL('./data/periodic-cases.json', import.meta.url), 'utf8'))

test('答え合わせの一覧のとおりに場所と名前を決める', () => {
  for (const c of cases.paths) {
    const label = `${c.period} ${c.date}`
    assert.equal(notePath(cases.root, c.period, c.date), c.path, label)
    const info = periodInfo(c.period, c.date)
    assert.equal(info.start, c.start, label)
    assert.deepEqual(info.parents, c.parents, label)
  }
})

test('答え合わせの一覧のとおりに月の表を作る', () => {
  for (const g of cases.grids) {
    const grid = monthGrid(g.month)
    assert.equal(grid.days.length, 42, g.month)
    assert.equal(grid.weeks.length, 6, g.month)
    assert.equal(grid.days[0], g.first, g.month)
    assert.equal(grid.days[41], g.last, g.month)
    assert.equal(grid.weeks[0].name, g.firstWeek, g.month)
    assert.equal(grid.weeks[0].start, g.first, g.month)
  }
})

test('日付の形を確かめる', () => {
  assert.equal(isValidDate('2024-02-29'), true)
  for (const bad of ['2026-02-29', '2026-13-01', '2026-1-1', '2026-11-08T00:00', '', 'x']) assert.equal(isValidDate(bad), false)
})

test('形の一覧のとおりに日付を書く', () => {
  for (const c of cases.formats) {
    assert.equal(formatDate(c.date, c.time, c.format), c.expected, `${c.date} ${c.format}`)
  }
})

test('ひな形の一覧のとおりにノートを作る', () => {
  for (const c of cases.templates) {
    const note = buildNote({ period: c.period, date: c.date, now: c.now, template: c.template })
    assert.equal(note, c.expected, `${c.period} ${c.date}`)
  }
})

test('ひな形の置き換えと上の期間へのリンク', () => {
  assert.equal(renderTemplate('{{date}} {{time:HH}} {{title}} {{x}}', { date: '2026-11-08', time: '07:30', title: 'T' }), '2026-11-08 07 T {{x}}')
  assert.equal(insertParentLinks('abc', []), 'abc')
  assert.equal(insertParentLinks('---\na: 1\n---\nbody', ['A', 'B']), '---\na: 1\n---\n[[A]] [[B]]\n\nbody')
  assert.equal(insertParentLinks('---\na: 1\nbody', ['A']), '[[A]]\n\n---\na: 1\nbody')
})
