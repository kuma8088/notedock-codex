import assert from 'node:assert/strict'
import { test } from 'node:test'

import { syntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'

import { findHeading, wikiLinkCompletion } from '../src/complete.mjs'
import { parseWikiLink, resolveHref, resolveWikiTarget, wikiLinkOf } from '../src/links.mjs'
import { noteMarkdown } from '../src/markdown-ext.mjs'
import { noteContext, previewField, setMode } from '../src/preview.mjs'
import { WikiLinkWidget } from '../src/widgets.mjs'

const KNOWN = new Set([
  'Home.md',
  'README.md',
  'a/README.md',
  'a/b.md',
  'a/note.md',
  'b/note.md',
  'c/deep/note.md',
  'c/only.md',
  'x/y/z.md',
  'p/x/y/z.md',
  '日本語 ノート.md',
])

function make(doc, { cursor = doc.length, path = 'a/b.md', known = KNOWN } = {}) {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [noteMarkdown(), noteContext.of({ path, known }), previewField],
  })
}

function wikiNodes(state) {
  const found = []
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === 'WikiLink') found.push(state.doc.sliceString(node.from, node.to))
    },
  })
  return found
}

function widgets(state) {
  const found = []
  state.field(previewField).deco.between(0, state.doc.length, (from, to, deco) => {
    if (deco.spec.widget instanceof WikiLinkWidget) found.push(deco.spec.widget.link)
  })
  return found
}

test('[[ ]]の中身を名前、見出し、別名に分ける', () => {
  assert.deepEqual(parseWikiLink('名前'), { file: '名前', anchor: '', alias: '' })
  assert.deepEqual(parseWikiLink('名前|別名'), { file: '名前', anchor: '', alias: '別名' })
  assert.deepEqual(parseWikiLink('名前#見出し'), { file: '名前', anchor: '見出し', alias: '' })
  assert.deepEqual(parseWikiLink('名前#見出し#小見出し|別名'), { file: '名前', anchor: '見出し#小見出し', alias: '別名' })
  assert.deepEqual(parseWikiLink('#見出し'), { file: '', anchor: '見出し', alias: '' })
  assert.deepEqual(parseWikiLink(' 名前 | 別名 '), { file: '名前', anchor: '', alias: '別名' })
  assert.deepEqual(parseWikiLink('名前\\|別名'), { file: '名前', anchor: '', alias: '別名' }, '表のマスの書き方')
  for (const empty of ['', ' ', '|', '#', '|別名']) assert.equal(parseWikiLink(empty), null, empty)
})

test('名前が1つだけならVaultのどこにあっても見つける', () => {
  assert.equal(resolveWikiTarget('a/b.md', 'only', KNOWN).path, 'c/only.md')
  assert.equal(resolveWikiTarget('a/b.md', 'only', KNOWN).exists, true)
})

test('大文字と小文字を区別せず、.mdはあってもなくてもよい', () => {
  assert.equal(resolveWikiTarget('Home.md', 'ONLY', KNOWN).path, 'c/only.md')
  assert.equal(resolveWikiTarget('Home.md', 'only.md', KNOWN).path, 'c/only.md')
  assert.equal(resolveWikiTarget('Home.md', 'home', KNOWN).path, 'Home.md')
})

test('同じ名前が複数あれば、同じフォルダーを選ぶ', () => {
  assert.equal(resolveWikiTarget('a/b.md', 'note', KNOWN).path, 'a/note.md')
  assert.equal(resolveWikiTarget('b/other.md', 'note', KNOWN).path, 'b/note.md')
  assert.equal(resolveWikiTarget('a/b.md', 'README', KNOWN).path, 'a/README.md', '一番上より同じフォルダー')
})

test('同じフォルダーになければ、一番上、短いパス、名前順で選ぶ', () => {
  assert.equal(resolveWikiTarget('Home.md', 'README', KNOWN).path, 'README.md')
  assert.equal(resolveWikiTarget('c/only.md', 'README', KNOWN).path, 'README.md')
  assert.equal(resolveWikiTarget('Home.md', 'note', KNOWN).path, 'a/note.md', '同じ深さなら名前順')
  assert.equal(resolveWikiTarget('c/only.md', 'note', KNOWN).path, 'a/note.md', '短いパスが先')
})

test('パス付きは一番上から探し、なければ途中からのパスとして探す', () => {
  assert.equal(resolveWikiTarget('Home.md', 'x/y/z', KNOWN).path, 'x/y/z.md')
  assert.equal(resolveWikiTarget('Home.md', 'y/z', KNOWN).path, 'x/y/z.md', '短いパスが先')
  assert.equal(resolveWikiTarget('Home.md', 'c/deep/note', KNOWN).path, 'c/deep/note.md')
  assert.equal(resolveWikiTarget('Home.md', 'deep/note', KNOWN).path, 'c/deep/note.md')
})

test('パス付きは同じフォルダーより一番上を先に見る', () => {
  const known = new Set(['decisions/log.md', 'old/decisions/log.md', 'old/Home.md', 'old/only/here.md'])
  assert.equal(resolveWikiTarget('old/Home.md', 'decisions/log', known).path, 'decisions/log.md')
  assert.equal(resolveWikiTarget('old/Home.md', 'only/here', known).path, 'old/only/here.md', '一番上になければ同じフォルダーから')
})

test('./ と ../ は開いているノートから、/ は一番上からだけ探す', () => {
  assert.equal(resolveWikiTarget('a/b.md', './note', KNOWN).path, 'a/note.md')
  assert.equal(resolveWikiTarget('c/deep/x.md', '../only', KNOWN).path, 'c/only.md')
  assert.equal(resolveWikiTarget('a/b.md', '/README', KNOWN).path, 'README.md')
  assert.equal(resolveWikiTarget('a/b.md', '/only', KNOWN).exists, false)
  assert.equal(resolveWikiTarget('a/b.md', '../../x', KNOWN), null, 'Vaultの外へは出ない')
})

test('見つからないときは、作る場所のパスを返す', () => {
  assert.deepEqual(resolveWikiTarget('a/b.md', 'ない', KNOWN), { path: 'ない.md', exists: false })
  assert.deepEqual(resolveWikiTarget('a/b.md', 'd/ない', KNOWN), { path: 'd/ない.md', exists: false })
})

test('ノートの一覧がまだないときは、あるものとして扱う', () => {
  assert.deepEqual(resolveWikiTarget('a/b.md', 'x', null), { path: 'x.md', exists: true })
})

test('表示する文字と行き先を作る', () => {
  const ctx = { path: 'a/b.md', known: KNOWN }
  assert.deepEqual(wikiLinkOf('only', ctx), { label: 'only', href: '/c/only.md', missing: false })
  assert.deepEqual(wikiLinkOf('only|別名', ctx), { label: '別名', href: '/c/only.md', missing: false })
  assert.deepEqual(wikiLinkOf('only#見出し', ctx), { label: 'only > 見出し', href: '/c/only.md#%E8%A6%8B%E5%87%BA%E3%81%97', missing: false })
  assert.deepEqual(wikiLinkOf('only#a#b', ctx), { label: 'only > a > b', href: '/c/only.md#a%23b', missing: false })
  assert.deepEqual(wikiLinkOf('#見出し', ctx), { label: '見出し', href: '#%E8%A6%8B%E5%87%BA%E3%81%97', missing: false })
  assert.deepEqual(wikiLinkOf('ない', ctx), { label: 'ない', href: '/ない.md', missing: true })
  assert.equal(wikiLinkOf('', ctx), null)
})

test('見つからない名前は、新しいノート用のフォルダーに作る。パス付きは書いてあるとおりの場所に作る', () => {
  const ctx = { path: 'a/b.md', known: KNOWN, newNoteDir: 'Inbox' }
  assert.equal(wikiLinkOf('ない', ctx).href, '/Inbox/ない.md')
  assert.equal(wikiLinkOf('ない#見出し', ctx).href, '/Inbox/ない.md#%E8%A6%8B%E5%87%BA%E3%81%97')
  assert.equal(wikiLinkOf('d/ない', ctx).href, '/d/ない.md')
  assert.equal(wikiLinkOf('./ない', ctx).href, '/a/ない.md')
  assert.equal(wikiLinkOf('/ない', ctx).href, '/ない.md', '一番上と書いてあれば一番上')
  assert.equal(wikiLinkOf('only', ctx).href, '/c/only.md')
  assert.equal(wikiLinkOf('a:b', ctx).href, '/Inbox/a-b.md', 'ほかの方法で作るときと同じくファイル名に使えない文字を置き換える')
})

test('新しいノート用のフォルダーが一番上なら、名前だけのリンクは一番上に作る', () => {
  const ctx = { path: 'a/b.md', known: KNOWN, newNoteDir: '' }
  assert.equal(wikiLinkOf('ない', ctx).href, '/ない.md')
  assert.equal(wikiLinkOf('a:b', ctx).href, '/a-b.md', '一番上でもファイル名に使えない文字は置き換える')
  const here = { path: 'a/b.md', known: KNOWN, newNoteDir: 'a' }
  assert.equal(wikiLinkOf('ない', here).href, '/a/ない.md', '今のノートと同じフォルダー')
})

test('行き先は既存のリンクの処理で元のパスに戻る', () => {
  const ctx = { path: 'a/b.md', known: KNOWN }
  for (const [inner, path, anchor] of [
    ['日本語 ノート', '日本語 ノート.md', ''],
    ['only#見出し', 'c/only.md', '見出し'],
    ['only#a#b', 'c/only.md', 'a#b'],
    ['#見出し', 'a/b.md', '見出し'],
    ['100% 完了', '100% 完了.md', ''],
    ['a(1)?', 'a(1)?.md', ''],
  ]) {
    const target = resolveHref(ctx.path, wikiLinkOf(inner, ctx).href)
    assert.deepEqual(target, { path, anchor }, inner)
  }
})

test('ノート以外のファイルは、開けないものとして見せる', () => {
  const ctx = { path: 'a/b.md', known: KNOWN }
  assert.deepEqual(wikiLinkOf('https://example.com/a', ctx), { label: 'https://example.com/a', href: null, missing: true }, 'URLはノートとして作らない')
  assert.notEqual(wikiLinkOf('A: 題名', ctx).href, null, 'コロンのある名前はURLではない')
  for (const inner of ['絵.png', 'a/資料.pdf', '音.wav', 'メモ.txt', 'x.canvas']) {
    assert.deepEqual(wikiLinkOf(inner, ctx), { label: inner, href: null, missing: true }, inner)
  }
  assert.equal(wikiLinkOf('v1.2の変更点', ctx).href, '/v1.2の変更点.md', '名前に点があるノートは開ける')
})

test('文中の[[ ]]を読み取る', () => {
  assert.deepEqual(wikiNodes(make('前 [[only]] 中 [[a/b|別名]] 後\n')), ['[[only]]', '[[a/b|別名]]'])
  assert.deepEqual(wikiNodes(make('**[[only]]**\n')), ['[[only]]'])
  assert.deepEqual(wikiNodes(make('- [[only]]\n')), ['[[only]]'])
  assert.deepEqual(wikiNodes(make('> [[only]]\n')), ['[[only]]'])
})

test('[[ ]]として読まないものを間違えない', () => {
  for (const text of [
    '![[絵.png]]\n',
    '`[[only]]`\n',
    '```\n[[only]]\n```\n',
    '    [[only]]\n',
    '\\[[only]]\n',
    '[[1]](https://example.com)\n',
    '[[]]\n',
    '[[ ]]\n',
    '[[a]\n',
    '[[a\nb]]\n',
    '[[a[b]]\n',
    '---\ntitle: "[[only]]"\n---\n',
    '$[[a]]$\n',
  ]) {
    assert.deepEqual(wikiNodes(make(text)), [], text)
  }
})

test('閉じていれば表示を整え、ファイルの文字は変えない', () => {
  const text = '前 [[only|別名]] 後\n\n次\n'
  const state = make(text)
  assert.deepEqual(widgets(state), [{ label: '別名', href: '/c/only.md', missing: false }])
  assert.equal(state.doc.toString(), text)
})

test('カーソルが触れているときは元の文字を見せる', () => {
  const text = '前 [[only|別名]] 後\n\n次\n'
  assert.equal(widgets(make(text, { cursor: text.indexOf('only') })).length, 0)
})

test('閲覧ではカーソルがあっても表示を整え、ソースでは整えない', () => {
  const text = '[[only]]\n'
  const state = make(text, { cursor: 2 })
  const reading = state.update({ effects: setMode.of('reading') }).state
  assert.equal(widgets(reading).length, 1)
  const source = state.update({ effects: setMode.of('source') }).state
  assert.equal(widgets(source).length, 0)
})

test('見つからないノートは印を付ける', () => {
  assert.equal(widgets(make('[[ない]]\n\n次\n', { cursor: 8 }))[0].missing, true)
})

function completionAt(doc, notes = [...KNOWN], path = 'a/b.md') {
  const state = make(doc, { path })
  const source = wikiLinkCompletion({ notes: () => notes, known: () => KNOWN, currentPath: () => path })
  return source({
    matchBefore(re) {
      const match = new RegExp(`(?:${re.source})$`).exec(doc.slice(doc.lastIndexOf('\n') + 1))
      return match ? { from: doc.length - match[0].length, to: doc.length, text: match[0] } : null
    },
    state,
    pos: doc.length,
  })
}

test('コードの中では候補を出さない', () => {
  assert.equal(completionAt('```bash\nif [[ -f x'), null, 'コード枠')
  assert.equal(completionAt('前 `[[a'), null, '文中のコード')
  assert.notEqual(completionAt('```bash\nx\n```\n\n[[a'), null, 'コード枠の後ろでは出す')
})

test('[[と打つとノートの候補が出て、開いたときにそのノートへ着く短い名前が入る', () => {
  const result = completionAt('前 [[on')
  assert.equal(result.from, 4)
  const byPath = new Map(result.options.map((option) => [option.notePath, option]))
  assert.equal(byPath.get('c/only.md').label, 'only')
  assert.equal(byPath.get('a/note.md').label, 'note', '同じフォルダーなので名前だけで着く')
  assert.equal(byPath.get('b/note.md').label, 'b/note', '名前だけだと別のノートへ行く')
  for (const option of result.options) {
    assert.equal(resolveWikiTarget('a/b.md', option.label, KNOWN).path, option.notePath, option.label)
  }
})

test('[[#と打つと開いているノートの見出しの候補が出る', () => {
  const doc = '# 大見出し\n\n## 小見出し\n\n[[#'
  const result = completionAt(doc)
  assert.equal(result.from, doc.length - 1)
  assert.deepEqual(result.options.map((option) => option.label), ['#大見出し', '#小見出し'])
})

test('[[の外や、別名を打っているときは候補を出さない', () => {
  assert.equal(completionAt('[x'), null)
  assert.equal(completionAt('[[a|別'), null)
  assert.equal(completionAt('[[a#見'), null)
  assert.equal(completionAt('[[a]] 後'), null)
})

test('#で続く見出しを順にたどる', () => {
  const headings = [
    { text: '前', slug: '前' },
    { text: '小', slug: '小' },
    { text: '大', slug: '大' },
    { text: '小', slug: '小' },
    { text: 'a#b', slug: 'ab' },
  ]
  assert.equal(findHeading(headings, '大#小'), headings[3], '大の後ろの小')
  assert.equal(findHeading(headings, '小'), headings[1])
  assert.equal(findHeading(headings, 'a#b'), headings[4], '#を含む見出し')
  assert.equal(findHeading(headings, '大#ない'), headings[2], '途中までたどれたらそこへ')
  assert.equal(findHeading(headings, '^abc'), null, 'ブロックへのリンクはノートを開くだけ')
})

test('Codex用：[[ ]]の行き先は、Vaultの場所が分かっていても一番上からの場所として開く', () => {
  const ctx = { path: 'a/b.md', known: KNOWN, newNoteDir: 'a' }
  const roots = ['/Users/x/vault']
  assert.equal(resolveHref('a/b.md', wikiLinkOf('only', ctx).href, roots).path, 'c/only.md')
  assert.equal(resolveHref('a/b.md', wikiLinkOf('ない', ctx).href, roots).path, 'a/ない.md')
})
