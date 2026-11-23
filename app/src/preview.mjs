import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { Facet, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'

import { isExternal, normalizeKey, resolveHref, wikiLinkOf } from './links.mjs'
import {
  BulletWidget,
  CalloutTitleWidget,
  CheckboxWidget,
  FrontmatterWidget,
  HiddenBlockWidget,
  ImageWidget,
  LineBreakWidget,
  MathWidget,
  MermaidWidget,
  TableWidget,
  WikiLinkWidget,
} from './widgets.mjs'

export const setMode = StateEffect.define()
export const setComposing = StateEffect.define()
export const togglePropsPanel = StateEffect.define()
export const noteContext = Facet.define({
  combine: (values) => values[0] ?? { path: 'note.md', known: null, api: null, rootPaths: [] },
})

// Obsidianのハイライトの6色。
const HIGHLIGHT_COLORS = [['🔴', 'red'], ['🟠', 'orange'], ['🟡', 'yellow'], ['🟢', 'green'], ['🔵', 'blue'], ['🟣', 'purple']]


export const CALLOUT_KINDS = ['note', 'tip', 'important', 'warning', 'caution']
const CALLOUT_LINE = /^\s*>\s*\[!(note|tip|important|warning|caution)\]\s*$/i
const INLINE_HTML = { u: 'cm-html-u', s: 'cm-strike', kbd: 'cm-html-kbd', sub: 'cm-html-sub', sup: 'cm-html-sup', mark: 'cm-html-mark' }
const HIDE = Decoration.replace({})

function selectionToucher(state, mode) {
  if (mode === 'reading') return { touches: () => false, lineTouched: () => false }
  const ranges = state.selection.ranges
  return {
    touches: (from, to) => ranges.some((r) => r.from <= to && r.to >= from),
    lineTouched: (from, to = from) => {
      const start = state.doc.lineAt(from).from
      const end = state.doc.lineAt(to).to
      return ranges.some((r) => r.from <= end && r.to >= start)
    },
  }
}

export function findCallouts(state) {
  const found = []
  const tree = ensureSyntaxTree(state, state.doc.length, 500) ?? syntaxTree(state)
  tree.iterate({
    enter(node) {
      if (node.name === 'Frontmatter' || node.name === 'FencedCode') return false
      if (node.name !== 'Blockquote') return undefined
      if (node.node.parent?.name === 'Document') {
        const match = state.doc.lineAt(node.from).text.match(CALLOUT_LINE)
        if (match) found.push({ from: node.from, to: node.to, kind: match[1].toLowerCase() })
      }
      return undefined
    },
  })
  return found
}

function hideRange(add, from, to) {
  if (to > from) add(from, to, HIDE)
}

function eachLine(state, from, to, fn) {
  let line = state.doc.lineAt(from)
  for (;;) {
    fn(line)
    if (line.to >= to || line.number >= state.doc.lines) break
    line = state.doc.line(line.number + 1)
  }
}

export function buildDecorations(state, { mode = 'live', propsOpen = false } = {}) {
  if (mode === 'source') return Decoration.none
  const ctx = state.facet(noteContext)
  const { touches, lineTouched } = selectionToucher(state, mode)
  const reading = mode === 'reading'
  const locked = reading || state.readOnly
  const checksLocked = ctx.editable === false
  const ranges = []
  const add = (from, to, deco) => ranges.push(deco.range(from, to))
  const addLine = (pos, cls) => {
    const at = state.doc.lineAt(pos).from
    ranges.push(Decoration.line({ class: cls }).range(at))
  }
  const doc = state.doc
  const tree = ensureSyntaxTree(state, doc.length, 500) ?? syntaxTree(state)
  const calloutFor = new Map(findCallouts(state).map((c) => [c.from, c]))

  const blockSpan = (from, to) => ({ from: doc.lineAt(from).from, to: doc.lineAt(to).to })
  const linkClass = (href) => {
    if (isExternal(href)) return 'cm-link cm-link-external'
    const target = resolveHref(ctx.path, href, ctx.rootPaths)
    const missing = !target || (ctx.known && !/\.[a-z0-9]+$/i.test(target.path) ? true : ctx.known && target.path.endsWith('.md') && !ctx.known.has(normalizeKey(target.path)))
    return missing && target?.path !== ctx.path ? 'cm-link cm-link-missing' : 'cm-link'
  }

  // ノートの最初の行（frontmatter があればその後、空行は飛ばす）。そこにある見出しには上の余白を付けない
  // （Obsidian の閲覧表示でも、先頭の要素の上の余白は 0）。
  const firstLine = firstBodyLine(state, tree)
  // 段落・コード・表・箇条書きのすぐあとの見出しには、閲覧の表示で上の余白を広げる印を付ける
  // （Obsidian の .markdown-rendered :is(p,pre,table,ul,ol) + :is(h1..h6) { margin-top: var(--heading-spacing) }）。
  const AFTER_BLOCK = new Set(['Paragraph', 'FencedCode', 'CodeBlock', 'Table', 'BulletList', 'OrderedList'])
  const headingClass = (node, level) => {
    let cls = `cm-heading cm-h${level}`
    if (doc.lineAt(node.from).number === firstLine) cls += ' cm-heading-first'
    else if (AFTER_BLOCK.has(node.node.prevSibling?.name)) cls += ' cm-heading-spaced'
    return cls
  }

  tree.iterate({
    enter(node) {
      const { name, from, to } = node
      switch (name) {
        case 'Frontmatter': {
          if (touches(from, to)) {
            eachLine(state, from, to, (line) => addLine(line.from, 'cm-frontmatter-line'))
            return false
          }
          const text = doc.sliceString(from, to)
          add(from, to, Decoration.replace({ widget: new FrontmatterWidget(text, propsOpen, from), block: true }))
          return false
        }
        case 'ATXHeading1':
        case 'ATXHeading2':
        case 'ATXHeading3':
        case 'ATXHeading4':
        case 'ATXHeading5':
        case 'ATXHeading6':
          addLine(from, headingClass(node, name.slice(-1)))
          return undefined
        case 'SetextHeading1':
        case 'SetextHeading2':
          // 見出しの文字の行と下線の行に、同じ印を付ける（最初の見出しかは、見出しの始まりの行で決める）。
          eachLine(state, from, to, (line) => addLine(line.from, headingClass(node, name.slice(-1))))
          return undefined
        case 'HeaderMark': {
          if (lineTouched(from)) return undefined
          const next = doc.sliceString(to, to + 1)
          hideRange(add, from, next === ' ' ? to + 1 : to)
          return undefined
        }
        case 'Emphasis':
          add(from, to, Decoration.mark({ class: 'cm-em' }))
          return undefined
        case 'StrongEmphasis':
          add(from, to, Decoration.mark({ class: 'cm-strong' }))
          return undefined
        case 'Strikethrough':
          add(from, to, Decoration.mark({ class: 'cm-strike' }))
          return undefined
        case 'Highlight': {
          // 「==🔴文字==」のように最初に色の絵文字があれば、その色にする。絵文字は書いている行でだけ見せる。
          const inner = doc.sliceString(from + 2, Math.min(to - 2, from + 6))
          const color = HIGHLIGHT_COLORS.find(([emoji]) => inner.startsWith(emoji))
          add(from, to, Decoration.mark({ class: color ? `cm-highlight cm-highlight-${color[1]}` : 'cm-highlight' }))
          if (color && !touches(from, to)) hideRange(add, from + 2, from + 2 + color[0].length)
          return undefined
        }
        case 'Tag':
          // リンクの文字の中の # は、Obsidianと同じくタグとして見せない。
          if (node.node.parent?.name !== 'Link') add(from, to, Decoration.mark({ class: 'cm-tag', attributes: { title: doc.sliceString(from, to) } }))
          return false
        case 'ObsidianComment':
          // Obsidianと同じく、閲覧では見せない。編集中は薄く見せる。
          if (reading) hideRange(add, from, to)
          else add(from, to, Decoration.mark({ class: 'cm-comment' }))
          return false
        case 'ObsidianCommentBlock': {
          const span = blockSpan(from, to)
          if (reading) add(span.from, span.to, Decoration.replace({ widget: new HiddenBlockWidget(), block: true }))
          else eachLine(state, span.from, span.to, (line) => addLine(line.from, 'cm-comment-line'))
          return false
        }
        case 'InlineCode':
          add(from, to, Decoration.mark({ class: 'cm-inline-code' }))
          return undefined
        case 'EmphasisMark':
        case 'HighlightMark':
        case 'StrikethroughMark': {
          const parent = node.node.parent
          if (!touches(parent.from, parent.to)) hideRange(add, from, to)
          else add(from, to, Decoration.mark({ class: 'cm-mark' }))
          return undefined
        }
        case 'CodeMark': {
          const parent = node.node.parent
          if (parent.name === 'InlineCode') {
            if (!touches(parent.from, parent.to)) hideRange(add, from, to)
            else add(from, to, Decoration.mark({ class: 'cm-mark' }))
          }
          return undefined
        }
        case 'Escape':
          if (!touches(from, to)) hideRange(add, from, from + 1)
          return undefined
        case 'Link': {
          const marks = node.node.getChildren('LinkMark')
          const url = node.node.getChild('URL')
          if (!url || marks.length < 2) return undefined
          const href = doc.sliceString(url.from, url.to)
          const textFrom = marks[0].to
          const textTo = marks[1].from
          if (touches(from, to)) {
            add(url.from, url.to, Decoration.mark({ class: 'cm-url' }))
            return undefined
          }
          hideRange(add, from, textFrom)
          hideRange(add, textTo, to)
          if (textTo > textFrom) {
            add(textFrom, textTo, Decoration.mark({ class: linkClass(href), attributes: { 'data-href': href } }))
          }
          return undefined
        }
        case 'WikiLink': {
          if (touches(from, to)) {
            add(from, to, Decoration.mark({ class: 'cm-url' }))
            return false
          }
          add(from, to, Decoration.replace({ widget: new WikiLinkWidget(wikiLinkOf(doc.sliceString(from + 2, to - 2), ctx)) }))
          return false
        }
        case 'Image': {
          const url = node.node.getChild('URL')
          if (!url || touches(from, to)) return false
          const href = doc.sliceString(url.from, url.to)
          const marks = node.node.getChildren('LinkMark')
          const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : ''
          add(from, to, Decoration.replace({ widget: new ImageWidget(href, alt, ctx) }))
          return false
        }
        case 'Autolink': {
          const url = node.node.getChild('URL')
          if (!url) return undefined
          const href = doc.sliceString(url.from, url.to)
          if (!touches(from, to)) {
            hideRange(add, from, url.from)
            hideRange(add, url.to, to)
          }
          add(url.from, url.to, Decoration.mark({ class: 'cm-link cm-link-external', attributes: { 'data-href': href } }))
          return false
        }
        case 'URL': {
          const parent = node.node.parent?.name
          if (parent === 'Link' || parent === 'Image' || parent === 'Autolink' || parent === 'LinkReference') return undefined
          const href = doc.sliceString(from, to)
          add(from, to, Decoration.mark({ class: 'cm-link cm-link-external', attributes: { 'data-href': href } }))
          return undefined
        }
        case 'Blockquote': {
          const callout = calloutFor.get(from)
          eachLine(state, from, to, (line) => {
            if (!callout) {
              addLine(line.from, 'cm-quote')
              return
            }
            const first = line.from === doc.lineAt(from).from
            const last = line.to >= to
            addLine(
              line.from,
              `cm-callout cm-callout-${callout.kind}${first ? ' cm-callout-first' : ''}${last ? ' cm-callout-last' : ''}`,
            )
          })
          if (callout && !lineTouched(from)) {
            const line = doc.lineAt(from)
            add(line.from, line.to, Decoration.replace({ widget: new CalloutTitleWidget(callout.kind) }))
          }
          return undefined
        }
        case 'QuoteMark': {
          if (lineTouched(from)) return undefined
          const line = doc.lineAt(from)
          const callout = [...calloutFor.values()].find((c) => c.from === line.from)
          if (callout) return undefined
          hideRange(add, from, doc.sliceString(to, to + 1) === ' ' ? to + 1 : to)
          return undefined
        }
        case 'ListMark': {
          const item = node.node.parent
          const task = item?.getChild('Task')
          const marker = task?.getChild('TaskMarker')
          if (marker) {
            if (!touches(from, marker.to)) hideRange(add, from, marker.from)
            return undefined
          }
          if (item?.parent?.name === 'BulletList') {
            if (!lineTouched(from)) add(from, to, Decoration.replace({ widget: new BulletWidget() }))
          } else {
            add(from, to, Decoration.mark({ class: 'cm-list-number' }))
          }
          return undefined
        }
        case 'TaskMarker': {
          const checked = /x/i.test(doc.sliceString(from, to))
          const parent = node.node.parent
          if (checked && parent) {
            const textFrom = Math.min(to + 1, parent.to)
            if (parent.to > textFrom) add(textFrom, parent.to, Decoration.mark({ class: 'cm-task-done' }))
          }
          if (!touches(from, to)) {
            add(from, to, Decoration.replace({ widget: new CheckboxWidget(checked, from, checksLocked) }))
          }
          return undefined
        }
        case 'HorizontalRule':
          if (!lineTouched(from)) {
            addLine(from, 'cm-hr')
            hideRange(add, from, to)
          }
          return false
        case 'FencedCode': {
          const span = blockSpan(from, to)
          const info = node.node.getChild('CodeInfo')
          const lang = info ? doc.sliceString(info.from, info.to).trim().toLowerCase() : ''
          if (lang === 'mermaid' && !touches(span.from, span.to) && !ctx.isTooltip) {
            const text = node.node.getChild('CodeText')
            const source = text ? doc.sliceString(text.from, text.to) : ''
            add(span.from, span.to, Decoration.replace({ widget: new MermaidWidget(source), block: true }))
            return false
          }
          const open = touches(span.from, span.to)
          const firstLine = doc.lineAt(span.from).number
          const lastLine = doc.lineAt(span.to).number
          eachLine(state, span.from, span.to, (line) => {
            let cls = 'cm-codeblock'
            if (line.number === firstLine) cls += ' cm-codeblock-first'
            if (line.number === lastLine) cls += ' cm-codeblock-last'
            addLine(line.from, cls)
            if (!open && (line.number === firstLine || (line.number === lastLine && lastLine !== firstLine))) {
              hideRange(add, line.from, line.to)
            }
          })
          return false
        }
        case 'CodeBlock':
          eachLine(state, from, to, (line) => addLine(line.from, 'cm-codeblock'))
          return false
        case 'Table': {
          const span = blockSpan(from, to)
          if (touches(span.from, span.to)) {
            eachLine(state, span.from, span.to, (line) => addLine(line.from, 'cm-table-source'))
            return false
          }
          // 引用や箇条書きの中の表は、行頭の記号を表の操作で壊さないよう文字のまま見せる。
          if (node.node.parent?.name !== 'Document') {
            eachLine(state, span.from, span.to, (line) => addLine(line.from, 'cm-table-source'))
            return undefined
          }
          const widget = new TableWidget(doc.sliceString(span.from, span.to), ctx, locked)
          add(span.from, span.to, Decoration.replace({ widget, block: true }))
          return false
        }
        case 'MathBlock': {
          const span = blockSpan(from, to)
          if (touches(span.from, span.to)) return false
          const source = doc.sliceString(from, to).trim().replace(/^\$\$/, '').replace(/\$\$$/, '')
          add(span.from, span.to, Decoration.replace({ widget: new MathWidget(source, true), block: true }))
          return false
        }
        case 'InlineMath': {
          if (touches(from, to)) return false
          add(from, to, Decoration.replace({ widget: new MathWidget(doc.sliceString(from + 1, to - 1), false) }))
          return false
        }
        case 'Comment':
          if (reading) hideRange(add, from, to)
          else add(from, to, Decoration.mark({ class: 'cm-comment' }))
          return false
        case 'CommentBlock': {
          const span = blockSpan(from, to)
          if (reading) add(span.from, span.to, Decoration.replace({ widget: new HiddenBlockWidget(), block: true }))
          else eachLine(state, span.from, span.to, (line) => addLine(line.from, 'cm-comment-line'))
          return false
        }
        case 'HTMLTag':
          decorateInlineHtml(node, doc, touches, add)
          return false
        case 'HTMLBlock':
          eachLine(state, from, to, (line) => addLine(line.from, 'cm-html-block'))
          return false
        default:
          return undefined
      }
    },
  })

  addIndentGuides(state, add)
  return Decoration.set(ranges, true)
}

// 本文の最初の行の番号。frontmatter があればその次の行から、空行を飛ばして数える。本文がなければ 0。
export function firstBodyLine(state, tree = syntaxTree(state)) {
  const doc = state.doc
  const front = tree.topNode.firstChild
  let n = front?.name === 'Frontmatter' ? doc.lineAt(Math.max(front.from, front.to - 1)).number + 1 : 1
  while (n <= doc.lines && doc.line(n).text.trim() === '') n++
  return n <= doc.lines ? n : 0
}

function decorateInlineHtml(node, doc, touches, add) {
  const text = doc.sliceString(node.from, node.to)
  if (/^<br\s*\/?>$/i.test(text)) {
    if (!touches(node.from, node.to)) add(node.from, node.to, Decoration.replace({ widget: new LineBreakWidget() }))
    return
  }
  const open = text.match(/^<([a-z]+)(\s[^>]*)?>$/i)
  if (!open) return
  const cls = INLINE_HTML[open[1].toLowerCase()]
  if (!cls) return
  const closing = `</${open[1].toLowerCase()}>`
  const line = doc.lineAt(node.from)
  const rest = doc.sliceString(node.to, line.to)
  const at = rest.toLowerCase().indexOf(closing)
  if (at < 0) return
  const closeFrom = node.to + at
  const closeTo = closeFrom + closing.length
  if (touches(node.from, closeTo)) return
  hideRange(add, node.from, node.to)
  hideRange(add, closeFrom, closeTo)
  if (closeFrom > node.to) add(node.to, closeFrom, Decoration.mark({ class: cls }))
}

function addIndentGuides(state, add) {
  const lines = state.doc.lines
  if (lines > 20000) return
  for (let n = 1; n <= lines; n++) {
    const line = state.doc.line(n)
    const match = line.text.match(/^([\t ]+)(?:[-*+]|\d+[.)])\s/)
    if (match) add(line.from, line.from + match[1].length, Decoration.mark({ class: 'cm-indent-guide' }))
  }
}

export const previewField = StateField.define({
  create(state) {
    return { deco: buildDecorations(state, { mode: 'live' }), mode: 'live', composing: false, propsOpen: false }
  },
  update(value, tr) {
    let { mode, composing, propsOpen } = value
    let changed = false
    for (const effect of tr.effects) {
      if (effect.is(setMode)) {
        mode = effect.value
        changed = true
      } else if (effect.is(setComposing)) {
        composing = effect.value
        changed = true
      } else if (effect.is(togglePropsPanel)) {
        propsOpen = effect.value ?? !propsOpen
        changed = true
      }
    }
    // 日本語の変換中は表示を切り替えない。変換が終わってからまとめて直す。
    if (composing) return { ...value, composing, mode, propsOpen, deco: value.deco.map(tr.changes) }
    if (changed || tr.docChanged || tr.selection) {
      return { deco: buildDecorations(tr.state, { mode, propsOpen }), mode, composing, propsOpen }
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
})

export function hiddenRanges(state) {
  const set = state.field(previewField).deco
  const hidden = []
  set.between(0, state.doc.length, (from, to, deco) => {
    if (deco.spec.widget === undefined && to > from && deco.point) hidden.push(state.doc.sliceString(from, to))
  })
  return hidden
}
