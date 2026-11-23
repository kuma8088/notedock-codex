// Codexアプリの代わり（テスト用）。本物のパネル（MCP の資源として返す panel.html）を iframe で開き、
// パネルとは postMessage だけでやりとりする。パネルからの道具の呼び出しは、テスト用のサーバー（host-server.mjs）の /tool へ渡す。
// ?file=<フォルダーの中の場所> を付けると、そのノートを開いたタブ（ファイルから開いたとき）のふりをする。付けなければ、ファイルなしで開いたときのふり。
// ?ctx= で、会話へ伝える内容（ui/update-model-context）の受け方を変える。standard（標準の宣言、文字と structuredContent）、
// textonly（文字だけ）、openai（OpenAI の印だけ）、none（受けない）、refuse（受けると宣言して断る）、refuseclear（空の上書きだけ断る）。
// 受けた内容は window.__ctx に、ログは window.__logs に残す。window.__teardown() でタブを閉じる前の知らせを送る。
// ?launcher= で、本体を取ってくる前の起動用のプログラム（準備中の係）のまねをする（test/browser/launcher-swap-check.py）。
// stale：本体がないのに前に読んだ本物のパネルが出た場面。status に state を返し、パネルの読み直しには仮のパネルの見本（印つき）を返す。
// hang：status に答えない（パネルは時間切れのあと、今までどおり続ける）。どちらも tool-input は Codex と同じく最初の initialized のときだけ送る。
// 道具の呼び出しと読み直しは window.__calls に、initialized の回数は window.__inits に残す。
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge'

const params = new URLSearchParams(location.search)
const file = params.get('file')
const ctxMode = params.get('ctx') ?? 'none'
const launcherMode = params.get('launcher')
window.__calls = []
window.__inits = 0
// 仮のパネルの見本。ui/initialize を済ませ、受け取った tool-input のファイル名を data-file に残す。
const SETUP_FIXTURE = '<!doctype html><html><head><meta charset="utf-8"><meta name="notedock-setup" content="1"><title>setup</title></head>'
  + '<body><main id="setup">setup fixture</main><script>(function(){var p=window.parent;var el=document.getElementById("setup");'
  + 'window.addEventListener("message",function(e){var m=e.data;if(e.source!==p||!m||m.jsonrpc!=="2.0")return;'
  + 'if(m.method==="ui/notifications/tool-input"){var f=m.params&&m.params.arguments&&m.params.arguments.file;el.dataset.file=f?f.name:"";el.dataset.inputs=String(Number(el.dataset.inputs||0)+1)}'
  + 'if(m.id==="fx-1"&&m.result){el.dataset.answers=String(Number(el.dataset.answers||0)+1);if(el.dataset.init)return;el.dataset.init="1";p.postMessage({jsonrpc:"2.0",method:"ui/notifications/initialized",params:{}},"*")}});'
  + 'p.postMessage({jsonrpc:"2.0",id:"fx-1",method:"ui/initialize",params:{appInfo:{name:"fixture",version:"0"},appCapabilities:{},protocolVersion:"2026-01-26"}},"*")})()</' + 'script></body></html>'
window.__links = []
window.__ctx = []
window.__logs = []
window.__ready = false

const frame = document.createElement('iframe')
frame.id = 'panel'
frame.src = '/panel.html'
frame.style.cssText = 'border:0;width:100%;height:100%'
// パネルが申し出ているクリップボードへの書き込み（server/mcp.mjs の permissions）を許す。Codexアプリが同じ形で許すかは確かめていない。
// このページではパネルが同じ origin から読まれるので、付けなくてもテストの結果は変わらない。
frame.allow = 'clipboard-write'
document.body.append(frame)

frame.addEventListener('load', async () => {
  const contextCaps = {
    standard: { updateModelContext: { text: {}, structuredContent: {} } },
    refuse: { updateModelContext: { text: {}, structuredContent: {} } },
    refuseclear: { updateModelContext: { text: {}, structuredContent: {} } },
    textonly: { updateModelContext: { text: {} } },
    openai: { experimental: { 'openai/modelContext': {} } },
    none: {},
  }[ctxMode]
  // 開いたファイルを、Codexアプリと同じく openai/resource の読み方でパネルに読ませる（編集できるフォルダーの外のノートは、こちらで読む）。
  const caps = { openLinks: {}, serverTools: {}, serverResources: {}, logging: {}, ...contextCaps }
  caps.experimental = { ...(contextCaps.experimental ?? {}), 'openai/resource': {} }
  const bridge = new AppBridge(null, { name: 'test-host', version: '1' }, caps, {
    hostContext: { theme: 'light', displayMode: 'fullscreen' },
  })
  bridge.onupdatemodelcontext = async (update) => {
    window.__ctx.push(update)
    const clear = !update.content?.length
    if (ctxMode === 'refuse' || (ctxMode === 'refuseclear' && clear)) throw new Error('no composer here')
    return {}
  }
  bridge.onloggingmessage = (message) => {
    window.__logs.push(message)
  }
  window.__teardown = () => bridge.teardownResource({})
  bridge.oncalltool = async ({ name, arguments: args }) => {
    window.__calls.push({ name, method: args?.method ?? null, url: args?.url ?? null })
    if (launcherMode === 'hang' && name === 'note_api' && args?.url === '/api/launcher/status') return new Promise(() => {})
    if (launcherMode === 'stale') {
      const answer = (structuredContent) => ({ content: [], structuredContent })
      if (name === 'note_api' && args?.url === '/api/launcher/status') return answer({ status: 200, data: { state: 'idle', bytes: 0, total: 88012226, version: '0.1.0', mine: false } })
      if (name === 'note_locate') return answer({ scope: 'outside' })
      if (name === 'note_api') return answer({ status: 503, data: { error: 'not yet' } })
    }
    // テストから保存をわざと失敗させる（下書きを確かめるため）。
    if (window.__failWrites && name === 'note_api' && args?.method === 'PUT' && String(args.url).startsWith('/api/note?')) {
      return { content: [], structuredContent: { status: 500, data: { error: 'down' } } }
    }
    const response = await fetch('/tool', { method: 'POST', body: JSON.stringify({ name, arguments: args, file }) })
    return response.json()
  }
  bridge.onreadresource = async ({ uri }) => {
    if (launcherMode) window.__calls.push({ read: uri })
    if (launcherMode === 'stale' && uri === 'ui://notedock/panel.html') return { contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: SETUP_FIXTURE }] }
    if (!file || uri !== `test-resource:${file}`) throw new Error('unknown resource')
    const response = await fetch(`/resource?file=${encodeURIComponent(file)}`)
    return { contents: [{ uri, mimeType: 'text/markdown', text: await response.text() }] }
  }
  bridge.onopenlink = async ({ url }) => {
    window.__links.push(url)
    return {}
  }
  bridge.oninitialized = () => {
    window.__inits++
    if (launcherMode && window.__inits > 1) return
    window.__toolInputs = (window.__toolInputs ?? 0) + 1
    const args = file ? { file: { name: file.split('/').pop(), resourceUri: `test-resource:${file}` } } : {}
    bridge.sendToolInput({ arguments: args })
    window.__ready = true
  }
  await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow))
})
