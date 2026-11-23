import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createCore } from '../server/core.mjs'

// 画像と日付ごとのノートの置き場を、決め打ちしない。
// 設定はVaultの外（控えと同じ場所の settings/<フォルダーの目印>.json）に置き、パネルの「設定」で決める。

const NOW = '2026-11-08T07:30'
const daily = { period: 'daily', date: '2026-11-08', now: NOW }
const editable = { editable: true, opened: null }
const readOnly = { editable: false, opened: null }

function listAll(dir, prefix = '') {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(`${prefix}${e.name}/`, ...listAll(path.join(dir, e.name), `${prefix}${e.name}/`))
    else out.push(`${prefix}${e.name}`)
  }
  return out.sort()
}

function setup({ files = { 'a.md': 'x\n' }, backupDir } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'settings-root-')))
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  const aux = backupDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'settings-aux-'))
  const core = createCore({ root, backupDir: aux })
  const call = (method, url, body, scope = editable) => core.request(method, url, body, scope)
  const paste = (scope) => call('POST', '/api/attachment?name=pic.png', { base64: 'AA==' }, scope)
  return { root, aux, core, call, paste }
}

test('設定がないと、画像は attachments に入り、日付ごとのノートは作らない', () => {
  const t = setup()
  const got = t.call('GET', '/api/settings')
  assert.equal(got.status, 200)
  assert.deepEqual(got.data, { attachmentDir: null, periodic: null, errors: [], defaultAttachmentDir: 'attachments' })
  assert.deepEqual(t.call('GET', '/api/periodic?month=2026-11').data, { disabled: true })
  const open = t.call('POST', '/api/periodic/open', daily)
  assert.equal(open.status, 409)
  assert.equal(open.data.error, 'no-periodic-root')
  assert.ok(open.data.message.includes('設定'), open.data.message)
  assert.equal(t.call('POST', '/api/periodic/open', { ...daily, dryRun: true }).status, 409)
  const pasted = t.paste()
  assert.equal(pasted.status, 201)
  assert.match(pasted.data.path, /^attachments\/pic-\d{14}\.png$/)
  assert.ok(fs.existsSync(path.join(t.root, pasted.data.path)))
  // 決めていない置き場のフォルダーは、どこにもできない（画像を貼った attachments だけ）
  const all = listAll(t.root)
  assert.deepEqual(all.filter((f) => !f.startsWith('attachments/')), ['a.md'], all.join(','))
})

test('「設定」で決めた場所に、画像と日付ごとのノートが入る。設定ファイルはVaultの外に置く', () => {
  const t = setup({ files: { 'a.md': 'x\n', 'T/d.md': '# {{title}}\n' } })
  const before = listAll(t.root)
  const put = t.call('PUT', '/api/settings', { attachmentDir: 'img/', periodic: { root: 'Days', templates: { daily: 'T/d.md' } } })
  assert.equal(put.status, 200)
  assert.deepEqual(put.data, { attachmentDir: 'img', periodic: { root: 'Days', templates: { daily: 'T/d.md' } }, errors: [], defaultAttachmentDir: 'attachments' })
  assert.deepEqual(listAll(t.root), before, '設定を保存しても、Vaultの中には何もできない')
  assert.equal(t.core.settingsPath, path.join(t.aux, 'settings', `${t.core.rootId}.json`))
  assert.ok(fs.existsSync(t.core.settingsPath))
  assert.match(t.paste().data.path, /^img\/pic-/)
  const made = t.call('POST', '/api/periodic/open', daily)
  assert.equal(made.status, 201)
  assert.equal(made.data.path, 'Days/2026/Daily/2026-11-08.md')
  assert.ok(fs.readFileSync(path.join(t.root, made.data.path), 'utf8').includes('# 2026-11-08\n'), 'ひな形を使う')
  assert.equal(t.call('GET', '/api/periodic?month=2026-11').data.periodicRoot, 'Days')
  // 起動し直しても同じ設定を使う
  const again = createCore({ root: t.root, backupDir: t.aux })
  assert.equal(again.request('GET', '/api/settings', undefined, editable).data.attachmentDir, 'img')
  // 日付ごとのノートを使わない設定に戻せる
  assert.equal(t.call('PUT', '/api/settings', { attachmentDir: null, periodic: null }).status, 200)
  assert.deepEqual(t.call('GET', '/api/periodic?month=2026-11').data, { disabled: true })
  assert.match(t.paste().data.path, /^attachments\//)
})

test('使えない場所は保存しない', () => {
  const t = setup({ files: { 'a.md': 'x\n', plainfile: 'not a folder\n' } })
  const good = { attachmentDir: 'img', periodic: { root: 'Days' } }
  assert.equal(t.call('PUT', '/api/settings', good).status, 200)
  const saved = fs.readFileSync(t.core.settingsPath, 'utf8')
  const bad = [
    { attachmentDir: '../x', periodic: null },
    { attachmentDir: '.hidden', periodic: null },
    { attachmentDir: '', periodic: null },
    { attachmentDir: 'a.md', periodic: null },
    { attachmentDir: 5, periodic: null },
    { attachmentDir: null, periodic: { root: '../out' } },
    { attachmentDir: null, periodic: { root: '' } },
    { attachmentDir: null, periodic: { root: 'node_modules' } },
    { attachmentDir: null, periodic: { root: 'Days', templates: { hourly: 'T/h.md' } } },
    { attachmentDir: null, periodic: { root: 'Days', templates: { daily: 'T/d.txt' } } },
    { attachmentDir: null, periodic: { root: 'Days', templates: { daily: '../d.md' } } },
    { attachmentDir: null, periodic: { root: 'Days', templates: [] } },
    { attachmentDir: null, periodic: 'Days' },
    { attachmentDir: '__outside__', periodic: null },
    { attachmentDir: null, periodic: { root: '__outside__/x' } },
    { attachmentDir: 'plainfile', periodic: null },
    { attachmentDir: null, periodic: { root: 'plainfile' } },
    { attachmentDir: null, periodic: { root: 'Days', templates: { daily: 'T/none.md' } } },
    { attachmentDir: 'img' },
    { periodic: null },
    {},
    null,
  ]
  for (const body of bad) {
    const r = t.call('PUT', '/api/settings', body)
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.equal(typeof r.data.message, 'string', JSON.stringify(body))
  }
  assert.equal(fs.readFileSync(t.core.settingsPath, 'utf8'), saved)
})

test('書き込めないタブでは、設定を見られるが変えられない', () => {
  const t = setup()
  assert.equal(t.call('GET', '/api/settings', undefined, readOnly).status, 200)
  assert.equal(t.call('PUT', '/api/settings', { attachmentDir: 'img', periodic: null }, readOnly).status, 403)
  assert.ok(!fs.existsSync(t.core.settingsPath))
})

test('設定ファイルが壊れていたら、画像も日付ごとのノートも、勝手な場所に作らない', () => {
  const t = setup()
  fs.mkdirSync(path.dirname(t.core.settingsPath), { recursive: true })
  fs.writeFileSync(t.core.settingsPath, '{oops')
  const before = listAll(t.root)
  const got = t.call('GET', '/api/settings').data
  assert.equal(got.attachmentDir, null)
  assert.equal(got.periodic, null)
  assert.equal(got.errors.length, 1)
  const pasted = t.paste()
  assert.equal(pasted.status, 409)
  assert.equal(pasted.data.error, 'bad-settings')
  const open = t.call('POST', '/api/periodic/open', daily)
  assert.equal(open.status, 409)
  assert.equal(open.data.error, 'bad-settings')
  assert.deepEqual(listAll(t.root), before)
  // 「設定」で保存し直せば直る
  assert.equal(t.call('PUT', '/api/settings', { attachmentDir: 'img', periodic: null }).status, 200)
  assert.equal(t.paste().status, 201)
})

test('設定ファイルの中の使えない場所は、項目ごとに使わず、理由を返す', () => {
  const t = setup()
  fs.mkdirSync(path.dirname(t.core.settingsPath), { recursive: true })
  fs.writeFileSync(t.core.settingsPath, JSON.stringify({ attachmentDir: '../x', periodic: { root: 'Days' } }))
  const got = t.call('GET', '/api/settings').data
  assert.equal(got.attachmentDir, null)
  assert.deepEqual(got.periodic, { root: 'Days', templates: {} })
  assert.equal(got.errors.length, 1)
  assert.equal(t.paste().status, 409, '決めた場所が使えないときは、attachments にも入れない')
  assert.equal(t.call('POST', '/api/periodic/open', daily).status, 201)
})

test('Vaultの中の .note-editor/periodic.json は読まない', () => {
  const t = setup({ files: { 'a.md': 'x\n', '.note-editor/periodic.json': JSON.stringify({ root: 'Periodic' }) } })
  assert.deepEqual(t.call('GET', '/api/periodic?month=2026-11').data, { disabled: true })
  assert.equal(t.call('POST', '/api/periodic/open', daily).status, 409)
})

test('設定はフォルダーごとに分かれる', () => {
  const aux = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-aux-'))
  const one = setup({ backupDir: aux })
  const two = setup({ backupDir: aux })
  assert.equal(one.call('PUT', '/api/settings', { attachmentDir: 'img', periodic: { root: 'Days' } }).status, 200)
  assert.deepEqual(two.call('GET', '/api/settings').data.periodic, null)
  assert.match(two.paste().data.path, /^attachments\//)
})

test('控えの片付けで、設定ファイルは消えない', () => {
  const t = setup()
  assert.equal(t.call('PUT', '/api/settings', { attachmentDir: 'img', periodic: null }).status, 200)
  t.core.prune()
  createCore({ root: setup().root, backupDir: t.aux }).prune()
  assert.ok(fs.existsSync(t.core.settingsPath))
})

test('設定ファイルが壊れているときは、カレンダーに「決まっていない」ではなく理由を出す', () => {
  const t = setup()
  fs.mkdirSync(path.dirname(t.core.settingsPath), { recursive: true })
  fs.writeFileSync(t.core.settingsPath, JSON.stringify({ periodic: { root: '../out' } }))
  const month = t.call('GET', '/api/periodic?month=2026-11').data
  assert.equal(month.disabled, true)
  assert.match(month.message, /日付ごとのノートの置き場/)
})

test('あとでフォルダーがファイルに替わったら、画像を入れずに理由を返す', () => {
  const t = setup()
  assert.equal(t.call('PUT', '/api/settings', { attachmentDir: 'img', periodic: null }).status, 200)
  fs.writeFileSync(path.join(t.root, 'img'), 'now a file\n')
  const pasted = t.paste()
  assert.equal(pasted.status, 409)
  assert.ok(!JSON.stringify(pasted.data).includes(t.root), '応答にファイルの場所を入れない')
})

test('設定を保存できないときは、ファイルの場所を出さずに理由を返す', () => {
  const t = setup()
  // 設定ファイルの場所がフォルダーになっていると、書き込めない
  fs.mkdirSync(t.core.settingsPath, { recursive: true })
  const r = t.call('PUT', '/api/settings', { attachmentDir: 'img', periodic: null })
  assert.equal(r.status, 500)
  assert.deepEqual(r.data, { error: 'settings-write-failed', message: '設定を保存できませんでした' })
  assert.deepEqual(fs.readdirSync(path.dirname(t.core.settingsPath)), [path.basename(t.core.settingsPath)], '一時ファイルを残さない')
})

test('「開いているノートをAIに伝える」は最初はオフで、保存するとどのタブからも同じ値になる', () => {
  const t = setup()
  assert.deepEqual(t.call('GET', '/api/share').data, { on: false })
  // 読むだけのタブでは、ほかの設定と同じく変えられない（読むことはできる）。
  assert.equal(t.call('PUT', '/api/share', { on: true }, readOnly).status, 403)
  assert.equal(t.call('PUT', '/api/share', { on: true }).status, 200)
  assert.deepEqual(t.call('GET', '/api/share', undefined, readOnly).data, { on: true })
  const again = createCore({ root: t.root, backupDir: t.aux })
  assert.deepEqual(again.request('GET', '/api/share', undefined, editable).data, { on: true })
  assert.equal(t.call('PUT', '/api/share', { on: 'yes' }).status, 400)
  assert.deepEqual(t.call('GET', '/api/share').data, { on: true })
  assert.equal(t.call('PUT', '/api/share', { on: false }).status, 200)
  assert.deepEqual(t.call('GET', '/api/share').data, { on: false })
  // Vaultの中には書かない。
  assert.deepEqual(listAll(t.root), ['a.md'])
})

test('「開いているノートをAIに伝える」の保存ファイルが壊れていたら、オフとして扱う', () => {
  const t = setup()
  assert.equal(t.call('PUT', '/api/share', { on: true }).status, 200)
  const file = path.join(t.aux, 'settings', `${t.core.rootId}.share.json`)
  fs.writeFileSync(file, '{ broken')
  assert.deepEqual(t.call('GET', '/api/share').data, { on: false })
  fs.writeFileSync(file, '"on"')
  assert.deepEqual(t.call('GET', '/api/share').data, { on: false })
})
