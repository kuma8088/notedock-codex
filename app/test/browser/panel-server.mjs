// 画面の試験用のサーバー。パネルの画面を組み立てて返し、/api/* はサーバーの中心（createCore）に渡す。
// 使い方: node test/browser/panel-server.mjs <Vault> <控えの場所>
// 空いている番号で待ち受け、「ready <番号>」と出す。FORCE で失敗を作れる（下の FAILURES）。
// DRAFT_DELAY_MS を付けると、下書きの問い合わせ（GET /api/draft）の応答だけを、その時間だけ遅らせる。
// DRAFT_FAIL を付けると、最初のその回数だけ、下書きの問い合わせ（GET /api/draft）を 500 で断る。
// TRASH_DELAY_MS を付けると、ゴミ箱に入れる（POST /api/trash）応答だけを遅らせる（ゴミ箱には、届いたときに入れる）。
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

import { createCore } from '../../server/core.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = path.resolve(here, '../..')
const [vault, backupDir] = process.argv.slice(2)

// パネルとの接続の部分だけを、試験用のものに差し替えて組み立てる。
const stub = { name: 'stub', setup(b) { b.onResolve({ filter: /\/panel\.mjs$/ }, () => ({ path: path.join(here, 'panel-stub.mjs') })) } }
const web = await build({
  entryPoints: { main: path.join(pkg, 'src/main.mjs'), style: path.join(pkg, 'src/style.css') },
  bundle: true, format: 'esm', write: false, outdir: path.join(os.tmpdir(), 'panel-check-out'),
  loader: { '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty' }, plugins: [stub], logLevel: 'warning',
})
const out = (name) => web.outputFiles.find((f) => f.path.endsWith(name)).text
const css = `${out('style.css')}\n${fs.readFileSync(path.join(pkg, 'src/panel.css'), 'utf8')}`
let html = fs.readFileSync(path.join(pkg, 'public/index.html'), 'utf8')
html = html.replace('<link rel="stylesheet" href="/assets/style.css">', () => `<style>${css}</style>`)
html = html.replace('<script type="module" src="/assets/main.js"></script>', () => `<script type="module">${out('main.js').replace(/<\/script/gi, '<\\/script')}</script>`)

// FORCE で作る失敗。[方法, 場所の始まり, 返す番号, 返す中身]
const FAILURES = {
  413: ['PUT', '/api/note', 413, { error: 'too large' }],
  500: ['PUT', '/api/note', 500, { error: 'down' }],
  409: ['PUT', '/api/note', 409, { error: 'something else' }],
  501: [null, '/api/trash', 501, { error: 'no trash command' }],
  backupfail: ['POST', '/api/backup', 500, { error: 'down' }],
  otherroot: ['PUT', '/api/draft', 200, { ok: false, reason: 'other-root' }],
}
const forced = FAILURES[process.env.FORCE]
const draftDelay = Number(process.env.DRAFT_DELAY_MS) || 0
const trashDelay = Number(process.env.TRASH_DELAY_MS) || 0
let draftFails = Number(process.env.DRAFT_FAIL) || 0

const core = createCore({ root: vault, backupDir })
const server = http.createServer((req, res) => {
  if (!req.url.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
    return
  }
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    let body = {}
    if (raw) {
      try {
        body = JSON.parse(raw)
      } catch {
        body = { base64: Buffer.from(raw, 'binary').toString('base64') }
      }
    }
    const hit = forced && (!forced[0] || forced[0] === req.method) && req.url.startsWith(forced[1])
    const where = new URL(req.url, 'http://127.0.0.1').pathname
    const failDraft = draftFails > 0 && req.method === 'GET' && where === '/api/draft'
    if (failDraft) draftFails -= 1
    const r = failDraft ? { status: 500, data: { error: 'down' } }
      : hit ? { status: forced[2], data: forced[3] } : core.request(req.method, req.url, body, { editable: true, opened: null })
    const reply = () => {
      res.writeHead(r.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(r.data))
    }
    // 下書きの問い合わせ・ゴミ箱の応答だけを遅らせる（中身は届いた時点のもの）。
    const wait = req.method === 'GET' && where === '/api/draft' ? draftDelay : req.method === 'POST' && where === '/api/trash' ? trashDelay : 0
    if (wait) setTimeout(reply, wait)
    else reply()
  })
})
server.listen(0, '127.0.0.1', () => console.log(`ready ${server.address().port}`))
