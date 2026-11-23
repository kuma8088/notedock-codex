import assert from 'node:assert/strict'
import { test } from 'node:test'

import { movedPath, rewriteLinks } from '../src/linkrewrite.mjs'

test('動かしたものの新しい場所を返す。関係ないものは null', () => {
  assert.equal(movedPath('a/x.md', 'a/x.md', 'b/x.md', false), 'b/x.md')
  assert.equal(movedPath('a/y.md', 'a/x.md', 'b/x.md', false), null)
  assert.equal(movedPath('a/sub/x.md', 'a', 'c/a', true), 'c/a/sub/x.md', 'フォルダーなら中身も一緒に動く')
  assert.equal(movedPath('a', 'a', 'c/a', true), 'c/a')
  assert.equal(movedPath('ab/x.md', 'a', 'c/a', true), null, '名前の頭が同じだけのフォルダーは関係ない')
})

const before = ['top.md', 'a/x.md', 'a/y.md', 'b/z.md', 'img/p.png']

function plan(from, to, isFolder = false) {
  const mapPath = (path) => movedPath(path, from, to, isFolder) ?? path
  return { mapPath, knownBefore: new Set(before.filter((p) => p.endsWith('.md'))), knownAfter: new Set(before.filter((p) => p.endsWith('.md')).map(mapPath)) }
}

test('ほかのノートの普通のリンクを、動かした先に書き換える', () => {
  const p = plan('a/x.md', 'b/x2.md')
  const text = '[行く](a/x.md) と [見出し](a/x.md#目標) と [別](b/z.md)\n'
  assert.equal(rewriteLinks(text, { notePath: 'top.md', newNotePath: 'top.md', ...p }), '[行く](b/x2.md) と [見出し](b/x2.md#目標) と [別](b/z.md)\n')
})

test('「/」で始まるリンクは、一番上からの書き方のまま書き換える', () => {
  const p = plan('a/x.md', 'b/x2.md')
  assert.equal(rewriteLinks('[行く](/a/x.md)', { notePath: 'b/z.md', newNotePath: 'b/z.md', ...p }), '[行く](/b/x2.md)')
})

test('動かしたノート自身の中のリンクも、新しい場所から見た書き方に直す', () => {
  const p = plan('a/x.md', 'b/x.md')
  const text = '[隣](y.md) [上](../top.md) [画像](../img/p.png)\n![絵](../img/p.png)'
  assert.equal(
    rewriteLinks(text, { notePath: 'a/x.md', newNotePath: 'b/x.md', ...p }),
    '[隣](../a/y.md) [上](../top.md) [画像](../img/p.png)\n![絵](../img/p.png)',
  )
})

test('フォルダーを動かすと、中のノートどうしのリンクはそのまま、外へのリンクは直す', () => {
  const p = plan('a', 'b/a', true)
  const text = '[隣](y.md) [上](../top.md)'
  assert.equal(rewriteLinks(text, { notePath: 'a/x.md', newNotePath: 'b/a/x.md', ...p }), '[隣](y.md) [上](../../top.md)')
  assert.equal(rewriteLinks('[x](a/x.md)', { notePath: 'top.md', newNotePath: 'top.md', ...p }), '[x](b/a/x.md)')
})

test('[[名前]]は、名前のままで着くなら変えない。名前を変えたら新しい名前にする', () => {
  const moved = plan('a/x.md', 'b/x.md')
  assert.equal(rewriteLinks('[[x]] [[x#見出し|別名]]', { notePath: 'top.md', newNotePath: 'top.md', ...moved }), '[[x]] [[x#見出し|別名]]')
  const renamed = plan('a/x.md', 'a/新しい.md')
  assert.equal(rewriteLinks('[[x]] [[x#見出し|別名]]', { notePath: 'top.md', newNotePath: 'top.md', ...renamed }), '[[新しい]] [[新しい#見出し|別名]]')
})

test('[[パス付き]]は、新しい場所が分かる書き方にする', () => {
  const p = plan('a/x.md', 'b/x.md')
  assert.equal(rewriteLinks('[[a/x]]', { notePath: 'top.md', newNotePath: 'top.md', ...p }), '[[x]]')
})

test('コードの中と、外のサイトへのリンクと、まだないノートへのリンクは触らない', () => {
  const p = plan('a/x.md', 'b/x.md')
  const text = '`[x](a/x.md)`\n\n```\n[x](a/x.md)\n```\n\n[web](https://e.com/a/x.md) [[ない]] [自分](#見出し)'
  assert.equal(rewriteLinks(text, { notePath: 'top.md', newNotePath: 'top.md', ...p }), text)
})

test('表のマスの中の[[名前\\|別名]]は、書き方を保つ', () => {
  const p = plan('a/x.md', 'a/w.md')
  const text = '| a |\n| --- |\n| [[x\\|別]] |\n'
  assert.equal(rewriteLinks(text, { notePath: 'top.md', newNotePath: 'top.md', ...p }), '| a |\n| --- |\n| [[w\\|別]] |\n')
})

test('参照の定義の行は、ファイルの名前に見えるときだけ書き換える。脚注は触らない', () => {
  const p = plan('a/x.md', 'b/x.md')
  const text = '[行く][r]\n\n[r]: a/x.md\n[^1]: a/x.md の説明\n[^2]: 説明だけ\n'
  assert.equal(rewriteLinks(text, { notePath: 'top.md', newNotePath: 'top.md', ...p }), '[行く][r]\n\n[r]: b/x.md\n[^1]: a/x.md の説明\n[^2]: 説明だけ\n')
})

test('近くに同じ名前のノートができて名前だけでは着かなくなるなら、場所まで書く', () => {
  const known = ['top.md', 'a/x.md', 'b/x.md']
  const mapPath = (p) => movedPath(p, 'a/x.md', 'c/x.md', false) ?? p
  const ctx = { mapPath, knownBefore: new Set(known), knownAfter: new Set(known.map(mapPath)) }
  // 動かす前は a/x.md を名前で指していた（同じフォルダーにあるため）。
  assert.equal(rewriteLinks('[[x]]', { notePath: 'a/y.md', newNotePath: 'a/y.md', ...ctx }), '[[c/x]]')
})
