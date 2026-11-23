import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'

import { noteMarkdown } from '../src/markdown-ext.mjs'
import { buildDecorations, firstBodyLine, noteContext } from '../src/preview.mjs'

function make(doc) {
  const state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [noteMarkdown(), noteContext.of({ path: 'a.md', known: new Set() })] })
  ensureSyntaxTree(state, state.doc.length, 5000)
  return state
}

// 見出しの行ごとに、行の番号と、最初の見出しの印が付いているか。
function headings(doc) {
  const state = make(doc)
  const found = []
  buildDecorations(state, { mode: 'reading' }).between(0, state.doc.length, (from, _to, deco) => {
    const cls = deco.spec.class ?? ''
    if (cls.includes('cm-heading')) found.push([state.doc.lineAt(from).number, cls.includes('cm-heading-first')])
  })
  return found
}

test('1行目の見出しだけ、上の余白を付けない印が付く', () => {
  assert.deepEqual(headings('# 一\n\n本文\n\n## 二'), [[1, true], [5, false]])
})

test('frontmatter のあとの最初の見出しも同じ（空行は飛ばす）', () => {
  assert.equal(firstBodyLine(make('---\ntitle: x\n---\n\n# 一')), 5)
  assert.deepEqual(headings('---\ntitle: x\n---\n# 一\n## 二'), [[4, true], [5, false]])
})

test('最初の行が見出しでなければ、どの見出しにも印は付かない', () => {
  assert.deepEqual(headings('本文\n# 一'), [[2, false]])
})

test('下線で書く見出し（Setext）にも付く', () => {
  assert.deepEqual(headings('一\n===\n\n本文'), [[1, true], [2, true]])
})

// 見出しの行ごとに、閲覧の表示で上を広げる印（段落・コード・表・箇条書きのすぐあと）が付いているか。
function spaced(doc) {
  const state = make(doc)
  const found = []
  buildDecorations(state, { mode: 'reading' }).between(0, state.doc.length, (from, _to, deco) => {
    const cls = deco.spec.class ?? ''
    if (cls.includes('cm-heading')) found.push([state.doc.lineAt(from).number, cls.includes('cm-heading-spaced')])
  })
  return found
}

test('段落・コード・箇条書きのすぐあとの見出しだけ、閲覧の表示で上を広げる印が付く', () => {
  assert.deepEqual(spaced('# 一\n本文\n\n## 二\n### 三\n\n- 項目\n\n## 四\n\n```\nx\n```\n## 五\n\n---\n## 六'),
    [[1, false], [4, true], [5, false], [9, true], [14, true], [17, false]])
})
