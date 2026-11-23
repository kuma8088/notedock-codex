// Codexアプリの代わりをするテスト用のサーバー。本物のエディターのサーバー（server/mcp.mjs）に MCP でつなぎ、
// パネルの画面は、そのサーバーが資源として返す panel.html をそのまま返す（ビルドしたもの。通信の制限も入っている）。
// 使い方: node test/browser/host-server.mjs <Vault> <控えの場所> <panel.html>
// 空いている番号で待ち受け、「ready <番号>」と出す。ゴミ箱は NOTEDOCK_TRASH_DIR で一時的なフォルダーへ向ける。
// 編集できるフォルダーの決め方を試すとき（test/browser/project-folder-check.py）：
// - HOST_NO_NOTE_ROOT=1 で、<Vault> を NOTE_ROOT にしない（公開版の利用者と同じ）。HOST_HOME で、ホームの代わりのフォルダーを渡す。
// - ?file= には、絶対パスも渡せる。POST /sandbox に {"cwd": "<フォルダー>"|"/"|null} を送ると、それ以後の呼び出しの
//   _meta に codex/sandbox-state（sandboxCwd）を付ける（Codex アプリが会話の作業フォルダーを付けるのと同じ形）。HOST_SANDBOX で最初の値。
// - ファイルなしで開いたタブは、サーバーでは読むだけになる。前からの試験（ファイルなしでフォルダーを編集する）のために、
//   ファイルなしのときも、サーバーへの呼び出しには HOST_TAB（なければ other/keep.md か最初のノート）を開いたファイルとして添える。
//   HOST_NO_DEFAULT_TAB=1 で添えない。
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { build } from 'esbuild'

import { createCore } from '../../server/core.mjs'
import { createNoteServer } from '../../server/mcp.mjs'
import { listNotes } from '../../server/paths.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const [vault, backupDir, panelFile] = process.argv.slice(2)

// Codexアプリがパネル用のつなぎで名乗る印（test/mcp.test.mjs と同じ）。
const PANEL_HOST = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app', 'text/html+skybridge'] } } }
const server = createNoteServer({
  root: process.env.HOST_NO_NOTE_ROOT ? undefined : vault, backupDir, panelFile, decideTtlMs: 0,
  ...(process.env.HOST_HOME ? { home: process.env.HOST_HOME } : {}),
})
let sandboxCwd = process.env.HOST_SANDBOX || null
const defaultTab = process.env.HOST_NO_DEFAULT_TAB ? null
  : process.env.HOST_TAB || (fs.existsSync(path.join(vault, 'other/keep.md')) ? 'other/keep.md' : listNotes(vault).sort()[0] ?? null)
const hostPathOf = (file) => (path.isAbsolute(file) ? file : path.join(vault, file))
const [a, b] = InMemoryTransport.createLinkedPair()
const client = new Client({ name: 'test-host', version: '1' }, { capabilities: PANEL_HOST })
await Promise.all([server.connect(a), client.connect(b)])

const { contents } = await client.readResource({ uri: 'ui://notedock/panel.html' })
const panel = contents[0].text
const harness = await build({
  entryPoints: [path.join(here, 'host-harness.mjs')], bundle: true, format: 'esm', write: false,
  outdir: path.join(os.tmpdir(), 'host-harness-out'), logLevel: 'warning',
})
const hostPage = `<!doctype html><meta charset="utf-8"><title>test host</title><style>html,body{margin:0;height:100%}</style>`
  + `<script type="module">${harness.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script>`

const http200 = (res, type, body) => {
  res.writeHead(200, { 'content-type': type })
  res.end(body)
}

const web = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://host.invalid')
  if (req.method === 'GET' && url.pathname === '/panel.html') return http200(res, 'text/html; charset=utf-8', panel)
  if (req.method === 'POST' && url.pathname === '/tool') {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', async () => {
      const { name, arguments: args, file } = JSON.parse(raw)
      // ファイルから開いたタブの呼び出しには、Codexアプリと同じく、開いたファイルの場所を添える。
      const tab = file ?? defaultTab
      const _meta = {
        ...(tab ? { 'openai/resource': { path: hostPathOf(tab) } } : {}),
        ...(sandboxCwd ? { 'codex/sandbox-state': { sandboxCwd: sandboxCwd === '/' ? 'file:///' : pathToFileURL(sandboxCwd).href } } : {}),
      }
      const meta = Object.keys(_meta).length ? { _meta } : {}
      let result
      try {
        result = await client.callTool({ name, arguments: args, ...meta })
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: String(error) }] }
      }
      http200(res, 'application/json', JSON.stringify(result))
    })
    return
  }
  if (req.method === 'GET' && url.pathname === '/resource') return http200(res, 'text/plain; charset=utf-8', fs.readFileSync(hostPathOf(url.searchParams.get('file')), 'utf8'))
  if (req.method === 'POST' && url.pathname === '/sandbox') {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      sandboxCwd = JSON.parse(raw).cwd ?? null
      http200(res, 'application/json', '{}')
    })
    return
  }
  if (req.method === 'GET' && url.pathname === '/') return http200(res, 'text/html; charset=utf-8', hostPage)
  res.writeHead(404)
  res.end()
})

// テストから設定を入れる（フォルダーの中身の処理に直接渡す）。
if (process.env.HOST_SETTINGS) createCore({ root: vault, backupDir }).request('PUT', '/api/settings', JSON.parse(process.env.HOST_SETTINGS), { editable: true, opened: null })
web.listen(0, '127.0.0.1', () => console.log(`ready ${web.address().port}`))
