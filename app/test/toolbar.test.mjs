import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EditorSelection, EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'

import { noteMarkdown } from '../src/markdown-ext.mjs'
import { nextCell } from '../src/table-model.mjs'
import { calloutSpec, codeBlockSpec, currentFormat, headingSpec, horizontalRuleSpec, inlineSpec, lineKindSpec, linkSpec, tableSpec } from '../src/toolbar.mjs'

function make(doc, from = doc.length, to = from) {
  const state = EditorState.create({ doc, selection: EditorSelection.single(from, to), extensions: [noteMarkdown()] })
  ensureSyntaxTree(state, state.doc.length, 5000)
  return state
}
const apply = (state, spec) => {
  const next = state.update(spec).state
  ensureSyntaxTree(next, next.doc.length, 5000)
  return next
}
const text = (state) => state.doc.toString()

test('箇条書きは付けて、もう一度で外す', () => {
  let state = make('項目')
  state = apply(state, lineKindSpec(state, 'bullet'))
  assert.equal(text(state), '- 項目')
  state = apply(state, lineKindSpec(state, 'bullet'))
  assert.equal(text(state), '項目')
})

test('空の行に付けるとカーソルは記号のあとへ行く', () => {
  const state = make('')
  const next = apply(state, lineKindSpec(state, 'task'))
  assert.equal(text(next), '- [ ] ')
  assert.equal(next.selection.main.head, 6)
})

test('複数の行を選ぶと行ごとに付き、空の行はそのまま', () => {
  const doc = 'あ\n\nい\nう'
  const state = make(doc, 0, doc.length)
  assert.equal(text(apply(state, lineKindSpec(state, 'bullet'))), '- あ\n\n- い\n- う')
  assert.equal(text(apply(state, lineKindSpec(state, 'number'))), '1. あ\n\n2. い\n3. う')
})

test('行の全体を選んだときは、次の行に付けない', () => {
  const doc = 'あ\nい'
  const state = make(doc, 0, 2)
  assert.equal(text(apply(state, lineKindSpec(state, 'bullet'))), '- あ\nい')
})

test('種類を変えると記号を置き換え、字下げは保つ', () => {
  const state = make('  - 項目')
  assert.equal(text(apply(state, lineKindSpec(state, 'number'))), '  1. 項目')
  assert.equal(text(apply(state, lineKindSpec(state, 'task'))), '  - [ ] 項目')
  const checked = make('- [x] 項目')
  assert.equal(text(apply(checked, lineKindSpec(checked, 'bullet'))), '- 項目')
})

test('前の行が番号付きなら続きの番号にする', () => {
  const state = make('1. あ\n2. い\nう')
  assert.equal(text(apply(state, lineKindSpec(state, 'number'))), '1. あ\n2. い\n3. う')
})

test('引用は付けて外せる', () => {
  let state = make('あ')
  state = apply(state, lineKindSpec(state, 'quote'))
  assert.equal(text(state), '> あ')
  state = apply(state, lineKindSpec(state, 'quote'))
  assert.equal(text(state), 'あ')
})

test('見出しは段階を変えられ、本文に戻せる', () => {
  let state = make('題名')
  state = apply(state, headingSpec(state, 2))
  assert.equal(text(state), '## 題名')
  state = apply(state, headingSpec(state, 1))
  assert.equal(text(state), '# 題名')
  state = apply(state, headingSpec(state, 0))
  assert.equal(text(state), '題名')
})

test('太字は選んだ文字に付け、もう一度で外す', () => {
  let state = make('前 太字 後', 2, 4)
  state = apply(state, inlineSpec(state, 'bold'))
  assert.equal(text(state), '前 **太字** 後')
  assert.equal(state.sliceDoc(state.selection.main.from, state.selection.main.to), '太字')
  state = apply(state, inlineSpec(state, 'bold'))
  assert.equal(text(state), '前 太字 後')
  assert.equal(state.sliceDoc(state.selection.main.from, state.selection.main.to), '太字')
})

test('太字の中にカーソルがあるときは、打った記号でも外せる', () => {
  const doc = '前 __太字__ 後'
  const state = make(doc, doc.indexOf('字'))
  assert.equal(text(apply(state, inlineSpec(state, 'bold'))), '前 太字 後')
})

test('選んでいないときは記号の間にカーソルを置く', () => {
  const state = make('あ')
  const next = apply(state, inlineSpec(state, 'strike'))
  assert.equal(text(next), 'あ~~~~')
  assert.equal(next.selection.main.head, 3)
})

test('斜体と取り消し線とコードも付け外しできる', () => {
  for (const [kind, mark] of [['italic', '*'], ['strike', '~~'], ['code', '`']]) {
    let state = make('語', 0, 1)
    state = apply(state, inlineSpec(state, kind))
    assert.equal(text(state), `${mark}語${mark}`, kind)
    state = apply(state, inlineSpec(state, kind))
    assert.equal(text(state), '語', kind)
  }
})

test('表と区切り線は前の文章とくっつけない', () => {
  const state = make('文章')
  assert.ok(text(apply(state, horizontalRuleSpec(state))).startsWith('文章\n\n---\n'))
  const blank = make('文章\n')
  assert.ok(text(apply(blank, horizontalRuleSpec(blank))).startsWith('文章\n\n---\n'), '次の行が空でも見出しに化けない')
  const empty = make('')
  assert.equal(text(apply(empty, horizontalRuleSpec(empty))), '---\n')
  const { spec, from } = tableSpec(state)
  const table = apply(state, spec)
  assert.equal(from, 4)
  assert.equal(table.sliceDoc(from, from + 1), '|')
  assert.ok(table.selection.main.head > from + 10, 'カーソルを表の外に置く')
})

test('コードのまとまりは選んだ行を囲む', () => {
  const state = make('あ\nい', 0, 3)
  assert.equal(text(apply(state, codeBlockSpec(state))), '```\nあ\nい\n```')
  const empty = make('')
  const next = apply(empty, codeBlockSpec(empty))
  assert.equal(text(next), '```\n\n```')
  assert.equal(next.selection.main.head, 4)
})

test('色付きの囲みは選んだ行を入れる', () => {
  const state = make('あ\nい', 0, 3)
  assert.equal(text(apply(state, calloutSpec(state, 'WARNING'))), '> [!WARNING]\n> あ\n> い')
  const empty = make('')
  const next = apply(empty, calloutSpec(empty, 'NOTE'))
  assert.equal(text(next), '> [!NOTE]\n> ')
  assert.equal(next.selection.main.head, next.doc.length)
})

test('リンクは文字を残して、行き先の場所にカーソルを置く', () => {
  const state = make('前 語 後', 2, 3)
  const next = apply(state, linkSpec(state, '語'))
  assert.equal(text(next), '前 [語]() 後')
  assert.equal(next.selection.main.head, next.doc.toString().indexOf(')'))
  assert.equal(linkSpec(make('前'), '語').changes.insert, '[語]()')
  assert.equal(linkSpec(make('前'), 'a]b\nc').changes.insert, '[a\\]b c]()', '記法を崩す文字を入れない')
})

test('今の書式を読み取る', () => {
  assert.equal(currentFormat(make('## 題')).heading, 2)
  assert.equal(currentFormat(make('- 項目')).line, 'bullet')
  assert.equal(currentFormat(make('- [ ] 項目')).line, 'task')
  assert.equal(currentFormat(make('3. 項目')).line, 'number')
  assert.equal(currentFormat(make('> 引用')).quote, true)
  const bold = '前 **太字** 後'
  assert.equal(currentFormat(make(bold, bold.indexOf('字'))).inline.has('bold'), true)
  assert.equal(currentFormat(make(bold, 0)).inline.has('bold'), false)
})

test('表のマスを順に移動する', () => {
  const source = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |'
  assert.deepEqual(nextCell(source, 0, 0, 1), { row: 0, col: 1 })
  assert.deepEqual(nextCell(source, 0, 1, 1), { row: 2, col: 0 }, '見出しの次は区切りを飛ばす')
  assert.deepEqual(nextCell(source, 2, 1, 1), { row: 3, col: 0 })
  assert.deepEqual(nextCell(source, 3, 1, 1), { row: 4, col: 0, add: true }, '最後のマスの次は行を足す')
  assert.deepEqual(nextCell(source, 2, 0, -1), { row: 0, col: 1 }, '戻るときも区切りを飛ばす')
  assert.deepEqual(nextCell(source, 0, 0, -1), { row: 0, col: 0 }, '先頭より前には行かない')
})
