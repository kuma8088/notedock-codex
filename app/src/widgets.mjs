import { EditorView, WidgetType } from '@codemirror/view'

import { askText, showMessage } from './dialogs.mjs'
import { isExternal, resolveHref, wikiLinkOf } from './links.mjs'
import {
  addColumn,
  addRow,
  deleteColumn,
  deleteRow,
  moveColumn,
  moveRow,
  nextCell,
  parseTable,
  replaceCell,
  setAlign,
  sortRows,
} from './table-model.mjs'
import { deleteProperty, parseFrontmatter, renameProperty, setProperty } from './yaml-lite.mjs'

const CALLOUT_LABEL = {
  note: ['ℹ', 'Note'],
  tip: ['💡', 'Tip'],
  important: ['❗', 'Important'],
  warning: ['⚠', 'Warning'],
  caution: ['🛑', 'Caution'],
}
const INLINE_RULES = [
  { re: /`([^`]+)`/, make: (m) => element('code', {}, [m[1]]) },
  { re: /\*\*([^*]+)\*\*|__([^_]+)__/, make: (m, r) => element('strong', {}, r(m[1] ?? m[2])) },
  { re: /\*([^*]+)\*|(?<![\w])_([^_]+)_(?![\w])/, make: (m, r) => element('em', {}, r(m[1] ?? m[2])) },
  { re: /~~([^~]+)~~/, make: (m, r) => element('s', {}, r(m[1])) },
  { re: /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/, make: (m, r, ctx) => imageElement(m[2], m[1], ctx) },
  {
    re: /(?<![!\\])\[\[([^[\]\n]+)\]\](?!\()/,
    make: (m, r, ctx) => {
      const link = wikiLinkOf(m[1], ctx)
      return link ? wikiElement(link) : m[0]
    },
  },
  {
    re: /\[([^\]]+)\]\(([^)\s]+)[^)]*\)/,
    make: (m, r) => element('a', { class: 'cm-link', 'data-href': m[2] }, r(m[1])),
  },
  {
    re: /https?:\/\/[^\s<>)]+/,
    make: (m) => element('a', { class: 'cm-link cm-link-external', 'data-href': m[0] }, [m[0]]),
  },
]

function element(tag, attrs = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
  for (const child of children) node.append(child)
  return node
}

export function assetUrl(ctx, href) {
  if (isExternal(href)) return /^https?:/i.test(href) ? href : null
  const target = resolveHref(ctx.path, href, ctx.rootPaths)
  return target ? `/api/file?path=${encodeURIComponent(target.path)}` : null
}

function wikiElement({ label, href, missing }) {
  const missingClass = missing ? ' cm-link-missing' : ''
  if (href === null) return element('span', { class: `cm-link${missingClass}`, title: 'このファイルはエディターでは開けません' }, [label])
  return element('a', { class: `cm-link${missingClass}`, 'data-href': href }, [label])
}

// 画像の読み込み方。ふだんは src に入れるだけ。Codexのパネル（src/panel.mjs）は、これを差し替えて、
// フォルダーの中の画像を data: の形にしてから入れる。パネルの通信の制限では、/api/file を読み込めないため。
// src に入れてからあとで差し替える形だと、差し替える前にブラウザーが読み込みを始めることがあり、
// 制限に止められて「画像を開けません」になる（貼り付けた直後の画像で起きた）。
let loadImage = (image, url) => {
  image.src = url
}
export function setImageLoader(loader) {
  loadImage = loader
}

function imageElement(href, alt, ctx) {
  const url = assetUrl(ctx, href)
  if (!url) return element('span', { class: 'cm-image-missing' }, [alt || href])
  const image = element('img', { alt, class: 'cm-image', loading: 'lazy', referrerpolicy: 'no-referrer' })
  // 外側の要素は替えず、中身だけを替える。外側を替えると、エディターが知らせの文を本文の入力と読み、
  // ノートに書き込んでしまう。
  const box = element('span', { class: 'cm-image-box' }, [image])
  image.addEventListener('error', () => {
    box.replaceChildren(element('span', { class: 'cm-image-missing' }, [`画像を開けません: ${alt || href}`]))
  })
  loadImage(image, url)
  return box
}

export function renderInline(text, ctx) {
  const render = (value) => {
    let best = null
    for (const rule of INLINE_RULES) {
      const match = rule.re.exec(value)
      if (match && (!best || match.index < best.match.index)) best = { match, rule }
    }
    if (!best) return [value.replace(/\\\|/g, '|')]
    const { match, rule } = best
    const before = value.slice(0, match.index)
    const after = value.slice(match.index + match[0].length)
    return [
      ...(before ? render(before) : []),
      rule.make(match, render, ctx),
      ...(after ? render(after) : []),
    ]
  }
  return render(text)
}

export class WikiLinkWidget extends WidgetType {
  constructor(link) {
    super()
    this.link = link
  }
  eq(other) {
    return other.link.label === this.link.label && other.link.href === this.link.href && other.link.missing === this.link.missing
  }
  toDOM() {
    return wikiElement(this.link)
  }
  // Alt+クリックでカーソルを入れられるよう、エディターにも渡す。リンクを開く処理は先に動く。
  ignoreEvent() {
    return false
  }
}

export class BulletWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    return element('span', { class: 'cm-bullet', 'aria-hidden': 'true' }, ['•'])
  }
}

export class LineBreakWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    return element('br')
  }
}

export class HiddenBlockWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    return element('div', { class: 'cm-hidden-block' })
  }
  get estimatedHeight() {
    return 0
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(checked, pos, readOnly = false) {
    super()
    this.checked = checked
    this.pos = pos
    this.readOnly = readOnly
  }
  eq(other) {
    return other.checked === this.checked && other.readOnly === this.readOnly
  }
  toDOM(view) {
    const box = element('input', { type: 'checkbox', class: 'cm-task-box', 'aria-label': 'チェック項目' })
    box.checked = this.checked
    box.disabled = this.readOnly
    box.addEventListener('mousedown', (event) => event.preventDefault())
    box.addEventListener('click', (event) => {
      event.preventDefault()
      const pos = view.posAtDOM(box)
      const text = view.state.doc.sliceString(pos, pos + 3)
      if (!/^\[[ xX]\]$/.test(text)) return
      view.dispatch({ changes: { from: pos, to: pos + 3, insert: /x/i.test(text) ? '[ ]' : '[x]' } })
    })
    return box
  }
  ignoreEvent() {
    return true
  }
}

export class CalloutTitleWidget extends WidgetType {
  constructor(kind) {
    super()
    this.kind = kind
  }
  eq(other) {
    return other.kind === this.kind
  }
  toDOM() {
    const [icon, label] = CALLOUT_LABEL[this.kind]
    return element('span', { class: 'cm-callout-title' }, [`${icon} ${label}`])
  }
}

export class ImageWidget extends WidgetType {
  constructor(href, alt, ctx) {
    super()
    this.href = href
    this.alt = alt
    this.ctx = ctx
  }
  eq(other) {
    return other.href === this.href && other.alt === this.alt && other.ctx.path === this.ctx.path
  }
  toDOM(view) {
    const node = imageElement(this.href, this.alt, this.ctx)
    node.querySelector('img')?.addEventListener('load', () => view.requestMeasure())
    return node
  }
  get estimatedHeight() {
    return 120
  }
  ignoreEvent(event) {
    return event.type !== 'mousedown'
  }
}

export class MathWidget extends WidgetType {
  constructor(source, block) {
    super()
    this.source = source
    this.block = block
  }
  eq(other) {
    return other.source === this.source && other.block === this.block
  }
  toDOM(view) {
    const node = element(this.block ? 'div' : 'span', { class: this.block ? 'cm-math-block' : 'cm-math' }, [this.source])
    import('katex')
      .then(({ default: katex }) => {
        katex.render(this.source, node, { displayMode: this.block, throwOnError: false, trust: false, strict: 'ignore' })
        view.requestMeasure()
      })
      .catch(() => {})
    return node
  }
  ignoreEvent() {
    return false
  }
}

let mermaidCounter = 0
const mermaidCache = new Map()

async function renderMermaid(source) {
  if (mermaidCache.has(source)) return mermaidCache.get(source)
  const [{ default: mermaid }, { default: DOMPurify }] = await Promise.all([import('mermaid'), import('dompurify')])
  const dark = matchMedia('(prefers-color-scheme: dark)').matches
  // 描けなかったときのエラーの絵（Syntax error in text）は Mermaid に描かせない。エディターが図の枠の中に理由を書く。
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: dark ? 'dark' : 'default', htmlLabels: false, flowchart: { htmlLabels: false } })
  mermaidCounter += 1
  const id = `note-mermaid-${mermaidCounter}`
  let svg
  try {
    ;({ svg } = await mermaid.render(id, source))
  } finally {
    // 描くために Mermaid がページに足した一時的な要素を、うまくいかなかったときも残さない。
    for (const leftover of [document.getElementById(`d${id}`), document.getElementById(id)]) {
      if (leftover && !leftover.closest('.cm-mermaid')) leftover.remove()
    }
  }
  // 図に書いたリンク（click や link）は残さない。Codexアプリでは、押すとアプリの中のブラウザーで外のページが開くため。
  // a は、同じ属性（箱の位置を決める transform など）を持つ g に置き換える。a を外すだけだと、箱の位置がずれる。
  // そのあと、図の中の印（#…）を指すもの以外の href を消す。
  const fragment = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['foreignObject'],
    RETURN_DOM_FRAGMENT: true,
  })
  for (const link of fragment.querySelectorAll('a')) {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    for (const attr of link.attributes) {
      if (attr.localName !== 'href' && attr.localName !== 'target') group.setAttribute(attr.name, attr.value)
    }
    group.append(...link.childNodes)
    link.replaceWith(group)
  }
  for (const node of fragment.querySelectorAll('*')) {
    for (const attr of [...node.attributes]) {
      if (attr.localName === 'href' && !attr.value.startsWith('#')) node.removeAttributeNode(attr)
    }
  }
  const box = document.createElement('div')
  box.append(fragment)
  const clean = box.innerHTML
  mermaidCache.set(source, clean)
  return clean
}

export class MermaidWidget extends WidgetType {
  constructor(source) {
    super()
    this.source = source
  }
  eq(other) {
    return other.source === this.source
  }
  toDOM(view) {
    const node = element('div', { class: 'cm-mermaid' }, ['図を描いています…'])
    renderMermaid(this.source)
      .then((svg) => {
        node.innerHTML = svg
        view.requestMeasure()
      })
      .catch((error) => {
        node.replaceChildren(element('pre', { class: 'cm-mermaid-error' }, [`図を描けません: ${error.message}\n\n${this.source}`]))
        view.requestMeasure()
      })
    return node
  }
  get estimatedHeight() {
    return 200
  }
  ignoreEvent() {
    return false
  }
}

// 置き換える前に、その場所の文字が部品を作ったときのままか確かめる。違えば書き換えない。
function replaceAt(view, from, source, next) {
  if (view.state.doc.sliceString(from, from + source.length) !== source) {
    showMessage('内容が変わったので、この操作は行いませんでした。もう一度やり直してください。')
    return false
  }
  if (source !== next) view.dispatch({ changes: { from, to: from + source.length, insert: next } })
  return true
}

function replaceBlock(view, node, source, next) {
  if (!view.contentDOM.contains(node)) {
    showMessage('内容が変わったので、この操作は行いませんでした。もう一度やり直してください。')
    return false
  }
  return replaceAt(view, view.posAtDOM(node), source, next)
}

const menuHost = { current: null }

function closeMenu() {
  menuHost.current?.remove()
  menuHost.current = null
  document.removeEventListener('keydown', closeOnEscape, true)
}

function closeOnEscape(event) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  closeMenu()
}

export function showMenu(event, items) {
  closeMenu()
  const menu = element('div', { class: 'note-menu', role: 'menu' })
  // 押してもエディターのカーソルと選択を保つ。
  menu.addEventListener('mousedown', (e) => e.preventDefault())
  for (const item of items) {
    if (item === '-') {
      menu.append(element('hr'))
      continue
    }
    const button = element('button', { type: 'button', role: 'menuitem' }, [item.label])
    button.addEventListener('click', () => {
      closeMenu()
      item.run()
    })
    menu.append(button)
  }
  menu.style.left = `${event.clientX}px`
  menu.style.top = `${event.clientY}px`
  document.body.append(menu)
  menuHost.current = menu
  document.addEventListener('keydown', closeOnEscape, true)
  const rect = menu.getBoundingClientRect()
  if (rect.bottom > innerHeight) menu.style.top = `${Math.max(4, innerHeight - rect.height - 4)}px`
  if (rect.right > innerWidth) menu.style.left = `${Math.max(4, innerWidth - rect.width - 4)}px`
  setTimeout(() => document.addEventListener('mousedown', function onDown(e) {
    if (!menu.contains(e.target)) {
      closeMenu()
      document.removeEventListener('mousedown', onDown)
    }
  }), 0)
}

function tableWrapAt(view, from) {
  for (const wrap of view.contentDOM.querySelectorAll('.cm-table-wrap')) {
    if (view.posAtDOM(wrap) === from) return wrap
  }
  return null
}

// 位置を手がかりにマスを探して編集を始める。書き戻すと表が作り直されるので、前の要素は使えない。
export function beginTableCell(view, from, row, col) {
  const cell = tableWrapAt(view, from)?.querySelector(`[data-row="${row}"][data-col="${col}"]`)
  if (!cell) return false
  cell.dispatchEvent(new CustomEvent('note-cell-begin'))
  return true
}

// 「＋」を押したとき。編集中のマスを書き戻してから、今の表に行や列を足して、新しいマスを開く。
function growTable(view, wrap, grow) {
  if (!view.contentDOM.contains(wrap)) return
  const from = view.posAtDOM(wrap)
  document.activeElement?.closest?.('.cm-cell-editing')?.blur()
  const current = tableWrapAt(view, from)
  if (!current) return
  const { next, row, col } = grow(current.noteSource)
  if (replaceAt(view, from, current.noteSource, next)) beginTableCell(view, from, row, col)
}

function growButton(view, wrap, className, label, grow) {
  const button = element('button', { type: 'button', class: `cm-table-add ${className}`, title: label, 'aria-label': label, tabindex: '-1' }, ['＋'])
  button.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  button.addEventListener('click', () => growTable(view, wrap, grow))
  return button
}

export class TableWidget extends WidgetType {
  constructor(source, ctx, readOnly) {
    super()
    this.source = source
    this.ctx = ctx
    this.readOnly = readOnly
  }
  eq(other) {
    return other.source === this.source && other.readOnly === this.readOnly && other.ctx.path === this.ctx.path
  }
  toDOM(view) {
    const { rows, align } = parseTable(this.source)
    // 読むだけ（閲覧の表示など）では「＋」のボタンを置かないので、その分の場所も取らない（cm-table-locked）。
    const wrap = element('div', { class: this.readOnly ? 'cm-table-wrap cm-table-locked' : 'cm-table-wrap' })
    wrap.noteSource = this.source
    const table = element('table', { class: 'cm-table' })
    const make = (row, rowIndex, tag) => {
      const tr = element('tr')
      const count = Math.max(align.length, row.cells.length)
      for (let col = 0; col < count; col++) {
        const raw = row.cells[col]?.text ?? ''
        const cell = element(tag, { 'data-row': String(rowIndex), 'data-col': String(col), ...(align[col] ? { style: `text-align:${align[col]}` } : {}) })
        cell.append(...renderInline(raw, this.ctx))
        if (!this.readOnly) this.bindCell(view, wrap, cell, rowIndex, col, raw)
        tr.append(cell)
      }
      return tr
    }
    const head = element('thead')
    if (rows[0]) head.append(make(rows[0], 0, 'th'))
    const body = element('tbody')
    rows.slice(2).forEach((row, index) => body.append(make(row, index + 2, 'td')))
    table.append(head, body)
    const scroller = element('div', { class: 'cm-table-scroll' })
    scroller.append(table)
    wrap.append(scroller)
    if (!this.readOnly) {
      wrap.append(
        growButton(view, wrap, 'cm-table-add-col', '右に列を追加', (source) => {
          const parsed = parseTable(source)
          const count = Math.max(parsed.align.length, parsed.rows[0]?.cells.length ?? 0)
          return { next: addColumn(source, count - 1, true), row: 0, col: count }
        }),
        growButton(view, wrap, 'cm-table-add-row', '下に行を追加', (source) => {
          const { rows } = parseTable(source)
          return { next: addRow(source, rows.length - 2, true), row: rows.length, col: 0 }
        }),
      )
    }
    return wrap
  }
  bindCell(view, wrap, cell, rowIndex, col, raw) {
    cell.setAttribute('tabindex', '0')
    const begin = () => {
      if (cell.isContentEditable) return
      cell.contentEditable = 'plaintext-only'
      cell.textContent = raw
      cell.classList.add('cm-cell-editing')
      cell.focus()
      const range = document.createRange()
      range.selectNodeContents(cell)
      range.collapse(false)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
    }
    // 変更して書き戻したら、書き戻したあとの表の文字を返す。
    const commit = (cancel = false) => {
      if (!cell.isContentEditable) return null
      const text = cell.textContent
      cell.contentEditable = 'false'
      cell.classList.remove('cm-cell-editing')
      if (cancel || text.trim() === raw.trim()) {
        cell.replaceChildren(...renderInline(raw, this.ctx))
        return null
      }
      const next = replaceCell(this.source, rowIndex, col, text)
      return replaceBlock(view, wrap, this.source, next) ? next : false
    }
    cell.addEventListener('note-cell-begin', begin)
    // 今のマスを書き戻してから、次のマスの編集を始める。
    const moveTo = (delta) => {
      if (!view.contentDOM.contains(wrap)) return
      const from = view.posAtDOM(wrap)
      let source = this.source
      const changed = commit()
      if (changed === false) return
      if (changed !== null) source = changed
      const target = delta === 'down'
        ? { row: rowIndex === 0 ? 2 : rowIndex + 1, col }
        : nextCell(source, rowIndex, col, delta)
      if (target.add) {
        const next = addRow(source, rowIndex - 1, true)
        if (!replaceAt(view, from, source, next)) return
      }
      if (!beginTableCell(view, from, target.row, target.col)) {
        // 下に行がないときは、表のすぐ後ろへカーソルを出す。
        const after = Math.min(view.state.doc.length, from + source.length + 1)
        view.dispatch({ selection: { anchor: after }, scrollIntoView: true })
        view.focus()
      }
    }
    let composing = false
    cell.addEventListener('compositionstart', () => { composing = true })
    cell.addEventListener('compositionend', () => { composing = false })
    cell.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      if (event.target.closest?.('a[data-href]') && !cell.isContentEditable) return
      event.stopPropagation()
      if (!cell.isContentEditable) {
        event.preventDefault()
        // 編集中のマスを書き戻すと、同じ表は作り直される。そのときは新しい表の同じマスを開く。
        const from = view.posAtDOM(wrap)
        const open = document.activeElement?.closest?.('.cm-cell-editing')
        open?.blur()
        if (view.contentDOM.contains(wrap)) begin()
        else beginTableCell(view, from, rowIndex, col)
      }
    })
    cell.addEventListener('blur', () => commit())
    cell.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (composing || event.isComposing) return
      if (!cell.isContentEditable) {
        if (event.key === 'Enter') {
          event.preventDefault()
          begin()
        }
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        commit(true)
        view.focus()
      } else if (event.key === 'Enter') {
        event.preventDefault()
        moveTo('down')
      } else if (event.key === 'Tab') {
        event.preventDefault()
        moveTo(event.shiftKey ? -1 : 1)
      }
    })
    cell.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      if (!view.contentDOM.contains(wrap)) return
      // 書き戻すと部品が作り直されるので、メニューの操作は場所と文字で確かめて行う。
      const from = view.posAtDOM(wrap)
      const changed = commit()
      if (changed === false) return
      const s = changed ?? this.source
      const run = (fn) => () => replaceAt(view, from, s, fn())
      const isBody = rowIndex >= 2
      const bodyIndex = isBody ? rowIndex - 1 : 0
      showMenu(event, [
        { label: '上に行を追加', run: run(() => addRow(s, Math.max(bodyIndex, 1), false)) },
        { label: '下に行を追加', run: run(() => addRow(s, bodyIndex, true)) },
        ...(isBody
          ? [
              { label: 'この行を上へ', run: run(() => moveRow(s, bodyIndex, -1)) },
              { label: 'この行を下へ', run: run(() => moveRow(s, bodyIndex, 1)) },
              { label: 'この行を削除', run: run(() => deleteRow(s, bodyIndex)) },
            ]
          : []),
        '-',
        { label: '左に列を追加', run: run(() => addColumn(s, col, false)) },
        { label: '右に列を追加', run: run(() => addColumn(s, col, true)) },
        { label: 'この列を左へ', run: run(() => moveColumn(s, col, -1)) },
        { label: 'この列を右へ', run: run(() => moveColumn(s, col, 1)) },
        { label: 'この列を削除', run: run(() => deleteColumn(s, col)) },
        '-',
        { label: '左寄せ', run: run(() => setAlign(s, col, 'left')) },
        { label: '中央寄せ', run: run(() => setAlign(s, col, 'center')) },
        { label: '右寄せ', run: run(() => setAlign(s, col, 'right')) },
        { label: 'この列で昇順に並べ替え', run: run(() => sortRows(s, col, false)) },
        { label: 'この列で降順に並べ替え', run: run(() => sortRows(s, col, true)) },
      ])
    })
  }
  get estimatedHeight() {
    return 28 * (this.source.split('\n').length - 1)
  }
  ignoreEvent() {
    return true
  }
  ignoreMutation() {
    return true
  }
}

export class FrontmatterWidget extends WidgetType {
  constructor(source, open, pos) {
    super()
    this.source = source
    this.open = open
    this.pos = pos
  }
  eq(other) {
    return other.source === this.source && other.open === this.open
  }
  toDOM(view) {
    const { items, simple } = parseFrontmatter(this.source)
    const wrap = element('div', { class: 'cm-props' })
    const head = element('button', { type: 'button', class: 'cm-props-head' }, [
      `${this.open ? '▾' : '▸'} ノートの情報（${items.length}）`,
    ])
    head.addEventListener('click', () => view.dom.dispatchEvent(new CustomEvent('note-toggle-props', { bubbles: true })))
    wrap.append(head)
    if (!this.open) return wrap
    const apply = (next) => replaceBlock(view, wrap, this.source, next)
    const editable = view.state.facet(EditorView.editable)
    if (!simple) {
      wrap.append(element('p', { class: 'cm-props-note' }, ['入れ子などがあるので、文字のまま編集します。']))
    }
    items.forEach((item, index) => wrap.append(this.row(view, item, index, simple && editable, apply)))
    if (simple && editable) {
      const add = element('button', { type: 'button', class: 'cm-props-add' }, ['＋ 項目を追加'])
      add.addEventListener('click', async () => {
        const name = await askText('追加する項目の名前')
        if (name?.trim()) apply(setProperty(this.source, name.trim(), ''))
      })
      wrap.append(add)
    }
    const source = element('button', { type: 'button', class: 'cm-props-source' }, ['文字で編集'])
    source.addEventListener('click', () => {
      const pos = view.posAtDOM(wrap)
      view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, pos + 4) } })
      view.focus()
    })
    wrap.append(source)
    return wrap
  }
  row(view, item, index, editable, apply) {
    const row = element('div', { class: 'cm-props-row' })
    const name = element('input', { class: 'cm-props-key', value: item.key, 'aria-label': '項目の名前' })
    name.disabled = !editable
    name.addEventListener('change', () => apply(renameProperty(this.source, item.key, name.value)))
    row.append(name, this.valueInput(item, editable, apply))
    if (editable) {
      const remove = element('button', { type: 'button', class: 'cm-props-del', 'aria-label': '項目を削除' }, ['×'])
      remove.addEventListener('click', () => apply(deleteProperty(this.source, item.key)))
      row.append(remove)
    }
    for (const input of row.querySelectorAll('input')) {
      input.addEventListener('keydown', (event) => {
        event.stopPropagation()
        // 日本語の変換を確定するEnterは、ブラウザーに任せる。
        if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || input.type === 'checkbox') return
        // Enterでは反映するだけにして、カーソルを同じ欄に残す。
        // 反映はブラウザーの change に任せる。こちらから change を送ると、反映の途中で
        // まだカーソルのある欄が作り直されて外れ、ブラウザーがもう一度 change を出してしまう。
        // 欄からいったん外すと、変わっていたときだけブラウザーが change を1回出す。
        // 反映するとこの部品は作り直されるので、新しい部品の同じ欄へカーソルを戻す。
        event.preventDefault()
        const field = input === name ? 'key' : 'value'
        if (input.isConnected) input.blur()
        if (input.isConnected) {
          input.focus()
          return
        }
        const next = view.contentDOM.querySelectorAll('.cm-props .cm-props-row')[index]
        const target = next?.querySelector(field === 'key' ? '.cm-props-key' : '.cm-props-value')
        if (!target) return
        target.focus()
        try {
          target.setSelectionRange(target.value.length, target.value.length)
        } catch {
          // 日付や数の欄は、カーソルの位置を決められない。
        }
      })
    }
    return row
  }
  valueInput(item, editable, apply) {
    let input
    // 書き込めなかったときは false を返す。
    const commit = (value) => {
      if (JSON.stringify(value) === JSON.stringify(item.value)) return true
      return apply(setProperty(this.source, item.key, value))
    }
    if (item.type === 'checkbox') {
      input = element('input', { type: 'checkbox', class: 'cm-props-value', 'aria-label': item.key })
      input.checked = item.value === 'true'
      input.addEventListener('change', () => commit(String(input.checked)))
    } else if (item.type === 'list' || item.type === 'tags') {
      input = element('input', { class: 'cm-props-value', value: item.value.join(', '), 'aria-label': item.key, title: 'カンマで区切ります' })
      input.addEventListener('change', () => commit(input.value.split(',').map((v) => v.trim()).filter(Boolean)))
    } else {
      const type = { number: 'number', date: 'date', datetime: 'datetime-local' }[item.type] ?? 'text'
      const value = item.type === 'datetime' ? item.value.replace(' ', 'T') : item.value
      input = element('input', { type, class: 'cm-props-value', value, 'aria-label': item.key })
      if (type === 'number') input.setAttribute('step', 'any')
      if (type === 'text') {
        input.addEventListener('change', () => commit(input.value))
      } else {
        // 日付・日時・数の欄は、1文字打つたびや矢印を押すたびにブラウザーが change を出す。
        // そのつど書き込むと部品が作り直されてカーソルが外れ、年の1文字目で日付が変わってしまう。
        // 欄を出たとき（Enterも欄からいったん外す）にだけ書き込む。
        // 表示したときの値から変わっていなければ書かない（日時の空白区切りや秒を勝手に変えない）。
        // 途中まで消した不完全な日付のときも書かない（元の日付を空にしない）。
        // キーを押さずに値が変わったとき（カレンダーで選んだときなど）は、すぐ書き込む。
        // 欄を出るきっかけがないことがあり、待つと書き込まれないまま残る。
        // カーソルの位置では見分けられない（日付の欄は、月から日へ移る瞬間にカーソルが欄の外に見える）。
        // 書き込むと部品が作り直され、カーソルのある古い欄が外れる。そのときブラウザーは、外す前に
        // もう一度 blur を出す（isConnected はまだ true）。書いた値を shown に入れておき、
        // その blur では「変わっていない」として何もしない。
        let shown = input.value
        let typing = false
        const save = () => {
          typing = false
          if (!input.isConnected || input.validity.badInput || input.value === shown) return
          const next = item.type === 'datetime' && item.value.includes(' ') ? input.value.replace('T', ' ') : input.value
          const before = shown
          shown = input.value
          if (commit(next) === false) shown = before
        }
        input.addEventListener('keydown', () => { typing = true })
        input.addEventListener('mousedown', () => { typing = false })
        input.addEventListener('blur', save)
        input.addEventListener('change', () => {
          if (typing) typing = false
          else save()
        })
      }
    }
    input.disabled = !editable
    return input
  }
  get estimatedHeight() {
    return this.open ? 200 : 30
  }
  ignoreEvent() {
    return true
  }
  ignoreMutation() {
    return true
  }
}
