import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'

import { completionKeys } from '../src/ime-keys.mjs'
import { isItemLineStart, listTextStarts, mergeWidths } from '../src/list-indent.mjs'
import { noteMarkdown } from '../src/markdown-ext.mjs'

function starts(doc) {
  const state = EditorState.create({ doc, extensions: [noteMarkdown()] })
  ensureSyntaxTree(state, state.doc.length, 5000)
  // 行の番号（1から）と、本文の始まりまでの文字数で返す。
  return listTextStarts(state).filter((item) => !item.empty).map(({ line, text }) => [state.doc.lineAt(line).number, text - line])
}

test('折り返しをそろえる位置は、記号とそのあとの空白のあと', () => {
  assert.deepEqual(starts('- あ\n* い\n+ う'), [[1, 2], [2, 2], [3, 2]])
})

test('タブやスペースで入れ子にした項目も、字下げと記号のあと', () => {
  assert.deepEqual(starts('- 親\n\t- 子\n\t\t- 孫\n    - 空白4つ'), [[1, 2], [2, 3], [3, 4], [4, 6]])
})

test('チェック項目は、チェック欄とそのあとの空白のあと', () => {
  assert.deepEqual(starts('- [ ] やる\n\t- [x] やった'), [[1, 6], [2, 7]])
})

test('番号付きは、番号と区切りのあと', () => {
  assert.deepEqual(starts('1. あ\n2. い\n10. う\n\n1) え'), [[1, 3], [2, 3], [3, 4], [5, 3]])
})

test('本文のない項目は empty として返す（行のすき間だけ付け、幅は測らない）', () => {
  const state = EditorState.create({ doc: '- \n- あ', extensions: [noteMarkdown()] })
  ensureSyntaxTree(state, state.doc.length, 5000)
  assert.deepEqual(listTextStarts(state).map((item) => item.empty), [true, false])
})

test('本文のない項目、段落、コードの中は数えない', () => {
  const doc = '- \n\n段落 - です\n\n```\n- コード\n```'
  assert.deepEqual(starts(doc), [])
})

test('引用の中の項目は、引用の記号と箇条書きの記号のあと', () => {
  assert.deepEqual(starts('> - 引用\n> \t- 入れ子'), [[1, 4], [2, 5]])
})

test('字下げの囲みは行の始まりから記号の前まで（引用の記号も含める）。縦の線は空白で始まる行だけ', () => {
  const state = EditorState.create({ doc: '- 親\n\t- あ\n\n> - 引用\n> \t- い', extensions: [noteMarkdown()] })
  ensureSyntaxTree(state, state.doc.length, 5000)
  const spans = listTextStarts(state).filter((item) => !item.empty).map(({ line, guide, mark }) => [mark - line, guide])
  assert.deepEqual(spans, [[0, false], [1, true], [2, false], [3, false]])
})

test('候補を出すキーに Ctrl+Space を使わない（Mac の入力ソースの切り替えとぶつかるため）', () => {
  assert.equal(completionKeys.some((binding) => binding.key === 'Ctrl-Space' || binding.mac === 'Ctrl-Space'), false)
  assert.ok(completionKeys.some((binding) => binding.key === 'Enter'))
})

test('測った幅の重ね方：画面の外の行は残し、測れなかった行は消し、揺れて固定した行は変えない', () => {
  const a = { hang: 20, indent: 0 }
  const b = { hang: 30, indent: 10 }
  const current = new Map([[0, a], [10, a], [20, a]])
  assert.equal(mergeWidths(current, new Map([[0, a]])), null)
  assert.deepEqual([...mergeWidths(current, new Map([[0, b]]))], [[0, b], [10, a], [20, a]])
  assert.deepEqual([...mergeWidths(current, new Map(), new Set([10]))], [[0, a], [20, a]])
  assert.equal(mergeWidths(current, new Map([[20, b]]), new Set(), new Set([20])), null)
})

test('項目の行の頭で Tab や Enter を打っても、測った幅を項目の行の頭へ移せる', () => {
  const start = EditorState.create({ doc: '前\n- 項目' })
  const line = 2
  // 行の頭で Tab：手前に寄せると Tab の前（項目の行の頭）に残る。
  const tab = start.update({ changes: { from: line, insert: '\t' } })
  const pick = (tr) => [tr.changes.mapPos(line, -1), tr.changes.mapPos(line, 1)].find((at) => isItemLineStart(tr.state.doc, at))
  assert.equal(pick(tab), 2)
  // 行の頭で Enter：手前は空の行になるので、後ろに寄せた位置（項目が移った行の頭）を使う。
  const enter = start.update({ changes: { from: line, insert: '\n' } })
  assert.equal(pick(enter), 3)
  assert.equal(isItemLineStart(enter.state.doc, 2), false)
})
