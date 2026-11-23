// Connects the editor to the Codex panel. The panel has no server to fetch from, no EventSource target
// and no new windows, so those three browser features are provided here and the editor stays unchanged.
// Keep this import first: it must run before any zod schema is built.
import './zod-jitless.mjs'
import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps'
import { OpenAIExtensions, OpenAIFileEntrypointInputSchema } from '@openai/mcp-extensions/app'

import { fitToHost } from './ai-context.mjs'
import { setupPage, setupToShow, STATUS_URL } from './launcher-swap.mjs'
import { PanelEventSource } from './panel-events.mjs'
import { setImageLoader } from './widgets.mjs'

const OUTSIDE_PREFIX = '__outside__/'
const NO_FILE_MS = 15000

const app = new App({ name: 'NoteDock', version: '0.1.0' })
const extensions = new OpenAIExtensions(app)
let opened
let resolveOpened
const openedFile = new Promise((resolve) => {
  resolveOpened = resolve
})

function receiveFile(args) {
  if (opened !== undefined) return
  const parsed = OpenAIFileEntrypointInputSchema.safeParse(args)
  if (parsed.success) {
    opened = parsed.data.file
    resolveOpened(opened)
  } else if (args?.file === undefined) {
    // Opened without a file (the AI called open_note, or a chat; there is no left rail or More tools entry any more): no file is coming, so do not wait for one.
    opened = null
    resolveOpened(null)
  }
}

function theme(context) {
  if (context?.theme) applyDocumentTheme(context.theme)
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables)
}

// 受け取った tool-input をそのまま覚えておく（仮のパネルに入れ替えるときに渡し直す）。
let toolInputParams = null
app.addEventListener('toolinput', (params) => {
  toolInputParams = params
  receiveFile(params?.arguments)
})
app.addEventListener('hostcontextchanged', theme)
// What this host declared for model context updates (kept here and in the host's log, to check real hosts).
let modelContextDeclaration = null
const connected = app.connect().then(() => {
  theme(app.getHostContext())
  const caps = app.getHostCapabilities()
  modelContextDeclaration = { standard: caps?.updateModelContext ?? null, openai: caps?.experimental?.['openai/modelContext'] ?? null }
  void app.sendLog({ level: 'info', logger: 'NoteDock', data: `model context capability: ${JSON.stringify(modelContextDeclaration)}` }).catch(() => {})
})
// 本体がないのに、前に読んだ本物のパネルが出ている（相手が起動用のプログラム）なら、仮のパネルに入れ替える。
// 判定が済むまで、ノートの場所もサーバーへの依頼も待たせる（読むだけの画面を、判定の前に編集できる扱いにしない）。
// 入れ替えたら ready は解決しない（この画面の続きは動かさない）。判定できないときは、今までどおり続ける。
// 問い合わせと読み直しは、会話へ伝えるのと同じ5秒で打ち切る（答えがなければ今までどおり続ける）。
// 同じタブで何度も入れ替わらないように、入れ替えた回数を window に持たせ、2回で止める（document.write のあとも window は同じ）。
const LAUNCHER_CHECK_MS = 5000
const MAX_SETUP_SWAPS = 2
const ready = connected.then(async () => {
  if ((window.__notedockSetupSwaps ?? 0) >= MAX_SETUP_SWAPS) return
  const html = await setupToShow({
    callStatus: () => tool('note_api', { method: 'GET', url: STATUS_URL, body: {} }, { timeout: LAUNCHER_CHECK_MS }),
    readPanel: async () => (await app.readServerResource({ uri: 'ui://notedock/panel.html' }, { timeout: LAUNCHER_CHECK_MS })).contents?.[0]?.text,
  })
  if (html === null) return
  window.__notedockSetupSwaps = (window.__notedockSetupSwaps ?? 0) + 1
  document.open()
  document.write(setupPage(html, toolInputParams))
  document.close()
  return new Promise(() => {})
})
export function hostModelContextDeclaration() {
  return modelContextDeclaration
}

async function tool(name, args, options) {
  const response = await app.callServerTool({ name, arguments: args }, options)
  if (response.isError || !response.structuredContent) throw new TypeError('panel request failed')
  return response.structuredContent
}

// A note outside the allowed folder is read through the host and can never be written.
async function readOutside(name) {
  await ready
  if (name !== opened?.name) return reply(404, { error: 'not found' })
  if (!extensions.resources) throw new TypeError('host cannot read files')
  const resource = await extensions.resources.read({ uri: opened.resourceUri, representation: 'text' })
  const content = resource.contents?.[0]
  if (content?.uri !== opened.resourceUri || typeof content.text !== 'string') throw new TypeError('unexpected read')
  return reply(200, { path: OUTSIDE_PREFIX + name, text: content.text, hash: '', editable: false, reason: 'outside', sourceOnly: false })
}

const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

async function encodeBody(body) {
  if (!body) return {}
  if (typeof body === 'string') return JSON.parse(body)
  const bytes = new Uint8Array(await body.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return { base64: btoa(binary) }
}

globalThis.fetch = async (url, options = {}) => {
  await ready
  const target = String(url)
  const method = options.method ?? 'GET'
  const asked = new URL(target, 'http://panel.invalid').searchParams.get('path')
  if (asked?.startsWith(OUTSIDE_PREFIX)) {
    if (method === 'GET' && target.startsWith('/api/note?')) return readOutside(asked.slice(OUTSIDE_PREFIX.length))
    if (method === 'GET' && target.startsWith('/api/backups?')) return reply(200, { backups: [] })
    return reply(403, { error: 'not editable' })
  }
  // 書き込みのたびに、受け取った rootId をサーバーへ送る（サーバーはその呼び出しで決めたフォルダーと照合する）。
  const root = options.headers?.['x-note-root']
  const { status, data } = await tool('note_api', { method, url: target, body: await encodeBody(options.body), ...(typeof root === 'string' && root ? { root } : {}) })
  return reply(status, data)
}

globalThis.EventSource = PanelEventSource

// Links open through the host. Images in the folder have no URL here, so they load through the server.
window.open = (url) => {
  if (/^https?:|^mailto:/i.test(String(url))) void app.openLink({ url: String(url) }).catch(() => {})
  return null
}

// The image never gets the /api/file URL as its src: the browser could start loading it before it is
// replaced, the Content-Security-Policy would block that, and the image would show as broken.
// Images outside the folder are not tried at all; they show as "cannot open".
setImageLoader((image, url) => {
  if (!url.startsWith('/api/file?')) {
    queueMicrotask(() => image.dispatchEvent(new Event('error')))
    return
  }
  fetch(url)
    .then((response) => response.json())
    .then(({ base64, mime }) => {
      image.src = `data:${mime};base64,${base64}`
    })
    .catch(() => image.dispatchEvent(new Event('error')))
})

// For Cmd+Click: a separate host tab, after the host's own permission question. False means stay in this panel.
export async function openInHost(path) {
  await ready
  if (!extensions.files) return false
  try {
    const { data } = await tool('note_api', { method: 'GET', url: `/api/absolute?path=${encodeURIComponent(path)}`, body: {} })
    if (!data?.path) return false
    await extensions.files.open(data.path)
    return true
  } catch {
    return false
  }
}

// Hands the open note to the chat (ui/update-model-context). Each call replaces the previous one.
// The OpenAI wrapper is used when the host advertises it: it sends the same request through App.updateModelContext
// and also returns the host's updateId. Otherwise the standard call is used if the host lists the capability.
// The content is cut down to what the host says it accepts (getHostCapabilities().updateModelContext): without
// structuredContent it is dropped, and without text nothing can be sent. A host that offers neither route, accepts no
// text, rejects the update or does not answer within UPDATE_TIMEOUT_MS makes this throw, so the caller can tell the user.
const UPDATE_TIMEOUT_MS = 5000
export async function updateNoteContext(params) {
  await ready
  const modalities = app.getHostCapabilities()?.updateModelContext
  const fitted = fitToHost(params, modalities)
  if (!fitted) throw new Error('host does not accept text in model context')
  // Nothing could have been put in the chat through this host, so there is nothing to clear.
  if (!extensions.modelContext && !modalities && params.content.length === 0) return
  if (extensions.modelContext) {
    await extensions.modelContext.update(fitted, { timeout: UPDATE_TIMEOUT_MS })
    return
  }
  if (modalities) {
    await app.updateModelContext(fitted, { timeout: UPDATE_TIMEOUT_MS })
    return
  }
  throw new Error('host does not accept model context updates')
}

// Whether the host still holds something this panel put in the model context.
export function hostHasContext() {
  const current = extensions.modelContext?.getCurrent()
  return Boolean(current && (current.content?.length || (current.structuredContent && Object.keys(current.structuredContent).length)))
}

// Runs before the host unmounts the panel (closing the tab), so the note can be taken out of the chat first.
let teardownTasks = []
app.onteardown = async () => {
  await Promise.allSettled(teardownTasks.map((task) => task()))
  return {}
}
export function onPanelTeardown(task) {
  teardownTasks.push(task)
}

// Records a refused context update in the host's log (not in the chat). Never throws.
export function logToHost(data) {
  void connected.then(() => app.sendLog({ level: 'warning', logger: 'NoteDock', data })).catch(() => {})
}

// The small panel inside a chat message, as opposed to a tab or the full page from the left rail.
export function panelInline() {
  return app.getHostContext()?.displayMode === 'inline'
}

// Which note this panel opened. Never rejects: a panel that cannot tell shows that in the editor.
export async function panelNote() {
  await ready
  const file = await Promise.race([openedFile, new Promise((resolve) => setTimeout(resolve, NO_FILE_MS))])
  // Opened by something other than the file list, for example a chat tool call.
  if (!file) return { path: null }
  const where = await tool('note_locate', {})
  return where.scope === 'inside' ? { path: where.path, rootId: where.rootId } : { path: OUTSIDE_PREFIX + file.name, outside: true }
}

// 軽い確かめ：このタブのノートが、今の呼び出しで編集できるフォルダーの中にあるか。会話が始まってフォルダーが届くと変わる。
// ファイルから開いたタブでなければ、いつも外。失敗しても投げない。
export async function locateNote() {
  await ready
  if (!opened) return { scope: 'outside' }
  try {
    const where = await tool('note_locate', {})
    return where.scope === 'inside' ? { scope: 'inside', path: where.path, rootId: where.rootId } : { scope: 'outside' }
  } catch {
    return { scope: 'outside' }
  }
}
