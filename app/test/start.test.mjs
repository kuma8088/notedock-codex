import assert from 'node:assert/strict'
import { test } from 'node:test'

import { firstNote } from '../src/start.mjs'

const notes = ['a.md', '日記/b.md']

test('a note opened from the file list wins', () => {
  assert.equal(firstNote({ path: 'x.md', inline: false, recent: ['a.md'], notes }), 'x.md')
  assert.equal(firstNote({ path: '__outside__/o.md', inline: true, recent: [], notes }), '__outside__/o.md')
})

test('opened without a file (the AI called open_note): the last note that still exists', () => {
  assert.equal(firstNote({ path: null, inline: false, recent: ['gone.md', '日記/b.md', 'a.md'], notes }), '日記/b.md')
})

test('nothing opened yet, or every recent note is gone: no note, the list shows', () => {
  assert.equal(firstNote({ path: null, inline: false, recent: [], notes }), null)
  assert.equal(firstNote({ path: null, inline: false, recent: ['gone.md'], notes }), null)
})

test('the small panel in a chat never opens a note by itself', () => {
  assert.equal(firstNote({ path: null, inline: true, recent: ['a.md'], notes }), null)
})

test('outside markers in the recent list are skipped', () => {
  assert.equal(firstNote({ path: null, inline: false, recent: ['__outside__/a.md'], notes: ['__outside__/a.md'] }), null)
})
