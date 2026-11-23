// 開いているノートを、Codexの会話へ伝える（MCP Apps の ui/update-model-context）。
// 伝えるのは、ノートの場所（Vaultの中の場所と、Vaultのフォルダーの絶対パス）と、選んでいる行の番号だけ。本文は送らない。
// 「開いているノートをAIに伝える」がオンのときだけ送る。呼ぶたびに前の内容を置き換える（ホストが最後の1回だけを使う）。
// オフのときは、空の内容で上書きして消す。ホストが断ったら、記録して、画面に小さく知らせる。
//
// 送る順番と内容: 送っている途中の1件と、次に送りたい最新の1件だけを持つ。送り終えたとき、最新が
// 受け取られた内容と違えば続けて送る（古い希望は捨てる）。こうすると、A→B→A と速く替えても最後は A になり、
// 送れない状態が続いても、オフにしたときの空の上書きが古い送信の後ろで待たされない。

// 選ぶ範囲を動かしている間は送らず、止まってからこの時間がたったら送る。
export const SELECTION_DELAY_MS = 500
const OUTSIDE_PREFIX = '__outside__/'
const KEEP_REFUSALS = 20
export const CLEAR = Object.freeze({ content: [] })

// エディターの選んでいる範囲を、行の番号（「12」か「12-18」）にする。何も選んでいなければ空。
// 範囲の終わりが次の行の先頭（行を丸ごと選んだとき）なら、その行は入れない。
// 本文は渡さない。AIは必要なときに、場所と行の番号からファイルを読む（保存は自動なので、ファイルと画面はほぼ同じ）。
// 行番号の計算は、ここ（selectionOf）の1か所だけでする。
export function selectionOf(state) {
  const { from, to } = state.selection.main
  if (from === to) return ''
  const first = state.doc.lineAt(from)
  let last = state.doc.lineAt(to)
  if (to === last.from && last.number > first.number) last = state.doc.line(last.number - 1)
  return first.number === last.number ? String(first.number) : `${first.number}-${last.number}`
}

// ホストへ渡す内容。ノートがないときは空（前の内容を消す）。
// 渡すのはノートの場所と、Vaultのフォルダーの絶対パス（AIがファイルを確実に読めるように）と、選んでいる行の番号だけ。
// Vaultの絶対パスが分からないときは、場所だけ。フォルダーの外のノートは、ファイル名だけ（絶対パスも行の番号も渡さない）。
export function contextFor(path, lines, vaultRoot = '') {
  if (!path) return CLEAR
  const outside = path.startsWith(OUTSIDE_PREFIX)
  const notePath = outside ? path.slice(OUTSIDE_PREFIX.length) : path
  const range = outside ? '' : String(lines ?? '')
  const root = outside ? '' : String(vaultRoot ?? '')
  const rootText = root ? `（Vault のフォルダー：「${root}」）` : ''
  const text = outside
    ? `NoteDock で開いているノート（編集できるフォルダーの外。ファイル名だけ）：「${notePath}」`
    : range
      ? `NoteDock で開いているノート：「${notePath}」${rootText}の ${range.replace('-', '〜')}行目を選んでいる。中身が要るときは、このファイルのその行を読む。`
      : `NoteDock で開いているノート：「${notePath}」${rootText}`
  const structuredContent = { notePath, outside }
  if (root) structuredContent.vaultRoot = root
  if (range) {
    const [fromLine, toLine = fromLine] = range.split('-').map(Number)
    Object.assign(structuredContent, { fromLine, toLine })
  }
  return { content: [{ type: 'text', text }], structuredContent }
}

// ホストが受け取れる種類（getHostCapabilities().updateModelContext）に合わせて内容を減らす。
// modalities が分からない（undefined）ときは、そのまま送る。文字を受け取れないホストには送れない（null）。
// 空の宣言（{}）は、種類を書いていないだけと見て、文字だけ送る。
export function fitToHost(params, modalities) {
  if (!modalities || params.content.length === 0) return params
  if (Object.keys(modalities).length === 0) modalities = { text: {} }
  if (!modalities.text) return null
  if (modalities.structuredContent || !params.structuredContent) return params
  const { structuredContent: _dropped, ...rest } = params
  return rest
}

const isClear = (params) => params.content.length === 0
const CLEAR_KEY = JSON.stringify(CLEAR)

// send(params) はホストへ送って、断られたら投げる（Promise を返す）。
// confirmShare() は、共有の設定がオンかを確かめて true／false を返す（ノートの内容を送る直前に呼ぶ）。
// onShareOff() は、確かめた結果オフだったとき。onRefused(reason, { cleared, mayRemain }) は断られたとき
// （mayRemain は、会話に内容が残っているかもしれないか）、onAccepted() は受け取られたとき。
// hostHasContext() は、ホストに前の内容が残っていそうか（残っていれば、同じ空の上書きでも送り直す）。
export function createAiContext({
  send,
  confirmShare = async () => true,
  onShareOff = () => {},
  onRefused = () => {},
  onAccepted = () => {},
  hostHasContext = () => false,
  vaultRoot = () => '',
  delay = SELECTION_DELAY_MS,
  timers = globalThis,
} = {}) {
  let enabled = false
  let path = null
  let selection = ''
  let timer = null
  let accepted = null // ホストに受け取られた最後の内容（JSON）
  let desired = null // 次に送りたい最新の内容
  let running = null // 送っている途中の処理
  let failedKey = null // 断られた内容。同じ内容は、次のきっかけ（retry）まで送り直さない
  let pumping = false
  let closed = false // タブを閉じる前の知らせのあと。空の上書きのほかは送らない
  let contentAccepted = false // ノートの内容が受け取られて、まだ空の上書きで消せていない
  const refusals = []

  const cancel = () => {
    if (timer !== null) timers.clearTimeout(timer)
    timer = null
  }

  // desired が空になったら、同じ流れの中で（あいだに別の処理を挟まずに）終わりの印を付ける。
  // こうすると、終わる直前に want() で入った最新の内容を取りこぼさない。
  async function pump() {
    pumping = true
    while (true) {
      if (!desired) {
        pumping = false
        running = null
        return
      }
      const params = desired
      if (closed && !isClear(params)) {
        desired = CLEAR
        continue
      }
      const key = JSON.stringify(params)
      if (key === accepted || key === failedKey) {
        if (desired === params) desired = null
        continue
      }
      // ノートの内容は、送る直前に共有の設定を確かめる（ほかのタブでオフにされていたら送らない）。
      if (!isClear(params)) {
        let on
        try {
          on = await confirmShare()
        } catch {
          on = null
        }
        if (on === false) {
          enabled = false
          onShareOff()
          desired = CLEAR
          continue
        }
        // 確かめられないときは送らない。次のきっかけでもう一度。
        if (on !== true) {
          if (desired === params) desired = null
          continue
        }
      }
      if (desired !== params) continue
      try {
        await send(params)
        accepted = key
        failedKey = null
        contentAccepted = !isClear(params)
        onAccepted()
      } catch (error) {
        accepted = null
        failedKey = key
        const reason = String(error?.message ?? error ?? 'refused')
        const cleared = isClear(params)
        // 会話に内容が残っているかもしれないのは、この画面で前に内容が受け取られた（まだ消せていない）か、
        // ホストに内容が残っているときだけ。何も伝えていない画面で空の上書きを断られても、残っているものはない。
        let hostHas = false
        try {
          hostHas = Boolean(hostHasContext())
        } catch {}
        const mayRemain = contentAccepted || hostHas
        refusals.push({ at: new Date().toISOString(), reason, cleared, mayRemain })
        if (refusals.length > KEEP_REFUSALS) refusals.shift()
        onRefused(reason, { cleared, mayRemain })
      }
      if (desired === params) desired = null
    }
  }

  function want(params) {
    desired = params
    if (!pumping) {
      const started = pump()
      // すぐに終わった（送るものがなかった）ときは、running を残さない。
      running = pumping ? started : null
    }
    return running ?? Promise.resolve()
  }

  // 空の上書きが断られたままなら、次の空の上書きでは送り直す（パネルにいるあいだも消すのをあきらめない）。
  const forgetFailedClear = () => {
    if (failedKey === CLEAR_KEY) failedKey = null
  }

  const current = () => (enabled && !closed ? contextFor(path, selection, vaultRoot()) : CLEAR)
  const idle = async () => {
    while (running) await running
  }

  return {
    // スイッチ。オンにしたら今の内容をすぐ送る。オフと分かったら、前の状態に関係なく空の内容で上書きする
    // （起動したときにオフでも、ホストに前の内容が残っていれば消す）。
    setEnabled(on) {
      enabled = on
      cancel()
      forgetFailedClear()
      if (!on && hostHasContext()) accepted = null
      return want(current())
    },
    // ノートを開いたとき・ほかのノートに替わったとき・閉じたとき（path は null）。すぐ送る。
    noteChanged(nextPath, nextSelection = '') {
      path = nextPath
      selection = nextSelection
      cancel()
      forgetFailedClear()
      return want(current())
    },
    // 選んでいる行が変わったとき。止まってから delay ミリ秒後に送る。
    selectionChanged(nextSelection) {
      if (nextSelection === selection) return
      selection = nextSelection
      if (!enabled) return
      cancel()
      timer = timers.setTimeout(() => {
        timer = null
        want(current())
      }, delay)
    },
    // 断られた内容を、次のきっかけ（フォーカス・操作）で送り直す。
    retry() {
      failedKey = null
      return want(current())
    },
    // タブを閉じる前の知らせ。空の内容で上書きし、それ以後は（遅れて届いた読み直しなどがあっても）空の上書きのほかは送らない。
    close() {
      closed = true
      cancel()
      forgetFailedClear()
      if (hostHasContext()) accepted = null
      return want(CLEAR)
    },
    get closed() {
      return closed
    },
    get enabled() {
      return enabled
    },
    refusals,
    idle,
  }
}
