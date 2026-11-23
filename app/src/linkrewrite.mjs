// ノートやフォルダーを動かしたとき、リンクを新しい場所に合わせて書き換える。画面には触らない。
// サーバーでも使う。リンクの位置は、エディターと同じMarkdownの読み取りで探すので、コードの中は触らない。

import { parser } from '@lezer/markdown'

import { isExternal, parseWikiLink, relativeHref, resolveHref, resolveWikiTarget, splitHref } from './links.mjs'
import { noteMarkdownExtensions } from './markdown-ext.mjs'

const markdownParser = parser.configure(noteMarkdownExtensions)
const FILE_LIKE = /\.[A-Za-z0-9]{1,5}(?:#.*)?$/
const same = (a, b) => a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase()

// path が動いた先。動かしたものに関係なければ null。isFolder なら中身も一緒に動く。
export function movedPath(path, from, to, isFolder) {
  // 濁点の持ち方が違っても、同じ場所として比べる。
  const value = path.normalize('NFC')
  const start = from.normalize('NFC')
  if (value === start) return to
  if (isFolder && value.startsWith(`${start}/`)) return `${to}${value.slice(start.length)}`
  return null
}

// 一番上からの書き方（「/」で始まる）
function fromTop(target) {
  return `/${relativeHref('_.md', target)}`
}

// [[ ]]の行き先を、新しい場所から一番短く書く。
function wikiFile(newNotePath, target, knownAfter) {
  const bare = target.replace(/\.md$/i, '')
  const name = bare.split('/').pop()
  const reaches = (text) => {
    const found = resolveWikiTarget(newNotePath, text, knownAfter)
    return found?.exists && same(found.path, target)
  }
  return [name, bare, `/${bare}`].find(reaches) ?? `/${bare}`
}

// text は notePath にあったノートの本文。動いた後は newNotePath にある。
// mapPath(古い場所) は新しい場所を返す（動いていなければそのまま）。
export function rewriteLinks(text, { notePath, newNotePath, mapPath, knownBefore, knownAfter }) {
  const edits = []
  const tree = markdownParser.parse(text)
  tree.iterate({
    enter(node) {
      if (node.name === 'Link' || node.name === 'Image' || node.name === 'LinkReference') {
        const url = node.node.getChild('URL')
        if (!url) return
        const href = text.slice(url.from, url.to)
        if (isExternal(href) || href.startsWith('#')) return
        // 参照の定義の行（[名前]: 行き先.md）は、ファイルの名前に見えるときだけ。脚注（[^1]: 説明）は触らない。
        if (node.name === 'LinkReference') {
          const label = node.node.getChild('LinkLabel')
          if (!label || text.slice(label.from, label.from + 2) === '[^' || !FILE_LIKE.test(href)) return
        }
        const resolved = resolveHref(notePath, href)
        if (!resolved) return
        const target = mapPath(resolved.path)
        if (target === resolved.path && notePath === newNotePath) return
        const { anchor } = splitHref(href)
        const file = href.trim().startsWith('/') ? fromTop(target) : relativeHref(newNotePath, target)
        const next = anchor ? `${file}#${anchor}` : file
        if (next !== href) edits.push({ from: url.from, to: url.to, insert: next })
        return
      }
      if (node.name === 'WikiLink') {
        const inner = text.slice(node.from + 2, node.to - 2)
        const parsed = parseWikiLink(inner)
        if (!parsed?.file) return false
        const found = resolveWikiTarget(notePath, parsed.file, knownBefore)
        if (!found?.exists) return false
        const target = mapPath(found.path)
        const still = resolveWikiTarget(newNotePath, parsed.file, knownAfter)
        if (still?.exists && same(still.path, target)) return false
        // 表のマスでは「|」を「\|」と書くので、元の書き方に合わせる。
        const bar = inner.includes('\\|') ? '\\|' : '|'
        const rebuilt = wikiFile(newNotePath, target, knownAfter)
          + (parsed.anchor ? `#${parsed.anchor}` : '')
          + (parsed.alias ? `${bar}${parsed.alias}` : '')
        edits.push({ from: node.from + 2, to: node.to - 2, insert: rebuilt })
        return false
      }
      return undefined
    },
  })
  if (edits.length === 0) return text
  let out = text
  for (const edit of edits.sort((a, b) => b.from - a.from)) out = out.slice(0, edit.from) + edit.insert + out.slice(edit.to)
  return out
}
