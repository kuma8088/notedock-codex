import { hostHasContext, locateNote, logToHost, onPanelTeardown, openInHost, panelInline, panelNote, updateNoteContext } from './panel.mjs'
import { createAiContext, selectionOf } from './ai-context.mjs'
import { createShareSwitch } from './share-switch.mjs'
import { firstNote } from './start.mjs'
import { draftKeyChanges, draftQuestion, expiredDraftKeys, newerDraft, settleLateDraft, trashedDraftKeys } from './drafts.mjs'
import { createDraftSync } from './draft-sync.mjs'
import { autocompletion, closeBrackets, closeBracketsKeymap, startCompletion } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab, insertNewline, isolateHistory } from '@codemirror/commands'
import { deleteMarkupBackward, insertNewlineContinueMarkup } from '@codemirror/lang-markdown'
import {
  HighlightStyle,
  foldAll,
  foldEffect,
  foldGutter,
  foldKeymap,
  foldable,
  foldedRanges,
  indentUnit,
  syntaxHighlighting,
  syntaxTree,
  unfoldAll,
  ensureSyntaxTree,
} from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { openSearchPanel, search, searchKeymap } from '@codemirror/search'
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state'
import { EditorView, placeholder, crosshairCursor, drawSelection, dropCursor, hoverTooltip, keymap, rectangularSelection } from '@codemirror/view'
import { tags } from '@lezer/highlight'

import { findHeading, headingsOf, linkCompletion, wikiLinkCompletion } from './complete.mjs'
import { copyText } from './copy.mjs'
import { askChoice, askConfirm, askDraft, askNewNote, askPlace, askSettings, askText, showCopyable, showMessage } from './dialogs.mjs'
import { isExternal, normalizeKey, relativeHref, resolveHref, wikiLinkOf } from './links.mjs'
import { absolutePath, addRecentDir, ancestorsOf, breadcrumbParts, buildTree, checkNewNote, defaultNoteDir, linkTargetFromPaste, newNotePath, noteFolders, resolvePasted, holdsPath, linkedNoteLines, touchesStoppedNote } from './files.mjs'
import { noteMarkdown } from './markdown-ext.mjs'
import { minimalChange } from './merge.mjs'
import { noteContext, previewField, setComposing, setMode, togglePropsPanel } from './preview.mjs'
import { listHangingIndent } from './list-indent.mjs'
import { completionKeys } from './ime-keys.mjs'
import { createSaver } from './save.mjs'
import { calloutSpec, codeBlockSpec, currentFormat, headingSpec, horizontalRuleSpec, inlineSpec, lineKindSpec, linkSpec, tableSpec } from './toolbar.mjs'
import { beginTableCell, showMenu } from './widgets.mjs'
import { calendarModel, shiftMonth } from './calendar.mjs'
import { buildCalendar } from './calendar-view.mjs'
import { periodInfo } from './periodic.mjs'
import { periodicStep } from './periodic-open.mjs'
import { setProperty } from './yaml-lite.mjs'

const $ = (id) => document.getElementById(id)
const external = Annotation.define()
const contextSlot = new Compartment()
const editableSlot = new Compartment()

const REASONS = {
  'mixed-eol': '改行のしかたが2種類混ざっているので、編集できない状態で開いています。',
  crlf: '改行がCRLFのファイルなので、編集できない状態で開いています。',
  bom: 'BOM付きのファイルなので、編集できない状態で開いています。',
  'not-utf8': 'UTF-8ではないファイルなので、編集できない状態で開いています。',
  outside: '編集できるフォルダーの外にあるノートなので、読むだけで開いています。普段の表示に戻すときは、上の「…」から「Open」の▾を開いて「Built-in」を選びます。',
  excalidraw: 'Excalidrawのノートなので、データを壊さないよう編集できない状態で開いています。',
  'too-large': '20MBより大きいノートなので、編集できない状態で開いています。',
}
const STATUS_TEXT = {
  saved: '保存済み',
  updated: '保存済み（ほかからの変更を反映）',
  dirty: '未保存',
  saving: '保存中…',
  offline: 'サーバーにつながりません。入力は続けられます',
  toolarge: '大きすぎて保存できません',
  failed: '保存できません',
  conflict: '保存を止めています',
  removed: 'ファイルが見つかりません',
  blocked: '編集できません',
  elsewhere: '保存を止めています',
  readonly: '編集できません',
  // 編集できるフォルダーの外で開いたノート。説明の文は出さず、この小さな印だけにする（会話が始まれば黙って切り替わる）。
  viewonly: '読むだけ',
}

const storage = {
  get(key, fallback = null) {
    try {
      const value = localStorage.getItem(key)
      return value === null ? fallback : JSON.parse(value)
    } catch {
      return fallback
    }
  },
  // 書けたかを返す。保存領域が使えなくても（入りきらなくても）編集は続ける。
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
      return true
    } catch {
      return false
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key)
    } catch {
      // 同上
    }
  },
}

// タブを閉じる途中の送信は、keepaliveを付けないと捨てられる。付けられるのは64KBまで。
const KEEPALIVE_LIMIT = 60_000
let unloading = false
let rootId = ''

function otherVault() {
  if (saver) saver.elsewhere()
  else if ($('status').dataset.state !== 'elsewhere') setStatus('elsewhere')
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    keepalive: unloading && (options.body?.length ?? 0) * 3 < KEEPALIVE_LIMIT,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      'x-note-editor': '1',
      ...(rootId ? { 'x-note-root': rootId } : {}),
      ...options.headers,
    },
  })
  if (response.status === 412) otherVault()
  const data = response.headers.get('content-type')?.includes('json') ? await response.json() : null
  // 書き込みが、その呼び出しで決めた編集できるフォルダーと違う rootId だった。中身は保存の仕組みが覚えたまま、受け取り直す。
  if (response.status === 423 && data?.error === 'other-root') void recheckFolder()
  return { status: response.status, ok: response.ok, data }
}

const noteUrl = (path) => `/api/note?path=${encodeURIComponent(path)}`
// 下書きの API には、どの Vault の下書きかを確かめるため root も付ける。
const draftUrl = (path, tail = '') => `/api/draft${tail}?path=${encodeURIComponent(path)}&root=${encodeURIComponent(rootId)}`
// サーバーと同じ上限。超えた本文は送らずに断る（送っても断られるうえ、大きな通信になるため）。
const MAX_NOTE_BYTES = 20 * 1024 * 1024
const overLimit = (text) => text.length > MAX_NOTE_BYTES / 3 && new TextEncoder().encode(text).length > MAX_NOTE_BYTES
const api = {
  async read(path) {
    const result = await request(noteUrl(path))
    if (!result.ok) throw Object.assign(new Error(result.data?.error ?? 'read failed'), { status: result.status })
    return result.data
  },
  async write(path, text, baseHash, typedAt) {
    if (overLimit(text)) throw Object.assign(new Error('too large'), { status: 413 })
    // 最後に打った時刻を付けると、サーバーはそれより前に打った下書きを消す。
    const withTyped = typeof typedAt === 'number'
    const result = await request(noteUrl(path), { method: 'PUT', body: JSON.stringify(withTyped ? { text, baseHash, typedAt } : { text, baseHash }) })
    // 衝突の知らせだけを衝突として返す。ほかの 409 を「保存できた」と取り違えない。
    if (result.status === 409 && result.data?.conflict === true) return result.data
    if (!result.ok) throw Object.assign(new Error(result.data?.error ?? 'save failed'), { status: result.status, code: result.data?.code })
    // サーバーが下書きを消したかもしれないので、最後に送った中身の覚えを捨てる（次の同じ中身も送る）。
    if (withTyped) draftSync.forget(path)
    // 保存できたので、開いたときに失敗した下書きの問い合わせを聞き直す。
    if (draftRetry?.path === path) {
      const { run } = draftRetry
      draftRetry = null
      run()
    }
    return result.data
  },
  async backup(path, text) {
    if (overLimit(text)) return
    await request(`/api/backup?path=${encodeURIComponent(path)}`, { method: 'POST', body: JSON.stringify({ text }) })
  },
  // 履歴に残せたかを返す。大きすぎるときや、つながらないときは false。
  async backupChecked(path, text) {
    if (overLimit(text)) return false
    try {
      const result = await request(`/api/backup?path=${encodeURIComponent(path)}`, { method: 'POST', body: JSON.stringify({ text }) })
      return result.ok
    } catch {
      return false
    }
  },
  // サーバーの下書きを問い合わせる。答えが届いたかを ok で返す（下書きがないのと、読めなかったのを分けるため）。
  // ブラウザーの控え（キャッシュ）は使わない。
  async queryDraft(path) {
    try {
      const result = await request(draftUrl(path), { cache: 'no-store' })
      return result.ok ? { ok: true, draft: result.data?.draft ?? null } : { ok: false, draft: null }
    } catch {
      return { ok: false, draft: null }
    }
  },
  // 下書きを書く・消す。サーバーが受け付けたかを返す。
  async sendDraft(op) {
    try {
      const result = op.kind === 'put'
        ? await request(draftUrl(op.path), { method: 'PUT', body: JSON.stringify({ draft: op.draft }) })
        : await request(draftUrl(op.path, '/clear'), { method: 'POST' })
      // サーバーが別の Vault のものに変わっていたら、打つたびに全文を送り続けないよう、このノートは保留にする。
      // 次にこのノートを開いたときの問い合わせで、決め直す。
      if (result.data?.reason === 'other-root') draftSync.hold(op.path)
      return result.data?.ok === true
    } catch {
      return false
    }
  },
}

// 下書きをサーバーへ送るキュー。ノートごとに順番を守り、間を空けて送る。
const draftSync = createDraftSync({ send: (op) => api.sendDraft(op) })

// テスト用のコピーと実際のVaultで同じパスの下書きが混ざらないよう、Vaultごとの印で分ける。
let vaultName = ''
const draftPrefix = () => `draft:${vaultName}:`
const drafts = {
  // localStorage に書けたかを返す。サーバーへは、上限を超えない本文だけ送る。
  set(path, draft) {
    const kept = storage.set(`${draftPrefix()}${path}`, draft)
    if (typeof draft?.text === 'string' && !overLimit(draft.text)) draftSync.put(path, draft)
    return kept
  },
  remove(path) {
    storage.remove(`${draftPrefix()}${path}`)
    draftSync.clear(path)
  },
  get: (path) => storage.get(`${draftPrefix()}${path}`),
}

// localStorage のキーの一覧。使えなければ空。
function storageKeys() {
  try {
    const keys = []
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i))
    return keys.filter((key) => key !== null)
  } catch {
    return []
  }
}

// ノートやフォルダーを動かしたあと、下書きのキーも新しいパスへ移す。移動先にあった古い下書きは消す。
// 先に全部読んでから消し、最後に書く（移す先と元が重なっても、書いた値を消さないため）。
function moveDraftKeys(from, to) {
  if (from === to) return
  const { move, remove } = draftKeyChanges(storageKeys(), draftPrefix(), from, to)
  const values = move.map(([oldKey, newKey]) => {
    try {
      return [newKey, localStorage.getItem(oldKey)]
    } catch {
      return [newKey, null]
    }
  })
  for (const [oldKey] of move) storage.remove(oldKey)
  for (const key of remove) storage.remove(key)
  for (const [newKey, value] of values) {
    if (value === null) continue
    try {
      localStorage.setItem(newKey, value)
    } catch {
      // 入りきらなければ、あきらめる（サーバーの下書きは一緒に移っている）。
    }
  }
}

const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.processingInstruction, color: 'var(--muted)' },
  { tag: tags.contentSeparator, color: 'var(--muted)' },
  { tag: tags.monospace, fontFamily: 'var(--mono)' },
  { tag: tags.keyword, color: 'var(--code-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--code-string)' },
  { tag: tags.comment, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--code-number)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--code-function)' },
  { tag: [tags.typeName, tags.className], color: 'var(--code-type)' },
])

let view = null
let saver = null
let events = null
let notes = []
// このタブをCodexが開いたノート。Codexはこの場所を覚えているので、動かすとこのタブで保存できなくなる。
let tabNote = null
// ファイル欄に出すフォルダー。ノートがないフォルダーも含む。
let folders = []
let known = null
let canCreate = false
let currentPath = null
// ノートはまず閲覧で開き、「編集」か Cmd+E で編集に切り替える。
let mode = 'reading'
let rootPaths = []
let vaultLabel = ''
let allNotes = []
let sourceOnly = false
let editable = true
let hoverWithMeta = false
let reloadConfirmed = false

// サーバーで保存に失敗した理由（ファイルの操作のエラーの種類）ごとの説明。
const SAVE_FAILURES = {
  EACCES: 'ファイルに書き込めません（書き込みの権限がないか、ほかのアプリが使っています）。',
  EPERM: 'ファイルに書き込めません（書き込みの権限がないか、ほかのアプリが使っています）。',
  EBUSY: 'ほかのアプリがファイルを使っているので、書き込めません。',
  ENOSPC: 'ディスクの空きが足りないので、保存できません。',
  EROFS: '書き込めない場所にあるので、保存できません。',
}

// 下書きに残せたかで、帯の文を変える。残せないときに「残しています」と言わないため。
const draftNote = (detail, kept = '画面の内容は下書きに残しています。') => detail.draftKept === false
  ? '画面の内容は、下書きにも残せていません（ブラウザーの保存場所に入りきらない、など）。このタブを閉じたり別のノートを開いたりすると消えるので、残したい内容はコピーしてほかのノートに貼ってください。'
  : kept

// 状態の欄（#status）は、「AI」のボタン、先頭の知らせ（#status-alert）、保存の状態（#status-text）を並べ、読み上げは知らせと保存の状態で別々にする。
// 知らせは、文が変わったときだけ読み上げられ、保存の状態が変わっても読み直されない。
// 知らせがあるあいだは data-alert を付け、欄が中身の幅を取って知らせを切らない（足りなければ帯の段が増え、保存の状態の文字は隠れてよい）。
function statusText(state) {
  return STATUS_TEXT[state] ?? ''
}
function renderStatus() {
  const short = shareAlertShort()
  const alert = $('status-alert')
  if (alert.textContent !== short) alert.textContent = short
  alert.hidden = !short
  alert.title = shareAlert()
  $('status').toggleAttribute('data-alert', Boolean(short))
}

function setStatus(state, detail = {}) {
  $('status-text').textContent = statusText(state)
  $('status').dataset.state = state
  const banner = $('banner')
  if (state === 'conflict') {
    banner.hidden = false
    banner.replaceChildren(
      document.createTextNode(`同じ行がほかから変更されたので、自動保存を止めました。どちらを残しますか。選ばなかった方はバックアップに残ります。${detail.draftKept === false ? draftNote(detail) : ''}`),
      bannerButton('違いを見る', () => compare(detail.theirs)),
      bannerButton('保存されているファイルの内容を使う', () => saver.resolve('theirs')),
      bannerButton('自分の内容を使う', () => saver.resolve('mine')),
    )
  } else if (state === 'removed') {
    banner.hidden = false
    banner.textContent = `このノートは消えたか、名前が変わりました。自動保存を止めました。${draftNote(detail, '画面の内容は下書きに残しています。残したい内容は、コピーしてほかのノートに貼ってください。')}`
  } else if (state === 'blocked') {
    banner.hidden = false
    banner.textContent = `このファイルは編集できない状態に変わりました（形式が変わった、大きくなりすぎた、など）。自動保存を止めました。${draftNote(detail)}`
  } else if (state === 'elsewhere') {
    banner.hidden = false
    banner.replaceChildren(
      document.createTextNode(`このタブを開いたあとで、サーバーが別のフォルダーのものに変わりました。ここの内容を向こうへ書かないよう、保存を止めました。${draftNote(detail, '画面の内容はこのタブの下書きに残しています。')}`),
      bannerButton('開き直す', async () => {
        if (saver?.keepNow() === false
          && !(await askConfirm('画面の内容は、下書きにも残せていません。開き直すと消えます。開き直しますか？', '開き直す'))) return
        // ここで確かめたので、閉じるときの確認は出さない。
        reloadConfirmed = true
        location.reload()
      }),
    )
  } else if (state === 'failed') {
    banner.hidden = false
    banner.textContent = `${SAVE_FAILURES[detail.reason] ?? 'サーバーで保存に失敗しました。'}入力は続けられます。少しあとで、もう一度保存します。${detail.draftKept === false ? draftNote(detail) : ''}`
  } else if (state === 'offline') {
    banner.hidden = false
    banner.textContent = `${detail.noReply ? 'サーバーから返事がありません。' : 'サーバーにつながりません。'}入力は続けられます。つながり直したら保存します。${detail.draftKept === false ? 'ただし、下書きには残せていない（ブラウザーの保存場所に入りきらない、など）ので、このタブを閉じたり別のノートを開いたりすると、保存していない分は消えます。' : ''}`
  } else if (state === 'toolarge') {
    banner.hidden = false
    banner.textContent = 'ノートが20MBを超えたので保存できません。大きすぎて下書きにも残せないので、このタブを閉じたり別のノートを開いたりすると、保存していない分は消えます。20MB以下に減らすと、また保存します。'
  } else if (state !== 'readonly') {
    banner.hidden = true
  }
}

function bannerButton(label, run) {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.addEventListener('click', run)
  return button
}

function compare(theirs, { mine = view.state.doc.toString(), mineTitle = '自分の内容', theirsTitle = '保存されているファイル' } = {}) {
  $('compare-mine-title').textContent = mineTitle
  $('compare-theirs-title').textContent = theirsTitle
  $('compare-mine').textContent = mine
  $('compare-theirs').textContent = theirs ?? ''
  $('compare').showModal()
}

// 保存されていない入力が残っていたら、反映するかを先に聞く。
let askingDraft = false

async function askAboutDraft(pending, forSaver) {
  askingDraft = true
  let choice
  try {
    choice = await askDraft(draftQuestion(pending.time), {
      // 聞いている間にノートが外で変わることがあるので、見るたびに今の内容で作り直す。
      onLook: () => {
        const now = forSaver.checkDraft(pending.draft) ?? pending
        compare(now.current, now.conflict
          ? { mine: now.draft.text, mineTitle: '保存されていない入力', theirsTitle: '今のノート' }
          : { mine: now.preview, mineTitle: '反映したあと', theirsTitle: '今のノート' })
      },
    })
  } finally {
    askingDraft = false
  }
  // 聞いている間に別のノートへ移っていたら、その入力には触らない。
  if (saver !== forSaver) return
  if (choice === 'apply') forSaver.applyDraft(pending.draft)
  else if (choice === 'discard') forSaver.discardDraft()
}

function softBreak(target) {
  const { state } = target
  const line = state.doc.lineAt(state.selection.main.head)
  const match = line.text.match(/^(\s*)(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/)
  if (!match) return insertNewline(target)
  const indent = ' '.repeat(match[0].length)
  target.dispatch(state.replaceSelection(`\n${indent}`), { scrollIntoView: true })
  return true
}

function runSpec(make) {
  return (target) => {
    if (target.state.readOnly) return false
    // ボタン1回を、Cmd+Zの1回にする。
    target.dispatch(make(target.state), { annotations: isolateHistory.of('full') })
    target.focus()
    return true
  }
}

function insertTable(target) {
  if (target.state.readOnly) return false
  const { from, spec } = tableSpec(target.state)
  target.dispatch(spec, { annotations: isolateHistory.of('full') })
  target.focus()
  beginTableCell(target, from, 0, 0)
  return true
}

async function insertLink(target) {
  if (target.state.readOnly) return false
  const { from, to } = target.state.selection.main
  const label = from === to ? await askText('リンクに表示する文字') : target.state.sliceDoc(from, to)
  if (!label?.trim()) {
    target.focus()
    return true
  }
  target.dispatch(linkSpec(target.state, label.trim()))
  target.focus()
  startCompletion(target)
  return true
}

const HEADING_MENU = [['本文', 0], ['見出し1', 1], ['見出し2', 2], ['見出し3', 3]]
const CALLOUT_MENU = [
  ['ℹ Note（補足）', 'NOTE'],
  ['💡 Tip（ヒント）', 'TIP'],
  ['❗ Important（重要）', 'IMPORTANT'],
  ['⚠ Warning（警告）', 'WARNING'],
  ['🛑 Caution（注意）', 'CAUTION'],
]

function menuBelow(button, items) {
  const rect = button.getBoundingClientRect()
  showMenu({ clientX: rect.left, clientY: rect.bottom + 2 }, items)
}

const TOOLBAR_ACTIONS = {
  heading: (button) => menuBelow(button, HEADING_MENU.map(([label, level]) => ({ label, run: () => runSpec((state) => headingSpec(state, level))(view) }))),
  bold: () => runSpec((state) => inlineSpec(state, 'bold'))(view),
  italic: () => runSpec((state) => inlineSpec(state, 'italic'))(view),
  strike: () => runSpec((state) => inlineSpec(state, 'strike'))(view),
  code: () => runSpec((state) => inlineSpec(state, 'code'))(view),
  bullet: () => runSpec((state) => lineKindSpec(state, 'bullet'))(view),
  number: () => runSpec((state) => lineKindSpec(state, 'number'))(view),
  task: () => runSpec((state) => lineKindSpec(state, 'task'))(view),
  quote: () => runSpec((state) => lineKindSpec(state, 'quote'))(view),
  link: () => insertLink(view),
  image: () => $('toolbar-image').click(),
  table: () => insertTable(view),
  rule: () => runSpec(horizontalRuleSpec)(view),
  codeblock: () => runSpec(codeBlockSpec)(view),
  callout: (button) => menuBelow(button, CALLOUT_MENU.map(([label, kind]) => ({ label, run: () => runSpec((state) => calloutSpec(state, kind))(view) }))),
}

// 変換中と、表のマスやノートの情報の欄を編集している間は、押しても何もしない。
function toolbarBusy() {
  return Boolean(view?.composing || view?.compositionStarted || document.activeElement?.closest?.('.cm-cell-editing, .cm-props'))
}

function syncToolbar() {
  const bar = $('toolbar')
  bar.hidden = !currentPath || !editable || mode === 'reading'
  if (bar.hidden || !view) return
  const busy = toolbarBusy()
  const format = currentFormat(view.state)
  const pressed = {
    heading: format.heading > 0,
    bold: format.inline.has('bold'),
    italic: format.inline.has('italic'),
    strike: format.inline.has('strike'),
    code: format.inline.has('code'),
    bullet: format.line === 'bullet',
    number: format.line === 'number',
    task: format.line === 'task',
    quote: format.quote,
  }
  for (const button of bar.querySelectorAll('button')) {
    button.setAttribute('aria-disabled', String(busy))
    if (button.dataset.action in pressed) button.setAttribute('aria-pressed', String(pressed[button.dataset.action]))
  }
  $('toolbar-heading-label').textContent = format.heading > 0 ? `見出し${format.heading}` : '見出し'
}

function bindToolbar() {
  const bar = $('toolbar')
  // 押してもエディターのカーソルと選択を保つ。
  bar.addEventListener('mousedown', (event) => event.preventDefault())
  bar.addEventListener('click', (event) => {
    const button = event.target.closest('button')
    if (!button || !view || toolbarBusy()) return
    TOOLBAR_ACTIONS[button.dataset.action]?.(button)
  })
  $('toolbar-image').addEventListener('change', (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file && view && !view.state.readOnly) uploadImage(file, view)
  })
  $('editor').addEventListener('focusin', syncToolbar)
  $('editor').addEventListener('focusout', () => setTimeout(syncToolbar, 0))
}

function cycleMode() {
  applyMode(mode === 'reading' ? 'live' : 'reading')
  return true
}

function addProperty(target) {
  askText('追加する項目の名前').then((name) => applyNewProperty(target, name))
  return true
}

function applyNewProperty(target, name) {
  if (!name?.trim()) return
  const doc = target.state.doc.toString()
  const front = doc.match(/^---\n[\s\S]*?\n---(?=\n|$)/)
  if (front) {
    target.dispatch({ changes: { from: 0, to: front[0].length, insert: setProperty(front[0], name.trim(), '') } })
  } else {
    target.dispatch({ changes: { from: 0, insert: `---\n${name.trim()}:\n---\n` } })
  }
  target.dispatch({ effects: togglePropsPanel.of(true) })
}

function saveNow() {
  saver?.save()
  return true
}

const editorKeys = keymap.of([
  ...completionKeys,
  { key: 'Enter', run: insertNewlineContinueMarkup },
  { key: 'Backspace', run: deleteMarkupBackward },
  { key: 'Shift-Enter', run: softBreak },
  { key: 'Mod-b', run: runSpec((state) => inlineSpec(state, 'bold')), preventDefault: true },
  { key: 'Mod-i', run: runSpec((state) => inlineSpec(state, 'italic')), preventDefault: true },
  { key: 'Mod-k', run: (target) => { insertLink(target); return true }, preventDefault: true },
  { key: 'Mod-s', run: saveNow, preventDefault: true },
  { key: 'Mod-e', run: cycleMode, preventDefault: true },
  { key: 'Mod-Alt-f', run: openSearchPanel, preventDefault: true },
  { key: 'Mod-;', run: addProperty, preventDefault: true },
  { key: 'Mod-Shift-t', run: insertTable, preventDefault: true },
  { key: 'Mod-Alt-[', run: (target) => foldAll(target), preventDefault: true },
  { key: 'Mod-Alt-]', run: (target) => unfoldAll(target), preventDefault: true },
  ...closeBracketsKeymap,
  ...searchKeymap,
  ...foldKeymap,
  ...historyKeymap,
  ...defaultKeymap,
  indentWithTab,
])

const JA = {
  Find: '検索',
  Replace: '置換',
  next: '次へ',
  previous: '前へ',
  all: 'すべて選択',
  'match case': '大文字と小文字を区別',
  'by word': '単語で探す',
  regexp: '正規表現',
  replace: '置換',
  'replace all': 'すべて置換',
  close: '閉じる',
  'current match': '現在の位置',
  'on line': '行',
  'Folded lines': '折りたたんだ行',
  'Unfolded lines': '開いた行',
  'Fold line': '折りたたむ',
  'Unfold line': '開く',
  'folded code': '折りたたみ',
  unfold: '開く',
}

// 「**」と打つと閉じる側も入れる。閉じる側を自分で打ったときは重ねずに先へ進む。
const boldAutoPair = EditorView.inputHandler.of((target, from, to, text) => {
  if (text !== '*' || from !== to) return false
  const doc = target.state.doc
  const after = doc.sliceString(to, to + 1)
  if (after === '*') {
    target.dispatch({ selection: { anchor: from + 1 } })
    return true
  }
  const before = doc.sliceString(Math.max(0, from - 2), from)
  if (!before.endsWith('*') || before === '**') return false
  target.dispatch({ changes: { from, insert: '***' }, selection: { anchor: from + 1 } })
  return true
})

const editorEvents = EditorView.domEventHandlers({
  compositionstart(_, target) {
    target.dispatch({ effects: setComposing.of(true) })
    syncToolbar()
    return false
  },
  compositionend(_, target) {
    setTimeout(() => {
      // 確定と同時に次の変換が始まっていたら、その変換が終わるまで待つ。
      if (target.compositionStarted) return
      target.dispatch({ effects: setComposing.of(false) })
      saver?.compositionEnded()
      syncToolbar()
    }, 0)
    return false
  },
  blur(_, target) {
    if (target.state.field(previewField).composing) target.dispatch({ effects: setComposing.of(false) })
    return false
  },
  paste(event, target) {
    if (target.state.readOnly) return false
    const file = [...(event.clipboardData?.files ?? [])].find((item) => item.type.startsWith('image/'))
    if (file) {
      event.preventDefault()
      uploadImage(file, target)
      return true
    }
    // リンクの括弧の中に貼った絶対パスは、相対パスにして入れる。カーソルが1つで、選んだ範囲が括弧の外へ出ないときだけ。
    const { ranges, main } = target.state.selection
    if (ranges.length !== 1 || /[)\n]/.test(target.state.sliceDoc(main.from, main.to))) return false
    const before = target.state.sliceDoc(Math.max(target.state.doc.lineAt(main.from).from, main.from - 2000), main.from)
    const href = linkTargetFromPaste(before, event.clipboardData?.getData('text/plain') ?? '', { rootPaths, notes: allNotes, currentPath })
    if (!href) return false
    event.preventDefault()
    target.dispatch(target.state.replaceSelection(href), { userEvent: 'input.paste', scrollIntoView: true })
    return true
  },
})

// サーバーと同じ上限。大きすぎるものは、送る形に変える前に断る。
const MAX_IMAGE_BYTES = 25 * 1024 * 1024

async function uploadImage(file, target) {
  if (file.size > MAX_IMAGE_BYTES) {
    showMessage('画像が大きすぎて保存できません。25MBまでです。')
    return
  }
  const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') ?? 'png'
  const name = file.name && file.name.includes('.') ? file.name : `image.${ext}`
  const response = await fetch(`/api/attachment?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'x-note-editor': '1', 'x-note-root': rootId },
    body: file,
  })
  if (response.status === 412) otherVault()
  if (!response.ok) {
    // 設定の画像の置き場が使えないときは、その理由を出す（ほかの場所には入れない）。
    const reason = response.status === 409 ? (await response.json().catch(() => null))?.message : null
    if (response.status === 413) showMessage('画像が大きすぎて保存できません。25MBまでです。')
    else showMessage(reason ? `画像を保存できませんでした。${reason}` : '画像を保存できませんでした。')
    return
  }
  const { path } = await response.json()
  target.dispatch(target.state.replaceSelection(`![](${relativeHref(currentPath, path)})`))
}

function linkAt(state, pos, side = 0) {
  // [[ ]]は1つの部品として表示するので、位置は端に来る。マウスのある側を見る。
  let node = syntaxTree(state).resolveInner(pos, side)
  while (node && node.name !== 'Link' && node.name !== 'WikiLink' && node.name !== 'Document') node = node.parent
  if (node?.name === 'WikiLink') {
    const link = wikiLinkOf(state.doc.sliceString(node.from + 2, node.to - 2), state.facet(noteContext))
    return link?.href ? { href: link.href, from: node.from, to: node.to } : null
  }
  if (!node || node.name !== 'Link') return null
  const url = node.getChild('URL')
  return url ? { href: state.doc.sliceString(url.from, url.to), from: node.from, to: node.to } : null
}

const hoverPreview = hoverTooltip(
  async (target, pos, side) => {
    if (!hoverWithMeta) return null
    // フォルダーの外のノートからは、リンク先を開かないのと同じく中身も見せない。
    if (currentPath?.startsWith('__outside__/')) return null
    const link = linkAt(target.state, pos, side)
    if (!link || isExternal(link.href)) return null
    const resolved = resolveHref(currentPath, link.href, rootPaths)
    if (!resolved?.path.endsWith('.md')) return null
    let note
    try {
      note = await api.read(resolved.path)
    } catch {
      return null
    }
    return {
      pos: link.from,
      end: link.to,
      above: true,
      create() {
        const dom = document.createElement('div')
        dom.className = 'note-hover'
        const inner = new EditorView({
          parent: dom,
          state: EditorState.create({
            doc: note.text.slice(0, 20000),
            extensions: [
              noteMarkdown(languages),
              noteContext.of({ path: resolved.path, known, rootPaths, isTooltip: true }),
              previewField,
              EditorView.editable.of(false),
              EditorState.readOnly.of(true),
              EditorView.lineWrapping,
              syntaxHighlighting(highlight),
            ],
          }),
        })
        inner.dispatch({ effects: setMode.of('reading') })
        return { dom, destroy: () => inner.destroy() }
      },
    }
  },
  { hoverTime: 250 },
)

function extensionsFor(path, canEdit) {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor({ key: 'Alt' }),
    EditorState.allowMultipleSelections.of(true),
    EditorView.clickAddsSelectionRange.of((event) => event.altKey),
    EditorState.tabSize.of(4),
    indentUnit.of('\t'),
    EditorView.lineWrapping,
    EditorState.phrases.of(JA),
    closeBrackets(),
    boldAutoPair,
    search({ top: true }),
    foldGutter({ openText: '▾', closedText: '▸' }),
    autocompletion({
      override: [
        linkCompletion({ notes: () => notes, currentPath: () => currentPath }),
        wikiLinkCompletion({ notes: () => notes, known: () => known, currentPath: () => currentPath }),
      ],
      icons: false,
      defaultKeymap: false,
    }),
    syntaxHighlighting(highlight),
    noteMarkdown(languages),
    contextSlot.of(noteContext.of({ path, known, newNoteDir: defaultNoteDir(path, pickerFolders()), api, rootPaths, editable: canEdit })),
    previewField,
    listHangingIndent,
    editableSlot.of(editableExtensions(canEdit)),
    editorKeys,
    editorEvents,
    hoverPreview,
    EditorView.updateListener.of(onUpdate),
    EditorView.contentAttributes.of({ spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
  ]
}

// 動かしている間（開き直し終わるまで）は、表示の切り替えや開き直しでも編集できるように戻さない。
let editorLocked = false

function editableExtensions(canEdit) {
  const allow = canEdit && !editorLocked && mode !== 'reading'
  return [EditorView.editable.of(allow), EditorState.readOnly.of(!allow)]
}

// 開いているノートを会話へ伝える（スイッチがオンのときだけ）。断られたら、記録して小さく知らせる。
// スイッチは上の帯の小さなボタン（押すとオン／オフ。状態は色と title）。知らせはボタンの横の小さな印と title に出し、帯の段を増やさない。
const SHARE_TITLE_ON = '開いているノートをAIに伝える：オン（ノートの場所と選んでいる行の番号を、Codexの会話に伝えます。押すとオフ）'
const SHARE_TITLE_OFF = '開いているノートをAIに伝える：オフ（押すとオンにして、ノートの場所と選んでいる行の番号を、Codexの会話に伝えます）'
const SHARE_TITLE_LOCKED = 'このタブでは「開いているノートをAIに伝える」を変えられません'
const UNCLEARED_NOTE = '会話に伝えた内容を消せませんでした'
// 状態の欄の先頭に出す短い知らせ（全文は title と、出たときに一度だけ出す確かめの画面）。
const SHORT_NOTICES = { uncleared: '⚠ AIに残存の恐れ', offUnsaved: '⚠ オフ未保存' }
// 知らせが重なったときは、この順で1つだけ出す（会話に内容が残っているかもしれない知らせを優先）。
const NOTICE_ORDER = ['uncleared', 'offUnsaved', 'blocked']
const topNotice = (kinds) => kinds.find((kind) => shareNotices.has(kind))
const BLOCKED_NOTE = 'この画面では会話にノートを伝えられません'
// 知らせは種類ごとに持つ。'blocked'（送られない側）はボタンの印と title だけ。
// 'uncleared' と 'offUnsaved'（会話に内容が残っているかもしれない側）は、文字でも状態の欄（#status、読み上げ対象）に出し続け、
// 出たときに一度だけ確かめの画面でも知らせる。
const shareNotices = new Map()
const TEXT_NOTICES = ['uncleared', 'offUnsaved']
function shareButtonOn() {
  return $('ai-share-on').getAttribute('aria-pressed') === 'true'
}
function setShareButton(on) {
  $('ai-share-on').setAttribute('aria-pressed', String(on))
  syncShareTitle()
}
function setShareNotice(kind, text) {
  const was = shareNotices.get(kind)
  if (text) shareNotices.set(kind, text)
  else shareNotices.delete(kind)
  const box = $('ai-share-on')
  const top = topNotice(NOTICE_ORDER)
  if (top) box.dataset.note = shareNotices.get(top)
  else delete box.dataset.note
  syncShareTitle()
  if (TEXT_NOTICES.includes(kind) && was !== text) {
    renderStatus()
    if (text) showMessage(text)
  }
}
// 会話に内容が残っているかもしれないという知らせの全文と、短い文（なければ空）。
function shareAlert() {
  const top = topNotice(TEXT_NOTICES)
  return top ? shareNotices.get(top) : ''
}
function shareAlertShort() {
  const top = topNotice(TEXT_NOTICES)
  return top ? SHORT_NOTICES[top] : ''
}
function syncShareTitle() {
  const box = $('ai-share-on')
  const head = !canCreate ? SHARE_TITLE_LOCKED : shareButtonOn() ? SHARE_TITLE_ON : SHARE_TITLE_OFF
  box.title = head + (box.dataset.note ? `\n${box.dataset.note}` : '')
}
// オンにする前の確かめ。ほかのタブへの知らせ（BroadcastChannel・storage イベント・4秒おきの読み直し）が
// 実機の隠れたタブで効くと確かめられるまでの次善策として、ほかのタブの分が残ることがあると伝える。
const SHARE_CONFIRM_ON = '開いているノートの場所（Vault のフォルダーの場所を含む）と、選んでいる行の番号を、Codexの会話に伝えます。本文は送りません。オフにしても、ほかのタブの分は、そのタブを表示したときに消えることがあります。'
const shareSwitch = createShareSwitch({
  request,
  confirmOn: () => askConfirm(SHARE_CONFIRM_ON, 'オンにする'),
  onSaved: (on) => shareSaved(on),
  canCreate: () => canCreate,
  ui: {
    getChecked: shareButtonOn,
    setChecked: setShareButton,
    setDisabled: (disabled) => {
      $('ai-share-on').disabled = disabled
      syncShareTitle()
    },
    setNotice: setShareNotice,
    message: showMessage,
  },
})
const aiContext = createAiContext({
  send: updateNoteContext,
  confirmShare: shareSwitch.confirmShare,
  hostHasContext,
  vaultRoot: () => rootPaths[0] ?? '',
  onShareOff: () => {
    if (!shareSwitch.saving) setShareButton(false)
  },
  onRefused: (reason, { cleared, mayRemain }) => {
    logToHost(`model context update refused${cleared ? ' (clear)' : ''}: ${reason}`)
    // 「消せませんでした」は、会話に内容が残っているかもしれないときだけ。何も伝えていない画面では「伝えられません」（印と title だけ）。
    if (cleared && mayRemain) setShareNotice('uncleared', UNCLEARED_NOTE)
    else setShareNotice('blocked', BLOCKED_NOTE)
  },
  // 受け取られたら、前の内容は置き換わったので「伝えられない」「消せなかった」の知らせは消す（オフの保存の知らせは残す）。
  onAccepted: () => {
    setShareNotice('blocked', null)
    setShareNotice('uncleared', null)
  },
})
shareSwitch.attach(aiContext)
const loadShare = () => shareSwitch.load()

// ほかのタブでスイッチを切り替えたことに、早く気づくための仕組み（隠れているタブでも、できるだけ早く空の上書きをする）。
// 1. 保存できたら、同じフォルダーのほかのタブへ知らせる（BroadcastChannel と localStorage の storage イベント）。
//    どちらも、受け取ったタブで読み直すだけ（値はサーバーの /api/share を正とする）。タイマーに頼らないので、
//    隠れているタブのタイマーが遅らされても届く見込み。届くのは、タブどうしが同じ origin・同じ保存場所のときだけ。
// 2. スイッチがオンの間は、SHARE_FAST_POLL_MS おきに読み直す（オフなら、60秒おきの読み直しだけ）。
const SHARE_FAST_POLL_MS = 4000
const shareKey = () => `notedock-share:${rootId ?? ''}`
let shareChannel = null
function shareSaved(on) {
  try {
    shareChannel?.postMessage({ on, at: Date.now() })
  } catch {}
  try {
    localStorage.setItem(shareKey(), JSON.stringify({ on, at: Date.now() }))
  } catch {}
}
function watchShareFromOtherTabs() {
  try {
    shareChannel = new BroadcastChannel(shareKey())
    shareChannel.onmessage = () => loadShare()
  } catch {}
  window.addEventListener('storage', (event) => {
    if (event.key === shareKey()) loadShare()
  })
  // 前の読み直しが返るまで、次は出さない（ホストの返事が遅いときに重ねない）。
  let polling = false
  setInterval(() => {
    if (!aiContext.enabled || polling) return
    polling = true
    loadShare().catch(() => {}).finally(() => { polling = false })
  }, SHARE_FAST_POLL_MS)
}

function onUpdate(update) {
  if (update.docChanged) {
    const fromOutside = update.transactions.some((tr) => tr.annotation(external))
    if (!fromOutside) saver?.changed()
    scheduleOutline()
  }
  if (update.docChanged || update.selectionSet) syncToolbar()
  // 選ぶ範囲が変わったとき、書き換えで選んでいる行の番号が動いたり選択が消えたりしたとき（外からの変更も含む）。
  if (update.selectionSet || update.docChanged) aiContext.selectionChanged(selectionOf(update.state))
  if (update.transactions.some((tr) => tr.effects.some((e) => e.is(foldEffect)))) rememberFolds()
}

function rememberFolds() {
  if (!view || !currentPath) return
  const lines = []
  foldedRanges(view.state).between(0, view.state.doc.length, (from) => {
    lines.push(view.state.doc.lineAt(from).number)
  })
  storage.set(`folds:${vaultName}:${currentPath}`, lines)
}

function restoreFolds(path) {
  const effects = []
  for (const number of storage.get(`folds:${vaultName}:${path}`, [])) {
    if (number > view.state.doc.lines) continue
    const line = view.state.doc.line(number)
    const range = foldable(view.state, line.from, line.to)
    if (range) effects.push(foldEffect.of(range))
  }
  if (effects.length) view.dispatch({ effects })
}

function applyMode(next) {
  if (sourceOnly && next !== 'source') return
  mode = next
  showPasteHint(false)
  for (const button of $('modes').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode))
  }
  document.body.dataset.mode = mode
  if (view) {
    view.dispatch({ effects: [setMode.of(mode), editableSlot.reconfigure(editableExtensions(editable))] })
  }
  syncToolbar()
}



let outlineTimer = null
function scheduleOutline() {
  if ($('outline').hidden) return
  clearTimeout(outlineTimer)
  outlineTimer = setTimeout(renderOutline, 300)
}

function renderOutline() {
  const box = $('outline')
  if (box.hidden || !view) return
  box.replaceChildren()
  for (const heading of headingsOf(view.state)) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = `outline-item outline-${heading.level}`
    item.textContent = heading.text || '（無題）'
    item.addEventListener('click', () => jumpTo(heading.from))
    box.append(item)
  }
}

function jumpTo(pos) {
  view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 20 }) })
}

function jumpToAnchor(anchor) {
  if (!anchor) return
  // 長いノートでも見出しまで読み取ってから探す。
  ensureSyntaxTree(view.state, view.state.doc.length, 200)
  const heading = findHeading(headingsOf(view.state), anchor)
  if (heading) jumpTo(heading.from)
}

const RECONNECT_MS = 3000

function connectEvents(path) {
  events?.close()
  events = new EventSource(`/api/events?path=${encodeURIComponent(path)}&root=${rootId}`)
  // 別のVaultのサーバーに断られると再接続されないので、断られたのかを確かめる。
  events.onerror = async () => {
    try {
      const { ok } = await request('/api/health')
      // ファイルが消えている間につながり直すと断られ、自動では再接続されない。
      if (ok && events?.readyState === EventSource.CLOSED) {
        setTimeout(() => {
          if (path === currentPath && events?.readyState === EventSource.CLOSED) connectEvents(path)
        }, RECONNECT_MS)
      }
    } catch {
      // サーバーが止まっている間は、ブラウザが自動でつなぎ直す。
    }
  }
  const receive = (note) => {
    if (note.path !== currentPath) return
    if (saver && note.editable) saver.applyExternal(note.text, note.hash)
    else if (saver) saver.blocked()
    else docAdapter.set(note.text)
  }
  events.addEventListener('changed', (event) => receive(JSON.parse(event.data)))
  events.addEventListener('removed', () => saver?.removed())
  // 編集できるフォルダーが変わった（fingerprint の応答の rootId が違う）。黙って受け取り直す。
  events.addEventListener('rootchanged', () => void recheckFolder())
  // つながるまでの間やつながり直すまでの間の変更は知らせが来ないので、読み直して確かめる。
  events.onopen = async () => {
    if (path !== currentPath) return
    try {
      const note = await api.read(path)
      if (path === currentPath) receive(note)
    } catch (error) {
      if (error.status === 404) saver?.removed()
    }
    if (['offline', 'failed'].includes($('status').dataset.state)) saver?.save()
  }
}

const docAdapter = {
  get: () => view.state.doc.toString(),
  set(text) {
    const change = minimalChange(view.state.doc.toString(), text)
    if (!change) return
    view.dispatch({ changes: change, annotations: [external.of(true), Transaction.addToHistory.of(false)] })
  },
  // 表のマスやノートの情報の欄を編集している間も、外からの変更で入力中の内容が消えないよう待つ。
  composing: () => view.composing || view.compositionStarted || Boolean(document.activeElement?.closest?.('.cm-cell-editing, .cm-props')),
  // 変換の途中の文字は保存しない。マスの編集中でも、本文に書き戻した分は保存してよい。
  holdSave: () => view.composing || view.compositionStarted,
}

// 編集中のマスや入力欄は、外へ出たときに本文へ書き戻される。
function commitOpenField() {
  const field = document.activeElement
  if (field?.closest?.('.cm-cell-editing, .cm-props')) field.blur()
}

let openRequest = 0
// 保存の仕組み（createSaver）まで進んだ、最後の開く操作の番号。
let saverRequest = 0
// 開いたときの下書きの問い合わせに失敗したノートの、聞き直し（次に保存できたときに1回だけ）。
let draftRetry = null
// 下書きの問い合わせを、ノートを読んだ応答のあと、ここまで待つ。
const DRAFT_WAIT_MS = 3000

async function openNote(path, { push = true, anchor = '', startMode = 'reading', offerCreate = false } = {}) {
  openRequest += 1
  const thisRequest = openRequest
  // ノートの読み込みと一緒に、サーバーの下書きも問い合わせる。届いたら reply に入れる。
  // 読めなかったとき（つながらない、ページを閉じて打ち切られた、など）は、届かなかったのと同じに扱う。
  // 「下書きなし」とみなすと、サーバーにだけある新しい下書きを消してしまうおそれがあるため。
  const reply = { done: false, draft: null }
  const draftReply = api.queryDraft(path).then((answer) => {
    if (answer.ok) {
      reply.done = true
      reply.draft = answer.draft
    }
    return answer
  })
  let note
  try {
    note = await api.read(path)
  } catch (error) {
    if (error.status === 404) {
      if (!offerCreate) {
        showMessage(`「${path}」が見つかりません。消えたか、名前が変わったのかもしれません。`)
      } else if (!canCreate) {
        showMessage(`「${path}」はまだありません。このタブでは新しいノートを作れません。`)
      } else if (await askConfirm(`「${path}」はまだありません。新しく作りますか。`, '作る')) {
        const created = await request(noteUrl(path), { method: 'POST' })
        if (created.ok) {
          await refreshNotes()
          return openNote(path, { push, anchor, startMode: 'live' })
        }
        showMessage('このノートは作れません。')
      }
      return
    }
    showMessage(error.status === 400 ? 'このファイルは開けません。' : 'このノートを開けませんでした。')
    return
  }
  // 編集できるノートだけ、サーバーの下書きを使う。
  // 今開いているノートを開き直すとき（保留中でなければ）は、このパネルが直前まで書いていた localStorage のほうが新しい。
  // 保存でサーバーの下書きはもう消えているかもしれないので、サーバーの下書きは使わない。
  // 編集できない状態で開いていたノート（saver がない）は、開き直しでもサーバーの下書きを使う。
  const useServerDraft = note.editable && !(path === currentPath && saver && !draftSync.held(path))
  if (useServerDraft && !reply.done && thisRequest === openRequest) {
    // 待つ間も、前のノートの保存の仕組みは生きている（打った分は前のノートに入る）。
    let timer
    await Promise.race([draftReply, new Promise((resolve) => { timer = setTimeout(resolve, DRAFT_WAIT_MS) })])
    clearTimeout(timer)
    // 来なければ（読めなかったときも）、応答が来るまでサーバーの下書きに書きも消しもしない。
    if (!reply.done && thisRequest === openRequest) draftSync.hold(path)
  }
  // 続けて開いたときは、最後に頼まれたノートを開く。
  if (thisRequest !== openRequest) return
  commitOpenField()
  const flushed = await saver?.flush()
  if (thisRequest !== openRequest) return
  // 大きすぎて保存も下書きもできない内容は、開き直すと消えるので確かめる。
  // 状態の表示ではなく、保存しきれず、今の本文が上限を超えているかで決める（変換中や保存を止めている間も含めるため）。
  // 下書きに残せなかったときも同じ（保存できていない間に、下書きも入りきらなかった）。
  const tooLarge = flushed === false && view && overLimit(view.state.doc.toString())
  const lost = flushed === false && saver?.keepNow() === false
  if ((tooLarge || lost) && !(await askConfirm(tooLarge
    ? '今のノートは20MBを超えていて、保存も下書きもできていません。別のノートを開くと、保存していない分は消えます。開きますか？'
    : '今のノートは保存できておらず、下書きにも残せていません（ブラウザーの保存場所に入りきらない、など）。別のノートを開くと、保存していない分は消えます。開きますか？', '開く'))) return
  if (thisRequest !== openRequest) return
  saver?.close()
  saver = null
  currentPath = path
  renderCalendar()
  sourceOnly = note.sourceOnly
  editable = note.editable
  const nextMode = sourceOnly ? 'source' : startMode
  mode = nextMode
  // YAMLの中にカーソルを置くと文字で見えてしまうので、本文の先頭から始める。
  const front = note.text.match(/^---\n[\s\S]*?\n---(?:\n|$)/)
  const state = EditorState.create({
    doc: note.text,
    selection: { anchor: front ? Math.min(front[0].length, note.text.length) : 0 },
    extensions: extensionsFor(path, editable),
  })
  if (view) view.setState(state)
  else view = new EditorView({ state, parent: $('editor') })
  applyMode(nextMode)
  renderBreadcrumb(path)
  $('copy-path').disabled = false
  document.title = path.split('/').at(-1).replace(/\.md$/i, '')
  aiContext.noteChanged(path, selectionOf(view.state))
  if (push) pushNoteUrl(path, anchor)
  rememberRecent(path)
  const banner = $('banner')
  banner.hidden = true
  let pendingDraft = null
  if (editable) {
    saver = createSaver({ doc: docAdapter, api, path, baseText: note.text, baseHash: note.hash, onStatus: ({ state: s, ...d }) => setStatus(s, d), drafts, typedAtAllowed: () => !draftSync.held(path) })
    saverRequest = thisRequest
    draftRetry = null
    setStatus('saved')
    pendingDraft = saver.checkDraft(draftToUse(path, useServerDraft, reply, draftReply, thisRequest))
  } else {
    // 編集できるフォルダーの外のノートは、帯の説明を出さず、状態の欄の小さな印（読むだけ）だけにする。
    setStatus(note.reason === 'outside' ? 'viewonly' : 'readonly')
    if (note.reason !== 'outside-tab' && note.reason !== 'outside') {
      banner.hidden = false
      banner.textContent = REASONS[note.reason] ?? '編集できません。'
    }
  }
  if (sourceOnly && editable) {
    banner.hidden = false
    banner.textContent = '大きいファイルなので、ソース表示で開いています。'
  }
  connectEvents(path)
  restoreFolds(path)
  renderOutline()
  revealInFiles(path)
  jumpToAnchor(anchor)
  view.focus()
  if (pendingDraft) void askAboutDraft(pendingDraft, saver)
  return true
}

// 開くときに checkDraft へ渡す下書きを決める。
// サーバーの応答が届いていれば、localStorage と比べて新しいほう。届いていなければ localStorage のもの。
function draftToUse(path, useServerDraft, reply, draftReply, thisRequest) {
  const local = drafts.get(path)
  if (!useServerDraft) return local
  if (reply.done) {
    draftSync.release(path)
    const chosen = newerDraft(local, reply.draft)
    // サーバーの下書きを使ったら、localStorage にも入れ直す（入りきらなくても進む）。
    if (chosen && chosen !== local) storage.set(`${draftPrefix()}${path}`, chosen)
    return chosen
  }
  // 遅れて届いたら、開いたときに使った下書き（used）と比べて後始末する。
  const used = local
  let retried = false
  const settle = async (answer) => {
    if (thisRequest !== openRequest || saverRequest !== thisRequest) return
    if (!answer.ok) {
      // 問い合わせに失敗したら、次に保存できたとき（サーバーにつながると分かったとき）に1回だけ聞き直す。
      // 聞き直しにも失敗したら、保留のままにする。
      if (retried) return
      retried = true
      draftRetry = { path, run: () => api.queryDraft(path).then(settle) }
      return
    }
    const result = await settleLateDraft({ used, late: answer.draft, backup: (text) => api.backupChecked(path, text) })
    // 履歴に残している間に、別の開く操作が始まっていたら、そちらに任せる（保留は残す）。
    if (result !== 'release' || thisRequest !== openRequest) return
    draftSync.release(path)
    // サーバーの下書きを、今の localStorage の下書きに合わせる。読めない形の下書きは送らず、消す。
    const now = drafts.get(path)
    if (typeof now?.text === 'string') draftSync.put(path, now)
    else draftSync.clear(path)
  }
  draftReply.then(settle)
  return local
}

// The panel page has no address of its own, so the notes visited in this tab are kept here.
const visited = []
let visitedAt = -1

function syncVisited() {
  $('nav-back').disabled = visitedAt <= 0
  $('nav-forward').disabled = visitedAt >= visited.length - 1
}

function pushNoteUrl(path) {
  visited.splice(visitedAt + 1)
  visited.push(path)
  visitedAt = visited.length - 1
  syncVisited()
}

async function goVisited(step) {
  const target = visited[visitedAt + step]
  if (!target) return
  if (!(await openNote(target, { push: false }))) return
  visitedAt += step
  syncVisited()
}

function rememberRecent(path) {
  const recent = storage.get(`recent:${vaultName}`, []).filter((item) => item !== path)
  recent.unshift(path)
  storage.set(`recent:${vaultName}`, recent.slice(0, 20))
}

function openHref(href, newTab) {
  if (isExternal(href)) {
    if (/^https?:|^mailto:/i.test(href)) window.open(href, '_blank', 'noopener')
    return
  }
  if (currentPath.startsWith('__outside__/')) {
    showMessage('フォルダーの外のノートからは、リンク先を開けません。')
    return
  }
  const target = resolveHref(currentPath, href, rootPaths)
  if (!target) {
    showMessage('Vaultの外へのリンクは開けません。')
    return
  }
  if (target.path === currentPath) {
    jumpToAnchor(target.anchor)
    return
  }
  if (!target.path.toLowerCase().endsWith('.md')) {
    if (/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(target.path)) {
      window.open(`/api/file?path=${encodeURIComponent(target.path)}`, '_blank', 'noopener')
    } else {
      showMessage(`「${target.path}」はエディターで開けません。`)
    }
    return
  }
  // まだないノートを作ると聞くのは、リンクを押したときだけ。一覧や戻るで消えたノートを作り直さない。
  if (!newTab) {
    openNote(target.path, { anchor: target.anchor, offerCreate: true })
    return
  }
  openInHost(target.path).then((opened) => {
    if (!opened) openNote(target.path, { anchor: target.anchor, offerCreate: true })
  })
}

async function refreshNotes() {
  const result = await request('/api/notes')
  if (!result.ok) return
  notes = result.data.notes
  allNotes = result.data.known
  folders = result.data.folders ?? []
  const changed = JSON.stringify([notes, folders]) !== filesRendered
  known = new Set(result.data.known.map(normalizeKey))
  canCreate = result.data.canCreate
  $('new-note').disabled = !canCreate
  $('new-note').title = canCreate ? '新しいノートを作る' : 'このタブでは新しいノートを作れません'
  $('open-settings').disabled = !canCreate
  $('ai-share-on').disabled = shareSwitch.disabled()
  syncShareTitle()
  $('open-settings').title = canCreate ? '画像と日付ごとのノートの置き場を決める' : 'このタブでは設定を変えられません'
  // 変わっていなければ描き直さない。キーボードの位置が外れないようにする。
  if (changed) renderFiles()
}

let filesOpen = new Set()
let filesRendered = ''

function saveFilesOpen() {
  storage.set(`files-open:${vaultName}`, [...filesOpen])
}

function renderFiles() {
  const box = $('files')
  if (box.hidden) return
  const scroll = box.scrollTop
  const rows = []
  const walk = (folder, depth) => {
    for (const child of folder.folders) {
      const open = filesOpen.has(child.path)
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'files-row'
      row.style.setProperty('--depth', String(depth))
      row.setAttribute('aria-expanded', String(open))
      row.title = child.path
      row.dataset.folder = child.path
      const arrow = document.createElement('span')
      arrow.className = 'files-arrow'
      arrow.textContent = open ? '▾' : '▸'
      const name = document.createElement('span')
      name.className = 'files-name'
      name.textContent = child.name
      row.append(arrow, name)
      decorateFileRow(row, child.path, true)
      row.addEventListener('click', () => {
        if (filesOpen.has(child.path)) filesOpen.delete(child.path)
        else filesOpen.add(child.path)
        saveFilesOpen()
        renderFiles()
      })
      rows.push(row)
      if (open) walk(child, depth + 1)
    }
    for (const file of folder.files) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'files-row files-note'
      row.style.setProperty('--depth', String(depth))
      row.title = file.path
      row.dataset.path = file.path
      if (file.path === currentPath) row.setAttribute('aria-current', 'true')
      const name = document.createElement('span')
      name.className = 'files-name'
      name.textContent = file.name
      row.append(name)
      decorateFileRow(row, file.path, false)
      row.addEventListener('click', () => openNote(file.path))
      rows.push(row)
    }
  }
  walk(buildTree(notes, folders), 0)
  filesRendered = JSON.stringify([notes, folders])
  box.replaceChildren(...rows)
  box.scrollTop = scroll
}

// 開いたノートの場所が見えるように、上のフォルダーを開いてそこまで動かす。
function revealInFiles(path) {
  let changed = false
  for (const folder of ancestorsOf(path)) {
    if (!filesOpen.has(folder)) {
      filesOpen.add(folder)
      changed = true
    }
  }
  if (changed) saveFilesOpen()
  renderFiles()
  for (const row of $('files').querySelectorAll('.files-note')) {
    if (row.dataset.path === path) {
      row.scrollIntoView({ block: 'nearest' })
      break
    }
  }
}

// 上の並びのパンくずリスト。フォルダーを押すと、ファイル欄でそのフォルダーを開いて見せる。
function renderBreadcrumb(path) {
  const box = $('note-path')
  const nodes = []
  breadcrumbParts(path, vaultLabel || 'フォルダー').forEach((part, index) => {
    if (index > 0) {
      const sep = document.createElement('span')
      sep.className = 'crumb-sep'
      sep.setAttribute('aria-hidden', 'true')
      sep.textContent = '›'
      nodes.push(sep)
    }
    if (part.folder === null) {
      const name = document.createElement('span')
      name.className = 'crumb-note'
      name.textContent = part.label
      nodes.push(name)
      return
    }
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'crumb'
    button.textContent = part.label
    button.title = `「${part.label}」をファイル欄で開く`
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', () => revealFolder(part.folder))
    nodes.push(button)
  })
  box.replaceChildren(...nodes)
  box.title = path ? path.replace(/^__outside__\//, '') : ''
}

// フォルダーとその上を開いた状態にして、そのフォルダーの行まで動かす。'' は一番上。
function revealFolder(folder) {
  if ($('files').hidden) {
    $('files').hidden = false
    storage.set('files-shown', true)
    closeOutline()
  }
  if (folder) {
    let changed = false
    for (const item of ancestorsOf(`${folder}/x`)) {
      if (!filesOpen.has(item)) {
        filesOpen.add(item)
        changed = true
      }
    }
    if (changed) saveFilesOpen()
  }
  renderFiles()
  const box = $('files')
  if (!folder) {
    box.scrollTop = 0
    return
  }
  const row = [...box.querySelectorAll('[data-folder]')].find((item) => item.dataset.folder === folder)
  if (!row) return
  row.scrollIntoView({ block: 'start' })
  row.classList.add('files-flash')
  setTimeout(() => row.classList.remove('files-flash'), 1200)
}

function showFiles(show) {
  $('files').hidden = !show
  storage.set('files-shown', show)
  if (show) {
    closeOutline()
    if (currentPath) revealInFiles(currentPath)
    else renderFiles()
  }
}

// 日付のノート（今日のノートとカレンダー）。決まりはClaude用の NoteDock と同じ。
const pad2 = (n) => String(n).padStart(2, '0')
function todayText() {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
function nowText() {
  const d = new Date()
  return `${todayText()}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

let calMonth = todayText().slice(0, 7)
let periodicState = null
let periodicStateMonth = null
let calendarRequest = 0

async function openPeriodicNote(period, date, { ask = false } = {}) {
  try {
    const name = periodInfo(period, date).name
    const post = (extra) => request('/api/periodic/open', { method: 'POST', body: JSON.stringify({ period, date, now: nowText(), ...extra }) })
    const refuse = (result) => {
      showMessage(result.status === 409 ? (result.data?.message ?? '日付のノートの設定を読めません。') : 'このノートは作れません。')
    }
    // Codex用では、書き込めないタブ（フォルダーの外のノートから開いたタブ）はノートを作れない。あるノートを読むだけで開く。
    if (periodicStep({ canCreate, ask }).probe) {
      const probe = await post({ dryRun: true })
      if (!probe.ok) return refuse(probe)
      const step = periodicStep({ canCreate, ask, probe: probe.data })
      if (step.action === 'refuse') return showMessage(`${name}のノートはまだありません。このタブでは新しいノートを作れません。`)
      if (step.action === 'open') {
        await openNote(step.path)
        drawCalendar()
        return
      }
      if (step.action === 'confirm' && !(await askConfirm(`${name}のノートはまだありません。作りますか？`, '作る'))) return
    }
    const result = await post()
    if (!result.ok) return refuse(result)
    const { path, created } = result.data
    // ノートがあっても、その年のフォルダーを作り直していることがあるので、一覧はいつも読み直す。
    await refreshNotes()
    await openNote(path, { startMode: created ? 'live' : 'reading' })
    drawCalendar()
  } catch {
    showMessage('このノートは作れません。')
  }
}

// 開いているノートが <periodicRoot>/<年>/Daily/YYYY-MM-DD.md の形なら、その日付。
function openDateOf() {
  const root = periodicState?.periodicRoot
  if (!root || !currentPath) return null
  const match = currentPath.match(/^(.*)\/(\d{4})\/Daily\/(\d{4}-\d{2}-\d{2})\.md$/)
  return match && match[1] === root && match[3].startsWith(match[2]) ? match[3] : null
}

async function drawCalendar() {
  if ($('calendar').hidden) return
  const mine = ++calendarRequest
  const month = calMonth
  let result
  try {
    result = await request(`/api/periodic?month=${month}`)
  } catch {
    return
  }
  if (mine !== calendarRequest) return
  periodicState = result.ok ? result.data : null
  periodicStateMonth = month
  renderCalendar()
}

function renderCalendar() {
  const box = $('calendar')
  if (box.hidden) return
  // 日付ごとのノートの置き場が決まっていなければ、カレンダーの代わりに案内を出す。
  if (periodicStateMonth === calMonth && periodicState?.disabled) {
    const note = document.createElement('p')
    note.className = 'cal-off'
    note.textContent = periodicState.message
      ? `日付ごとのノートの設定に、使えないところがあります：${periodicState.message}`
      : canCreate
        ? '日付ごとのノートの置き場が決まっていないので、カレンダーは出ません。「設定」で決められます。'
        : '日付ごとのノートの置き場が決まっていないので、カレンダーは出ません。'
    // 書き込めないタブでは設定を変えられないので、ボタンは出さない。
    if (!canCreate) {
      box.replaceChildren(note)
      return
    }
    const open = document.createElement('button')
    open.type = 'button'
    open.textContent = '設定を開く'
    open.className = 'cal-off-open'
    open.addEventListener('click', openSettings)
    box.replaceChildren(note, open)
    return
  }
  const model = calendarModel(calMonth, todayText(), openDateOf(), periodicStateMonth === calMonth ? (periodicState ?? {}) : {})
  box.replaceChildren(
    ...buildCalendar(model, {
      open: (period, date) => openPeriodicNote(period, date, { ask: !(period === 'daily' && date === todayText()) }),
      go: (step) => {
        calMonth = step === 0 ? todayText().slice(0, 7) : shiftMonth(calMonth, step)
        drawCalendar()
      },
    }),
  )
}

function showCalendar(show, { remember = true } = {}) {
  $('calendar').hidden = !show
  if (remember) storage.set('calendar-shown', show)
  if (show) {
    closeOutline()
    $('calendar').hidden = false
    drawCalendar()
  }
}

// 目次と右の列は同じ場所に出る。目次を出すときはカレンダーも隠し、目次を閉じたら元に戻す（次回の表示の設定は変えない）。
let calendarUnderOutline = false
let filesUnderOutline = false
function closeOutline() {
  if ($('outline').hidden) return
  $('outline').hidden = true
  if (calendarUnderOutline) {
    $('calendar').hidden = false
    drawCalendar()
  }
  if (filesUnderOutline) {
    $('files').hidden = false
    if (currentPath) revealInFiles(currentPath)
    else renderFiles()
  }
  calendarUnderOutline = false
  filesUnderOutline = false
}

// 一覧もカレンダーも隠れたら、右の列ごと隠す。
function syncSide() {
  $('side').hidden = $('calendar').hidden && $('files').hidden
}

function openSwitcher() {
  const dialog = $('switcher')
  const input = $('switcher-input')
  input.value = ''
  renderSwitcher('')
  if (!dialog.open) dialog.showModal()
  input.focus()
  // 一覧が変わっていなければ描き直さない。矢印キーで選んだ行が先頭へ戻らないようにする。
  const before = JSON.stringify(notes)
  refreshNotes().then(() => {
    if (JSON.stringify(notes) !== before) renderSwitcher(input.value)
  })
}

function renderSwitcher(query) {
  const list = $('switcher-list')
  const pasted = resolvePasted(query, rootPaths, allNotes)
  const needle = pasted ? pasted.toLowerCase().normalize('NFC') : query.trim().toLowerCase().normalize('NFC')
  const source = needle ? notes.filter((note) => note.toLowerCase().normalize('NFC').includes(needle)) : storage.get(`recent:${vaultName}`, []).filter((note) => notes.includes(note)).concat(notes.slice(0, 30))
  // 名前に入っているものを先に並べてから、上限で切る。
  const nameHit = (note) => (note.split('/').at(-1).toLowerCase().includes(needle) ? 0 : 1)
  const ordered = needle ? [...source].sort((a, b) => nameHit(a) - nameHit(b)) : source
  const seen = new Set()
  const shown = []
  for (const note of ordered) {
    if (seen.has(note)) continue
    seen.add(note)
    shown.push(note)
    if (shown.length >= 50) break
  }
  const fresh = query.trim()
  const newPath = canCreate && !pasted ? newNotePath(query, defaultNoteDir(currentPath, pickerFolders()), allNotes) : null
  const rows = pasted ? [pasted] : [...shown]
  // パスを貼っても開けないときは、黙って空にせず理由を出す。
  if (!pasted && fresh.includes('/') && rows.length === 0) {
    const item = document.createElement('li')
    item.className = 'switcher-missing'
    item.textContent = `このパスのノートは「${vaultLabel}」の中に見つかりません。`
    list.replaceChildren(item)
    return
  }
  const createRow = Boolean(newPath)
  if (createRow) rows.push(newPath)
  list.replaceChildren(
    ...rows.map((note, index) => {
      const item = document.createElement('li')
      if (createRow && index === rows.length - 1) {
        const label = document.createElement('span')
        label.className = 'switcher-name'
        label.textContent = `「${fresh}」を新しく作る`
        const place = document.createElement('span')
        place.className = 'switcher-folder'
        place.textContent = newPath
        item.append(label, place)
        item.dataset.path = newPath
        item.dataset.create = 'true'
        item.setAttribute('aria-selected', String(index === 0))
        item.addEventListener('click', () => createFromSwitcher(newPath))
        return item
      }
      const parts = note.split('/')
      const name = document.createElement('span')
      name.className = 'switcher-name'
      name.textContent = parts.at(-1).replace(/\.md$/i, '')
      const folder = document.createElement('span')
      folder.className = 'switcher-folder'
      folder.textContent = parts.slice(0, -1).join('/')
      item.append(name, folder)
      item.dataset.path = note
      item.setAttribute('aria-selected', String(index === 0))
      item.addEventListener('click', () => chooseSwitcher(note))
      return item
    }),
  )
}

function chooseSwitcher(path) {
  if (!path) return
  $('switcher').close()
  if (path) openNote(path)
}

const KIND_LABEL = { previous: '保存の直前', snapshot: '定期', conflict: 'ぶつかったとき・上書きされたとき' }
let historyChoice = null
// 「履歴」を開くたび、控えを選ぶたびに上げる番号。遅れて届いた前の答え（ほかのノートの控えなど）を捨てるため。
let historyTurn = 0

async function openHistory() {
  if (!currentPath) return
  const turn = ++historyTurn
  const notePath = currentPath
  historyChoice = null
  const result = await request(`/api/backups?path=${encodeURIComponent(notePath)}`)
  if (turn !== historyTurn || notePath !== currentPath) return
  const list = $('history-list')
  historyChoice = null
  $('history-text').textContent = ''
  $('history-restore').disabled = true
  const items = result.data?.backups ?? []
  if (items.length === 0) {
    const empty = document.createElement('li')
    empty.textContent = 'このノートのバックアップはまだありません'
    list.replaceChildren(empty)
  } else {
    list.replaceChildren(
      ...items.map((backup) => {
        const item = document.createElement('li')
        item.tabIndex = 0
        const time = new Date(backup.time).toLocaleString('ja-JP')
        item.textContent = `${time}（${KIND_LABEL[backup.kind] ?? backup.kind}）`
        item.addEventListener('click', () => {
          for (const other of list.children) other.removeAttribute('aria-selected')
          item.setAttribute('aria-selected', 'true')
          historyChoice = null
          $('history-text').textContent = ''
          $('history-restore').disabled = true
          const chooseTurn = ++historyTurn
          const chosen = `/api/backup?path=${encodeURIComponent(notePath)}&id=${encodeURIComponent(backup.id)}`
          request(chosen).then(({ ok, status, data }) => {
            // 選び直した、別の「履歴」を開いた、別のノートに移った、のどれかなら、この答えは使わない。
            if (chooseTurn !== historyTurn || notePath !== currentPath || !list.contains(item)) return
            if (!ok) {
              $('history-text').textContent = status === 404
                ? 'この控えは、期限が切れたため削除されました。'
                : 'この控えを読めませんでした。'
              return
            }
            historyChoice = { path: notePath, text: data.text }
            $('history-text').textContent = data.text
            $('history-restore').disabled = !editable
          }).catch(() => {
            if (chooseTurn === historyTurn && notePath === currentPath && list.contains(item)) {
              $('history-text').textContent = 'この控えを読めませんでした。'
            }
          })
        })
        return item
      }),
    )
  }
  $('history').showModal()
}

// 「新しいノート」のボタン。最初は今のノートと同じフォルダーを選んでおく。
// フォルダーごとの設定（画像と日付ごとのノートの置き場）。置き場が決まっていなければ「今日のノート」を出さない。
let vaultSettings = null
async function loadSettings() {
  let result
  try {
    result = await request('/api/settings')
  } catch {
    return
  }
  vaultSettings = result.ok ? result.data : null
  $('today-note').hidden = !vaultSettings?.periodic
}

async function openSettings() {
  if (!canCreate) {
    showMessage('このタブでは設定を変えられません。')
    return
  }
  await loadSettings()
  if (!vaultSettings) {
    showMessage('設定を読めませんでした。')
    return
  }
  await askSettings({
    current: vaultSettings,
    notes,
    topLabel: vaultLabel || 'フォルダー',
    pickFolder: (title, selected) => askPlace({
      title,
      folders: pickerFolders(),
      selected,
      topLabel: vaultLabel || 'フォルダー',
      recent: [],
      describe: (dir) => (dir ? `選ぶ場所：${dir}/` : '一番上のフォルダーは選べません'),
      confirmLabel: 'ここにする',
    }),
    save: async (value) => {
      try {
        const result = await request('/api/settings', { method: 'PUT', body: JSON.stringify(value) })
        if (result.ok) return { ok: true, data: result.data }
        return { ok: false, message: result.data?.message ?? '保存できませんでした。' }
      } catch {
        return { ok: false, message: '保存できませんでした。' }
      }
    },
  })
  // 保存したかどうかに関わらず読み直す（保存の途中で閉じても、画面を今の設定にそろえる）。
  await loadSettings()
  drawCalendar()
}

async function newNoteFromButton() {
  if (!canCreate) {
    showMessage('このタブでは新しいノートを作れません。')
    return
  }
  newNoteIn(null)
}

// folder を渡すと、その中を最初に選んでおく。null なら今のノートと同じフォルダー。
async function newNoteIn(folder) {
  if (!canCreate) {
    showMessage('このタブでは新しいノートを作れません。')
    return
  }
  const places = pickerFolders()
  const chosen = await askNewNote({
    folders: places,
    selected: folder ?? defaultNoteDir(currentPath, places),
    topLabel: vaultLabel || 'フォルダー',
    recent: storage.get(`recent-dirs:${vaultName}`, []),
    check: (name, dir) => checkNewNote(name, dir, allNotes),
  })
  if (chosen) createFromSwitcher(chosen.path)
}

async function createFromSwitcher(path) {
  $('switcher').close()
  const created = await request(noteUrl(path), { method: 'POST' })
  if (!created.ok && created.status !== 409) {
    showMessage('ノートを作れませんでした。')
    return
  }
  // 最近ノートを作った場所として、場所選びに出す。
  const dir = path.split('/').slice(0, -1).join('/')
  storage.set(`recent-dirs:${vaultName}`, addRecentDir(storage.get(`recent-dirs:${vaultName}`, []), dir))
  await refreshNotes()
  openNote(path, { startMode: 'live' })
}


// 場所選びに出すフォルダー。ファイル欄と同じ（ノートがないフォルダーも含む）。'' は一番上。
function pickerFolders() {
  const all = new Set(['', ...folders, ...noteFolders(notes)])
  return [...all].sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }))
}

const DRAG_TYPE = 'application/x-notedock-path'
const baseName = (item) => item.split('/').pop()
const parentOf = (item) => item.split('/').slice(0, -1).join('/')
const placeLabel = (dir) => (dir ? `${dir}/` : `${vaultLabel || 'フォルダー'}（一番上）`)
const inside = (item, folder) => item === folder || item.startsWith(`${folder}/`)

function canChangeFiles() {
  if (canCreate) return true
  showMessage('このタブではファイルを変えられません。')
  return false
}

const OWN_NOTE_MESSAGE = 'このタブを開いたノート（またはそれが入っているフォルダー）は、このタブでは動かせず、ゴミ箱にも入れられません。別のノートのタブから操作してください。'

const STOPPED_MESSAGE = '開いているノートの自動保存を止めているので、そのノート（またはそれが入っているフォルダー）は動かせず、ゴミ箱にも入れられません。先に上の帯の知らせに対応するか、別のノートを開いてから、もう一度試してください。'
const TOOLARGE_MESSAGE = '開いているノートが20MBを超えていて保存できないので、そのノート（またはそれが入っているフォルダー）は動かせず、ゴミ箱にも入れられません。先に20MB以下に減らしてください。'
const UNSAVED_MESSAGE = '開いているノートをまだ保存しきれていないので、そのノート（またはそれが入っているフォルダー）は動かせず、ゴミ箱にも入れられません。日本語の変換を確定するか、少し待ってから、もう一度試してください。'

// 自動保存を止めている間に開いているノートを動かすと、未保存の入力が画面から消えるので断る。
function refuseWhileStopped(item) {
  if (!touchesStoppedNote(currentPath, item, saver?.isStopped())) return false
  showMessage(STOPPED_MESSAGE)
  return true
}

// このタブを開いたノートか、それが入っているフォルダーなら、先に断る。
function holdsTabNote(item) {
  if (!tabNote || tabNote.startsWith('__outside__/')) return false
  const a = item.normalize('NFC').toLowerCase()
  const b = tabNote.normalize('NFC').toLowerCase()
  return a === b || b.startsWith(`${a}/`)
}

// ファイル欄の行のメニュー。右クリックと「…」のボタンから開く。
function fileMenu(event, item, isFolder) {
  event.preventDefault()
  event.stopPropagation()
  const items = []
  if (isFolder) {
    items.push({ label: 'この中に新しいノート', run: () => newNoteIn(item) })
    items.push({ label: 'この中に新しいフォルダー', run: () => newFolderIn(item) })
    items.push('-')
  }
  items.push({ label: '名前を変える', run: () => renameItem(item, isFolder) })
  items.push({ label: '移動', run: () => moveWithPicker(item, isFolder) })
  items.push('-')
  items.push({ label: 'ゴミ箱に入れる', run: () => trashFileItem(item, isFolder) })
  showMenu(event, items)
}

async function newFolderIn(folder) {
  if (!canChangeFiles()) return
  const name = (await askText(`「${placeLabel(folder)}」の中に作るフォルダーの名前`))?.trim()
  if (!name) return
  if (name.includes('/') || name.startsWith('.')) {
    showMessage('フォルダーの名前に「/」は使えません。点で始まる名前も使えません。')
    return
  }
  const target = folder ? `${folder}/${name}` : name
  const created = await request(`/api/folder?path=${encodeURIComponent(target)}`, { method: 'POST' })
  if (!created.ok) {
    showMessage(created.status === 409 ? '同じ名前のフォルダーがあります。' : 'フォルダーを作れませんでした。')
    return
  }
  await refreshNotes()
  revealFolder(target)
}

async function renameItem(item, isFolder) {
  if (!canChangeFiles()) return
  if (holdsTabNote(item)) return showMessage(OWN_NOTE_MESSAGE)
  if (refuseWhileStopped(item)) return
  const current = isFolder ? baseName(item) : baseName(item).replace(/\.md$/i, '')
  const name = (await askText('新しい名前', current))?.trim()
  if (!name || name === current) return
  if (name.includes('/') || name.startsWith('.')) {
    showMessage('名前に「/」は使えません。点で始まる名前も使えません。')
    return
  }
  const dir = parentOf(item)
  const leaf = isFolder ? name : `${name.replace(/\.md$/i, '')}.md`
  moveFileItem(item, dir ? `${dir}/${leaf}` : leaf, { isFolder })
}

async function moveWithPicker(item, isFolder) {
  if (!canChangeFiles()) return
  if (holdsTabNote(item)) return showMessage(OWN_NOTE_MESSAGE)
  if (refuseWhileStopped(item)) return
  // フォルダーは、自分の中へは動かせない。
  const places = pickerFolders().filter((dir) => !(isFolder && inside(dir, item)))
  const dir = await askPlace({
    title: `「${baseName(item)}」を動かす場所`,
    folders: places,
    selected: parentOf(item),
    topLabel: vaultLabel || 'フォルダー',
    recent: storage.get(`recent-dirs:${vaultName}`, []),
    describe: (target) => `動かした先：${target ? `${target}/` : ''}${baseName(item)}`,
  })
  if (dir === null || dir === parentOf(item)) return
  moveFileItem(item, dir ? `${dir}/${baseName(item)}` : baseName(item), { isFolder })
}

// 動かしている間は、開いているノートに入力できないようにする。
function lockEditor(locked) {
  editorLocked = locked
  if (!view) return
  view.dispatch({ effects: editableSlot.reconfigure(editableExtensions(editable)) })
}

async function moveFileItem(from, to, { isFolder, fromDrag = false }) {
  if (!canChangeFiles()) return
  if (holdsTabNote(from)) return showMessage(OWN_NOTE_MESSAGE)
  if (refuseWhileStopped(from)) return
  const planned = await request(`/api/move-plan?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
  if (!planned.ok) {
    showMessage(planned.status === 404 ? '動かすものが見つかりません。' : '動かせません。')
    return
  }
  const { notes: linked, blocked } = planned.data
  const details = []
  details.push(...linkedNoteLines(linked))
  if (blocked.length) details.push(`形が違うか読めないため、書き換えられないノート：${blocked.join('、')}`)
  let rewrite = false
  const renaming = parentOf(from) === parentOf(to)
  const what = renaming ? `「${baseName(from)}」の名前を「${baseName(to)}」に変えます。` : `「${baseName(from)}」を「${to}」へ動かします。`
  const verb = renaming ? '変える' : '動かす'
  if (linked.length) {
    const choice = await askChoice(`${what}${linked.length}件のノートのリンクも書き換えますか。`, [
      { label: `書き換えずに${verb}`, value: 'keep' },
      { label: `書き換えて${verb}`, value: 'rewrite', primary: true },
    ], details)
    if (!choice) return
    rewrite = choice === 'rewrite'
  } else if ((fromDrag && isFolder) || blocked.length) {
    // フォルダーをドラッグしたときは、リンクがなくても必ず確かめる。
    const ok = await askChoice(what, [{ label: verb, value: true, primary: true }], details)
    if (!ok) return
  }
  const touchesOpen = currentPath && inside(currentPath, from)
  // 表のマスやノートの情報の欄で入力中の文字も、先に本文へ戻して保存する。
  commitOpenField()
  const flushed = await saver?.flush()
  // 確かめている間や、いま保存しきる途中で止まったときも断る。
  if (refuseWhileStopped(from)) return
  // 保存しきれないまま動かすと、新しい場所のファイルの内容で開き直し、未保存の入力が画面から消える。
  if (flushed === false && holdsPath(currentPath, from)) return showMessage($('status').dataset.state === 'toolarge' ? TOOLARGE_MESSAGE : UNSAVED_MESSAGE)
  // 動かしている間に元の場所を見張ると「消えました」と出るので、先に止める。
  if (touchesOpen) closeEvents()
  lockEditor(true)
  let moved
  // 開いているノートを動かせたら、新しいパスで開き直し終わるまで止めたままにする。
  // その間に打った分は前の保存の仕組みに入り、古いパスの下書きになってしまうため。
  let keepLocked = false
  try {
    moved = await request('/api/move', { method: 'POST', body: JSON.stringify({ from, to, rewrite }) })
    keepLocked = moved.ok && Boolean(touchesOpen)
  } finally {
    if (!keepLocked) lockEditor(false)
  }
  if (!moved.ok) {
    if (touchesOpen) connectEvents(currentPath)
    const messages = {
      409: moved.data?.error === 'opened note'
        ? 'このタブを開いたノート（またはそれが入っているフォルダー）は、このタブでは動かせません。別のノートのタブから動かしてください。'
        : '動かした先に同じ名前があります。',
      400: 'そこへは動かせません。',
      404: '動かすものか、動かした先のフォルダーが見つかりません。',
    }
    showMessage(messages[moved.status] ?? '動かせませんでした。')
    return
  }
  try {
    await afterMove(from, to, { isFolder, touchesOpen, data: moved.data })
  } finally {
    // 開き直せたときも、失敗したときも、ここで解く。
    if (keepLocked) lockEditor(false)
  }
}

// 動かせたあとの片付け。開いていたノートは、新しいパスで開き直し終わるまで待つ。
async function afterMove(from, to, { isFolder, touchesOpen, data }) {
  const { skipped = [], failed = [] } = data
  // 開き直す先は、ほかの操作で currentPath が変わる前に決めておく。
  const reopen = touchesOpen ? `${to}${currentPath.slice(from.length)}` : null
  // サーバーの下書きは履歴と一緒に移るので、localStorage の下書きも新しいパスへ移す。
  const movedKeys = draftKeyChanges(storageKeys(), draftPrefix(), from, to).move
  moveDraftKeys(from, to)
  // 移る前のパスへ送っている途中や、送る順番を待っている下書きが、あとから古いパスに下書きを作り直さないよう、消す指示を続けて送る。
  // 下書きを送るのは、localStorage に下書きを書いたノートと、開いているノートだけなので、その分だけ送る
  // （フォルダーの中のノートすべてに送ると、大きいフォルダーでは呼び出しが一度に増えるため）。
  const oldPaths = new Set(movedKeys.map(([oldKey]) => oldKey.slice(draftPrefix().length)))
  if (currentPath && inside(currentPath, from)) oldPaths.add(currentPath)
  for (const oldPath of oldPaths) {
    const newPath = `${to}${oldPath.slice(from.length)}`
    // 大文字と小文字だけの違いなら送らない。サーバーは古いパスを今のファイル名（新しいパス）に読み替えるので、移った下書きを消してしまう。
    if (oldPath.normalize('NFC').toLowerCase() === newPath.normalize('NFC').toLowerCase()) continue
    draftSync.clear(oldPath)
  }
  // 開いていたフォルダーは、新しい場所でも開いたままにする。
  filesOpen = new Set([...filesOpen].map((folder) => (inside(folder, from) ? `${to}${folder.slice(from.length)}` : folder)))
  saveFilesOpen()
  await refreshNotes()
  revealFolder(isFolder ? to : parentOf(to))
  if (reopen) await openNote(reopen, { push: false })
  if (skipped.length || failed.length) {
    showMessage(`動かしました。ただし、次のノートのリンクは書き換えていません：${[...skipped, ...failed].join('、')}`)
  }
}

async function trashFileItem(item, isFolder) {
  if (!canChangeFiles()) return
  if (holdsTabNote(item)) return showMessage(OWN_NOTE_MESSAGE)
  if (refuseWhileStopped(item)) return
  const info = await request(`/api/item?path=${encodeURIComponent(item)}`)
  if (!info.ok) {
    showMessage('見つかりません。')
    return
  }
  const message = isFolder
    ? `フォルダー「${item}」と、中のノート${info.data.notes}件${info.data.others ? `、ほかのファイル${info.data.others}件` : ''}をゴミ箱に入れます。Finderのゴミ箱から戻せます。`
    : `「${item}」をゴミ箱に入れます。Finderのゴミ箱から戻せます。`
  if (!(await askConfirm(message, 'ゴミ箱に入れる'))) return
  if (currentPath && inside(currentPath, item)) {
    commitOpenField()
    const flushed = await saver?.flush()
    if (refuseWhileStopped(item)) return
    if (flushed === false && holdsPath(currentPath, item)) return showMessage($('status').dataset.state === 'toolarge' ? TOOLARGE_MESSAGE : UNSAVED_MESSAGE)
  }
  const touchesOpen = currentPath && inside(currentPath, item)
  const openPath = touchesOpen ? currentPath : null
  // 消えたノートを見張ると「消えました」と出てしまうので、先に止める。
  if (touchesOpen) closeEvents()
  const trashed = await request(`/api/trash?path=${encodeURIComponent(item)}`, { method: 'POST' })
  if (!trashed.ok) {
    if (touchesOpen) connectEvents(currentPath)
    showMessage(trashed.status === 409
      ? 'このタブを開いたノート（またはそれが入っているフォルダー）は、このタブではゴミ箱に入れられません。'
      : trashed.status === 501
        ? 'このMacには、ゴミ箱に入れるためのコマンド（/usr/bin/trash）がありません。Finderでゴミ箱に入れてください。'
        : 'ゴミ箱に入れられませんでした。')
    return
  }
  if (touchesOpen) closeNote()
  storage.set(`recent:${vaultName}`, storage.get(`recent:${vaultName}`, []).filter((path) => !inside(path, item)))
  // 中のノートの下書きも消す。同じ名前で作った別のノートで確認が出ないように。
  // サーバーの下書きはサーバーが消しているが、ゴミ箱に入れている間に打った分や、送る途中の下書きがあとから届くので、
  // サーバーにも消す指示を送る（ノートごとのキューで、送る途中の下書きのあとに届く）。
  for (const key of trashedDraftKeys(storageKeys(), draftPrefix(), item)) drafts.remove(key.slice(draftPrefix().length))
  // localStorage に入りきらなかった下書きもあるので、開いていたノートには必ず送る。
  if (touchesOpen) draftSync.clear(openPath)
  await refreshNotes()
}

// 開いていたノートをゴミ箱に入れたあと。何も開いていない画面に戻し、一覧を出す。
function closeNote() {
  closeEvents()
  saver?.close()
  saver = null
  // 閉じたノートの、遅れて届いた下書きの応答は使わない。
  saverRequest = 0
  draftRetry = null
  currentPath = null
  editable = false
  view?.destroy()
  view = null
  $('editor').replaceChildren()
  renderBreadcrumb(null)
  $('copy-path').disabled = true
  aiContext.noteChanged(null)
  $('banner').hidden = true
  setStatus('none')
  document.title = 'Visual Editor'
  showFiles(true)
}

function closeEvents() {
  events?.close()
  events = null
}

// ファイル欄の行に、「…」のボタン、右クリックのメニュー、ドラッグを付ける。
function decorateFileRow(row, item, isFolder) {
  const more = document.createElement('span')
  more.className = 'files-more'
  more.setAttribute('role', 'button')
  more.setAttribute('aria-label', 'メニュー')
  more.title = 'メニュー'
  more.textContent = '…'
  more.addEventListener('click', (event) => fileMenu(event, item, isFolder))
  row.append(more)
  row.addEventListener('contextmenu', (event) => fileMenu(event, item, isFolder))
  row.draggable = true
  row.addEventListener('dragstart', (event) => {
    // エディターの本文では受け取れない種類で渡す。普通の文字だと、本文に場所が入ってしまう。
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ item, isFolder }))
    event.dataTransfer.effectAllowed = 'move'
  })
  // ノートの行に落としたときは、そのノートと同じフォルダーへ動かす。
  acceptDrop(row, isFolder ? item : parentOf(item))
}

// フォルダーの行（とファイル欄の空いた所）に落とすと、そこへ動かす。
function acceptDrop(target, folder) {
  target.addEventListener('dragover', (event) => {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
    event.preventDefault()
    event.stopPropagation()
    target.classList.add('files-drop')
  })
  target.addEventListener('dragleave', () => target.classList.remove('files-drop'))
  target.addEventListener('drop', (event) => {
    target.classList.remove('files-drop')
    const raw = event.dataTransfer.getData(DRAG_TYPE)
    if (!raw) return
    event.preventDefault()
    event.stopPropagation()
    const { item, isFolder } = JSON.parse(raw)
    if (parentOf(item) === folder || (isFolder && inside(folder, item))) return
    moveFileItem(item, folder ? `${folder}/${baseName(item)}` : baseName(item), { isFolder, fromDrag: true })
  })
}

function moveSwitcher(delta) {
  const items = [...$('switcher-list').children]
  if (!items.length) return
  const index = items.findIndex((item) => item.getAttribute('aria-selected') === 'true')
  const next = Math.max(0, Math.min(items.length - 1, index + delta))
  items[index]?.setAttribute('aria-selected', 'false')
  items[next].setAttribute('aria-selected', 'true')
  items[next].scrollIntoView({ block: 'nearest' })
}

// 文字を貼れる画面では、Cmd+Vは普通の貼り付けにする。
function pasteOpensNote() {
  return !currentPath || mode === 'reading' || !editable
}

// 本文をクリックしても見た目が変わらないと分からないので、貼り付けを待っていることを見せる。
function showPasteHint(show) {
  $('paste-hint').hidden = !show
  document.body.classList.toggle('paste-ready', show)
}

// 閲覧表示では文字を貼る場所がないので、Cmd+Vをコピーしたパスのノートを開く操作に使う。
function openFromPaste(event) {
  if (document.querySelector('dialog[open]')) return
  if (!pasteOpensNote()) return
  if (event.target?.closest?.('input, textarea, .cm-cell-editing, .cm-props')) return
  const text = event.clipboardData?.getData('text/plain') ?? ''
  const pasted = resolvePasted(text, rootPaths, allNotes)
  if (pasted) {
    event.preventDefault()
    openNote(pasted)
  } else if (/\.md\b/i.test(text) && text.includes('/')) {
    setStatusHint('コピーしたパスのノートが見つかりません')
  }
}

function bindChrome() {
  // ファイル欄の空いた所に落とすと、一番上へ動かす。
  acceptDrop($('files'), '')
  bindToolbar()
  document.addEventListener('paste', openFromPaste)
  document.addEventListener('click', (event) => {
    // チェックやリンクを押したときは、その操作のためなので案内を出さない。
    const onBody = event.target.closest?.('#editor') && !event.target.closest('.cm-task-box, [data-href], a')
    showPasteHint(Boolean(onBody) && pasteOpensNote())
  })
  // 案内が最後の行に重なるので、読み進めるときは消す。
  $('editor').addEventListener('scroll', () => showPasteHint(false), { capture: true, passive: true })
  window.addEventListener('blur', () => showPasteHint(false))
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') showPasteHint(false)
  })
  $('open-note').addEventListener('click', openSwitcher)
  $('new-note').addEventListener('click', newNoteFromButton)
  $('open-history').addEventListener('click', openHistory)
  $('history-close').addEventListener('click', () => $('history').close())
  $('history-restore').addEventListener('click', async () => {
    // 選んだ控えが、今開いているノートのものでなければ戻さない。
    if (historyChoice === null || !saver || historyChoice.path !== currentPath) return
    await saver.restore(historyChoice.text)
    $('history').close()
  })
  $('switcher-input').addEventListener('input', (event) => renderSwitcher(event.target.value))
  $('switcher-input').addEventListener('keydown', (event) => {
    if (event.isComposing) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveSwitcher(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveSwitcher(-1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const selected = $('switcher-list').querySelector('[aria-selected="true"]')
      if (selected?.dataset.create) createFromSwitcher(selected.dataset.path)
      else if (selected) chooseSwitcher(selected.dataset.path)
    }
  })
  for (const button of $('modes').querySelectorAll('button')) {
    button.addEventListener('click', () => applyMode(button.dataset.mode))
  }
  $('toggle-outline').addEventListener('click', () => {
    if ($('outline').hidden) {
      calendarUnderOutline = !$('calendar').hidden
      filesUnderOutline = !$('files').hidden
      $('calendar').hidden = true
      $('files').hidden = true
      $('outline').hidden = false
    } else {
      closeOutline()
    }
    renderOutline()
  })
  $('toggle-files').addEventListener('click', () => showFiles($('files').hidden))
  $('toggle-calendar').addEventListener('click', () => showCalendar($('calendar').hidden))
  $('today-note').addEventListener('click', () => openPeriodicNote('daily', todayText(), { ask: false }))
  $('open-settings').addEventListener('click', openSettings)
  // 押したら、表示を先に切り替えてから保存する（保存できなければ shareSwitch が戻す）。
  $('ai-share-on').addEventListener('click', () => {
    setShareButton(!shareButtonOn())
    shareSwitch.save()
  })
  // ほかのタブで切り替えたときにそろえる。戻ってきたとき、見えるようになったとき、60秒おき。
  // 断られた内容も、このときにもう一度送る。
  const recheckShare = () => {
    loadShare()
    aiContext.retry()
  }
  window.addEventListener('focus', recheckShare)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') recheckShare()
  })
  // タブを閉じるときは、会話に伝えた内容を消す。
  // 閉じたあとは、遅れて届いた読み直しの結果でも送り直さない。
  onPanelTeardown(() => {
    shareSwitch.close()
    return aiContext.close()
  })
  new MutationObserver(syncSide).observe($('calendar'), { attributes: true, attributeFilter: ['hidden'] })
  new MutationObserver(syncSide).observe($('files'), { attributes: true, attributeFilter: ['hidden'] })
  // 押してもカーソルを本文から動かさない。
  $('copy-path').addEventListener('mousedown', (event) => event.preventDefault())
  $('copy-path').addEventListener('click', copyNotePath)
  $('nav-back').addEventListener('click', () => goVisited(-1))
  $('nav-forward').addEventListener('click', () => goVisited(1))
  // 書式の付いたリンクは、マウスを押した時点で開く。離す前にカーソルが入ると表示が変わるため。
  $('editor').addEventListener(
    'mousedown',
    (event) => {
      if (event.button !== 0 || event.altKey || mode === 'source') return
      const link = event.target.closest?.('[data-href]')
      if (!link) return
      event.preventDefault()
      event.stopPropagation()
      openHref(link.dataset.href, event.metaKey || event.ctrlKey)
    },
    true,
  )
  $('editor').addEventListener('note-toggle-props', () => view.dispatch({ effects: togglePropsPanel.of(null) }))
  // 表のマスなどの編集が終わったら、待たせていた外からの変更を反映する。
  $('editor').addEventListener('focusout', () => setTimeout(() => saver?.compositionEnded(), 0))
  window.addEventListener('keydown', (event) => {
    hoverWithMeta = event.metaKey || event.ctrlKey
    if (askingDraft) return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
      event.preventDefault()
      openSwitcher()
    }
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'e' && !view?.hasFocus) {
      event.preventDefault()
      cycleMode()
    }
  })
  window.addEventListener('keyup', (event) => {
    hoverWithMeta = event.metaKey || event.ctrlKey
  })
  window.addEventListener('popstate', () => {
    if (askingDraft) return
    const path = new URLSearchParams(location.search).get('note')
    if (path) openNote(path, { push: false })
  })
  window.addEventListener('pagehide', () => {
    unloading = true
    saver?.close()
  })
  window.addEventListener('beforeunload', (event) => {
    unloading = true
    commitOpenField()
    // 保存も下書きもできていない内容があれば、閉じる前に確かめてもらう（出せるかはホストしだい）。
    // 欄の入力を本文に戻してから、今すぐ下書きを書いて決める。
    // keepNow は、本文が元と同じなら書けたとみなすので、状態の表示を見なくてよい。
    if (!reloadConfirmed && ($('status').dataset.state === 'toolarge' || saver?.keepNow() === false)) event.preventDefault()
    if ($('status').dataset.state === 'dirty') saver?.save()
  })
  // 戻るボタンなどでページが保存されていた状態から戻ると、保存の係はもう閉じている。下書きから開き直す。
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload()
  })
}

// 埋め込みの画面では選択してコピーする方法しか通らないことがあるので、それも用意する。
function execCopy(text) {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()
  try {
    return document.execCommand('copy')
  } finally {
    area.remove()
  }
}

// ホストのタブの「…」にあるパスのコピーは、パネルで切り替えても最初のノートのままなので、ここで今のノートのパスを渡す。
// 押した直後でないとコピーを断るブラウザがあるので、サーバーを待たずにその場で作る。
async function copyNotePath() {
  if (!currentPath) return
  if (currentPath.startsWith('__outside__/')) {
    showMessage('フォルダーの外のノートは、タブの右上の「…」からパスをコピーできます。')
    return
  }
  const full = absolutePath(rootPaths, currentPath)
  if (!full) {
    showMessage('このノートのパスを調べられませんでした。')
    return
  }
  // 表のマスなどで入力していた場所へ戻す。
  const before = document.activeElement
  if (await copyText(full, { clipboard: navigator.clipboard, execCopy })) {
    setStatusHint('コピーしました')
    // 本文は CodeMirror の focus で戻す。カーソルの位置も描き直される。
    if (view && before === view.contentDOM) view.focus()
    else if (before instanceof HTMLElement && before !== document.body && before.isConnected) before.focus()
    else view?.focus()
  } else {
    showCopyable('コピーできませんでした。選んである文字を Cmd+C でコピーしてください。', full)
  }
}

function setStatusHint(text) {
  const box = $('status-text')
  const previous = $('status').dataset.state
  box.textContent = text
  setTimeout(() => {
    if (box.textContent === text) box.textContent = statusText($('status').dataset.state ?? previous)
  }, 2500)
}

// 30日より前の下書きを片付ける（どのフォルダーの下書きも）。保存場所が使えなければ何もしない。
function removeOldDrafts() {
  try {
    const entries = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith('draft:')) entries.push([key, localStorage.getItem(key)])
    }
    for (const key of expiredDraftKeys(entries)) localStorage.removeItem(key)
  } catch {}
}

// 編集できるフォルダーごとの情報を受け取る（起動したときと、黙って切り替えるとき）。
async function loadRoot() {
  const answer = await request('/api/health')
  const health = answer.data ?? {}
  vaultName = health.rootId
  rootId = health.rootId
  rootPaths = health.rootPaths ?? []
  vaultLabel = health.root ?? ''
  filesOpen = new Set(storage.get(`files-open:${vaultName}`, []))
  return answer
}

// 会話が始まってフォルダーが届いたら、黙って編集できる状態に切り替える（読むだけ → 編集できる）。
// 開いたままのパネルで、編集できるフォルダー（rootId）が変わったときも、同じに受け取り直す。
const RECHECK_MS = 3000
let rechecking = null
function recheckFolder() {
  if (rechecking || !tabNote) return rechecking
  rechecking = (async () => {
    try {
      const where = await locateNote()
      if (where.scope !== 'inside') return
      const outside = !currentPath || currentPath.startsWith('__outside__/')
      if (!outside && where.rootId === rootId) return
      await switchFolder(where)
    } catch {
      // 確かめられなければ、今のまま。次のきっかけでまた確かめる。
    } finally {
      rechecking = null
    }
  })()
  return rechecking
}

const UNSAVED = new Set(['dirty', 'saving', 'failed', 'offline', 'elsewhere'])
// 前のフォルダーの中の相対パスを、新しいフォルダーの中の相対パスに直す。直せなければ null。
function mapPath(rel, fromRoot, toRoot) {
  if (!rel || rel.startsWith('__outside__/') || !fromRoot || !toRoot) return null
  const full = `${fromRoot.replace(/\/+$/, '')}/${rel}`
  const base = `${toRoot.replace(/\/+$/, '')}/`
  return full.startsWith(base) ? full.slice(base.length) : null
}
async function switchFolder(where) {
  const keep = view ? { head: view.state.selection.main.head, top: view.scrollDOM.scrollTop } : null
  const fromRoot = rootPaths[0]
  const before = currentPath
  // 打っている途中なら、前の rootId のまま保存を終えてから切り替える。
  let pending = saver && UNSAVED.has($('status').dataset.state) ? view.state.doc.toString() : null
  const pendingHash = saver?.baseHash?.() ?? null
  if (pending !== null) {
    await saver.flush()
    if ($('status').dataset.state === 'saved') pending = null
  }
  saver?.close()
  saver = null
  currentPath = null
  await loadRoot()
  tabNote = where.path
  await refreshNotes()
  await loadSettings()
  loadShare().catch(() => {})
  // いま開いているノートを、新しいフォルダーの中で開き直す。タブのノートから移っていたときも、同じノートに留まる。
  const mapped = mapPath(before, fromRoot, rootPaths[0])
  const target = mapped ?? where.path
  const opened = await openNote(target, { push: false, startMode: mode })
  if (!opened || !view) return
  // 書けなかった中身は、同じノートで、保存されている中身が前と同じ（ハッシュが同じ）ときだけ入れ直す。保存はハッシュの照合を通る。
  // 違うノートになった、または外から変わっていたときは入れ直さない（中身は前のノートの下書きに残っている）。
  if (pending !== null && saver && mapped !== null && saver.baseHash?.() === pendingHash && view.state.doc.toString() !== pending) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: pending } })
  }
  if (keep) {
    view.dispatch({ selection: { anchor: Math.min(keep.head, view.state.doc.length) } })
    view.scrollDOM.scrollTop = keep.top
  }
}

// 読むだけのあいだだけ、フォーカス・画面が見えたとき・キーを押したとき・時計で、軽い確かめを送る。
function watchFolder() {
  const readOnlyTab = () => Boolean(tabNote?.startsWith('__outside__/') && (!currentPath || currentPath.startsWith('__outside__/')))
  const check = () => {
    if (readOnlyTab()) void recheckFolder()
  }
  window.addEventListener('focus', check)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check()
  })
  document.addEventListener('keydown', check, true)
  setInterval(() => {
    if (document.visibilityState === 'visible') check()
  }, RECHECK_MS)
}

async function start() {
  bindChrome()
  applyMode(mode)
  const answer = await loadRoot()
  // パネルを出せると名乗らないアプリからは、サーバーがノートを読ませない。
  // パネルは出ているのに名乗っていないアプリでは、何も開けないので、理由を出して止める。
  if (answer.status === 403 && answer.data?.error === 'panel only') {
    showMessage('このアプリでは、エディターでノートを開けません。パネルを出せることを、アプリがエディターに知らせていないためです。')
    return
  }
  removeOldDrafts()
  // パネルは読み込みの直後は幅が定まらないことがあるので、幅では決めない。
  $('files').hidden = !storage.get('files-shown', true)
  await refreshNotes()
  await loadSettings()
  // 起動したときの読み直しと空の上書きは待たない（ホストが返事をしなくても、最初のノートを開くのを遅らせない）。
  loadShare().catch(() => {})
  watchShareFromOtherTabs()
  showCalendar(storage.get('calendar-shown', true), { remember: false })
  syncSide()
  const { path } = await panelNote()
  tabNote = path ?? null
  const first = firstNote({ path, inline: panelInline(), recent: storage.get(`recent:${vaultName}`, []), notes })
  if (first) await openNote(first)
  else showFiles(true)
  watchFolder()
  setInterval(() => {
    refreshNotes()
    // ほかのタブで設定を変えたときも、「今日のノート」を出すかどうかを追いつかせる。
    loadSettings()
    loadShare()
    // 断られた内容（消せなかった空の上書きも）を、フォーカスがなくても送り直す。
    aiContext.retry()
    drawCalendar().catch(() => {})
  }, 60_000)
}

window.noteEditor = { getView: () => view, getSaver: () => saver }
start()
