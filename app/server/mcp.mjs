import { readFile } from 'node:fs/promises'
import { clearInterval, setInterval } from 'node:timers'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RESOURCE_MIME_TYPE, getUiCapability, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { getResourcePath } from '@openai/mcp-extensions'
import { z } from 'zod'

import { createCore, pruneBackups } from './core.mjs'
import { createResolver, pruneRecords, writeRecord } from './folders.mjs'
import { defaultBackupDir } from './places.mjs'
import { DEFAULT_ATTACHMENT_DIR } from './vault-settings.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const UI = 'ui://notedock/panel.html'

// What the host said about the opened file. 'none' means no file at all (the AI called open_note, or a chat; there is no left rail or More tools entry any more);
// anything the host sent that is not a usable path is 'invalid' and is never mistaken for 'none'.
function hostFileOf(context) {
  let hostPath
  try {
    hostPath = getResourcePath(context?._meta ?? context?.mcpReq?._meta)
  } catch {
    return { kind: 'invalid' }
  }
  if (hostPath === undefined) return { kind: 'none' }
  if (typeof hostPath !== 'string' || hostPath === '') return { kind: 'invalid' }
  return { kind: 'path', path: hostPath }
}

const result = (structuredContent) => ({ content: [], structuredContent })
const metaOf = (context) => context?._meta ?? context?.mcpReq?._meta

// 読むだけ（編集できるフォルダーが決まらない）のときに答える中身。ファイル欄は空で、何も書けない。
const READ_ONLY = {
  'GET /api/health': { ok: true, root: '', rootId: 'none', rootPaths: [], editable: false },
  'GET /api/notes': { notes: [], known: [], folders: [], canCreate: false },
  'GET /api/share': { on: false },
  'GET /api/settings': { attachmentDir: null, periodic: null, errors: [], defaultAttachmentDir: DEFAULT_ATTACHMENT_DIR },
}
// 書き込みが通ったときに「使ったことがある」の記録を書くきっかけ。下書き・競合の控え・調べるだけ（dryRun）は入れない。
const RECORD_ROUTES = new Set([
  'PUT /api/note', 'POST /api/note', 'POST /api/attachment', 'POST /api/folder', 'POST /api/move', 'POST /api/trash',
  'POST /api/periodic/open', 'PUT /api/settings', 'PUT /api/share',
])
// 下書きの依頼は、URL の root で core が照合する（違えば何もしない）。
const DRAFT_ROUTES = new Set(['PUT /api/draft', 'POST /api/draft/clear'])

// サーバーの側でも、パネルからの依頼だけを受ける。
// パネルを出せると名乗ったつなぎ（MCP Apps の io.modelcontextprotocol/ui）だけで、ノートの読み書きを受ける。
// Codexアプリ（26.1027 と 26.1111 で確かめた）は、パネルの呼び出しを、この印を付けたつなぎでだけ送ってきた。印のないつなぎは、
// 道具などの一覧を聞くだけだった。AIの呼び出しがどのつなぎを通るかは確かめていない。
// なので、Codexアプリの中では、AIから見えないようにする印（visibility）が今までどおりの守り。これで足すのは、
// パネルを出せると名乗らないアプリ（AIに機能を隠さないかもしれない）に、何も読ませず、書かせないこと。
// この印はアプリが自分で名乗るだけなので、悪意のあるアプリは防げない。
function panelHost(server) {
  const ui = getUiCapability(server.server.getClientCapabilities())
  return Array.isArray(ui?.mimeTypes) && ui.mimeTypes.includes(RESOURCE_MIME_TYPE)
}

// 期限切れの控えを片付ける間隔。起動したときだけだと、長く動かしている間に古い控えがたまるため。
const PRUNE_EVERY_MS = 60 * 60 * 1000

export function createNoteServer({ root, backupDir, panelFile = join(HERE, 'panel.html'), extensions = ['.md'], pruneEvery = PRUNE_EVERY_MS, home = homedir(), decideTtlMs = 2000, log = (line) => console.error(line) }) {
  // 編集できるフォルダーは、呼び出しのたびに、その呼び出しの _meta から決める。サーバー全体で使い回す「今のフォルダー」は持たない。
  const resolver = createResolver({ noteRoot: root, backupDir, home, ttlMs: decideTtlMs })
  // 中身の処理はフォルダーごとに作る。キーは native の realpath。
  const cores = new Map()
  const coreFor = (decision) => {
    let core = cores.get(decision.native)
    if (!core) {
      core = createCore({ root: decision.folder, backupDir })
      cores.set(decision.native, core)
    }
    return core
  }
  // 読むだけになった理由は、画面には出さず、サーバーの記録（stderr）にだけ残す。同じものは繰り返さない。
  const logged = new Set()
  const decide = (context, { fresh = false } = {}) => {
    const file = hostFileOf(context)
    if (file.kind === 'invalid') return { invalid: true }
    if (file.kind === 'none') return { editable: false, reasons: ['no-file'] }
    const decision = resolver.decide(file.path, metaOf(context), { fresh })
    if (!decision.editable) {
      const line = `notedock: read only (${decision.reasons.join(', ')}): ${file.path}`
      if (!logged.has(line)) {
        if (logged.size > 500) logged.clear()
        logged.add(line)
        try {
          log(line)
        } catch {}
      }
    }
    return decision
  }
  // 書き込みが 2xx 以外で返ったときの理由。画面の帯だけでは原因が分からないので、
  // 経路・番号・エラーの種類（core が返す短い語。ノートの場所は入らない）・フォルダーの決まり方を、サーバーの記録に1行残す。
  // 衝突（409 conflict）はふつうの動きなので残さない。同じ行は繰り返さない。
  const reportWrite = (route, answer, decision) => {
    if (answer.status < 400 || answer.data?.conflict === true) return answer
    const kind = typeof answer.data?.error === 'string' ? answer.data.error.slice(0, 60) : 'unknown'
    const line = `notedock: write failed (${route} ${answer.status} ${kind}; ${decision?.editable ? decision.source : 'read-only'})`
    if (!logged.has(line)) {
      if (logged.size > 500) logged.clear()
      logged.add(line)
      try {
        log(line)
      } catch {}
    }
    return answer
  }
  // 古い控えの片付けに失敗しても、エディターは起動する。フォルダーが決まっていなくても、置き場全体にかける。
  const prune = () => {
    try {
      pruneBackups(backupDir)
    } catch {}
    try {
      if (pruneRecords(backupDir, { home }).length) resolver.bump()
    } catch {}
  }
  prune()
  // 片付けのためだけに、サーバーを終わらせずに残すことはしない（node:timers なら Deno でも unref できる）。
  const pruneTimer = setInterval(prune, pruneEvery)
  pruneTimer.unref()
  // codex/sandbox-state を名乗ると、Codex はツールの呼び出しの _meta に、会話の作業フォルダー（sandboxCwd）を入れる。
  // server/discover（新しい規格の確かめ）には答えない（古い規格の initialize で続ける）。試験で固定している。
  const server = new McpServer({ name: 'notedock', version: '0.1.0' }, { capabilities: { experimental: { 'codex/sandbox-state': {} } } })
  registerAppResource(server, 'NoteDock', UI, {}, async () => ({
    contents: [{
      uri: UI,
      mimeType: RESOURCE_MIME_TYPE,
      text: await readFile(panelFile, 'utf8'),
      _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] }, permissions: { clipboardWrite: {} } } },
    }],
  }))
  registerAppTool(server, 'open_note', {
    title: 'Visual Editor',
    description: '開いたMarkdownを見た目を整えて表示し、許可されたフォルダーのノートを編集する。',
    inputSchema: { file: z.object({ name: z.string(), resourceUri: z.string() }).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: {
      ui: { resourceUri: UI },
      'openai/outputTemplate': UI,
      // 開く入口は、会話やファイルの一覧の .md からだけ（左の列・More tools からは開かない）。
      'openai/ui': { entrypoints: [{ type: 'file', extensions }] },
    },
    // Never an error: the host keeps the plugin as the viewer for other .md files, and an error there
    // leaves only "Couldn't display". Notes outside the folder open read-only in the panel instead.
  }, async () => result({ opened: true }))
  server.registerTool('note_locate', {
    description: 'ホストが開いたファイルが編集できるフォルダーの中にあるかを調べる。',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] } },
  }, async (_args, context) => {
    if (!panelHost(server)) return result({ scope: 'outside' })
    const decision = decide(context)
    return result(decision.editable ? { scope: 'inside', path: decision.path, rootId: decision.rootId } : { scope: 'outside' })
  })
  server.registerTool('note_api', {
    description: 'パネルからのノートの読み書き。許可されたフォルダーの中だけを扱う。',
    inputSchema: {
      method: z.enum(['GET', 'PUT', 'POST']),
      url: z.string().max(4096),
      body: z.record(z.string(), z.unknown()).optional(),
      // パネルが開いたとき（切り替え・受け取り直しのとき）に受け取った rootId。書き込みのたびに照合する。
      root: z.string().max(64).optional(),
    },
    // ノートを上書きし、ゴミ箱に入れることもあるので、正直に「消す操作をする」と申告する。
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] } },
    // The host attaches the opened file's path only to calls from a panel in a file entrypoint. A panel opened
    // without a file (for example when the AI calls open_note) edits the folder. That path is no longer an entry point
    // (no left rail or More tools), but it is kept for open_note. The model cannot see this tool. A file outside the folder still opens read-only.
  }, async ({ method, url, body, root: sentRoot }, context) => {
    if (!panelHost(server)) return result({ status: 403, data: { error: 'panel only' } })
    let target
    try {
      target = new URL(url, 'http://panel.invalid')
    } catch {
      return result({ status: 400, data: { error: 'path not allowed' } })
    }
    const route = `${method} ${target.pathname}`
    const write = method !== 'GET' && !(route === 'POST /api/periodic/open' && body?.dryRun === true)
    // 書き込みのときは、使い回さずに決め直す。
    const decision = decide(context, { fresh: write })
    if (decision.invalid) return result({ status: 403, data: { error: 'panel only' } })
    // 途中で編集できるフォルダーが変わると、パネルが持っている相対パスが別のフォルダーに向く。
    // 書き込みは rootId が違えば（送っていなくても）断る。読み出しも、前のフォルダーの rootId を送ってきたら断る
    // （別のフォルダーの同じ相対パスの中身を、開いているノートに取り込まないため）。health だけは受け取り直しに使うので答える。
    // パネルは中身を覚えたまま、小さな印だけを出して受け取り直す（開き直しを促す文は出さない）。
    const current = decision.editable ? decision.rootId : 'none'
    const stale = typeof sentRoot === 'string' && sentRoot !== '' && sentRoot !== 'none' && sentRoot !== current
    const refuse = route !== 'GET /api/health' && !DRAFT_ROUTES.has(route) && (stale || (write && decision.editable && sentRoot !== current))
    if (refuse) return result(write ? reportWrite(route, { status: 423, data: { error: 'other-root', rootId: current } }, decision) : { status: 423, data: { error: 'other-root', rootId: current } })
    if (!decision.editable) {
      const answer = READ_ONLY[route]
      if (answer) return result({ status: 200, data: answer })
      const refused = { status: 403, data: { error: 'read only' } }
      return result(write ? reportWrite(route, refused, decision) : refused)
    }
    const answer = coreFor(decision).request(method, url, body ?? {}, { editable: true, opened: decision.path })
    if (route === 'GET /api/fingerprint' && answer.status === 200) answer.data = { ...answer.data, rootId: decision.rootId }
    if (write && answer.status >= 200 && answer.status < 300 && RECORD_ROUTES.has(route)) {
      try {
        // NOTE_ROOT か sandboxCwd で編集できると決まったフォルダーだけ。使ったことのあるフォルダーには、すでに記録がある。
        const wrote = decision.source !== 'used' && writeRecord(backupDir, decision.native)
        if (wrote || route === 'PUT /api/settings') resolver.bump()
      } catch {}
    }
    if (write) reportWrite(route, answer, decision)
    return result(answer)
  })
  // サーバーを閉じたら、片付けの間隔も止める。
  const close = server.close.bind(server)
  server.close = async () => {
    clearInterval(pruneTimer)
    return close()
  }
  return server
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const backupDir = defaultBackupDir()
  const server = createNoteServer({ root: process.env.NOTE_ROOT, backupDir })
  // アプリとの接続が閉じたら終わる。書き込みはどれも同期なので、途中で終わっても書きかけは残らない。
  // 'end' だけでなく 'close' でも終わる（Windows でパイプが切れたときなど）。
  for (const event of ['end', 'close']) process.stdin.on(event, () => process.exit(0))
  await server.connect(new StdioServerTransport())
}
