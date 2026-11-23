// 開けない画像があるノートを動かす試験用のページ。test/browser/image-error-check.py が組み立てて使う。
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { noteMarkdown } from '../../src/markdown-ext.mjs'
import { noteContext, previewField, setMode } from '../../src/preview.mjs'

const doc = '# 画像\n\n前の行\n![開けない画像](missing/none.jpg)\n後の行\n\n| 列 |\n| --- |\n| ![表の中の画像](missing/cell.jpg) |\n\n最後の行\n'
const view = new EditorView({
  parent: document.getElementById('ed'),
  state: EditorState.create({
    doc,
    selection: { anchor: 0 },
    extensions: [noteMarkdown(), noteContext.of({ path: 'a.md', known: new Set() }), previewField],
  }),
})
// 閲覧表示（書き込めない設定）でも、開けない画像で中身が変わらないか。
const reading = new EditorView({
  parent: document.getElementById('read'),
  state: EditorState.create({
    doc,
    extensions: [noteMarkdown(), noteContext.of({ path: 'a.md', known: new Set() }), previewField, EditorView.editable.of(false), EditorState.readOnly.of(true)],
  }),
})
reading.dispatch({ effects: setMode.of('reading') })
window.original = doc
window.view = view
window.reading = reading
