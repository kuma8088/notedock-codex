import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'

import { hashText } from '../server/notes.mjs'
import { createNoteServer } from '../server/mcp.mjs'
import { nativeOf, rootIdOf } from '../server/folders.mjs'

// Codexアプリがパネル用のつなぎで名乗る印（Codexアプリ 26.1027 から取ったもの）。
const PANEL_HOST = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app', 'text/html+skybridge'] } } }

async function setup(t, { root = true, capabilities = PANEL_HOST } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-note-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const vault = path.join(base, 'vault')
  fs.mkdirSync(path.join(vault, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(vault, 'sub/ノート.md'), '---\ntitle: a\n---\n\n本文\n')
  fs.writeFileSync(path.join(base, 'outside.md'), 'outside\n')
  fs.writeFileSync(path.join(base, 'panel.html'), '<!doctype html>')
  const server = createNoteServer({ root: root ? vault : undefined, backupDir: path.join(base, 'backups'), panelFile: path.join(base, 'panel.html') })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'codex-note-test', version: '1' }, { capabilities })
  await Promise.all([server.connect(a), client.connect(b)])
  t.after(() => client.close())
  const rootId = rootIdOf(nativeOf(vault))
  // パネルは、受け取った rootId を送る（note_api の root）。試験でも、フォルダーの中で開いたタブなら、書いていなければ足す。
  // フォルダーの外・ファイルなしのタブは、パネルが受け取る rootId が none なので送らない。
  const inVault = (hostPath) => root && typeof hostPath === 'string' && hostPath.startsWith(vault + path.sep)
  const call = async (name, args, hostPath) => (await client.callTool({
    name,
    arguments: name === 'note_api' && args.root === undefined && inVault(hostPath) ? { ...args, root: rootId } : args,
    ...(hostPath === undefined ? {} : { _meta: { 'openai/resource': { path: hostPath } } }),
  })).structuredContent
  return { base, vault, client, call, rootId, note: path.join(vault, 'sub/ノート.md') }
}

const url = (rel) => `/api/note?path=${encodeURIComponent(rel)}`

test('the editor opens from .md files only (no left rail or More tools entry); panel tools are hidden from the model', async (t) => {
  const { client } = await setup(t)
  const { tools } = await client.listTools()
  const open = tools.find((tool) => tool.name === 'open_note')
  assert.deepEqual(open._meta['openai/ui'].entrypoints, [{ type: 'file', extensions: ['.md'] }])
  for (const name of ['note_locate', 'note_api']) {
    assert.deepEqual(tools.find((tool) => tool.name === name)._meta.ui.visibility, ['app'])
  }
})

test('the panel asks the host for permission to write the clipboard', async (t) => {
  const { client } = await setup(t)
  const { contents } = await client.readResource({ uri: 'ui://notedock/panel.html' })
  assert.deepEqual(contents[0]._meta.ui.permissions, { clipboardWrite: {} })
})

// パネルは起動したら GET /api/launcher/status を聞き、state を含む答え（起動用のプログラム）のときだけ仮のパネルに替わる。本体は state を返さない。
test('the server answers the launcher status url without a state', async (t) => {
  const { call, note } = await setup(t)
  const seen = []
  for (const hostPath of [note, undefined]) {
    const result = await call('note_api', { method: 'GET', url: '/api/launcher/status', body: {} }, hostPath)
    seen.push(result.status + ' ' + result.data?.error)
    assert.equal(result.data?.state, undefined)
  }
  // フォルダーの中のファイルから開いたタブは 404。開いたファイルの場所のない呼び出しは、編集できない扱いで 403（read only）。
  assert.deepEqual(seen, ['404 not found', '403 read only'])
})

test('opening never errors, inside or outside the folder', async (t) => {
  const { client, base } = await setup(t)
  const file = { name: 'outside.md', resourceUri: 'codex-resource:opaque' }
  const opened = await client.callTool({ name: 'open_note', arguments: { file }, _meta: { 'openai/resource': { path: path.join(base, 'outside.md') } } })
  assert.equal(opened.isError, undefined)
})

test('the host path decides the note; only files in the folder are editable', async (t) => {
  const { call, note, base, vault, rootId } = await setup(t)
  assert.deepEqual(await call('note_locate', {}, note), { scope: 'inside', path: 'sub/ノート.md', rootId })
  assert.deepEqual(await call('note_locate', {}, path.join(base, 'outside.md')), { scope: 'outside' })
  assert.deepEqual(await call('note_locate', {}), { scope: 'outside' })
  assert.deepEqual(await call('note_locate', {}, 'sub/ノート.md'), { scope: 'outside' })
  assert.deepEqual(await call('note_locate', {}, path.join(vault, '../outside.md')), { scope: 'outside' })
  fs.symlinkSync(path.join(base, 'outside.md'), path.join(vault, 'link.md'))
  assert.deepEqual(await call('note_locate', {}, path.join(vault, 'link.md')), { scope: 'outside' })
  fs.symlinkSync(note, path.join(vault, 'alias.md'))
  assert.deepEqual(await call('note_locate', {}, path.join(vault, 'alias.md')), { scope: 'outside' })
  fs.mkdirSync(path.join(vault, '.hidden'))
  fs.writeFileSync(path.join(vault, '.hidden/a.md'), 'x')
  assert.deepEqual(await call('note_locate', {}, path.join(vault, '.hidden/a.md')), { scope: 'outside' })
  fs.mkdirSync(path.join(base, 'elsewhere'))
  fs.writeFileSync(path.join(base, 'elsewhere/b.md'), 'x')
  fs.symlinkSync(path.join(base, 'elsewhere'), path.join(vault, 'linked-folder'))
  assert.deepEqual(await call('note_locate', {}, path.join(vault, 'linked-folder/b.md')), { scope: 'outside' })
})

// A note in the folder that is a hard link to a file outside may be edited,
// and saving must not change the outside name. This holds only while saves write a new file and rename it.
test('saving a hard-linked note leaves the other name untouched', async (t) => {
  const { call, base, vault, rootId } = await setup(t)
  const outside = path.join(base, 'outside.md')
  const inside = path.join(vault, 'hard.md')
  fs.linkSync(outside, inside)
  const before = fs.statSync(outside)
  const located = await call('note_locate', {}, inside)
  assert.deepEqual(located, { scope: 'inside', path: 'hard.md', rootId })
  const read = await call('note_api', { method: 'GET', url: url('hard.md') }, inside)
  const saved = await call('note_api', { method: 'PUT', url: url('hard.md'), body: { text: 'changed\n', baseHash: read.data.hash } }, inside)
  assert.equal(saved.status, 200)
  assert.equal(fs.readFileSync(inside, 'utf8'), 'changed\n')
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside\n')
  assert.equal(fs.statSync(outside).ino, before.ino)
  assert.notEqual(fs.statSync(inside).ino, before.ino)
})

test('a Japanese name in NFD resolves and can be saved under the same spelling', async (t) => {
  const { call, vault } = await setup(t)
  const name = 'がぎぐ.md'.normalize('NFD')
  assert.notEqual(name, 'がぎぐ.md')
  fs.writeFileSync(path.join(vault, name), 'x\n')
  const hostPath = path.join(vault, name)
  const located = await call('note_locate', {}, hostPath)
  assert.equal(located.scope, 'inside')
  const target = `/api/note?path=${encodeURIComponent(located.path)}`
  const read = await call('note_api', { method: 'GET', url: target }, hostPath)
  const saved = await call('note_api', { method: 'PUT', url: target, body: { text: 'y\n', baseHash: read.data.hash } }, hostPath)
  assert.equal(saved.status, 200)
})

test('a folder reached through a symbolic link still works', async (t) => {
  const { base, vault } = await setup(t)
  const alias = path.join(base, 'alias')
  fs.symlinkSync(vault, alias)
  const { createCore } = await import('../server/core.mjs')
  const core = createCore({ root: alias, backupDir: path.join(base, 'b2') })
  assert.equal(core.locate(path.join(alias, 'sub/ノート.md')), 'sub/ノート.md')
  assert.equal(core.locate(path.join(vault, 'sub/ノート.md')), 'sub/ノート.md')
})

test('a panel saves other notes in the folder only on the hash of the current file', async (t) => {
  const { call, note, vault } = await setup(t)
  const other = path.join(vault, 'other.md')
  fs.writeFileSync(other, 'other\n')
  const put = (body) => call('note_api', { method: 'PUT', url: url('other.md'), body }, note)
  assert.equal((await put({ text: 'changed', baseHash: 'not-the-hash' })).status, 409)
  assert.equal(fs.readFileSync(other, 'utf8'), 'other\n')
  const read = await call('note_api', { method: 'GET', url: url('other.md') }, note)
  assert.equal(read.data.editable, true)
  fs.writeFileSync(other, 'changed after reading\n')
  assert.equal((await put({ text: 'mine', baseHash: read.data.hash })).status, 409)
  assert.equal(fs.readFileSync(other, 'utf8'), 'changed after reading\n')
  const fresh = await call('note_api', { method: 'GET', url: url('other.md') }, note)
  assert.equal((await put({ text: 'mine', baseHash: fresh.data.hash })).status, 200)
  assert.equal(fs.readFileSync(other, 'utf8'), 'mine')
})

test('a backup is refused for a path outside the folder', async (t) => {
  const { call, note } = await setup(t)
  const backup = (rel) => call('note_api', { method: 'POST', url: `/api/backup?path=${encodeURIComponent(rel)}`, body: { text: 'x' } }, note)
  assert.equal((await backup('sub/ノート.md')).status, 200)
  assert.equal((await backup('../outside.md')).status, 400)
})

test('a panel opened on a note outside every editable folder serves nothing of the folder and writes nothing', async (t) => {
  const { call, vault, base } = await setup(t)
  const other = path.join(vault, 'other.md')
  fs.writeFileSync(other, 'other\n')
  const outside = path.join(base, 'outside.md')
  const read = await call('note_api', { method: 'GET', url: url('other.md') }, outside)
  assert.equal(read.status, 403)
  const health = await call('note_api', { method: 'GET', url: '/api/health' }, outside)
  assert.deepEqual(health.data, { ok: true, root: '', rootId: 'none', rootPaths: [], editable: false })
  assert.deepEqual((await call('note_api', { method: 'GET', url: '/api/notes' }, outside)).data, { notes: [], known: [], folders: [], canCreate: false })
  assert.equal((await call('note_api', { method: 'PUT', url: url('other.md'), body: { text: 'x', baseHash: 'h' } }, outside)).status, 403)
  assert.equal((await call('note_api', { method: 'POST', url: '/api/attachment?name=a.png', body: { base64: 'AA==' } }, outside)).status, 403)
  assert.equal(fs.readFileSync(other, 'utf8'), 'other\n')
})

test('a write outside the folder is refused even after asking to read it', async (t) => {
  const { call, note, base } = await setup(t)
  assert.equal((await call('note_api', { method: 'GET', url: url('../outside.md') }, note)).status, 400)
  assert.equal((await call('note_api', { method: 'PUT', url: url('../outside.md'), body: { text: 'x', baseHash: hashText('outside\n') } }, note)).status, 400)
  assert.equal(fs.readFileSync(path.join(base, 'outside.md'), 'utf8'), 'outside\n')
})

test('the opened note can be saved under another spelling of its name', async (t) => {
  const { call, vault } = await setup(t)
  const nfd = 'がぎぐ.md'.normalize('NFD')
  fs.writeFileSync(path.join(vault, nfd), 'x\n')
  const hostPath = path.join(vault, nfd)
  const target = `/api/note?path=${encodeURIComponent('がぎぐ.md'.normalize('NFC'))}`
  const read = await call('note_api', { method: 'GET', url: target }, hostPath)
  assert.equal(read.data.editable, true)
  const saved = await call('note_api', { method: 'PUT', url: target, body: { text: 'y\n', baseHash: read.data.hash } }, hostPath)
  assert.equal(saved.status, 200)
})

test('a real folder named like the panel marker is not served', async (t) => {
  const { call, vault, note } = await setup(t)
  fs.mkdirSync(path.join(vault, '__outside__'))
  fs.writeFileSync(path.join(vault, '__outside__/x.md'), 'x\n')
  assert.deepEqual(await call('note_locate', {}, path.join(vault, '__outside__/x.md')), { scope: 'outside' })
  assert.equal((await call('note_api', { method: 'GET', url: url('__outside__/x.md') }, note)).status, 400)
  const list = await call('note_api', { method: 'GET', url: '/api/notes' }, note)
  assert.ok(!list.data.known.some((rel) => rel.startsWith('__outside__')))
})

// When the AI calls open_note (no entry point, so no file), the host attaches no file. Such a
// panel edits the folder like a panel opened on a note inside it.
test('a panel opened without a file (the AI called open_note) only reads: nothing in the folder is served or written', async (t) => {
  const { call, vault, base } = await setup(t)
  const api = (method, target, body) => call('note_api', { method, url: target, body })
  assert.equal((await api('GET', url('sub/ノート.md'))).status, 403)
  assert.equal((await api('GET', '/api/notes')).data.canCreate, false)
  assert.equal((await api('GET', '/api/health')).data.rootId, 'none')
  assert.equal((await api('PUT', url('sub/ノート.md'), { text: 'x\n', baseHash: 'h' })).status, 403)
  assert.equal((await api('POST', url('new.md'))).status, 403)
  assert.equal((await api('POST', '/api/move', { from: 'sub/ノート.md', to: 'moved.md', rewrite: false })).status, 403)
  assert.ok(fs.readFileSync(path.join(vault, 'sub/ノート.md'), 'utf8').includes('本文'))
  assert.ok(!fs.existsSync(path.join(vault, 'new.md')))
  assert.ok(!fs.existsSync(path.join(base, 'escape.md')))
})

test('drafts go through note_api: write, read and clear with the root id', async (t) => {
  const { call, note } = await setup(t)
  const api = (method, target, body) => call('note_api', { method, url: target, body }, note)
  const { rootId } = (await api('GET', '/api/health')).data
  const draftUrl = (tail = '') => `/api/draft${tail}?path=${encodeURIComponent('sub/ノート.md')}&root=${rootId}`
  const draft = { text: 'typed\n', baseText: 'base\n', baseHash: 'h', time: 1, savedAt: 2 }
  const written = await api('PUT', draftUrl(), { draft })
  assert.equal(written.status, 200)
  assert.deepEqual(written.data, { ok: true })
  assert.deepEqual((await api('GET', draftUrl())).data, { draft })
  const cleared = await api('POST', draftUrl('/clear'))
  assert.equal(cleared.status, 200)
  assert.deepEqual(cleared.data, { ok: true })
  assert.deepEqual((await api('GET', draftUrl())).data, { draft: null })
})

test('a malformed host path is refused, not treated as no file', async (t) => {
  const { client } = await setup(t)
  for (const meta of [{ path: 42 }, 'x', { path: '' }]) {
    const res = (await client.callTool({ name: 'note_api', arguments: { method: 'GET', url: url('sub/ノート.md') }, _meta: { 'openai/resource': meta } })).structuredContent
    assert.equal(res.status, 403, JSON.stringify(meta))
  }
})

test('read, conditional save, conflict and path limits', async (t) => {
  const { call, note, base } = await setup(t)
  const api = (method, target, body) => call('note_api', { method, url: target, body }, note)
  const read = await api('GET', url('sub/ノート.md'))
  assert.equal(read.status, 200)
  assert.equal(read.data.editable, true)
  const text = read.data.text.replace('本文', '編集後')
  const saved = await api('PUT', url('sub/ノート.md'), { text, baseHash: read.data.hash })
  assert.equal(saved.status, 200)
  assert.equal(fs.readFileSync(note, 'utf8'), text)
  assert.equal(saved.data.hash, hashText(text))
  const stale = await api('PUT', url('sub/ノート.md'), { text: 'old base', baseHash: read.data.hash })
  assert.equal(stale.status, 409)
  assert.equal(fs.readFileSync(note, 'utf8'), text)
  assert.equal((await api('GET', url('../outside.md'))).status, 400)
  assert.equal((await api('PUT', url('../outside.md'), { text: 'x', baseHash: 'x' })).status, 400)
  assert.equal((await api('GET', url(path.join(base, 'outside.md')))).status, 400)
  assert.equal(fs.readFileSync(path.join(base, 'outside.md'), 'utf8'), 'outside\n')
  const backups = await api('GET', `/api/backups?path=${encodeURIComponent('sub/ノート.md')}`)
  assert.ok(backups.data.backups.length >= 1)
})

test('an absolute path is given back only for notes in the folder', async (t) => {
  const { call, note } = await setup(t)
  const ask = (rel) => call('note_api', { method: 'GET', url: `/api/absolute?path=${encodeURIComponent(rel)}` }, note)
  assert.equal((await ask('sub/ノート.md')).data.path, note)
  assert.equal((await ask('../outside.md')).status, 400)
  // A missing note is not handed to the host, so Cmd+Click falls back to asking to create it in this tab.
  assert.equal((await ask('sub/まだない.md')).status, 404)
  assert.equal((await ask('ないフォルダー/まだない.md')).status, 404)
  fs.mkdirSync(path.join(path.dirname(note), 'フォルダー.md'))
  assert.equal((await ask('sub/フォルダー.md')).status, 404, 'a folder named .md is not a note')
})

test('fingerprint changes with the file and reports a removed note', async (t) => {
  const { call, note } = await setup(t)
  const target = `/api/fingerprint?path=${encodeURIComponent('sub/ノート.md')}`
  const first = (await call('note_api', { method: 'GET', url: target }, note)).data.fingerprint
  fs.writeFileSync(note, 'changed and longer than before\n')
  const second = (await call('note_api', { method: 'GET', url: target }, note)).data.fingerprint
  assert.notEqual(first, second)
  fs.rmSync(note)
  assert.equal((await call('note_api', { method: 'GET', url: target }, note)).data.fingerprint, 'missing')
})

test('with no folder configured nothing can be read or written', async (t) => {
  const { call, note } = await setup(t, { root: false })
  assert.deepEqual(await call('note_locate', {}, note), { scope: 'outside' })
  assert.equal((await call('note_api', { method: 'GET', url: url('sub/ノート.md') }, note)).status, 403)
})

test('a configured folder that is missing does not stop the server; it acts as no folder', async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-note-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const note = path.join(base, 'other.md')
  fs.writeFileSync(note, 'other\n')
  fs.writeFileSync(path.join(base, 'panel.html'), '<!doctype html>')
  const server = createNoteServer({ root: path.join(base, 'renamed-away'), backupDir: path.join(base, 'backups'), panelFile: path.join(base, 'panel.html') })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'codex-note-test', version: '1' }, { capabilities: PANEL_HOST })
  await Promise.all([server.connect(a), client.connect(b)])
  t.after(() => client.close())
  const call = async (name, args) => (await client.callTool({ name, arguments: args, _meta: { 'openai/resource': { path: note } } })).structuredContent
  assert.deepEqual(await call('note_locate', {}), { scope: 'outside' })
  assert.equal((await call('note_api', { method: 'PUT', url: url('other.md'), body: { text: 'x', baseHash: hashText('other\n') } })).status, 403)
  assert.equal(fs.readFileSync(note, 'utf8'), 'other\n')
  assert.equal(fs.existsSync(path.join(base, 'renamed-away')), false, 'the missing folder is not created')
})

test('a panel opened in the folder creates an empty note it can then save', async (t) => {
  const { call, note, vault } = await setup(t)
  const api = (method, target, body) => call('note_api', { method, url: target, body }, note)
  assert.equal((await api('GET', '/api/notes')).data.canCreate, true)
  const created = await api('POST', url('Inbox/新しい.md'))
  assert.equal(created.status, 201)
  assert.equal(fs.readFileSync(path.join(vault, 'Inbox/新しい.md'), 'utf8'), '')
  assert.ok((await api('GET', '/api/notes')).data.notes.includes('Inbox/新しい.md'), 'shown at once, not after the list cache expires')
  const saved = await api('PUT', url('Inbox/新しい.md'), { text: '本文\n', baseHash: created.data.hash })
  assert.equal(saved.status, 200)
  assert.equal(fs.readFileSync(path.join(vault, 'Inbox/新しい.md'), 'utf8'), '本文\n')
})

test('creating never replaces a note that exists', async (t) => {
  const { call, note } = await setup(t)
  const before = fs.readFileSync(note, 'utf8')
  const again = await call('note_api', { method: 'POST', url: url('sub/ノート.md'), body: { text: 'x' } }, note)
  assert.equal(again.status, 409)
  assert.equal(fs.readFileSync(note, 'utf8'), before)
})

test('a new note starts empty whatever the request carries', async (t) => {
  const { call, note, vault } = await setup(t)
  await call('note_api', { method: 'POST', url: url('a.md'), body: { text: 'x' } }, note)
  assert.equal(fs.readFileSync(path.join(vault, 'a.md'), 'utf8'), '')
})

test('notes are not created outside the folder or in places that are not served', async (t) => {
  const { call, note, base, vault } = await setup(t)
  fs.mkdirSync(path.join(base, 'elsewhere'))
  fs.symlinkSync(path.join(base, 'elsewhere'), path.join(vault, 'link'))
  for (const rel of ['../new.md', '.hidden/new.md', 'node_modules/new.md', '__outside__/new.md', 'new.txt', 'link/new.md', path.join(base, 'new.md')]) {
    assert.equal((await call('note_api', { method: 'POST', url: url(rel) }, note)).status, 400, rel)
  }
  assert.ok(!fs.existsSync(path.join(base, 'new.md')))
  assert.deepEqual(fs.readdirSync(path.join(base, 'elsewhere')), [])
  assert.ok(!fs.existsSync(path.join(vault, '.hidden')))
  assert.ok(!fs.existsSync(path.join(vault, '__outside__')))
})

test('a tab opened outside the folder cannot create a note', async (t) => {
  const { call, base, vault } = await setup(t)
  const outside = path.join(base, 'outside.md')
  assert.equal((await call('note_api', { method: 'GET', url: '/api/notes' }, outside)).data.canCreate, false)
  assert.equal((await call('note_api', { method: 'POST', url: url('new.md') }, outside)).status, 403)
  assert.equal((await call('note_api', { method: 'GET', url: url('sub/ノート.md') }, outside)).status, 403)
  assert.ok(!fs.existsSync(path.join(vault, 'new.md')))
})

test('creating under another spelling of an existing name keeps that note and its name', async (t) => {
  const { call, note, vault } = await setup(t)
  fs.writeFileSync(path.join(vault, 'Memo.md'), 'x\n')
  const created = await call('note_api', { method: 'POST', url: url('memo.md') }, note)
  const caseInsensitive = fs.existsSync(path.join(vault, 'MEMO.md'))
  assert.equal(created.status, caseInsensitive ? 409 : 201)
  assert.equal(fs.readFileSync(path.join(vault, 'Memo.md'), 'utf8'), 'x\n')
  assert.ok(fs.readdirSync(vault).includes('Memo.md'))
})

test('a folder named like a note is not replaced, and a new note may start new folders', async (t) => {
  const { call, note, vault } = await setup(t)
  fs.mkdirSync(path.join(vault, 'dir.md'))
  assert.equal((await call('note_api', { method: 'POST', url: url('dir.md') }, note)).status, 409)
  assert.ok(fs.statSync(path.join(vault, 'dir.md')).isDirectory())
  assert.equal((await call('note_api', { method: 'POST', url: url('a/b/new.md') }, note)).status, 201)
  assert.equal(fs.readFileSync(path.join(vault, 'a/b/new.md'), 'utf8'), '')
})

test('file pane: folders listed, created, moved with link rewrite, and trashed', async (t) => {
  const { call, note, vault } = await setup(t)
  const api = (method, target, body) => call('note_api', { method, url: target, body }, note)
  fs.writeFileSync(path.join(vault, 'メモ.md'), '本文')
  fs.writeFileSync(path.join(vault, 'top.md'), '[行く](メモ.md)')
  assert.equal((await api('POST', `/api/folder?path=${encodeURIComponent('空')}`)).status, 201)
  assert.ok((await api('GET', '/api/notes')).data.folders.includes('空'), 'an empty folder is listed at once')
  const planned = await api('GET', `/api/move-plan?from=${encodeURIComponent('メモ.md')}&to=${encodeURIComponent('空/メモ.md')}`)
  assert.deepEqual(planned.data, { notes: ['top.md'], blocked: [] })
  const moved = await api('POST', '/api/move', { from: 'メモ.md', to: '空/メモ.md', rewrite: true })
  assert.equal(moved.status, 200)
  assert.equal(moved.data.rewritten, 1)
  assert.equal(fs.readFileSync(path.join(vault, 'top.md'), 'utf8'), '[行く](空/メモ.md)')
  fs.writeFileSync(path.join(vault, '空/絵.png'), 'png')
  const info = await api('GET', `/api/item?path=${encodeURIComponent('空')}`)
  assert.deepEqual(info.data, { isFolder: true, notes: 1, others: 1 })
  const trashDir = path.join(path.dirname(vault), 'trash')
  fs.mkdirSync(trashDir)
  process.env.NOTEDOCK_TRASH_DIR = trashDir
  t.after(() => { delete process.env.NOTEDOCK_TRASH_DIR })
  assert.equal((await api('POST', `/api/trash?path=${encodeURIComponent('空')}`)).status, 200)
  assert.ok(!fs.existsSync(path.join(vault, '空')))
  assert.ok(fs.existsSync(path.join(trashDir, '空', 'メモ.md')))
})

test('the note this tab was opened on, and folders holding it, cannot be moved or trashed', async (t) => {
  const { call, note } = await setup(t)
  const api = (method, target, body) => call('note_api', { method, url: target, body }, note)
  const own = await api('POST', '/api/move', { from: 'sub/ノート.md', to: 'ノート.md', rewrite: false })
  assert.equal(own.status, 409)
  assert.equal(own.data.error, 'opened note')
  assert.equal((await api('POST', '/api/move', { from: 'sub', to: 'sub2', rewrite: false })).status, 409)
  assert.equal((await api('POST', `/api/trash?path=${encodeURIComponent('sub/ノート.md')}`)).status, 409)
  assert.equal((await api('POST', '/api/trash?path=sub')).status, 409)
  assert.ok(fs.existsSync(note))
})

test('file pane operations are refused from a tab that cannot write, and for hidden or outside paths', async (t) => {
  const { call, note, base, vault } = await setup(t)
  const api = (method, target, body, host = note) => call('note_api', { method, url: target, body }, host)
  fs.writeFileSync(path.join(vault, 'x.md'), '')
  assert.equal((await api('POST', '/api/folder?path=x', undefined, path.join(base, 'outside.md'))).status, 403)
  assert.equal((await api('POST', '/api/folder?path=.hidden')).status, 400)
  assert.equal((await api('POST', '/api/move', { from: 'x.md', to: '../out.md', rewrite: false })).status, 400)
  assert.equal((await api('POST', '/api/move', { from: 'x.md', to: '__outside__/x.md', rewrite: false })).status, 400)
  assert.equal((await api('POST', '/api/trash?path=')).status, 400)
})

// 書き込み禁止のフォルダーでは保存を断り、元のノートも、書きかけのファイルも残さない。
test('a save into a read-only folder fails, leaves the note as it was and no half-written file', async (t) => {
  const { call, note } = await setup(t)
  const api = (method, target, body) => call('note_api', { method, url: target, body }, note)
  const folder = path.dirname(note)
  const before = fs.readFileSync(note, 'utf8')
  const read = await api('GET', url('sub/ノート.md'))
  fs.chmodSync(folder, 0o555)
  try {
    const failed = await api('PUT', url('sub/ノート.md'), { text: 'x\n', baseHash: read.data.hash })
    assert.equal(failed.status, 500)
    assert.equal(fs.readFileSync(note, 'utf8'), before)
    assert.deepEqual(fs.readdirSync(folder), ['ノート.md'])
  } finally {
    fs.chmodSync(folder, 0o755)
  }
  const saved = await api('PUT', url('sub/ノート.md'), { text: 'x\n', baseHash: read.data.hash })
  assert.equal(saved.status, 200)
  assert.equal(fs.readFileSync(note, 'utf8'), 'x\n')
  assert.deepEqual(fs.readdirSync(folder), ['ノート.md'])
})

// パネルを出せないアプリ（AIに機能を隠さないかもしれないアプリ）からは、ノートを読み書きさせない。
// Codexアプリ（26.1027 と 26.1111 で確かめた）は、パネルの呼び出しを、パネルを出せると名乗ったつなぎでだけ送ってきた。
test('a host that does not announce panel support can neither read nor write notes', async (t) => {
  for (const capabilities of [{}, { extensions: {} }, { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/plain'] } } }]) {
    const { call, note, vault } = await setup(t, { capabilities })
    const before = fs.readFileSync(note, 'utf8')
    for (const hostPath of [undefined, note]) {
      const read = await call('note_api', { method: 'GET', url: url('sub/ノート.md') }, hostPath)
      assert.equal(read.status, 403, JSON.stringify(capabilities))
      assert.equal(read.data.error, 'panel only')
      assert.equal(JSON.stringify(read).includes('本文'), false, 'no note text in the answer')
      const put = await call('note_api', { method: 'PUT', url: url('sub/ノート.md'), body: { text: 'x', baseHash: hashText(before) } }, hostPath)
      assert.equal(put.status, 403)
      const trash = await call('note_api', { method: 'POST', url: `/api/trash?path=${encodeURIComponent('sub/ノート.md')}` }, hostPath)
      assert.equal(trash.status, 403)
      assert.deepEqual(await call('note_locate', {}, hostPath), { scope: 'outside' })
    }
    assert.equal(fs.readFileSync(note, 'utf8'), before)
    assert.deepEqual(fs.readdirSync(vault).sort(), ['sub'])
  }
})

test('a host that announces panel support keeps working, with and without an opened file', async (t) => {
  const { call, note, rootId } = await setup(t)
  assert.equal((await call('note_api', { method: 'GET', url: url('sub/ノート.md') }, note)).status, 200)
  // ファイルなしで開いたとき（AI が open_note を呼んだとき）は読むだけで、フォルダーの中は何も渡さない。
  assert.equal((await call('note_api', { method: 'GET', url: url('sub/ノート.md') })).status, 403)
  assert.deepEqual(await call('note_locate', {}, note), { scope: 'inside', path: 'sub/ノート.md', rootId })
})

test('note_api says honestly that it can overwrite and trash notes', async (t) => {
  const { client } = await setup(t)
  const { tools } = await client.listTools()
  const api = tools.find((tool) => tool.name === 'note_api')
  assert.equal(api.annotations.readOnlyHint, false)
  assert.equal(api.annotations.destructiveHint, true)
})

test('動いている間も、決まった間隔で期限切れの控えを片付ける', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-every-'))
  const vault = path.join(base, 'vault')
  fs.mkdirSync(vault)
  fs.writeFileSync(path.join(vault, 'a.md'), 'x\n')
  fs.writeFileSync(path.join(base, 'panel.html'), '<p>panel</p>')
  const backupDir = path.join(base, 'backups')
  const server = createNoteServer({ root: vault, backupDir, panelFile: path.join(base, 'panel.html'), pruneEvery: 20 })
  // 起動したあとで、期限切れの控えができた（長く動かしている間に古くなったのと同じ）。
  // 今の置き方（控えの場所／フォルダーの目印（16文字）／ノートのフォルダー）。
  const folder = path.join(backupDir, 'a'.repeat(16), 'b'.repeat(20))
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, '_path.txt'), 'a.md')
  const old = path.join(folder, `previous-${Date.now() - 3 * 24 * 60 * 60 * 1000}-1.md`)
  fs.writeFileSync(old, 'old')
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(fs.existsSync(old), false)
  await server.close()
})
