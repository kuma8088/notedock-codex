// Claude用の NoteDock の同じテストを、Codex用のサーバー（createCore の request）に合わせて写したもの。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createCore } from '../server/core.mjs'
import { buildNote } from '../src/periodic.mjs'

const NOW = '2026-11-08T07:30'

async function setup({ settings, files = {}, editable = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'periodic-root-')))
  const aux = fs.mkdtempSync(path.join(os.tmpdir(), 'periodic-aux-'))
  const put = (rel, content) => {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  for (const [rel, content] of Object.entries(files)) put(rel, content)
  const core = createCore({ root, backupDir: aux })
  // 設定は、Vaultの外のフォルダーごとの設定ファイルに書く。
  // ここでは日付ごとのノートの設定（{ root, templates }）だけを渡す。文字なら、そのままファイルに書く（壊れたファイルの試験）。
  if (settings !== undefined) {
    fs.mkdirSync(path.dirname(core.settingsPath), { recursive: true })
    fs.writeFileSync(core.settingsPath, typeof settings === 'string' ? settings : JSON.stringify({ periodic: settings }))
  }
  const scope = { editable, opened: null }
  const post = async (body) => {
    const r = core.request('POST', '/api/periodic/open', body, scope)
    return { status: r.status, json: r.data }
  }
  const get = async (month) => {
    const r = core.request('GET', `/api/periodic?month=${month}`, undefined, scope)
    return { status: r.status, json: r.data }
  }
  const close = async () => {}
  return { root, post, get, close, put }
}

function listAll(dir, prefix = '') {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...listAll(path.join(dir, e.name), `${prefix}${e.name}/`))
    else out.push(`${prefix}${e.name}`)
  }
  return out.sort()
}

const daily = { period: 'daily', date: '2026-11-08', now: NOW }

// 置き場が決まるまでは作らない。決まった名前のひな形も読まない。
test('置き場が決まっていなければ作らず、決まった名前のひな形も読まない', async () => {
  const t = await setup({ files: { 'a.md': 'x', 'templates/daily-note.md': '# {{title}}\n' } })
  try {
    const r = await t.post(daily)
    assert.equal(r.status, 409)
    assert.equal(r.json.error, 'no-periodic-root')
    assert.deepEqual(listAll(t.root), ['a.md', 'templates/daily-note.md'])
  } finally { await t.close() }
})

test('ノートを作るとき、その年のQuarterly・Monthly・Weekly・Dailyのフォルダーをまとめて作る', async () => {
  const t = await setup({ settings: { root: 'Periodic' }, files: { 'a.md': 'x' } })
  try {
    const probe = await t.post({ ...daily, dryRun: true })
    assert.deepEqual(probe.json, { path: null, exists: false })
    assert.equal(fs.existsSync(path.join(t.root, 'Periodic')), false)
    await t.post(daily)
    for (const sub of ['Quarterly', 'Monthly', 'Weekly', 'Daily']) {
      assert.equal(fs.statSync(path.join(t.root, 'Periodic/2026', sub)).isDirectory(), true, sub)
    }
    // 週は、その週が入る年（ISO）のフォルダーに作る。2027-01-01は2026-W53。
    await t.post({ period: 'weekly', date: '2027-01-01', now: NOW })
    assert.equal(fs.existsSync(path.join(t.root, 'Periodic/2026/Weekly/2026-W53.md')), true)
    assert.equal(fs.existsSync(path.join(t.root, 'Periodic/2027')), false)
    await t.post({ period: 'yearly', date: '2027-01-01', now: NOW })
    for (const sub of ['Quarterly', 'Monthly', 'Weekly', 'Daily']) {
      assert.equal(fs.statSync(path.join(t.root, 'Periodic/2027', sub)).isDirectory(), true, sub)
    }
    // ノートがもうあっても、足りないフォルダーは作る。
    fs.rmSync(path.join(t.root, 'Periodic/2026/Monthly'), { recursive: true })
    const again = await t.post(daily)
    assert.equal(again.json.created, false)
    assert.equal(fs.statSync(path.join(t.root, 'Periodic/2026/Monthly')).isDirectory(), true)
  } finally { await t.close() }
})

test('ひな形を決めていなければ、上の期間へのリンクだけのノートを作る', async () => {
  const t = await setup({ settings: { root: 'Periodic' }, files: { 'a.md': 'x', 'templates/periodic/weekly.md': '# 決まった名前\n' } })
  try {
    const r = await t.post({ period: 'weekly', date: '2026-11-04', now: NOW })
    assert.equal(r.status, 201)
    assert.equal(r.json.path, 'Periodic/2026/Weekly/2026-W45.md')
    assert.equal(fs.readFileSync(path.join(t.root, r.json.path), 'utf8'), buildNote({ period: 'weekly', date: '2026-11-04', now: NOW, template: '' }))
  } finally { await t.close() }
})

test('設定ファイルがおかしければ作らない', async () => {
  const cases = [
    ['JSON壊れ', { settings: '{oops' }],
    ['root: ..', { settings: { root: '../out' } }],
    ['root: 隠し', { settings: { root: '.hidden' } }],
  ]
  for (const [label, opts] of cases) {
    const t = await setup(opts)
    try {
      const r = await t.post(daily)
      assert.equal(r.status, 409, label)
      assert.equal(r.json.error, 'bad-settings', label)
    } finally { await t.close() }
  }
})

test('ひな形からデイリーノートを作り、もう一度押すと開くだけ', async () => {
  const template = '---\ntags: [daily]\n---\n# {{title}}\n{{date}} {{time}}\n'
  const t = await setup({ settings: { root: 'Periodic/', templates: { daily: 'Templates/daily.md' } }, files: { 'Templates/daily.md': template } })
  try {
    const first = await t.post(daily)
    assert.equal(first.status, 201)
    assert.equal(first.json.created, true)
    assert.equal(first.json.path, 'Periodic/2026/Daily/2026-11-08.md')
    const file = path.join(t.root, first.json.path)
    const text = fs.readFileSync(file, 'utf8')
    assert.equal(text, buildNote({ ...daily, template }))
    fs.appendFileSync(file, '追記\n')
    const second = await t.post(daily)
    assert.equal(second.status, 200)
    assert.equal(second.json.created, false)
    assert.equal(fs.readFileSync(file, 'utf8'), text + '追記\n')
  } finally { await t.close() }
})

test('同時に2回押しても1つしか作らない', async () => {
  const t = await setup({ settings: { root: 'Periodic' } })
  try {
    const [a, b] = await Promise.all([t.post(daily), t.post(daily)])
    assert.equal(a.json.path, b.json.path)
    assert.deepEqual([a.json.created, b.json.created].sort(), [false, true])
    assert.deepEqual(listAll(t.root).filter((f) => f.startsWith('Periodic')), ['Periodic/2026/Daily/2026-11-08.md'])
  } finally { await t.close() }
})

// あるかどうかは決まった場所だけで見る。ほかの場所の同じ名前は探さない。
test('ほかの場所に同じ名前のノートがあっても、決まった場所だけを見て作る', async () => {
  const files = { 'archives/a/2026-W23.md': 'a', 'archives/b/2026-W23.md': 'b', 'notes/2026-W23.md': 'c', 'test-copies/x/2026-W23.md': 'copy' }
  const t = await setup({ settings: { root: 'Periodic' }, files })
  try {
    const r = await t.post({ period: 'weekly', date: '2026-06-03', now: NOW })
    assert.equal(r.status, 201)
    assert.deepEqual(r.json, { path: 'Periodic/2026/Weekly/2026-W23.md', created: true })
    for (const [rel, text] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(t.root, rel), 'utf8'), text)
  } finally { await t.close() }
})

test('ひな形が見つからなければ作らない', async () => {
  const t = await setup({ settings: { root: 'Periodic', templates: { daily: 'Templates/none.md' } } })
  try {
    const r = await t.post(daily)
    assert.equal(r.status, 409)
    assert.equal(r.json.error, 'bad-settings')
    assert.deepEqual(listAll(t.root).filter((f) => f.startsWith('Periodic')), [])
  } finally { await t.close() }
})

test('書き方がおかしい依頼は受け付けない', async () => {
  const t = await setup({ settings: { root: 'Periodic' } })
  try {
    for (const body of [
      { ...daily, period: 'daily2' },
      { ...daily, date: '2026-02-30' },
      { ...daily, now: '2026-11-08 07:30' },
      { ...daily, now: '2026-11-08T25:30' },
    ]) {
      assert.equal((await t.post(body)).status, 400, JSON.stringify(body))
    }
    assert.equal((await t.get('2026-1')).status, 400)
    assert.equal((await t.get('2026-13')).status, 400)
    assert.deepEqual(listAll(t.root).filter((f) => f.startsWith('Periodic')), [])
  } finally { await t.close() }
})

test('月のカレンダーにノートの有無を知らせ、何も書き込まない', async () => {
  const t = await setup({ settings: { root: 'Periodic' }, files: { 'archives/2026-11-03.md': 'other' } })
  const bare = await setup({ files: { 'a.md': 'x' } })
  try {
    await t.post(daily)
    await t.post({ period: 'weekly', date: '2026-11-04', now: NOW })
    await t.post({ period: 'monthly', date: '2026-11-01', now: NOW })
    const before = listAll(t.root)
    const r = await t.get('2026-11')
    assert.equal(r.status, 200)
    assert.deepEqual(r.json, { periodicRoot: 'Periodic', days: ['2026-11-08'], weeks: ['2026-W45'], month: true, quarter: false, year: false })
    assert.deepEqual(listAll(t.root), before)
    const none = await bare.get('2026-11')
    assert.deepEqual(none.json, { disabled: true })
    assert.deepEqual(listAll(bare.root), ['a.md'])
  } finally { await t.close(); await bare.close() }
})

test('dryRunは何も書かずに、あるかどうかだけ答える', async () => {
  const t = await setup({ settings: { root: 'Periodic' }, files: { 'Periodic/2026/Daily/2026-11-08.md': 'x', 'archives/2026-W23.md': 'old' } })
  try {
    const before = listAll(t.root)
    const own = await t.post({ ...daily, dryRun: true })
    assert.equal(own.status, 200)
    assert.deepEqual(own.json, { path: 'Periodic/2026/Daily/2026-11-08.md', exists: true })
    const same = await t.post({ period: 'weekly', date: '2026-06-03', now: NOW, dryRun: true })
    assert.equal(same.status, 200)
    assert.deepEqual(same.json, { path: null, exists: false })
    const none = await t.post({ period: 'daily', date: '2026-11-09', now: NOW, dryRun: true })
    assert.equal(none.status, 200)
    assert.deepEqual(none.json, { path: null, exists: false })
    assert.deepEqual(listAll(t.root), before)
  } finally { await t.close() }
})

test('設定がなければ、dryRunも何も書かずに断る', async () => {
  const t = await setup({ files: { 'a.md': 'x' } })
  try {
    const r = await t.post({ ...daily, dryRun: true })
    assert.equal(r.status, 409)
    assert.equal(r.json.error, 'no-periodic-root')
    assert.deepEqual(listAll(t.root), ['a.md'])
  } finally { await t.close() }
})

// Codex用だけの決まり：フォルダーの外のノートから開いたタブ（書き込めないタブ）では作らない。
// あるかどうかを調べること（dryRun）と月の一覧は、何も書かないので、そのタブでもできる。
test('書き込めないタブでは作らないが、あるかどうかと月の一覧は答える', async () => {
  const t = await setup({ settings: { root: 'Periodic' }, files: { 'Periodic/2026/Daily/2026-11-08.md': 'x' }, editable: false })
  try {
    const before = listAll(t.root)
    const made = await t.post({ period: 'daily', date: '2026-11-09', now: NOW })
    assert.equal(made.status, 403)
    const own = await t.post({ ...daily, dryRun: true })
    assert.equal(own.status, 200)
    assert.deepEqual(own.json, { path: 'Periodic/2026/Daily/2026-11-08.md', exists: true })
    const month = await t.get('2026-11')
    assert.equal(month.status, 200)
    assert.deepEqual(month.json.days, ['2026-11-08'])
    assert.deepEqual(listAll(t.root), before)
  } finally { await t.close() }
})

test('Windowsで作ったひな形（CRLF、BOM付き）からでも、編集できるノートを作る', async () => {
  const template = '﻿---\r\ntags: [daily]\r\n---\r\n# {{title}}\r\n本文\r\n'
  const t = await setup({ settings: { root: 'Periodic/', templates: { daily: 'Templates/daily.md' } }, files: { 'Templates/daily.md': template } })
  try {
    const first = await t.post(daily)
    assert.equal(first.status, 201)
    const text = fs.readFileSync(path.join(t.root, first.json.path), 'utf8')
    assert.ok(!text.includes('\r'), '改行は LF だけ')
    assert.ok(!text.startsWith('﻿'), '先頭に BOM を付けない')
    assert.equal(text, buildNote({ ...daily, template: '---\ntags: [daily]\n---\n# {{title}}\n本文\n' }))
  } finally { await t.close() }
})
