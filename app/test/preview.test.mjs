import assert from 'node:assert/strict'
import { test } from 'node:test'

import { syntaxTree } from '@codemirror/language'
import { EditorState, EditorSelection } from '@codemirror/state'

import { headingsOf, linkCompletion } from '../src/complete.mjs'
import { insideRoot, relativeHref, resolveHref, slugify } from '../src/links.mjs'
import { noteMarkdown } from '../src/markdown-ext.mjs'
import { findCallouts, hiddenRanges, noteContext, previewField, setComposing, setMode } from '../src/preview.mjs'
import { addColumn, addRow, deleteRow, parseTable, replaceCell, setAlign, sortRows, splitRow } from '../src/table-model.mjs'
import { CheckboxWidget, TableWidget, assetUrl } from '../src/widgets.mjs'
import { deleteProperty, inferType, parseFrontmatter, renameProperty, setProperty } from '../src/yaml-lite.mjs'

function make(doc, cursor = doc.length) {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [noteMarkdown(), noteContext.of({ path: 'a/b.md', known: new Set(['a/c.md']) }), previewField],
  })
}

test('太字の記号はふだん隠れ、カーソルが入ると見える', () => {
  const text = '前の文\n\n**太字** です'
  const away = make(text, 0)
  assert.deepEqual(hiddenRanges(away), ['**', '**'])
  const inside = make(text, text.indexOf('太字') + 1)
  assert.deepEqual(hiddenRanges(inside), [])
})

test('見出しの記号はカーソルの行だけ見える', () => {
  const text = '# 見出し\n\n本文'
  assert.deepEqual(hiddenRanges(make(text, text.length)), ['# '])
  assert.deepEqual(hiddenRanges(make(text, 2)), [])
})

test('変換中は隠す範囲を更新しない', () => {
  const text = '**太字** です\n\n次の行'
  let state = make(text, text.length)
  const before = hiddenRanges(state)
  state = state.update({ effects: setComposing.of(true) }).state
  state = state.update({ selection: { anchor: 3 } }).state
  assert.deepEqual(hiddenRanges(state), before, '変換中はカーソルが動いても変えない')
  state = state.update({ effects: setComposing.of(false) }).state
  assert.deepEqual(hiddenRanges(state), [], '変換が終わると直す')
})


test('コールアウトは5種類と小文字だけ見つける', () => {
  const doc = (line) => findCallouts(make(`${line}\n> 本文\n\n次`))
  for (const kind of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION', 'note']) {
    assert.equal(doc(`> [!${kind}]`).length, 1, kind)
  }
  assert.equal(doc('> [!INFO]').length, 0)
  assert.equal(doc('> [!NOTE] 題名').length, 0)
  assert.equal(doc('> [!NOTE]-').length, 0)
  assert.equal(findCallouts(make('```\n> [!NOTE]\n```\n')).length, 0)
})

test('どの表示でも文書の文字は変わらない', () => {
  const text = '---\na: 1\n---\n# 見出し\n\n- [ ] 項目\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'
  let state = make(text)
  for (const mode of ['reading', 'source', 'live']) {
    state = state.update({ effects: setMode.of(mode) }).state
    assert.equal(state.doc.toString(), text)
  }
  assert.equal(state.field(previewField).mode, 'live')
})

test('ソース表示では何も隠さない', () => {
  let state = make('# 見出し\n\n**太字**\n', 0)
  state = state.update({ effects: setMode.of('source') }).state
  assert.equal(state.field(previewField).deco.size, 0)
})

test('閲覧表示ではカーソルがあっても隠す', () => {
  const text = '**太字** です'
  let state = make(text, 3)
  assert.deepEqual(hiddenRanges(state), [])
  state = state.update({ effects: setMode.of('reading') }).state
  assert.deepEqual(hiddenRanges(state), ['**', '**'])
})

test('先頭のYAMLは見出しや水平線にしない', () => {
  const state = make('---\ntitle: x\n---\n本文\n', 20)
  let replaced = 0
  state.field(previewField).deco.between(0, 5, (from, to, deco) => {
    if (deco.spec.block) replaced += 1
  })
  assert.equal(replaced, 1)
})

test('金額は数式にしない', () => {
  const names = (doc) => {
    const found = []
    syntaxTree(make(doc)).iterate({ enter: (node) => { found.push(node.name) } })
    return found
  }
  assert.ok(!names('$100と$200です').includes('InlineMath'))
  assert.ok(!names('$ a $').includes('InlineMath'))
  assert.ok(names('式 $e^{i\\pi}=1$ です').includes('InlineMath'))
  assert.ok(names('$$\na\n$$\n').includes('MathBlock'))
})

test('リンクの行き先を解決する', () => {
  assert.equal(resolveHref('a/b.md', 'c.md').path, 'a/c.md')
  assert.equal(resolveHref('a/b.md', '../d.md').path, 'd.md')
  assert.equal(resolveHref('a/b.md', '/x/y.md').path, 'x/y.md')
  assert.equal(resolveHref('a/b.md', 'my%20note.md#見出し').path, 'a/my note.md')
  assert.equal(resolveHref('a/b.md', 'my%20note.md#見出し').anchor, '見出し')
  assert.equal(resolveHref('a/b.md', '#x').path, 'a/b.md')
  assert.equal(resolveHref('a.md', '../../x.md'), null)
  assert.equal(relativeHref('a/b.md', 'a/c d.md'), 'c%20d.md')
  assert.equal(relativeHref('a/b/c.md', 'x/日本語(1).md'), '../../x/日本語%281%29.md')
  assert.equal(relativeHref('n.md', 'n2.md'), 'n2.md')
  assert.equal(slugify('Hello World! 日本語'), 'hello-world-日本語')
})

test('表のマスを1つ直しても、ほかは変わらない', () => {
  const source = '| a  |   b |\n|:--|--:|\n| 1 | 2 |\n| 3 |  |'
  assert.equal(replaceCell(source, 2, 1, '９'), '| a  |   b |\n|:--|--:|\n| 1 | ９ |\n| 3 |  |')
  assert.equal(replaceCell(source, 3, 1, 'x'), '| a  |   b |\n|:--|--:|\n| 1 | 2 |\n| 3 | x |')
  assert.equal(replaceCell(source, 2, 0, 'p|q'), '| a  |   b |\n|:--|--:|\n| p\\|q | 2 |\n| 3 |  |')
})

test('表の縦線の打ち消しとコードの中の縦線で列がずれない', () => {
  assert.equal(splitRow('| [[a\\|b]] | `x|y` | c |').length, 3)
  assert.equal(splitRow('a | b').length, 2)
  assert.deepEqual(parseTable('a|b\n:--|--:\n1|2').align, ['left', 'right'])
})

test('表の行と列を操作する', () => {
  const source = '| a | b |\n| --- | --- |\n| 2 | x |\n| 1 | y |'
  assert.equal(addRow(source, 1, true).split('\n').length, 5)
  assert.equal(deleteRow(source, 1).split('\n').length, 3)
  assert.equal(parseTable(addColumn(source, 0, true)).columns, 3)
  assert.deepEqual(parseTable(setAlign(source, 1, 'right')).align, [null, 'right'])
  assert.equal(sortRows(source, 0).split('\n')[2], '| 1 | y |')
})

test('ノートの情報を読み、変えた項目の行だけ直す', () => {
  const source = '---\ntitle: 題名\n# メモ\ndone: true\ncount: 3\nday: 2026-11-03\ntags:\n  - a\n  - b\n---'
  const { items, simple } = parseFrontmatter(source)
  assert.equal(simple, true)
  assert.deepEqual(items.map((i) => i.type), ['text', 'checkbox', 'number', 'date', 'tags'])
  assert.deepEqual(items.at(-1).value, ['a', 'b'])
  assert.equal(setProperty(source, 'count', '4'), source.replace('count: 3', 'count: 4'))
  assert.equal(setProperty(source, 'tags', ['c']), source.replace('  - a\n  - b', '  - c'))
  assert.ok(setProperty(source, 'new', 'v').endsWith('new: v\n---'))
  assert.equal(deleteProperty(source, 'done'), source.replace('done: true\n', ''))
  assert.equal(renameProperty(source, 'day', 'date'), source.replace('day:', 'date:'))
  assert.equal(parseFrontmatter('---\na:\n  b: 1\n---').simple, false)
  assert.equal(inferType('x', '2026-11-03 10:00'), 'datetime')
  assert.equal(setProperty('---\na: 1\n---', 'a', 'x: y'), '---\na: "x: y"\n---')
})

function completionAt(doc, notes, path = 'a/b.md') {
  const state = make(doc)
  const source = linkCompletion({ notes: () => notes, currentPath: () => path })
  return source({
    matchBefore(re) {
      const text = doc.slice(0, state.selection.main.head)
      const line = text.slice(text.lastIndexOf('\n') + 1)
      const match = new RegExp(`(?:${re.source})$`).exec(line)
      return match ? { from: text.length - match[0].length, to: text.length, text: match[0] } : null
    },
    state,
  })
}

test('リンクの行き先を打つとノート名の候補が出る', () => {
  const result = completionAt('[x](oth', ['a/other.md', 'c/日本語 ノート.md'])
  assert.equal(result.from, 4)
  assert.deepEqual(result.options.map((o) => o.label), ['other.md', '../c/日本語%20ノート.md'])
  assert.equal(result.options[0].displayLabel, 'other')
})

test('リンクの外や外部のURLでは候補を出さない', () => {
  assert.equal(completionAt('普通の文', ['a.md']), null)
  assert.equal(completionAt('[x](https://exa', ['a.md']), null)
})

test('見出しの候補を出す', () => {
  const result = completionAt('# 最初 の見出し\n\n[x](#', [])
  assert.deepEqual(result.options.map((o) => o.label), ['#最初-の見出し'])
  assert.equal(headingsOf(make('---\n# 違う\n---\n## 本物\n'))[0].text, '本物')
})

function widgetsOf(state, type) {
  const found = []
  state.field(previewField).deco.between(0, state.doc.length, (from, to, value) => {
    if (value.spec.widget instanceof type) found.push(value.spec.widget)
  })
  return found
}

test('引用や箇条書きの中の表は、部品にせず文字のまま見せる', () => {
  const quoted = '> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n\n次の行'
  assert.equal(widgetsOf(make(quoted), TableWidget).length, 0)
  const listed = '- 項目\n\n  | a | b |\n  | --- | --- |\n  | 1 | 2 |\n\n次の行'
  assert.equal(widgetsOf(make(listed), TableWidget).length, 0)
  const plain = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n次の行'
  assert.equal(widgetsOf(make(plain), TableWidget).length, 1)
})

test('編集できないノートでは、表とチェックを変えられないようにする', () => {
  const text = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- [ ] 項目\n\n次の行'
  const locked = EditorState.create({
    doc: text,
    selection: EditorSelection.cursor(text.length),
    extensions: [noteMarkdown(), noteContext.of({ path: 'a/b.md', known: new Set(), editable: false }), previewField, EditorState.readOnly.of(true)],
  })
  assert.equal(widgetsOf(locked, TableWidget)[0].readOnly, true)
  assert.equal(widgetsOf(locked, CheckboxWidget)[0].readOnly, true)
  // 閲覧表示は設計どおり、チェックだけ押せる。
  const reading = make(text).update({ effects: setMode.of('reading') }).state
  assert.equal(widgetsOf(reading, TableWidget)[0].readOnly, true)
  assert.equal(widgetsOf(reading, CheckboxWidget)[0].readOnly, false)
  const free = make(text)
  assert.equal(widgetsOf(free, TableWidget)[0].readOnly, false)
  assert.equal(widgetsOf(free, CheckboxWidget)[0].readOnly, false)
})

test('閉じていないYAMLや数式の枠があっても、その先の文書を読める', () => {
  const headingAfter = (text) => {
    const names = []
    syntaxTree(make(text)).iterate({ enter: (node) => { names.push(node.name) } })
    return names
  }
  for (const text of ['---\ntitle: x\n# 見出し\n\n本文\n', '$$\na+b\n\n# 見出し\n\n本文\n']) {
    const names = headingAfter(text)
    assert.ok(names.includes('ATXHeading1'), text)
    assert.ok(!names.includes('Frontmatter') && !names.includes('MathBlock'), text)
  }
  assert.ok(headingAfter('---\ntitle: x\n---\n# 見出し\n').includes('Frontmatter'))
  assert.ok(headingAfter('$$\na+b\n$$\n\n# 見出し\n').includes('MathBlock'))
})

test('フォルダーの中を指す絶対パスのリンクは、そのノートへのリンクとして読む', () => {
  const roots = ['/Users/me/vault']
  assert.equal(resolveHref('a/b.md', '/Users/me/vault/日記/x.md', roots).path, '日記/x.md')
  assert.equal(resolveHref('a/b.md', '/Users/me/vault/日記/x.md#見出し', roots).anchor, '見出し')
  assert.equal(resolveHref('a/b.md', '/Users/me/vault/my%20note.md', roots).path, 'my note.md')
  // フォルダーの名前の濁点の持ち方が違っても同じ場所として扱う。
  const nfd = ['/Users/me/データ'.normalize('NFD')]
  assert.equal(resolveHref('a/b.md', '/Users/me/データ/x.md', nfd).path, 'x.md')
})

test('フォルダーの場所で始まらない「/」のリンクは、今までどおりフォルダーの一番上から読む', () => {
  const roots = ['/Users/me/vault']
  assert.equal(resolveHref('a/b.md', '/x/y.md', roots).path, 'x/y.md')
  assert.equal(resolveHref('a/b.md', '/Users/me/vaultX/a.md', roots).path, 'Users/me/vaultX/a.md')
  assert.equal(resolveHref('a/b.md', '/x/y.md').path, 'x/y.md', 'フォルダーの場所を渡さないときも同じ')
})

test('絶対パスをフォルダーの中の場所に直す', () => {
  assert.equal(insideRoot('/Users/me/vault/a/b.md', ['/Users/me/vault']), 'a/b.md')
  assert.equal(insideRoot('/Users/me/vault', ['/Users/me/vault']), null)
  assert.equal(insideRoot('/Users/other/a.md', ['/Users/me/vault']), null)
  assert.equal(insideRoot('/Users/me/vault/a.md', []), null)
})

test('絶対パスで書いた画像も、フォルダーの中ならサーバーから読む', () => {
  const ctx = { path: 'a/b.md', rootPaths: ['/Users/me/vault'] }
  assert.equal(assetUrl(ctx, '/Users/me/vault/図/x.png'), `/api/file?path=${encodeURIComponent('図/x.png')}`)
})
test('Obsidianの記法を読む：色付きハイライト、複数行のコメント、タグ', async () => {
  const { parser } = await import('@lezer/markdown')
  const { noteMarkdownExtensions } = await import('../src/markdown-ext.mjs')
  const p = parser.configure(noteMarkdownExtensions)
  const names = (text) => {
    const found = []
    p.parse(text).iterate({ enter: (n) => { if (['Highlight', 'ObsidianComment', 'ObsidianCommentBlock', 'Tag'].includes(n.name)) found.push(`${n.name}:${text.slice(n.from, n.to)}`) } })
    return found
  }
  assert.deepEqual(names('==🔴赤== と a == b == c'), ['Highlight:==🔴赤=='])
  assert.deepEqual(names('%%\n中\n%%\n本文'), ['ObsidianCommentBlock:%%\n中\n%%'])
  assert.deepEqual(names('#仕事 #a/b-c #123 x#no `#code` https://x.y/#frag'), ['Tag:#仕事', 'Tag:#a/b-c'])
  assert.deepEqual(names('# 見出し'), [])
})

test('Obsidianの記法：段落のすぐ下のコメント、全角空白の後のタグ、絵文字の修飾', async () => {
  const { parser } = await import('@lezer/markdown')
  const { noteMarkdownExtensions } = await import('../src/markdown-ext.mjs')
  const p = parser.configure(noteMarkdownExtensions)
  const names = (text) => {
    const found = []
    p.parse(text).iterate({ enter: (n) => { if (['ObsidianCommentBlock', 'Tag'].includes(n.name)) found.push(`${n.name}:${text.slice(n.from, n.to)}`) } })
    return found
  }
  assert.deepEqual(names('a\n%%\nc\n%%'), ['ObsidianCommentBlock:%%\nc\n%%'])
  assert.deepEqual(names('メモ　#仕事 #👍🏽 #_x #2026'), ['Tag:#仕事', 'Tag:#👍🏽', 'Tag:#_x'])
})

test('引用符で囲んだ値は、数やチェックに見えても文字として扱い、書き直しても引用符を残す', () => {
  const source = '---\nid: "123"\nflag: \'true\'\nn: 5\n---'
  const { items } = parseFrontmatter(source)
  assert.deepEqual(items.map((i) => [i.key, i.value, i.type]), [['id', '123', 'text'], ['flag', 'true', 'text'], ['n', '5', 'number']])
  assert.equal(setProperty(source, 'id', '124'), '---\nid: "124"\nflag: \'true\'\nn: 5\n---')
  assert.equal(setProperty(source, 'flag', 'false'), '---\nid: "123"\nflag: "false"\nn: 5\n---')
  assert.equal(setProperty(source, 'n', '6'), '---\nid: "123"\nflag: \'true\'\nn: 6\n---')
  // もとが引用符つきなら、ふつうの文字に変えても引用符を残す。
  assert.equal(setProperty(source, 'id', 'abc'), '---\nid: "abc"\nflag: \'true\'\nn: 5\n---')
})

test('引用符つきの値は、書き直しても引用符を残す（null や yes のような値でも）', () => {
  const source = '---\nv: "null"\n---'
  assert.equal(setProperty(source, 'v', 'yes'), '---\nv: "yes"\n---')
})

test('引用符つきの日付は、日付の欄のまま扱い、書き直しても引用符を残す', () => {
  const source = '---\ndate: "2026-11-15"\n---'
  assert.equal(parseFrontmatter(source).items[0].type, 'date')
  assert.equal(setProperty(source, 'date', '2026-11-16'), '---\ndate: "2026-11-16"\n---')
})

test('引用符の中の \\ や \\" は、読むときに戻し、何度書き直しても増えない', () => {
  let source = '---\np: "C:\\\\dir"\nq: "say \\"hi\\""\nr: \'it\'\'s\'\n---'
  const { items } = parseFrontmatter(source)
  assert.deepEqual(items.map((i) => i.value), ['C:\\dir', 'say "hi"', "it's"])
  source = setProperty(source, 'p', 'C:\\dirx')
  source = setProperty(source, 'p', 'C:\\dirxx')
  assert.equal(source.split('\n')[1], 'p: "C:\\\\dirxx"')
  assert.equal(parseFrontmatter(source).items[0].value, 'C:\\dirxx')
  source = setProperty(source, 'q', 'say "bye"')
  assert.equal(parseFrontmatter(source).items[1].value, 'say "bye"')
})

test('範囲外の文字番号や制御文字の書き方は、例外を出さず、戻さずにそのまま残す', () => {
  const source = '---\np: "\\UFFFFFFFF"\nq: "\\x41\\0\\x1b"\n---'
  const { items } = parseFrontmatter(source)
  assert.deepEqual(items.map((i) => i.value), ['\\UFFFFFFFF', 'A\\0\\x1b'])
  const written = setProperty(source, 'q', 'B\\0\\x1b')
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(written), '生の制御文字を書かない')
})

test('行の区切りの文字やサロゲートの片方の書き方も、戻さずに残し、書き直しても項目として読める', () => {
  const source = '---\np: "\\u2028x\\uD800"\n---'
  assert.equal(parseFrontmatter(source).items[0].value, '\\u2028x\\uD800')
  const written = setProperty(source, 'p', '\\u2028y\\uD800')
  assert.equal(parseFrontmatter(written).items[0]?.key, 'p')
  assert.ok(!/[\u2028\u2029\ud800-\udfff]/.test(written))
})
