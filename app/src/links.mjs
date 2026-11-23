// リンク先の解決。普通のMarkdownと同じく、開いているノートを起点にする。「/」で始まるものはVaultの一番上から。
// ただしVaultの場所そのもので始まる絶対パス（「パスをコピー」で写したもの）は、そのノートを指す。

export function isExternal(href) {
  return /^[a-z][a-z0-9+.-]*:/i.test(href)
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

export function splitHref(href) {
  const clean = href.trim().replace(/^<|>$/g, '')
  const hash = clean.indexOf('#')
  return hash < 0 ? { file: clean, anchor: '' } : { file: clean.slice(0, hash), anchor: clean.slice(hash + 1) }
}

// 絶対パスがVaultの中なら、Vaultの中の場所を返す。濁点の持ち方の違いはそろえて比べる。中でなければ null。
export function insideRoot(absolute, rootPaths = []) {
  const value = absolute.normalize('NFC')
  for (const root of rootPaths) {
    const base = root.normalize('NFC')
    if (value.startsWith(`${base}/`)) return value.slice(base.length + 1) || null
  }
  return null
}

export function resolveHref(notePath, href, rootPaths = []) {
  const { file, anchor } = splitHref(href)
  if (file === '') return { path: notePath, anchor: safeDecode(anchor) }
  const decoded = safeDecode(file).normalize('NFC')
  const fromTop = decoded.startsWith('/')
  const rel = fromTop ? insideRoot(decoded, rootPaths) ?? decoded : decoded
  const parts = fromTop ? [] : notePath.split('/').slice(0, -1)
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  return { path: parts.join('/'), anchor: safeDecode(anchor) }
}

export function relativeHref(fromNote, target) {
  const from = fromNote.split('/').slice(0, -1)
  const to = target.split('/')
  let common = 0
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common += 1
  const up = from.slice(common).map(() => '..')
  return [...up, ...to.slice(common)].map(encodePathPart).join('/')
}

// 日本語はそのままにして、リンクの書き方と重なる文字だけを置き換える。
function encodePathPart(part) {
  return part.replace(/[ ()#?%<>\\]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}

export function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

export function normalizeKey(path) {
  return path.normalize('NFC')
}

// [[名前#見出し|別名]]の中身を分ける。表のマスでは「|」を「\|」と書く。
export function parseWikiLink(inner) {
  const clean = inner.replace(/\\\|/g, '|')
  const bar = clean.indexOf('|')
  const dest = bar < 0 ? clean : clean.slice(0, bar)
  const alias = bar < 0 ? '' : clean.slice(bar + 1).trim()
  const hash = dest.indexOf('#')
  const file = (hash < 0 ? dest : dest.slice(0, hash)).trim()
  const anchor = hash < 0 ? '' : dest.slice(hash + 1).trim()
  return file || anchor ? { file, anchor, alias } : null
}

const wikiIndexes = new WeakMap()
const foldCase = (text) => text.normalize('NFC').toLowerCase()
const baseName = (path) => path.slice(path.lastIndexOf('/') + 1)

// 名前で探す表。同じ名前のノートは、短いパス、名前順に並べておく。
function wikiIndex(known) {
  let index = wikiIndexes.get(known)
  if (index) return index
  index = new Map()
  for (const path of known) {
    const key = foldCase(baseName(path))
    if (!index.has(key)) index.set(key, [])
    index.get(key).push(path)
  }
  const depth = (path) => path.split('/').length
  for (const paths of index.values()) {
    paths.sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0))
  }
  wikiIndexes.set(known, index)
  return index
}

function joinInside(start, text) {
  const parts = [...start]
  for (const part of text.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  return parts.join('/')
}

// 「./」「../」はノートから、「/」は一番上からだけ探す。
// 名前だけなら同じフォルダーを先に、パス付きなら一番上を先に見る。パス付きは一番上からの場所を書くことが多いため。
export function resolveWikiTarget(notePath, target, known) {
  const clean = target.normalize('NFC')
  const withExt = /\.md$/i.test(clean) ? clean : `${clean}.md`
  const folder = notePath.split('/').slice(0, -1)
  const relative = /^\.{1,2}\//.test(clean)
  const wanted = joinInside(relative ? folder : [], withExt)
  if (!wanted) return null
  if (!known) return { path: wanted, exists: true }
  const sameName = wikiIndex(known).get(foldCase(baseName(wanted))) ?? []
  const exact = (path) => sameName.find((item) => foldCase(item) === foldCase(path))
  const near = () => exact([...folder, wanted].join('/'))
  const found = relative || clean.startsWith('/')
    ? exact(wanted)
    : (wanted.includes('/') ? exact(wanted) ?? near() : near() ?? exact(wanted)) ?? sameName.find((item) => foldCase(item).endsWith(`/${foldCase(wanted)}`))
  return found ? { path: found, exists: true } : { path: wanted, exists: false }
}

// エディターで開けないファイル。名前に点があるノートと間違えないよう、よく使う拡張子だけを挙げる。
const NON_NOTE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|pdf|canvas|base|mp3|m4a|wav|ogg|flac|mp4|mov|webm|mkv|txt|json|html?|zip|csv|xlsx?|docx?|pptx?)$/i

// 行き先は普通のリンクと同じ形にして、開く処理を共通にする。
export function wikiLinkOf(inner, ctx) {
  const parsed = parseWikiLink(inner)
  if (!parsed) return null
  const { file, anchor, alias } = parsed
  const sections = anchor.split('#').map((part) => part.trim()).filter(Boolean).join(' > ')
  const label = alias || [file, sections].filter(Boolean).join(' > ')
  if (NON_NOTE.test(file) || /^[a-z][a-z0-9+.-]*:\/\//i.test(file)) return { label, href: null, missing: true }
  const hash = anchor ? `#${encodeURIComponent(anchor)}` : ''
  if (!file) return { label, href: hash, missing: false }
  const target = resolveWikiTarget(ctx.path, file, ctx.known)
  if (!target) return { label, href: null, missing: true }
  // 名前だけのリンクから作るノートは、ほかの方法で作るときと同じフォルダーに置く。
  let path = target.path
  if (!target.exists && !file.includes('/')) {
    const name = target.path.split('/').pop().replace(/[\\:]/g, '-')
    path = ctx.newNoteDir ? `${ctx.newNoteDir}/${name}` : name
  }
  return { label, href: `/${path.split('/').map(encodePathPart).join('/')}${hash}`, missing: !target.exists }
}
