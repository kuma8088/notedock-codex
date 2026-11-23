import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'

import { nativeOf, rootIdOf, writeRecord } from '../server/folders.mjs'
import { createNoteServer } from '../server/mcp.mjs'

// 編集できるフォルダーの決め方を、MCP のつなぎ越しに確かめる（Codex がパネルの呼び出しに付ける _meta と同じ形で送る）。
const PANEL_HOST = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app', 'text/html+skybridge'] } } }

async function setup(t, { noteRoot } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-folder-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const home = path.join(base, 'home')
  const backupDir = path.join(home, 'Library/Application Support/NoteDockCodex')
  fs.mkdirSync(backupDir, { recursive: true })
  fs.writeFileSync(path.join(base, 'panel.html'), '<!doctype html>')
  const note = (rel, text = '# x\n') => {
    const file = path.join(home, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
    return file
  }
  const logs = []
  const server = createNoteServer({
    root: noteRoot ? path.join(home, noteRoot) : undefined, backupDir, panelFile: path.join(base, 'panel.html'), home, decideTtlMs: 0, log: (line) => logs.push(line),
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'codex-test', version: '1' }, { capabilities: PANEL_HOST })
  await Promise.all([server.connect(a), client.connect(b)])
  t.after(() => client.close())
  const meta = (hostPath, cwd) => ({
    ...(hostPath ? { 'openai/resource': { path: hostPath } } : {}),
    ...(cwd === undefined ? {} : { 'codex/sandbox-state': { sandboxCwd: cwd === '/' ? 'file:///' : pathToFileURL(cwd).href } }),
  })
  const call = async (name, args, hostPath, cwd) => (await client.callTool({ name, arguments: args, _meta: meta(hostPath, cwd) })).structuredContent
  const idOf = (rel) => rootIdOf(nativeOf(path.join(home, rel)))
  const records = () => {
    try {
      return fs.readdirSync(path.join(backupDir, 'settings')).filter((name) => name.endsWith('.root.json')).sort()
    } catch {
      return []
    }
  }
  return { base, home, backupDir, note, call, idOf, records, logs, server }
}

const url = (rel) => `/api/note?path=${encodeURIComponent(rel)}`

test('サーバーは capabilities.experimental に codex/sandbox-state を名乗り、server/discover には答えない', async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'discover-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  fs.writeFileSync(path.join(base, 'panel.html'), '<!doctype html>')
  const server = createNoteServer({ backupDir: path.join(base, 'b'), panelFile: path.join(base, 'panel.html'), home: base })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const replies = new Map()
  b.onmessage = (message) => replies.set(message.id, message)
  await b.start()
  const ask = async (id, method, params) => {
    await b.send({ jsonrpc: '2.0', id, method, params })
    for (let i = 0; i < 100 && !replies.has(id); i++) await new Promise((resolve) => setTimeout(resolve, 5))
    return replies.get(id)
  }
  // Codex は initialize の前に server/discover（新しい規格の確かめ）を送ってくる。
  const discover = await ask(1, 'server/discover', {})
  assert.equal(discover.error?.code, -32601)
  assert.equal(discover.result, undefined)
  const init = await ask(2, 'initialize', { protocolVersion: '2025-06-18', capabilities: PANEL_HOST, clientInfo: { name: 'c', version: '1' } })
  assert.deepEqual(init.result.capabilities.experimental, { 'codex/sandbox-state': {} })
  await server.close()
})

test('プロジェクトの会話：sandboxCwd の中のノートは編集でき、保存すると「使ったことがある」の記録を書く', async (t) => {
  const { home, call, idOf, records, note, backupDir } = await setup(t)
  const file = note('srv/project/docs/n.md', 'base\n')
  const project = path.join(home, 'srv/project')
  assert.deepEqual(await call('note_locate', {}, file, project), { scope: 'inside', path: 'docs/n.md', rootId: idOf('srv/project') })
  const health = await call('note_api', { method: 'GET', url: '/api/health' }, file, project)
  assert.equal(health.data.rootId, idOf('srv/project'))
  assert.deepEqual(health.data.rootPaths, [fs.realpathSync(project)])
  const read = await call('note_api', { method: 'GET', url: url('docs/n.md') }, file, project)
  assert.equal(read.data.editable, true)
  assert.deepEqual(records(), [])
  const saved = await call('note_api', { method: 'PUT', url: url('docs/n.md'), body: { text: 'changed\n', baseHash: read.data.hash }, root: idOf('srv/project') }, file, project)
  assert.equal(saved.status, 200)
  assert.equal(fs.readFileSync(file, 'utf8'), 'changed\n')
  assert.deepEqual(records(), [`${idOf('srv/project')}.root.json`])
  const record = JSON.parse(fs.readFileSync(path.join(backupDir, 'settings', `${idOf('srv/project')}.root.json`), 'utf8'))
  assert.equal(record.path, nativeOf(project))
  assert.equal(typeof record.firstUsedAt, 'number')
  // 一度保存したので、会話の前（sandboxCwd が /）でも編集できる（使ったことのあるフォルダー）。
  assert.deepEqual(await call('note_locate', {}, file, '/'), { scope: 'inside', path: 'docs/n.md', rootId: idOf('srv/project') })
})

test('記録は、読むだけ・下書き・調べるだけ・断られた書き込みでは書かない', async (t) => {
  const { home, call, idOf, records, note } = await setup(t)
  const file = note('srv/project/n.md', 'base\n')
  const project = path.join(home, 'srv/project')
  const root = idOf('srv/project')
  await call('note_api', { method: 'GET', url: url('n.md') }, file, project)
  await call('note_api', { method: 'PUT', url: `/api/draft?path=n.md&root=${root}`, body: { draft: { text: 'a', baseText: 'b' } } }, file, project)
  await call('note_api', { method: 'POST', url: '/api/periodic/open', body: { dryRun: true, kind: 'daily', date: '2026-11-23' }, root }, file, project)
  await call('note_api', { method: 'PUT', url: url('n.md'), body: { text: 'x', baseHash: 'wrong' }, root }, file, project)
  await call('note_api', { method: 'POST', url: '/api/backup?path=n.md', body: { text: 'x' }, root }, file, project)
  assert.deepEqual(records(), [])
  assert.equal(fs.readFileSync(file, 'utf8'), 'base\n')
})

test('プロジェクトなしの会話：作業フォルダーの中の .md は編集できる。外のノートは読むだけ', async (t) => {
  const { home, call, idOf, note } = await setup(t)
  const work = path.join(home, 'Documents/Codex/2026-11-23/talk')
  const memo = note('Documents/Codex/2026-11-23/talk/memo.md')
  const vault = note('srv/vault/Home.md')
  assert.deepEqual(await call('note_locate', {}, memo, work), { scope: 'inside', path: 'memo.md', rootId: idOf('Documents/Codex/2026-11-23/talk') })
  assert.deepEqual(await call('note_locate', {}, vault, work), { scope: 'outside' })
  assert.equal((await call('note_api', { method: 'GET', url: '/api/health' }, vault, work)).data.rootId, 'none')
})

test('会話の前（sandboxCwd が /）：使ったことがなければ読むだけ。理由はサーバーの記録にだけ残す', async (t) => {
  const { call, note, logs } = await setup(t)
  const file = note('srv/vault/Home.md')
  assert.deepEqual(await call('note_locate', {}, file, '/'), { scope: 'outside' })
  const read = await call('note_api', { method: 'GET', url: url('Home.md') }, file, '/')
  assert.equal(read.status, 403)
  assert.ok(logs.some((line) => line.includes('sandbox-too-broad')), logs)
  // 同じ理由は繰り返して書かない。
  await call('note_locate', {}, file, '/')
  assert.equal(logs.filter((line) => line.includes('sandbox-too-broad')).length, 1)
})

test('使ったことのあるフォルダー：今の設定ファイルがあれば、会話の前でも編集できる。保存しても新しい記録は書かない', async (t) => {
  const { call, note, idOf, records, backupDir } = await setup(t)
  const file = note('srv/vault/sub/n.md', 'base\n')
  fs.mkdirSync(path.join(backupDir, 'settings'), { recursive: true })
  fs.writeFileSync(path.join(backupDir, 'settings', `${idOf('srv/vault')}.json`), '{}')
  const root = idOf('srv/vault')
  assert.deepEqual(await call('note_locate', {}, file, '/'), { scope: 'inside', path: 'sub/n.md', rootId: root })
  const read = await call('note_api', { method: 'GET', url: url('sub/n.md') }, file)
  const saved = await call('note_api', { method: 'PUT', url: url('sub/n.md'), body: { text: 'x\n', baseHash: read.data.hash }, root }, file)
  assert.equal(saved.status, 200)
  assert.deepEqual(records(), [])
})

test('NOTE_ROOT：両方に含まれるときは NOTE_ROOT。保存で NOTE_ROOT の記録を書く', async (t) => {
  const { home, call, idOf, note, records } = await setup(t, { noteRoot: 'srv/vault' })
  const file = note('srv/vault/sub/n.md', 'base\n')
  const inner = path.join(home, 'srv/vault/sub')
  assert.deepEqual(await call('note_locate', {}, file, inner), { scope: 'inside', path: 'sub/n.md', rootId: idOf('srv/vault') })
  assert.deepEqual(await call('note_locate', {}, file, '/'), { scope: 'inside', path: 'sub/n.md', rootId: idOf('srv/vault') })
  const read = await call('note_api', { method: 'GET', url: url('sub/n.md') }, file, '/')
  await call('note_api', { method: 'PUT', url: url('sub/n.md'), body: { text: 'x\n', baseHash: read.data.hash }, root: idOf('srv/vault') }, file, '/')
  assert.deepEqual(records(), [`${idOf('srv/vault')}.root.json`])
})

test('リンク：sandboxCwd が実体側の綴りで届き、ノートをリンク側の道で開いても編集できる', async (t) => {
  const { home, call, idOf, note } = await setup(t)
  note('Library/CloudStorage/Dropbox-a/Vault/n.md')
  fs.symlinkSync(path.join(home, 'Library/CloudStorage/Dropbox-a'), path.join(home, 'Dropbox'))
  const opened = path.join(home, 'Dropbox/Vault/n.md')
  const real = path.join(home, 'Library/CloudStorage/Dropbox-a/Vault')
  assert.deepEqual(await call('note_locate', {}, opened, real), { scope: 'inside', path: 'n.md', rootId: idOf('Library/CloudStorage/Dropbox-a/Vault') })
  // リンク側の綴りで届いても同じ rootId。
  assert.deepEqual(await call('note_locate', {}, opened, path.join(home, 'Dropbox/Vault')), { scope: 'inside', path: 'n.md', rootId: idOf('Library/CloudStorage/Dropbox-a/Vault') })
})

test('広すぎる：ホーム・Documents・~/.codex の worktrees のすぐ下は断り、worktree そのものは認める', async (t) => {
  const { home, call, idOf, note } = await setup(t)
  const file = note('Documents/n.md')
  assert.deepEqual(await call('note_locate', {}, file, home), { scope: 'outside' })
  assert.deepEqual(await call('note_locate', {}, file, path.join(home, 'Documents')), { scope: 'outside' })
  const tree = note('.codex/worktrees/a1b2/repo/README.md')
  assert.deepEqual(await call('note_locate', {}, tree, path.join(home, '.codex/worktrees/a1b2')), { scope: 'outside' })
  assert.deepEqual(await call('note_locate', {}, tree, path.join(home, '.codex/worktrees/a1b2/repo')), { scope: 'inside', path: 'README.md', rootId: idOf('.codex/worktrees/a1b2/repo') })
})

test('rootId の照合：送った rootId が、その呼び出しで決めたフォルダーと違う書き込みは断る（423）', async (t) => {
  const { home, call, idOf, note } = await setup(t)
  const file = note('srv/outer/inner/n.md', 'base\n')
  const outer = path.join(home, 'srv/outer')
  const inner = path.join(home, 'srv/outer/inner')
  const read = await call('note_api', { method: 'GET', url: url('n.md') }, file, inner)
  // 内側で開いたパネルが、外側の会話に変わったあとで、内側の rootId のまま相対パスで書こうとする。
  const refused = await call('note_api', { method: 'PUT', url: url('n.md'), body: { text: 'x\n', baseHash: read.data.hash }, root: idOf('srv/outer/inner') }, file, outer)
  assert.equal(refused.status, 423)
  assert.deepEqual(refused.data, { error: 'other-root', rootId: idOf('srv/outer') })
  assert.equal(fs.readFileSync(file, 'utf8'), 'base\n')
  // rootId なしの書き込みも断る。
  assert.equal((await call('note_api', { method: 'POST', url: url('new.md') }, file, inner)).status, 423)
  // 照合が合えば書ける。
  assert.equal((await call('note_api', { method: 'PUT', url: url('n.md'), body: { text: 'x\n', baseHash: read.data.hash }, root: idOf('srv/outer/inner') }, file, inner)).status, 200)
})

test('前のフォルダーの rootId を送ってきた読み出しは、中身を返さずに断る（別のフォルダーの同じ相対パスを読まない）', async (t) => {
  const { home, call, idOf, note } = await setup(t)
  const file = note('srv/outer/inner/n.md', 'inner\n')
  note('srv/outer/n.md', 'outer\n')
  const outer = path.join(home, 'srv/outer')
  const read = await call('note_api', { method: 'GET', url: url('n.md'), root: idOf('srv/outer/inner') }, file, outer)
  assert.equal(read.status, 423)
  assert.deepEqual(read.data, { error: 'other-root', rootId: idOf('srv/outer') })
  const fp = await call('note_api', { method: 'GET', url: '/api/fingerprint?path=n.md', root: idOf('srv/outer/inner') }, file, outer)
  assert.equal(fp.status, 423)
  assert.equal(fp.data.rootId, idOf('srv/outer'))
  // health は受け取り直しに使うので、前の rootId でも答える。
  const health = await call('note_api', { method: 'GET', url: '/api/health', root: idOf('srv/outer/inner') }, file, outer)
  assert.equal(health.data.rootId, idOf('srv/outer'))
})

test('編集できる → 読むだけ：前の rootId を送った書き込みは 423（rootId は none）で断り、何も書かない', async (t) => {
  const { home, call, idOf, note } = await setup(t)
  const file = note('srv/project/n.md', 'base\n')
  const project = path.join(home, 'srv/project')
  const read = await call('note_api', { method: 'GET', url: url('n.md') }, file, project)
  const refused = await call('note_api', { method: 'PUT', url: url('n.md'), body: { text: 'x\n', baseHash: read.data.hash }, root: idOf('srv/project') }, file, '/')
  assert.equal(refused.status, 423)
  assert.deepEqual(refused.data, { error: 'other-root', rootId: 'none' })
  assert.equal(fs.readFileSync(file, 'utf8'), 'base\n')
  // 同じフォルダーに戻れば、同じ rootId で保存できる。
  assert.equal((await call('note_api', { method: 'PUT', url: url('n.md'), body: { text: 'x\n', baseHash: read.data.hash }, root: idOf('srv/project') }, file, project)).status, 200)
})

test('古いキー codex/sandbox-state-meta だけが届いても、決め方まで通る', async (t) => {
  const { home, idOf, note, server } = await setup(t)
  void server
  const file = note('srv/project/n.md')
  const [a, b] = InMemoryTransport.createLinkedPair()
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  fs.writeFileSync(path.join(base, 'panel.html'), '<!doctype html>')
  const other = createNoteServer({ backupDir: path.join(base, 'b'), panelFile: path.join(base, 'panel.html'), home, decideTtlMs: 0, log: () => {} })
  const client = new Client({ name: 'c', version: '1' }, { capabilities: PANEL_HOST })
  await Promise.all([other.connect(a), client.connect(b)])
  t.after(() => client.close())
  const got = (await client.callTool({ name: 'note_locate', arguments: {}, _meta: { 'openai/resource': { path: file }, 'codex/sandbox-state-meta': { sandboxCwd: pathToFileURL(path.join(home, 'srv/project')).href } } })).structuredContent
  assert.deepEqual(got, { scope: 'inside', path: 'n.md', rootId: idOf('srv/project') })
})

test('fingerprint の応答に rootId が入るので、開いたままのパネルが、フォルダーが変わったことに気づける', async (t) => {
  const { home, call, idOf, note } = await setup(t)
  const file = note('srv/outer/inner/n.md')
  const a = await call('note_api', { method: 'GET', url: '/api/fingerprint?path=n.md' }, file, path.join(home, 'srv/outer/inner'))
  assert.equal(a.data.rootId, idOf('srv/outer/inner'))
  const b = await call('note_api', { method: 'GET', url: '/api/fingerprint?path=inner/n.md' }, file, path.join(home, 'srv/outer'))
  assert.equal(b.data.rootId, idOf('srv/outer'))
})

test('ファイルなしで開いたとき（AI が open_note を呼んだ）は、sandboxCwd があっても読むだけ', async (t) => {
  const { home, call, note } = await setup(t)
  note('srv/project/n.md')
  assert.deepEqual(await call('note_locate', {}, undefined, path.join(home, 'srv/project')), { scope: 'outside' })
  assert.equal((await call('note_api', { method: 'GET', url: url('n.md') }, undefined, path.join(home, 'srv/project'))).status, 403)
})

test('AI が書ける道具の引数（open_note の file）では、編集できる範囲は広がらない', async (t) => {
  const { home, call, note, records } = await setup(t)
  const file = note('srv/project/n.md')
  await call('open_note', { file: { name: 'n.md', resourceUri: pathToFileURL(file).href } }, undefined, path.join(home, 'srv/project'))
  assert.deepEqual(await call('note_locate', {}, undefined), { scope: 'outside' })
  assert.deepEqual(records(), [])
})


// NOTE_ROOT があり、会話の前で sandboxCwd が file:///（読むだけの permissionProfile 付き）、すでに .root.json があるときも、
// 読み出しと書き込みが同じフォルダーで通ること。
test('NOTE_ROOT と会話の前（Codex の _meta の形そのまま、sandboxCwd が file:///）：読み出しと書き込みが同じフォルダーで通る', async (t) => {
  const { base, home, backupDir, note, idOf } = await setup(t)
  const file = note('srv/vault/_editor-test-folder.md', '# 試験\n')
  const server = createNoteServer({ root: path.join(home, 'srv/vault'), backupDir, panelFile: path.join(base, 'panel.html'), home, log: () => {} })
  // A・B で保存したあと（.root.json がある）。
  writeRecord(backupDir, nativeOf(path.join(home, 'srv/vault')))
  const state = { permissionProfile: { type: 'managed', file_system: { type: 'restricted', entries: [{ path: { type: 'special', value: { kind: 'root' } }, access: 'read' }] }, network: 'restricted' }, codexLinuxSandboxExe: null, sandboxCwd: 'file:///', useLegacyLandlock: false, useMxc: false }
  const _meta = { 'openai/resource': { path: file }, thread_id: 't', threadId: 't', 'codex/sandbox-state': state, 'codex/sandbox-state-meta': state, 'codex/sandbox-launcher': { codexExecutable: '/x/codex' }, progressToken: 2 }
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'codex', version: '1' }, { capabilities: PANEL_HOST })
  await Promise.all([server.connect(a), client.connect(b)])
  t.after(() => client.close())
  const call = async (name, args) => (await client.callTool({ name, arguments: args, _meta })).structuredContent
  const root = idOf('srv/vault')
  assert.deepEqual(await call('note_locate', {}), { scope: 'inside', path: '_editor-test-folder.md', rootId: root })
  const health = await call('note_api', { method: 'GET', url: '/api/health' })
  assert.equal(health.data.rootId, root)
  const read = await call('note_api', { method: 'GET', url: url('_editor-test-folder.md'), root })
  assert.equal(read.data.editable, true)
  const saved = await call('note_api', { method: 'PUT', url: url('_editor-test-folder.md'), body: { text: '# 試験x\n', baseHash: read.data.hash, typedAt: Date.now() }, root })
  assert.equal(saved.status, 200, JSON.stringify(saved))
  assert.equal(fs.readFileSync(file, 'utf8'), '# 試験x\n')
})

// 書き込みが断られた理由は、画面の帯（「サーバーで保存に失敗しました」）だけでは分からない。
// 書き込みが 2xx 以外で返ったときは、経路・番号・エラーの種類と、フォルダーの決まり方を、サーバーの記録（stderr）に1行残す。
// ノートの場所や本文は書かない。同じ行は繰り返さない。
test('書き込みが断られたら、理由をサーバーの記録に1行だけ残す（ノートの場所は書かない）', async (t) => {
  const { home, call, note, logs, idOf } = await setup(t)
  const file = note('srv/project/crlf.md', 'a\r\nb\r\n')
  const project = path.join(home, 'srv/project')
  const root = idOf('srv/project')
  const read = await call('note_api', { method: 'GET', url: url('crlf.md'), root }, file, project)
  const before = logs.length
  for (let i = 0; i < 2; i++) {
    const saved = await call('note_api', { method: 'PUT', url: url('crlf.md'), body: { text: 'x\n', baseHash: read.data.hash }, root }, file, project)
    assert.equal(saved.status, 403)
  }
  const added = logs.slice(before)
  assert.equal(added.length, 1, JSON.stringify(added))
  assert.match(added[0], /^notedock: write failed \(PUT \/api\/note 403 not editable; sandbox\)$/)
  assert.ok(!added[0].includes(home) && !added[0].includes('crlf'), added[0])
  // ほかのフォルダーの rootId（423）と、外の印のパス（400）も残す。衝突（409 conflict）は残さない。
  await call('note_api', { method: 'PUT', url: url('crlf.md'), body: { text: 'x\n', baseHash: read.data.hash }, root: 'ffffffffffffffff' }, file, project)
  await call('note_api', { method: 'PUT', url: url('__outside__/crlf.md'), body: { text: 'x\n', baseHash: 'h' }, root }, file, project)
  const ok = note('srv/project/ok.md', 'base\n')
  await call('note_api', { method: 'PUT', url: url('ok.md'), body: { text: 'x\n', baseHash: 'wrong' }, root }, ok, project)
  const rest = logs.slice(before + 1)
  assert.deepEqual(rest, [
    'notedock: write failed (PUT /api/note 423 other-root; sandbox)',
    'notedock: write failed (PUT /api/note 400 path not allowed; sandbox)',
  ])
})
