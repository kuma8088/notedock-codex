// ノートの情報を1階層だけ読む。入れ子や複数行の値は simple:false を返し、文字のまま扱う。書き換えるのは変えた項目の行だけ。

const KEY = /^([^\s:#][^:]*?):(?:\s+(.*)|\s*)$/
const LIST_ITEM = /^\s*-\s+(.*)$/
const COMPLEX = /^[|>{[]|^&|^\*/

// 引用符の中の書き方を元に戻す。二重引用符は \\ \" \n などを、単引用符は '' を戻す。
// 書くときは doubleQuote で逆の形にするので、読んで書き戻しても元と同じになる。
// 制御文字（タブ・改行・CR を除く）と、範囲外の番号は戻さない。戻すと、書くときに生の制御文字になったり、例外になったりする。
const ESCAPES = { '\\': '\\', '"': '"', '/': '/', n: '\n', t: '\t', r: '\r', ' ': ' ' }
// 行の区切りの文字（U+0085、U+2028、U+2029）と、サロゲートの片方（U+D800〜U+DFFF）も戻さない。
const KEEP_AS_TEXT = (cp) => cp > 0x10ffff || cp === 0x7f || cp === 0x85 || cp === 0x2028 || cp === 0x2029
  || (cp >= 0xd800 && cp <= 0xdfff) || (cp < 0x20 && cp !== 9 && cp !== 10 && cp !== 13)
function unquote(value) {
  const match = value.match(/^(["'])(.*)\1$/)
  if (!match) return value
  if (match[1] === "'") return match[2].replace(/''/g, "'")
  return match[2].replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (whole, code) => {
    if (code.length > 1) {
      const cp = parseInt(code.slice(1), 16)
      return KEEP_AS_TEXT(cp) ? whole : String.fromCodePoint(cp)
    }
    return ESCAPES[code] ?? whole
  })
}

function doubleQuote(text) {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r')}"`
}

export function inferType(key, value) {
  if (Array.isArray(value)) return key.toLowerCase() === 'tags' ? 'tags' : 'list'
  if (value === 'true' || value === 'false') return 'checkbox'
  if (/^-?\d+(\.\d+)?$/.test(value)) return 'number'
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date'
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(value)) return 'datetime'
  return 'text'
}

export function parseFrontmatter(source) {
  const lines = source.split('\n')
  if (lines[0]?.trimEnd() !== '---' || lines.at(-1)?.trimEnd() !== '---' || lines.length < 2) {
    return { simple: false, items: [], lines }
  }
  const items = []
  let simple = true
  for (let i = 1; i < lines.length - 1; ) {
    const line = lines[i]
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      i += 1
      continue
    }
    const match = line.match(KEY)
    if (!match) {
      simple = false
      i += 1
      continue
    }
    const key = match[1].trim()
    const raw = (match[2] ?? '').trim()
    if (raw === '') {
      let end = i + 1
      const values = []
      while (end < lines.length - 1) {
        const item = lines[end].match(LIST_ITEM)
        if (!item) break
        values.push(unquote(item[1].trim()))
        end += 1
      }
      if (end < lines.length - 1 && /^\s+\S/.test(lines[end])) simple = false
      const value = values.length > 0 ? values : ''
      items.push({ key, value, type: inferType(key, value), start: i, end })
      i = end
      continue
    }
    if (COMPLEX.test(raw)) {
      if (raw.startsWith('[') && raw.endsWith(']')) {
        const value = raw.slice(1, -1).split(',').map((v) => unquote(v.trim())).filter(Boolean)
        items.push({ key, value, type: inferType(key, value), start: i, end: i + 1, flow: true })
        i += 1
        continue
      }
      simple = false
    }
    const value = unquote(raw)
    // 引用符で囲んだ値は文字。"123" や "true" を数やチェックとして扱わない（日付は日付の欄のまま）。
    const quoted = raw !== value
    const inferred = inferType(key, value)
    items.push({ key, value, type: quoted && (inferred === 'number' || inferred === 'checkbox') ? 'text' : inferred, start: i, end: i + 1, quoted })
    i += 1
    if (i < lines.length - 1 && /^\s+\S/.test(lines[i]) && !LIST_ITEM.test(lines[i])) simple = false
  }
  return { simple, items, lines }
}

function quoteIfNeeded(value) {
  const text = String(value)
  if (text === '') return ''
  if (/^[\s>|{[&*!%@`#]|: |\s#|\s$|^["']|[\n\t\r]/.test(text)) return doubleQuote(text)
  return text
}

function renderItem(key, value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${key}:`]
    return [`${key}:`, ...value.map((item) => `  - ${quoteIfNeeded(item)}`)]
  }
  const text = quoteIfNeeded(value)
  return [text === '' ? `${key}:` : `${key}: ${text}`]
}

export function setProperty(source, key, value) {
  const { items, lines } = parseFrontmatter(source)
  const item = items.find((candidate) => candidate.key === key)
  // もとが引用符つきなら、書き直しても引用符を付けて、文字のままにする。
  const keepText = item?.quoted && typeof value === 'string' && value !== ''
  const rendered = keepText ? [`${key}: ${doubleQuote(value)}`] : renderItem(key, value)
  if (item) lines.splice(item.start, item.end - item.start, ...rendered)
  else lines.splice(lines.length - 1, 0, ...rendered)
  return lines.join('\n')
}

export function deleteProperty(source, key) {
  const { items, lines } = parseFrontmatter(source)
  const item = items.find((candidate) => candidate.key === key)
  if (item) lines.splice(item.start, item.end - item.start)
  return lines.join('\n')
}

export function renameProperty(source, key, nextKey) {
  const { items, lines } = parseFrontmatter(source)
  const item = items.find((candidate) => candidate.key === key)
  if (item && nextKey.trim()) lines[item.start] = lines[item.start].replace(key, nextKey.trim())
  return lines.join('\n')
}
