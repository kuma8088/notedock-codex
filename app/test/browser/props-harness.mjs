// ノートの情報の欄だけを動かす試験用のページ。test/browser/props-enter-check.py が組み立てて使う。
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { noteMarkdown } from '../../src/markdown-ext.mjs'
import { noteContext, previewField, togglePropsPanel } from '../../src/preview.mjs'

const doc = '---\ntitle: はじめ\ntags: a, b\ndate: 2026-01-02\nwhen: 2026-01-02 10:00\ncount: 3\n---\n\n本文の行\n'
window.log = []
const view = new EditorView({
  parent: document.getElementById('ed'),
  state: EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [noteMarkdown(), noteContext.of({ path: 'a.md', known: new Set() }), previewField],
  }),
})
view.dom.addEventListener('note-toggle-props', () => view.dispatch({ effects: togglePropsPanel.of(null) }))
view.dispatch({ effects: togglePropsPanel.of(true) })
window.view = view
