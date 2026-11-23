import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'

import { parseWikiLink } from './links.mjs'

const DOLLAR = 36
const OPEN_BRACKET = 91
const CLOSE_BRACKET = 93
const OPEN_PAREN = 40
const NEWLINE = 10

// 閉じる行がないのに読み進めると、先の文書が丸ごと読めなくなるので、進む前に確かめる。
// cx.input は @lezer/markdown の公開の型にはない。更新で壊れたら preview.test.mjs のテストで分かる。
function hasClosingLine(cx, line, isClosing) {
  const rest = cx.input.read(cx.lineStart + line.text.length, cx.input.length)
  return rest.split('\n').slice(1).some(isClosing)
}

// ノートの先頭の「---」で囲んだ部分。普通のMarkdownとして読むと見出しや水平線になってしまう。
const Frontmatter = {
  defineNodes: [{ name: 'Frontmatter', block: true }],
  parseBlock: [
    {
      name: 'Frontmatter',
      before: 'HorizontalRule',
      parse(cx, line) {
        if (cx.lineStart !== 0 || line.text.trimEnd() !== '---') return false
        if (!hasClosingLine(cx, line, (text) => text.trimEnd() === '---')) return false
        const start = cx.lineStart
        while (cx.nextLine()) {
          if (line.text.trimEnd() === '---') {
            const end = cx.lineStart + line.text.length
            cx.addElement(cx.elt('Frontmatter', start, end))
            cx.nextLine()
            return true
          }
        }
        return false
      },
    },
  ],
}

const MathBlock = {
  defineNodes: [{ name: 'MathBlock', block: true }],
  parseBlock: [
    {
      name: 'MathBlock',
      before: 'HorizontalRule',
      parse(cx, line) {
        if (!/^\s*\$\$/.test(line.text)) return false
        const start = cx.lineStart
        const trimmed = line.text.trim()
        if (trimmed.length > 4 && trimmed.endsWith('$$')) {
          cx.addElement(cx.elt('MathBlock', start, cx.lineStart + line.text.length))
          cx.nextLine()
          return true
        }
        if (trimmed !== '$$') return false
        if (!hasClosingLine(cx, line, (text) => text.trim() === '$$')) return false
        while (cx.nextLine()) {
          if (line.text.trim() === '$$') {
            cx.addElement(cx.elt('MathBlock', start, cx.lineStart + line.text.length))
            cx.nextLine()
            return true
          }
        }
        return false
      },
    },
  ],
}

// 「$100と$200」のような金額を数式にしないよう、開始の直後と終了の直前の空白、終了の直後の数字を認めない。
const InlineMath = {
  defineNodes: [{ name: 'InlineMath' }],
  parseInline: [
    {
      name: 'InlineMath',
      before: 'Escape',
      parse(cx, next, pos) {
        if (next !== DOLLAR) return -1
        const first = cx.char(pos + 1)
        if (first === DOLLAR || first === 32 || first === 9 || first === 10 || first === -1) return -1
        if (cx.char(pos - 1) === 92) return -1
        for (let i = pos + 1; i < cx.end; i++) {
          const ch = cx.char(i)
          if (ch === 10) return -1
          if (ch === 92) {
            i += 1
            continue
          }
          if (ch === DOLLAR) {
            const before = cx.char(i - 1)
            const after = cx.char(i + 1)
            if (before === 32 || before === 9 || (after >= 48 && after <= 57)) continue
            return cx.addElement(cx.elt('InlineMath', pos, i + 1))
          }
        }
        return -1
      },
    },
  ],
}

// 「![[」はImageの処理が「![」まで読み進めるので、ここには「[[」の形で来ない。
const WikiLink = {
  defineNodes: [{ name: 'WikiLink' }],
  parseInline: [
    {
      name: 'WikiLink',
      before: 'Link',
      parse(cx, next, pos) {
        if (next !== OPEN_BRACKET || cx.char(pos + 1) !== OPEN_BRACKET) return -1
        let end = pos + 2
        while (end < cx.end && cx.char(end) !== CLOSE_BRACKET) {
          if (cx.char(end) === OPEN_BRACKET || cx.char(end) === NEWLINE) return -1
          end += 1
        }
        if (cx.char(end) !== CLOSE_BRACKET || cx.char(end + 1) !== CLOSE_BRACKET) return -1
        // 「[[1]](URL)」は普通のMarkdownのリンクとして読む。
        if (cx.char(end + 2) === OPEN_PAREN) return -1
        if (!parseWikiLink(cx.slice(pos + 2, end))) return -1
        return cx.addElement(cx.elt('WikiLink', pos, end + 2))
      },
    },
  ],
}

const EQUAL = 61
const PERCENT = 37
const HASH = 35
const isSpace = (ch) => ch === 32 || ch === 9 || ch === 10 || Number.isNaN(ch) || ch === -1 || ch === undefined

// Obsidianのハイライト「==文字==」。中の太字なども読めるように、取り消し線と同じ区切りの仕組みを使う。
const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' }
const Highlight = {
  defineNodes: [{ name: 'Highlight' }, { name: 'HighlightMark' }],
  parseInline: [
    {
      name: 'Highlight',
      after: 'Emphasis',
      parse(cx, next, pos) {
        if (next !== EQUAL || cx.char(pos + 1) !== EQUAL || cx.char(pos + 2) === EQUAL || cx.char(pos - 1) === EQUAL) return -1
        const before = cx.char(pos - 1)
        const after = cx.char(pos + 2)
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, !isSpace(after), !isSpace(before))
      },
    },
  ],
}

// Obsidianのコメント「%%文字%%」。行の中のものと、行の頭の「%%」から次の「%%」までの複数行のものがある。
const ObsidianComment = {
  defineNodes: [{ name: 'ObsidianComment' }, { name: 'ObsidianCommentBlock', block: true }],
  parseInline: [
    {
      name: 'ObsidianComment',
      before: 'Escape',
      parse(cx, next, pos) {
        if (next !== PERCENT || cx.char(pos + 1) !== PERCENT) return -1
        for (let i = pos + 2; i < cx.end - 1; i++) {
          if (cx.char(i) === NEWLINE) return -1
          if (cx.char(i) === PERCENT && cx.char(i + 1) === PERCENT) return cx.addElement(cx.elt('ObsidianComment', pos, i + 2))
        }
        return -1
      },
    },
  ],
  parseBlock: [
    {
      name: 'ObsidianCommentBlock',
      before: 'HorizontalRule',
      parse(cx, line) {
        if (!line.text.startsWith('%%')) return false
        // 同じ行で閉じているものは、行の中のコメントとして読む。
        if (line.text.indexOf('%%', 2) >= 0) return false
        const start = cx.lineStart
        // 閉じていないときは、Obsidianと同じく、そこから最後までをコメントにする。
        let end = cx.lineStart + line.text.length
        while (cx.nextLine()) {
          end = cx.lineStart + line.text.length
          if (line.text.includes('%%')) {
            cx.addElement(cx.elt('ObsidianCommentBlock', start, end))
            cx.nextLine()
            return true
          }
        }
        cx.addElement(cx.elt('ObsidianCommentBlock', start, end))
        return true
      },
      // 段落のすぐ下の行でも、行の頭の「%%」からコメントを始める。
      endLeaf(cx, line) {
        return line.text.startsWith('%%') && line.text.indexOf('%%', 2) < 0
      },
    },
  ],
}

// Obsidianのタグ「#仕事」「#受信箱/読む」。前が空白か行の頭のときだけ。数字だけのものはタグにしない。
const TAG_CHAR = /[\p{L}\p{N}\p{M}_\-/\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f\u20e3]/u
// タグの前に来てよい文字。日本語の文章でよく使う全角の空白も入れる。
const beforeTag = (ch) => isSpace(ch) || ch === 0x3000 || ch === 0xa0
const Tag = {
  defineNodes: [{ name: 'Tag' }],
  parseInline: [
    {
      name: 'Tag',
      before: 'Emphasis',
      parse(cx, next, pos) {
        if (next !== HASH || !beforeTag(cx.char(pos - 1))) return -1
        let end = pos + 1
        while (end < cx.end) {
          const code = cx.slice(end, end + 2)
          const ch = String.fromCodePoint(code.codePointAt(0))
          if (!TAG_CHAR.test(ch)) break
          end += ch.length
        }
        const body = cx.slice(pos + 1, end)
        // Obsidianと同じく、数字以外の文字が1つもないものはタグにしない。
        if (!body || /^\d+$/.test(body)) return -1
        return cx.addElement(cx.elt('Tag', pos, end))
      },
    },
  ],
}

export const noteMarkdownExtensions = [GFM, Frontmatter, MathBlock, InlineMath, WikiLink, Highlight, ObsidianComment, Tag]

export function noteMarkdown(codeLanguages) {
  return markdown({
    base: commonmarkLanguage,
    extensions: noteMarkdownExtensions,
    addKeymap: false,
    ...(codeLanguages ? { codeLanguages } : {}),
  })
}
