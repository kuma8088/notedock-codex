import { syntaxTree } from '@codemirror/language'
import { StateEffect } from '@codemirror/state'
import { Decoration, ViewPlugin } from '@codemirror/view'

// 箇条書き・番号付き・チェックの項目が長くて折り返したとき、2行目以降を本文の始まり（記号のあと）にそろえる。
// 記号の幅は、字下げ（タブ・空白）、記号の表示（•・チェック欄・番号）、フォントで変わるので、
// 画面に描いたあとで1行目の本文の始まりの位置を測り、その幅を行の左の余白にして、1行目だけ同じ幅を戻す。
//
// 記号の前の字下げ（タブ・空白）は、幅の決まった囲み（inline-block）に入れる。
// タブの幅は「次のタブの止まる位置まで」なので、囲まないと、行の左の余白を変えるたびにタブの幅が変わり、
// 測った幅も変わって、測り直しが止まらなくなる。囲みの中のタブは囲みの左端から数えるので、余白に左右されない。
// 囲みは行の書き始めにあるので、1行目の見た目は囲む前と同じ。

// 項目の1行目ごとに、行の始まり、記号の始まり、本文の始まりの位置と、行が空白で始まるか（字下げの縦の線を引くか）を返す。
// 引用（>）の中の項目も含める。
export function listTextStarts(state, from = 0, to = state.doc.length) {
  const found = []
  const doc = state.doc
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'Frontmatter') return false
      if (node.name !== 'ListMark') return undefined
      const item = node.node.parent
      if (!item || item.name !== 'ListItem') return undefined
      const line = doc.lineAt(node.from)
      const before = doc.sliceString(line.from, node.from)
      // 記号の前は、字下げと引用の記号だけ（項目の続きの行の途中にある記号は数えない）。
      if (!/^[\t >]*$/.test(before)) return undefined
      let end = node.to
      const marker = item.getChild('Task')?.getChild('TaskMarker')
      if (marker && marker.to <= line.to) end = marker.to
      const space = doc.sliceString(end, line.to).match(/^[\t ]*/)[0].length
      const text = end + space
      // 字下げの囲みは行の始まりから。引用の記号（>）も含めて囲むと、囲みの中のタブは行の始まりから数えるので、
      // 1行目の見た目が囲む前と同じになる（> のあとから囲むと、タブを > の右から数え直してしまう）。
      // 本文のない項目（empty）は、行の上下のすき間だけ付けて、幅は測らない。
      found.push({ line: line.from, guide: /^[\t ]/.test(before), mark: node.from, text, empty: text >= line.to })
      return undefined
    },
  })
  return found
}

// 測った幅を、次の描き直しで行に付けるための合図。
const hangMeasured = StateEffect.define()

const INDENT = Decoration.mark({ class: 'cm-list-indent' })

function lineElement(view, pos) {
  let node = view.domAtPos(pos).node
  while (node && node !== view.contentDOM) {
    if (node.nodeType === 1 && node.classList.contains('cm-line')) return node
    node = node.parentNode
  }
  return null
}

function visibleStarts(view) {
  return view.visibleRanges.flatMap((range) => listTextStarts(view.state, range.from, range.to))
}

// タブ1つ分の幅（tab-size × 空白の幅）。入れ子の縦の線の間隔に使う。
function tabWidth(probe) {
  return Math.round(probe.getBoundingClientRect().width * 100) / 100
}

// 見えている項目の行の幅を測る。測れなかった行（描かれていない・幅がおかしい）は unmeasured に入れ、古い値を消す。
function measure(view) {
  const widths = new Map()
  const unmeasured = new Set()
  for (const { line, mark, text, empty } of visibleStarts(view)) {
    if (empty) {
      unmeasured.add(line)
      continue
    }
    const element = lineElement(view, line)
    const at = view.coordsAtPos(text, 1)
    const markAt = view.coordsAtPos(mark, 1)
    if (!element || !at || !markAt) {
      unmeasured.add(line)
      continue
    }
    const style = getComputedStyle(element)
    // 1行目の書き始めは、左の線・左の余白・1行目の字下げを足した位置。字下げを付けても付けなくても同じ値になる。
    const start = element.getBoundingClientRect().left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft) + parseFloat(style.textIndent)
    const hang = Math.round((at.left - start) * 2) / 2
    const indent = Math.max(0, Math.round((markAt.left - start) * 2) / 2)
    if (hang > 0 && hang < element.clientWidth / 2) widths.set(line, { hang, indent })
    else unmeasured.add(line)
  }
  return { widths, unmeasured, width: view.contentDOM.clientWidth }
}

// pos が、項目（箇条書き・番号付き・チェック）の行の頭か。
const ITEM_LINE = /^[\t >]*(?:[-*+]|\d+[.)])[\t ]/
export function isItemLineStart(doc, pos) {
  const line = doc.lineAt(pos)
  return line.from === pos && ITEM_LINE.test(line.text)
}

const sameWidth = (a, b) => Boolean(a && b) && a.hang === b.hang && a.indent === b.indent

// 測った値を今の値に重ねて返す。画面の外の行（測っていない行）の値は残し、測れなかった行の値は消す。
// frozen の行は値を変えない（揺れ続けた行）。変わるところがなければ null。
export function mergeWidths(current, measured, unmeasured = new Set(), frozen = new Set()) {
  const next = new Map(current)
  let changed = false
  for (const [line, value] of measured) {
    if (frozen.has(line) || sameWidth(current.get(line), value)) continue
    next.set(line, value)
    changed = true
  }
  for (const line of unmeasured) {
    if (!frozen.has(line) && next.delete(line)) changed = true
  }
  return changed ? next : null
}

// 本文・カーソル・幅が変わらないのに（自分の付け直しだけで）同じ行の値がこの回数変わったら、その行は揺れているとみなして値を固定する。
const FLIP_LIMIT = 3

function decorationsFor(view, widths) {
  const ranges = []
  for (const { line, guide, mark } of visibleStarts(view)) {
    const width = widths.get(line)
    const spec = width === undefined
      ? { class: 'cm-list-line' }
      : {
          class: `cm-list-line cm-hang${guide && width.indent > 0 ? ' cm-hang-guide' : ''}`,
          attributes: { style: `--hang: ${width.hang}px; --indent: ${width.indent}px` },
        }
    ranges.push(Decoration.line(spec).range(line))
    if (mark > line) ranges.push(INDENT.range(line, mark))
  }
  return Decoration.set(ranges, true)
}

// 付け直しの歯止め：1秒に LIMIT 回まで。超えた分は捨てずに、時間が空いたら最後の1回を必ず測り直して付ける。
const LIMIT = 8
const WINDOW = 1000

export const listHangingIndent = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view
      this.widths = new Map()
      this.sent = []
      this.pending = false
      this.retry = null
      this.tab = 0
      // 行ごとの、本文と幅が同じままで値が変わった回数。本文か幅が変わったら数え直す。
      this.flips = new Map()
      this.frozen = new Set()
      this.layoutWidth = -1
      // タブ1つ分の幅を測るための、見えない部品。エディターと同じ文字の設定を引き継ぐ。
      this.probe = document.createElement('span')
      this.probe.setAttribute('aria-hidden', 'true')
      this.probe.style.cssText = `position: absolute; top: 0; left: 0; visibility: hidden; pointer-events: none; white-space: pre; tab-size: ${view.state.tabSize}`
      this.probe.textContent = '\t'
      view.dom.appendChild(this.probe)
      this.decorations = decorationsFor(view, this.widths)
      this.schedule()
    }
    update(update) {
      for (const tr of update.transactions) {
        for (const effect of tr.effects) if (effect.is(hangMeasured)) this.widths = effect.value
      }
      // 揺れの数え直し：自分の付け直し以外の変化（本文、カーソル、表示の切り替えなど）があれば、値が変わるのは当然なので数え直す。
      if (update.transactions.some((tr) => !tr.effects.some((effect) => effect.is(hangMeasured)))) {
        this.flips.clear()
        this.frozen.clear()
      }
      if (update.docChanged) {
        // 測り直すまでのあいだ、今の幅を新しい位置へ移しておく。行の頭に打った字（Tab など）の前に残すよう、
        // 位置は手前側へ寄せる（後ろへ寄せると行の頭でなくなり、1回分の描き直しのあいだ字下げが外れる）。
        const moved = new Map()
        for (const [line, width] of this.widths) {
          // 手前に寄せた位置が項目の行の頭でなければ（項目の行の頭で Enter を押したときなど）、後ろに寄せた位置も試す。
          const pos = [update.changes.mapPos(line, -1), update.changes.mapPos(line, 1)].find((at) => isItemLineStart(update.state.doc, at))
          if (pos !== undefined) moved.set(pos, width)
        }
        this.widths = moved
      }
      if (update.docChanged || update.viewportChanged || update.selectionSet || update.transactions.length) {
        this.decorations = decorationsFor(update.view, this.widths)
      }
      if (update.docChanged || update.viewportChanged || update.geometryChanged || update.selectionSet || update.transactions.length) this.schedule()
    }
    schedule() {
      this.view.requestMeasure({
        key: this,
        read: (view) => ({ ...measure(view), tab: tabWidth(this.probe) }),
        write: ({ widths: measured, unmeasured, width, tab }, view) => {
          if (tab > 0 && tab !== this.tab) {
            this.tab = tab
            view.dom.style.setProperty('--tab-width', `${tab}px`)
          }
          if (this.pending || this.retry) return
          if (width !== this.layoutWidth) {
            this.layoutWidth = width
            this.flips.clear()
            this.frozen.clear()
          }
          for (const [line, value] of measured) {
            const old = this.widths.get(line)
            if (!old || sameWidth(old, value) || this.frozen.has(line)) continue
            const count = (this.flips.get(line) ?? 0) + 1
            this.flips.set(line, count)
            if (count >= FLIP_LIMIT) this.frozen.add(line)
          }
          const next = mergeWidths(this.widths, measured, unmeasured, this.frozen)
          if (!next) return
          const now = Date.now()
          this.sent = this.sent.filter((time) => now - time < WINDOW)
          if (this.sent.length >= LIMIT) {
            // 上限を超えたら、いちばん古い回が1秒の外に出たところで、もう一度測る（そのときの最新の値で付ける）。
            this.retry = setTimeout(() => {
              this.retry = null
              if (!this.destroyed) this.schedule()
            }, WINDOW - (now - this.sent[0]) + 10)
            return
          }
          this.sent.push(now)
          this.pending = true
          // 描き直しの途中では本文を変えられないので、終わってから付け直す。
          queueMicrotask(() => {
            this.pending = false
            if (this.destroyed) return
            // 日本語の変換中は付け直さない。変換が終わると update が来て、もう一度測る。
            if (view.composing || view.compositionStarted) return
            view.dispatch({ effects: hangMeasured.of(next) })
          })
        },
      })
    }
    destroy() {
      this.destroyed = true
      clearTimeout(this.retry)
      this.probe.remove()
    }
  },
  { decorations: (plugin) => plugin.decorations },
)
