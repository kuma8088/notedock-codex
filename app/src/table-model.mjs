// 表の文字を行と列に分ける。縦線の打ち消し（\|）とコードの中の縦線を区切りとみなさない。

export function splitRow(line) {
  const cells = []
  let start = 0
  let inCode = false
  let i = 0
  const text = line
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '`') inCode = !inCode
    if (ch === '|' && !inCode) {
      cells.push({ from: start, to: i })
      start = i + 1
    }
    i += 1
  }
  cells.push({ from: start, to: text.length })
  if (cells.length > 1 && text.slice(cells[0].from, cells[0].to).trim() === '') cells.shift()
  if (cells.length > 1 && text.slice(cells.at(-1).from, cells.at(-1).to).trim() === '') cells.pop()
  return cells.map((cell) => {
    const raw = text.slice(cell.from, cell.to)
    const leading = raw.length - raw.trimStart().length
    const trailing = raw.length - raw.trimEnd().length
    const from = cell.from + leading
    const to = Math.max(from, cell.to - trailing)
    return { from, to, rawFrom: cell.from, rawTo: cell.to, text: text.slice(from, to) }
  })
}

export function parseTable(source) {
  const lines = source.split('\n')
  const rows = lines.map((line, index) => ({ index, line, cells: splitRow(line) }))
  const align = rows[1]
    ? rows[1].cells.map((cell) => {
        const left = cell.text.startsWith(':')
        const right = cell.text.endsWith(':')
        if (left && right) return 'center'
        if (right) return 'right'
        if (left) return 'left'
        return null
      })
    : []
  return { lines, rows, align, columns: rows[0]?.cells.length ?? 0 }
}

export function escapeCell(text) {
  return text.replace(/\r?\n/g, ' ').replace(/(^|[^\\])\|/g, '$1\\|')
}

// 1つのマスだけ書き換える。ほかのマスと行は1文字も変えない。
export function replaceCell(source, rowIndex, colIndex, text) {
  const { lines } = parseTable(source)
  const row = splitRow(lines[rowIndex])
  const cell = row[colIndex]
  const clean = escapeCell(text.trim())
  if (cell) {
    const line = lines[rowIndex]
    if (cell.from === cell.to && clean !== '') {
      lines[rowIndex] = `${line.slice(0, cell.rawFrom)} ${clean} ${line.slice(cell.rawTo)}`
    } else {
      lines[rowIndex] = line.slice(0, cell.from) + clean + line.slice(cell.to)
    }
  } else {
    lines[rowIndex] = `${lines[rowIndex].replace(/\|?\s*$/, '')} | ${clean} |`
  }
  return lines.join('\n')
}

function cellsOf(line) {
  return splitRow(line).map((cell) => cell.text)
}

function formatRow(cells) {
  return `| ${cells.join(' | ')} |`
}

function delimiter(align) {
  if (align === 'center') return ':---:'
  if (align === 'right') return '---:'
  if (align === 'left') return ':---'
  return '---'
}

function rebuild(source, mapRows) {
  const { lines, align } = parseTable(source)
  const rows = lines.map(cellsOf)
  const body = rows.filter((_, index) => index !== 1)
  const next = mapRows({ rows: body, align: [...align] })
  const out = [formatRow(next.rows[0]), formatRow(next.align.map(delimiter)), ...next.rows.slice(1).map(formatRow)]
  return out.join('\n')
}

export function addRow(source, rowIndex, after = true) {
  return rebuild(source, ({ rows, align }) => {
    const at = Math.max(1, rowIndex + (after ? 1 : 0))
    rows.splice(at, 0, align.map(() => ''))
    return { rows, align }
  })
}

export function deleteRow(source, rowIndex) {
  return rebuild(source, ({ rows, align }) => {
    if (rowIndex >= 1 && rowIndex < rows.length) rows.splice(rowIndex, 1)
    return { rows, align }
  })
}

export function addColumn(source, colIndex, after = true) {
  return rebuild(source, ({ rows, align }) => {
    const at = colIndex + (after ? 1 : 0)
    for (const row of rows) {
      while (row.length < align.length) row.push('')
      row.splice(at, 0, '')
    }
    align.splice(at, 0, null)
    return { rows, align }
  })
}

export function deleteColumn(source, colIndex) {
  return rebuild(source, ({ rows, align }) => {
    if (align.length <= 1) return { rows, align }
    for (const row of rows) row.splice(colIndex, 1)
    align.splice(colIndex, 1)
    return { rows, align }
  })
}

export function moveRow(source, rowIndex, delta) {
  return rebuild(source, ({ rows, align }) => {
    const to = rowIndex + delta
    if (rowIndex >= 1 && to >= 1 && to < rows.length) rows.splice(to, 0, rows.splice(rowIndex, 1)[0])
    return { rows, align }
  })
}

export function moveColumn(source, colIndex, delta) {
  return rebuild(source, ({ rows, align }) => {
    const to = colIndex + delta
    if (to < 0 || to >= align.length) return { rows, align }
    for (const row of rows) {
      while (row.length < align.length) row.push('')
      row.splice(to, 0, row.splice(colIndex, 1)[0])
    }
    align.splice(to, 0, align.splice(colIndex, 1)[0])
    return { rows, align }
  })
}

export function setAlign(source, colIndex, value) {
  return rebuild(source, ({ rows, align }) => {
    align[colIndex] = value
    return { rows, align }
  })
}

export function sortRows(source, colIndex, descending = false) {
  return rebuild(source, ({ rows, align }) => {
    const [head, ...body] = rows
    body.sort((a, b) => {
      const order = (a[colIndex] ?? '').localeCompare(b[colIndex] ?? '', 'ja', { numeric: true })
      return descending ? -order : order
    })
    return { rows: [head, ...body], align }
  })
}

// Tabで次のマス、Shift+Tabで前のマスへ。2行目の区切りは飛ばし、最後のマスの次は行を足す。
export function nextCell(source, rowIndex, colIndex, delta) {
  const { rows, align } = parseTable(source)
  const count = Math.max(align.length, rows[rowIndex]?.cells.length ?? 0)
  const col = colIndex + delta
  if (col >= 0 && col < count) return { row: rowIndex, col }
  if (delta > 0) {
    const row = rowIndex === 0 ? 2 : rowIndex + 1
    return row < rows.length ? { row, col: 0 } : { row, col: 0, add: true }
  }
  if (rowIndex === 0) return { row: 0, col: 0 }
  const row = rowIndex === 2 ? 0 : rowIndex - 1
  return { row, col: Math.max(align.length, rows[row].cells.length) - 1 }
}

export const EMPTY_TABLE = '|     |     |\n| --- | --- |\n|     |     |'
