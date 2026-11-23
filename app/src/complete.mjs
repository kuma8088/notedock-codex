import { pickedCompletion } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'

import { relativeHref, resolveWikiTarget, slugify } from './links.mjs'

export function headingsOf(state) {
  const found = []
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === 'Frontmatter') return false
      const match = node.name.match(/^(?:ATX|Setext)Heading(\d)$/)
      if (match) {
        const text = state.doc
          .sliceString(node.from, node.to)
          .split('\n')[0]
          .replace(/^#{1,6}\s*/, '')
          .replace(/\s*#+\s*$/, '')
        found.push({ level: Number(match[1]), text, from: node.from, slug: slugify(text) })
        return false
      }
      return undefined
    },
  })
  return found
}

// リンクの行き先を打つ「](」のあとに、ノート名と見出しの候補を出す。
// [[名前#見出し#小見出し]]は、見出しを順にたどる。「#」を含む見出しもあるので、先に全体で探す。
export function findHeading(headings, anchor) {
  const matches = (heading, text) => heading.text === text || heading.slug === slugify(text)
  const whole = headings.find((heading) => matches(heading, anchor))
  if (whole) return whole
  let found = null
  let start = 0
  for (const part of anchor.split('#').map((text) => text.trim()).filter(Boolean)) {
    const at = headings.findIndex((heading, index) => index >= start && matches(heading, part))
    if (at < 0) break
    found = headings[at]
    start = at + 1
  }
  return found
}

export function linkCompletion({ notes, currentPath }) {
  return (context) => {
    const match = context.matchBefore(/\]\([^)\s]*/)
    if (!match) return null
    const typed = match.text.slice(2)
    if (/^[a-z][a-z0-9+.-]*:/i.test(typed)) return null
    const from = match.from + 2
    if (typed.startsWith('#')) {
      return {
        from,
        validFor: /^#[^)\s]*$/,
        options: headingsOf(context.state).map((heading) => ({
          label: `#${heading.slug}`,
          displayLabel: heading.text,
          detail: `見出し${heading.level}`,
          type: 'keyword',
        })),
      }
    }
    const path = currentPath()
    return {
      from,
      validFor: /^[^)\s]*$/,
      options: notes().map((note) => {
        const parts = note.split('/')
        const name = parts.at(-1).replace(/\.md$/i, '')
        return {
          label: relativeHref(path, note),
          displayLabel: name,
          detail: parts.slice(0, -1).join('/'),
          type: 'text',
        }
      }),
      filter: true,
    }
  }
}

// シェルの「if [[ -f x ]]」などを打っているときに候補を出さない。
function insideCode(state, pos) {
  // 閉じる前の「`」は、まだコードとして読み取られていない。
  const line = state.doc.lineAt(pos)
  if ((state.doc.sliceString(line.from, pos).match(/`/g)?.length ?? 0) % 2 === 1) return true
  for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'InlineCode') return true
  }
  return false
}

// 候補を選んだら「]]」の後ろへ進む。閉じていなければ閉じる。
function applyWikiTarget(view, completion, from, to) {
  const closed = /^\]{0,2}/.exec(view.state.sliceDoc(to, to + 2))[0].length
  view.dispatch({
    changes: { from, to, insert: completion.label + ']'.repeat(2 - closed) },
    selection: { anchor: from + completion.label.length + 2 },
    annotations: pickedCompletion.of(completion),
    userEvent: 'input.complete',
  })
}

// [[のあとに、ノート名の候補を出す。入れるのは、このノートから開いたときにそのノートへ着く一番短い書き方。
export function wikiLinkCompletion({ notes, known, currentPath }) {
  return (context) => {
    const match = context.matchBefore(/\[\[[^[\]\n|]*/)
    if (!match || insideCode(context.state, context.pos)) return null
    const typed = match.text.slice(2)
    const from = match.from + 2
    if (typed.startsWith('#')) {
      return {
        from,
        validFor: /^#[^[\]\n|]*$/,
        options: headingsOf(context.state).map((heading) => ({
          label: `#${heading.text}`,
          detail: `見出し${heading.level}`,
          type: 'keyword',
          apply: applyWikiTarget,
        })),
      }
    }
    if (typed.includes('#')) return null
    const path = currentPath()
    const set = known()
    return {
      from,
      validFor: /^[^[\]\n|#]*$/,
      options: notes().map((note) => {
        const bare = note.replace(/\.md$/i, '')
        const parts = bare.split('/')
        const name = parts.at(-1)
        const label = [name, bare, `/${bare}`].find((text) => resolveWikiTarget(path, text, set)?.path === note) ?? `/${bare}`
        return { label, displayLabel: name, detail: parts.slice(0, -1).join('/'), type: 'text', notePath: note, apply: applyWikiTarget }
      }),
      filter: true,
    }
  }
}
