// 長い項目の折り返しと、Ctrl+Space を確かめる試験用のページ。test/browser/wrap-indent-check.py が組み立てて使う。
// ?off を付けると、折り返しをそろえる仕組みを外して描く（直す前の見た目と比べるため）。
// ?long を付けると、同じ中身を20回くり返した長いノートにする（速くスクロールしたあとを確かめるため）。
// ?leading=1.7 のように付けると、本文の行間（style.css の --note-leading）をその値にして描く。
// ?mode=reading（閲覧）や ?mode=source（ソース）を付けると、その表示で描く。
// ?headings を付けると、見出し1〜6（長くて折り返すものも）、段落のあとの見出し、コードのかたまり、コールアウトを先頭に足す。
import { autocompletion } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { completionKeys } from '../../src/ime-keys.mjs'
import { listHangingIndent } from '../../src/list-indent.mjs'
import { noteMarkdown } from '../../src/markdown-ext.mjs'
import { noteContext, previewField, setMode } from '../../src/preview.mjs'

const long = 'というか、最近の勤務や出社により体調がよくない？可能性が高い。若干疲れ気味になった。金曜日のリモートと土曜日によって体調が回復した'
const doc = [
  ...(location.search.includes('headings') ? [
    '# 見出し1 ' + long,
    '## 見出し2',
    '### 見出し3 ' + long,
    '#### 見出し4',
    '##### 見出し5',
    '###### 見出し6',
    '本文の段落。',
    '## 段落のあとの見出し',
    '',
    '```',
    'const x = 1',
    '```',
    '',
    '> [!note]',
    '> 囲みの中の文',
  ] : ['# 見出し']),
  '',
  '- 会社について',
  '\t- 3月末退社はまだ諦めない',
  `\t- ${long}`,
  `\t\t- ${long}`,
  `- [ ] ${long}`,
  `\t- [x] ${long}`,
  `1. ${long}`,
  `10. ${long}`,
  `\t2) ${long}`,
  `    - ${long}`,
  `* The quick brown fox jumps over the lazy dog and keeps running far away across the field.`,
  '',
  long,
  '',
  '> - ' + long,
  '> \t- ' + long,
  '> ' + long,
  '',
  '- ',
].join('\n')
const text = location.search.includes('long') ? Array(20).fill(doc).join('\n\n') : doc
const off = location.search.includes('off')
const params = new URLSearchParams(location.search)
if (params.get('leading')) document.documentElement.style.setProperty('--note-leading', params.get('leading'))
const mode = params.get('mode')
if (mode) document.body.dataset.mode = mode
const view = new EditorView({
  parent: document.getElementById('ed'),
  state: EditorState.create({
    doc: text,
    selection: { anchor: 0 },
    extensions: [
      noteMarkdown(),
      noteContext.of({ path: 'a.md', known: new Set() }),
      previewField,
      EditorState.tabSize.of(4),
      EditorView.lineWrapping,
      autocompletion({ override: [() => null], defaultKeymap: false }),
      keymap.of(completionKeys),
      ...(off ? [] : [listHangingIndent]),
    ],
  }),
})
if (mode) view.dispatch({ effects: setMode.of(mode) })
window.view = view
window.EditorView = EditorView
