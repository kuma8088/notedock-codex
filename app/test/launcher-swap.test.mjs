import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { isSetupPage, launcherState, replayScript, setupPage, setupToShow, wantsSetup } from '../src/launcher-swap.mjs'

const SETUP = '<!doctype html><html><head><meta charset="utf-8"><meta name="notedock-setup" content="1"><title>NoteDock の準備</title></head><body><button id="go"></button></body></html>'
const REAL = '<!doctype html><html><head><meta charset="utf-8"></head><body>NoteDock</body></html>'
const INPUT = { arguments: { file: { name: 'a</script>.md', resourceUri: 'file:///v/a.md' } } }

test('only an answer with a state comes from the launcher; the server answers 404 without one', () => {
  assert.equal(launcherState({ status: 200, data: { state: 'idle', bytes: 0 } }), 'idle')
  assert.equal(launcherState({ status: 404, data: { error: 'not found' } }), null)
  assert.equal(launcherState({ status: 403, data: { error: 'panel only' } }), null)
  assert.equal(launcherState(undefined), null)
  assert.equal(launcherState({ status: 200, data: { state: 3 } }), null)
  for (const state of ['idle', 'downloading', 'failed', 'unsupported']) assert.equal(wantsSetup(state), true)
  assert.equal(wantsSetup('ready'), false)
  assert.equal(wantsSetup(null), false)
})

test('the setup page is recognised by its mark only', () => {
  // setup.html は、本物のパネルに印の文字（name="notedock-setup"）がないことで本物と見分ける。本物のパネルに入るこのファイルにも書かない。
  const source = readFileSync(new URL('../src/launcher-swap.mjs', import.meta.url), 'utf8')
  assert.equal(source.includes('name="notedock-' + 'setup"'), false)
  assert.equal(isSetupPage(source), false)
  assert.equal(isSetupPage(SETUP), true)
  assert.equal(isSetupPage(REAL), false)
  assert.equal(isSetupPage(undefined), false)
})

test('the panel swaps only when the launcher answers and the re-read is the setup page', async () => {
  const calls = []
  const run = (status, panel) => setupToShow({
    callStatus: async () => { calls.push('status'); if (status instanceof Error) throw status; return status },
    readPanel: async () => { calls.push('read'); if (panel instanceof Error) throw panel; return panel },
  })
  assert.equal(await run({ status: 200, data: { state: 'idle' } }, SETUP), SETUP)
  assert.equal(await run({ status: 200, data: { state: 'failed', kind: 'interrupted' } }, SETUP), SETUP)
  calls.length = 0
  // 本体：読み直さない
  assert.equal(await run({ status: 404, data: { error: 'not found' } }, SETUP), null)
  assert.deepEqual(calls, ['status'])
  // 起動用のプログラムが ready（次の依頼で本体に入れ替わる）：読み直さない
  calls.length = 0
  assert.equal(await run({ status: 200, data: { state: 'ready' } }, SETUP), null)
  assert.deepEqual(calls, ['status'])
  // 判定できない・読み直しても仮のパネルでない：今の扱いのまま
  assert.equal(await run(new TypeError('panel request failed'), SETUP), null)
  assert.equal(await run({ status: 200, data: { state: 'idle' } }, REAL), null)
  assert.equal(await run({ status: 200, data: { state: 'idle' } }, new Error('read failed')), null)
})

test('the setup page gets the replay script at the top of its head, and nothing without a tool-input', () => {
  const page = setupPage(SETUP, INPUT)
  assert.ok(page.startsWith('<!doctype html><html><head><script>'))
  assert.ok(page.includes('<meta name="notedock-setup" content="1">'))
  assert.equal(page.match(/<\/script/gi).length, 1, 'the file name cannot close the script early')
  assert.equal(setupPage(SETUP, null), SETUP)
})

// 入れ替えた画面の中で、仮のパネルの ui/initialize に答えが来たあと、受け取っていた tool-input を渡し直す。
test('the replay script hands the tool-input back after the setup page is initialized', async () => {
  const parent = {}
  class FakeMessageEvent extends Event {
    constructor(type, init) { super(type); this.data = init.data; this.source = init.source }
  }
  const win = new EventTarget()
  win.parent = parent
  const got = []
  win.addEventListener('message', (e) => { if (e.data?.method === 'ui/notifications/tool-input') got.push(e) })
  const context = vm.createContext({ window: win, MessageEvent: FakeMessageEvent, setTimeout })
  const script = replayScript(INPUT).replace(/^<script>|<\/script>$/g, '')
  vm.runInContext(script, context)
  // 関係のない答え・ほかの窓からの知らせでは渡さない
  win.dispatchEvent(new FakeMessageEvent('message', { data: { jsonrpc: '2.0', id: 'setup-9', result: {} }, source: parent }))
  win.dispatchEvent(new FakeMessageEvent('message', { data: { jsonrpc: '2.0', id: 'x', result: { protocolVersion: '2026-01-26', hostCapabilities: {} } }, source: {} }))
  await new Promise((ok) => setTimeout(ok, 100))
  assert.equal(got.length, 0)
  win.dispatchEvent(new FakeMessageEvent('message', { data: { jsonrpc: '2.0', id: 'setup-1', result: { protocolVersion: '2026-01-26', hostCapabilities: {} } }, source: parent }))
  await new Promise((ok) => setTimeout(ok, 600))
  assert.equal(got.length, 2)
  assert.equal(JSON.stringify(got[0].data.params), JSON.stringify(INPUT))
  assert.equal(got[0].source, parent)
  assert.equal(replayScript(null), '')
})
