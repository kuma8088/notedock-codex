// 本体（サーバー）を取ってくる前は、Codex アプリが前に読んだ本物のパネルを出したまま、起動用のプログラム（準備中の係）と話すことがある。
// そのままだと note_locate が外（outside）を返して読むだけの画面になり、取ってくるボタンも出ない。
// 起動用のプログラムだと分かったら、同じパネルの URI を読み直し、仮のパネル（取ってくるボタンのある画面）なら自分の画面と入れ替える。
// 起動用のプログラムの仮のパネルが本物に替わるやり方（launcher/setup.html の swap）の裏返し。

export const STATUS_URL = '/api/launcher/status'
// 仮のパネルの印（meta の name が notedock-setup）。setup.html は、読み直した本物のパネルにこの印の文字がないことで本物と見分ける。
// そのため、ここ（本物のパネルに入る）には印そのままの文字を書かない（正規表現で、引用符をはさんだ形にする）。
export const SETUP_MARK = /<meta\s+name=["']?notedock-setup["'\s>]/i

// note_api GET /api/launcher/status の答え（structuredContent）が、起動用のプログラムの答えか。本体は 404 を返し、state を持たない。
export function launcherState(result) {
  const state = result?.data?.state
  return typeof state === 'string' ? state : null
}

// 起動用のプログラムが ready と答えたときは、次の依頼から本体に入れ替わるので、そのまま続ける。
export function wantsSetup(state) {
  return state !== null && state !== 'ready'
}

export function isSetupPage(html) {
  return typeof html === 'string' && SETUP_MARK.test(html)
}

// 受け取っていた tool-input（ui/notifications/tool-input の params）を、入れ替えた画面に渡し直す小さなスクリプト。
// Codex は tool-input を最初の initialized のときに1回だけ送り、2回目では送り直さない。
// 仮のパネルの ui/initialize が済んだあとに、間をあけて3回渡す（仮のパネルは最後に受けたものを覚えるだけ）。
export function replayScript(input) {
  if (!input) return ''
  const body = `(function(input){var done=false;window.addEventListener('message',function(e){var m=e.data;if(done||e.source!==window.parent||!m||m.jsonrpc!=='2.0'||!m.result||!m.result.protocolVersion||!m.result.hostCapabilities)return;done=true;[50,500,2000].forEach(function(ms){setTimeout(function(){window.dispatchEvent(new MessageEvent('message',{data:{jsonrpc:'2.0',method:'ui/notifications/tool-input',params:input},source:window.parent}))},ms)})})})(${JSON.stringify(input).replace(/</g, '\\x3c')})`
  return '<script>' + body + '</script>'
}

export function setupPage(html, input) {
  const inject = replayScript(input)
  const head = /<head[^>]*>/i
  return head.test(html) ? html.replace(head, (m) => m + inject) : inject + html
}

// 判定。callStatus は note_api の structuredContent を返す（失敗は投げる）。readPanel はパネルの HTML を返す。
// 起動用のプログラムでない、判定できない、読み直しても仮のパネルでない、のときは null（今の扱いのまま続ける）。
export async function setupToShow({ callStatus, readPanel }) {
  let state
  try {
    state = launcherState(await callStatus())
  } catch {
    return null
  }
  if (!wantsSetup(state)) return null
  let html
  try {
    html = await readPanel()
  } catch {
    return null
  }
  return isSetupPage(html) ? html : null
}
