// フォルダーの一覧と、貼り付けたパスの解釈。画面には触らない。

import { relativeHref } from './links.mjs'

const compareNames = (a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true })

// folders を渡すと、ノートがないフォルダーも木に入れる。
export function buildTree(paths, folders = []) {
  const root = { name: '', path: '', folders: new Map(), files: [] }
  const folderOf = (parts) => {
    let current = root
    let prefix = ''
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part
      if (!current.folders.has(part)) current.folders.set(part, { name: part, path: prefix, folders: new Map(), files: [] })
      current = current.folders.get(part)
    }
    return current
  }
  for (const folder of folders) if (folder) folderOf(folder.split('/'))
  for (const note of paths) {
    const parts = note.split('/')
    const fileName = parts.pop()
    folderOf(parts).files.push({ name: fileName, path: note })
  }
  const finish = (folder) => ({
    name: folder.name,
    path: folder.path,
    folders: [...folder.folders.values()].map(finish).sort(compareNames),
    files: folder.files.sort(compareNames),
  })
  return finish(root)
}

export function ancestorsOf(note) {
  const parts = note.split('/').slice(0, -1)
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}

// Macのファイル名は大文字と小文字、濁点の持ち方を区別しないので、同じノートとして比べる。
const sameNote = (note) => note.normalize('NFC').toLowerCase()

// 新しいノートの名前と場所を確かめる。作れるなら { path }、作れないなら { error }。
// dir は '' なら一番上のフォルダー。
export function checkNewNote(name, dir, notes = []) {
  const fresh = name.trim()
  if (fresh.includes('/')) return { error: '名前に「/」は使えません。場所は下で選んでください。' }
  const base = fresh.replace(/[\\:]/g, '-').replace(/\.md$/i, '')
  if (!base) return { error: '名前を入れてください。' }
  if (base.startsWith('.')) return { error: '点で始まる名前は使えません。' }
  const path = dir ? `${dir}/${base}.md` : `${base}.md`
  if (notes.some((note) => sameNote(note) === sameNote(path))) return { error: 'この場所には同じ名前のノートがあります。' }
  return { path }
}

// 場所選びで、今いる場所の1つ下のフォルダーだけを返す。'' は一番上。
export function childFolders(folders, current) {
  const depth = current ? current.split('/').length + 1 : 1
  const prefix = current ? `${current}/` : ''
  return folders.filter((folder) => folder && folder.startsWith(prefix) && folder.split('/').length === depth)
}

// フォルダーの名前で探す。どの階層にあっても、そのフォルダー自身の名前に含むものを返す。
export function searchFolders(folders, query, limit = 100) {
  const wanted = query.trim().normalize('NFC').toLowerCase()
  if (!wanted) return []
  return folders
    .filter((folder) => folder && folder.split('/').pop().normalize('NFC').toLowerCase().includes(wanted))
    .slice(0, limit)
}

// 最近ノートを作った場所。新しい順に5つまで。
export function addRecentDir(recent, dir) {
  return [dir, ...recent.filter((item) => item !== dir)].slice(0, 5)
}

// パンくずリストの部品。folder は押したときにファイル欄で開くフォルダー（'' は一番上）。ノートの名前は null。
// フォルダーの外のノートは、ファイル欄にないので名前だけを返す。
export function breadcrumbParts(path, rootLabel) {
  if (!path) return []
  if (path.startsWith('__outside__/')) return [{ label: path.split('/').pop(), folder: null }]
  const parts = path.split('/')
  const name = parts.pop()
  return [
    { label: rootLabel, folder: '' },
    ...parts.map((part, index) => ({ label: part, folder: parts.slice(0, index + 1).join('/') })),
    { label: name, folder: null },
  ]
}

// 「探す」に入力した名前から、新しいノートの場所を作る。作れない名前なら null。
export function newNotePath(query, dir, notes = []) {
  return checkNewNote(query, dir, notes).path ?? null
}

// 新しいノートを置けるフォルダー。ノートのあるフォルダーと、その上のフォルダー。'' は一番上。
// ノートのないフォルダーは一覧から分からないので出さない。新しいフォルダーもここでは作らない。
export function noteFolders(notes) {
  const folders = new Set([''])
  for (const note of notes) for (const folder of ancestorsOf(note)) folders.add(folder)
  return [...folders].sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }))
}

// 最初に選んでおく場所。いま開いているノートと同じフォルダー。選べないときは一番上。
export function defaultNoteDir(currentPath, folders) {
  if (!currentPath) return ''
  const dir = currentPath.split('/').slice(0, -1).join('/').normalize('NFC')
  // 一覧の書き方で返す。濁点の持ち方が違っても同じフォルダーとして探す。
  return folders.find((folder) => folder.normalize('NFC') === dir) ?? ''
}

// ファイルパネルなどからコピーしたパスを、Vaultの中のノートに直す。パスでなければ null。
export function resolvePasted(text, rootPaths, notes) {
  let value = text.trim().replace(/^["']|["']$/g, '')
  if (value.includes('\n')) return null
  if (value.startsWith('file://')) {
    try {
      value = decodeURIComponent(value.slice('file://'.length))
    } catch {
      return null
    }
  }
  // Macのファイル名は濁点を分けて持つことがあるので、形をそろえて比べ、一覧の表記のまま返す。
  value = value.replace(/:\d+(?::\d+)?$/, '').normalize('NFC').replace(/^\.\//, '')
  // セッションのフォルダーから見たパスは「../」で始まることがある。上へ戻った先は分からないので、後ろの部分で探す。
  const climbed = /^(\.\.\/)+/.test(value)
  value = value.replace(/^(\.\.\/)+/, '')
  if (!value.toLowerCase().endsWith('.md') || value.split('/').includes('..')) return null
  const same = (note) => note.normalize('NFC')
  if (value.startsWith('/')) {
    const root = rootPaths.map((item) => item.normalize('NFC')).find((item) => value.startsWith(`${item}/`))
    if (!root) return null
    value = value.slice(root.length + 1)
    return notes.find((note) => same(note) === value) ?? null
  }
  const exact = notes.find((note) => same(note) === value)
  if (exact && !climbed) return exact
  const candidates = notes.filter((note) => same(note) === value || same(note).endsWith(`/${value}`))
  return candidates.length === 1 ? candidates[0] : null
}

// 今のノートの絶対パス。サーバーへ聞かずに作るので、押した直後にコピーできる。作れないときは null。
export function absolutePath(rootPaths, rel) {
  if (!rootPaths[0] || typeof rel !== 'string' || rel.startsWith('__outside__/')) return null
  return `${rootPaths[0]}/${rel}`
}

// リンクの括弧の中に絶対パスを貼ったら、今のノートからの相対パスに直す。別のMacでもリンクが切れないように。直さないときは null。
export function linkTargetFromPaste(before, text, { rootPaths, notes, currentPath }) {
  if (!/\]\([^)\s]*$/.test(before)) return null
  const value = text.trim()
  if (!value.startsWith('/') && !value.startsWith('file://')) return null
  const note = resolvePasted(value, rootPaths, notes)
  return note ? relativeHref(currentPath, note) : null
}

// 自動保存を止めている間に、開いているノート（またはそれが入っているフォルダー）を動かす・ゴミ箱に入れる操作か。
// 動かすと新しい場所のファイルの内容で開き直し、未保存の入力が画面から消えるので断る。
export function touchesStoppedNote(currentPath, item, stopped) {
  return Boolean(stopped) && holdsPath(currentPath, item)
}

// 開いているノートが item そのものか、item のフォルダーの中にあるか。
// Macのフォルダーと同じく、大文字と小文字、濁点の持ち方の違いは同じとみなす。
export function holdsPath(currentPath, item) {
  if (!currentPath) return false
  const open = currentPath.normalize('NFC').toLowerCase()
  const target = item.normalize('NFC').toLowerCase()
  return open === target || open.startsWith(`${target}/`)
}

// 動かす・名前を変える前の確認に出す、リンクを書き換えるノートの一覧。多いときは先頭だけ並べて残りの件数を出す。
export function linkedNoteLines(notes, max = 10) {
  if (!notes.length) return []
  const lines = [`リンクを書き換えるノート（${notes.length}件）：`, ...notes.slice(0, max)]
  if (notes.length > max) lines.push(`ほか${notes.length - max}件`)
  return lines
}
