import { syntaxTree } from '@codemirror/language'
import { EditorSelection } from '@codemirror/state'

import { EMPTY_TABLE } from './table-model.mjs'

// ツールバーの操作。どれも今の状態から変更の内容を作るだけで、画面には触らない。

const INLINE = {
  bold: { mark: '**', node: 'StrongEmphasis' },
  italic: { mark: '*', node: 'Emphasis' },
  strike: { mark: '~~', node: 'Strikethrough' },
  code: { mark: '`', node: 'InlineCode' },
}
const LIST_MARK = /^(\s*)(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/
const QUOTE_MARK = /^(\s*)>\s?/
const HEADING_MARK = /^#{1,6}\s+/

function kindOf(text) {
  const match = text.match(LIST_MARK)
  if (!match) return null
  const mark = match[0].trim()
  if (/\[[ xX]\]$/.test(mark)) return 'task'
  return /^\d/.test(mark) ? 'number' : 'bullet'
}

// 選んでいる行。行全体を選ぶと選択の終わりが次の行の先頭に来るので、その行は含めない。
function selectedLines(state) {
  const { from, to } = state.selection.main
  const first = state.doc.lineAt(from).number
  let last = state.doc.lineAt(to).number
  if (to > from && state.doc.line(last).from === to) last -= 1
  const lines = []
  for (let n = first; n <= last; n++) lines.push(state.doc.line(n))
  return lines
}

function targetLines(state) {
  const lines = selectedLines(state)
  return lines.length > 1 ? lines.filter((line) => line.text.trim() !== '') : lines
}

function withChanges(state, list) {
  const changes = state.changes(list)
  return { changes, selection: state.selection.map(changes, 1), scrollIntoView: true }
}

export function lineKindSpec(state, kind) {
  const lines = targetLines(state)
  if (kind === 'quote') {
    const remove = lines.length > 0 && lines.every((line) => QUOTE_MARK.test(line.text))
    return withChanges(
      state,
      lines.map((line) => {
        if (!remove) return { from: line.from, insert: '> ' }
        return { from: line.from, to: line.from + line.text.match(QUOTE_MARK)[0].length, insert: line.text.match(QUOTE_MARK)[1] }
      }),
    )
  }
  const remove = lines.length > 0 && lines.every((line) => kindOf(line.text) === kind)
  let number = 1
  if (kind === 'number' && lines[0]?.number > 1) {
    const before = state.doc.line(lines[0].number - 1).text.match(/^\s*(\d+)[.)]\s/)
    if (before) number = Number(before[1]) + 1
  }
  return withChanges(
    state,
    lines.map((line) => {
      const match = line.text.match(LIST_MARK)
      const indent = match ? match[1] : ''
      const length = match ? match[0].length : 0
      let mark = ''
      if (!remove) {
        if (kind === 'bullet') mark = '- '
        if (kind === 'task') mark = '- [ ] '
        if (kind === 'number') {
          mark = `${number}. `
          number += 1
        }
      }
      return { from: line.from, to: line.from + length, insert: indent + mark }
    }),
  )
}

export function headingSpec(state, level) {
  return withChanges(
    state,
    targetLines(state).map((line) => {
      const current = line.text.match(HEADING_MARK)
      return { from: line.from, to: line.from + (current ? current[0].length : 0), insert: level ? `${'#'.repeat(level)} ` : '' }
    }),
  )
}

function inlineNodeAt(state, kind, from, to) {
  const name = INLINE[kind].node
  let node = syntaxTree(state).resolveInner(from, 1)
  while (node) {
    if (node.name === name && node.from <= from && node.to >= to) return node
    node = node.parent
  }
  return null
}

export function inlineSpec(state, kind) {
  const { mark } = INLINE[kind]
  const { from, to } = state.selection.main
  const found = inlineNodeAt(state, kind, from, to)
  if (found?.firstChild && found.lastChild && found.firstChild.from !== found.lastChild.from) {
    const open = found.firstChild
    const close = found.lastChild
    const openLength = open.to - open.from
    const clamp = (pos) => Math.min(Math.max(pos, open.to), close.from) - openLength
    return {
      changes: [
        { from: open.from, to: open.to },
        { from: close.from, to: close.to },
      ],
      selection: EditorSelection.range(clamp(from), clamp(to)),
      scrollIntoView: true,
    }
  }
  return {
    changes: [
      { from, insert: mark },
      { from: to, insert: mark },
    ],
    selection: EditorSelection.range(from + mark.length, to + mark.length),
    scrollIntoView: true,
  }
}

// 前の文章のすぐ下に置くと見出しや続きの文に化けるので、空の行を挟む。
function blockInsertion(state) {
  const line = state.doc.lineAt(state.selection.main.to)
  let prefix = ''
  if (line.text.trim() !== '') prefix = '\n\n'
  else if (line.number > 1 && state.doc.line(line.number - 1).text.trim() !== '') prefix = '\n'
  return { at: line.to, prefix }
}

export function horizontalRuleSpec(state) {
  const { at, prefix } = blockInsertion(state)
  const insert = `${prefix}---\n`
  return { changes: { from: at, insert }, selection: { anchor: at + insert.length }, scrollIntoView: true }
}

// 表はカーソルを外に置いて表の形で見せ、1つ目のマスの編集を呼び出し側で始める。
export function tableSpec(state) {
  const { at, prefix } = blockInsertion(state)
  const insert = `${prefix}${EMPTY_TABLE}\n`
  return {
    from: at + prefix.length,
    spec: { changes: { from: at, insert }, selection: { anchor: at + insert.length }, scrollIntoView: true },
  }
}

export function codeBlockSpec(state) {
  const lines = selectedLines(state)
  const from = lines[0].from
  const to = lines.at(-1).to
  const body = state.sliceDoc(from, to)
  const insert = `\`\`\`\n${body}\n\`\`\``
  const anchor = body === '' ? from + 4 : from + insert.length
  return { changes: { from, to, insert }, selection: { anchor }, scrollIntoView: true }
}

export function calloutSpec(state, kind) {
  const lines = selectedLines(state)
  const from = lines[0].from
  const to = lines.at(-1).to
  const body = lines.map((line) => `> ${line.text}`.trimEnd() || '>').join('\n')
  const text = state.sliceDoc(from, to)
  const insert = `> [!${kind}]\n${text === '' ? '> ' : body}`
  return { changes: { from, to, insert }, selection: { anchor: from + insert.length }, scrollIntoView: true }
}

// 行き先を打つ場所にカーソルを置くと、ノートの候補を出せる。
export function linkSpec(state, label) {
  const { from, to } = state.selection.main
  const insert = `[${label.replace(/\n+/g, ' ').replace(/(?<!\\)\]/g, '\\]')}]()`
  return { changes: { from, to, insert }, selection: { anchor: from + insert.length - 1 }, scrollIntoView: true }
}

export function currentFormat(state) {
  const { from, to } = state.selection.main
  const text = state.doc.lineAt(from).text
  const heading = text.match(HEADING_MARK)
  const inline = new Set()
  for (const kind of Object.keys(INLINE)) {
    if (inlineNodeAt(state, kind, from, to)) inline.add(kind)
  }
  return {
    heading: heading ? heading[0].trim().length : 0,
    line: kindOf(text),
    quote: QUOTE_MARK.test(text),
    inline,
  }
}
