import fs from 'node:fs'
import path from 'node:path'

const BLOCKED = new Set(['node_modules'])
const ASSET_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp'])

// Windowsでだけ断る名前。Macでは普通に使える名前（「AIとは?.md」「A | B.md」など）なので、Macでは断らない。
// \ はWindowsでは区切りになる。: はドライブ名と別のデータストリームになる。ほかはWindowsのファイル名に使えない文字。
const WINDOWS_BAD_CHARS = /[\\:*?"<>|\x00-\x1f]/
// Windowsの予約名。拡張子が付いていても、名前のあとに空白があっても機器を指す。
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$) *(\..*)?$/i

const isHiddenOrBlocked = (part) => part.startsWith('.') || BLOCKED.has(part.toLowerCase())
const spelled = (value) => value.normalize('NFC').toLowerCase()

function partAllowed(part, platform) {
  if (part === '' || isHiddenOrBlocked(part)) return false
  if (platform !== 'win32') return true
  return (
    !WINDOWS_BAD_CHARS.test(part) &&
    // Windowsは最後の空白と点を削るので、別の名前を指してしまう。
    !/[ .]$/.test(part) &&
    !WINDOWS_RESERVED.test(part)
  )
}

function outside(relative) {
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
}

// realpath と platform は試験のときだけ差し替える（Windowsの短い名前やジャンクションを、Macの上で再現するため）。
export function resolveInside(root, rel, { realpath = fs.realpathSync.native, platform = process.platform } = {}) {
  if (typeof rel !== 'string' || rel === '' || path.isAbsolute(rel) || rel.includes('\0')) {
    throw new Error('path not allowed')
  }
  const parts = rel.split('/')
  if (!parts.every((part) => partAllowed(part, platform))) throw new Error('path not allowed')
  let current = root
  let existing = root
  let found = 0
  for (const part of parts) {
    current = path.join(current, part)
    let stat
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      if (error.code === 'ENOENT') break
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error('path not allowed')
    existing = current
    found += 1
  }
  // 文字で確かめたあと、今ある部分を実際の場所に直して、もう一度確かめる。
  // 実際の名前が、頼まれた名前と（大文字小文字と濁点などの書き方の違いを除いて）同じでなければ断る。
  // Windowsの短い名前（.git が GIT~1 になるなど）や、リンクとして見えないジャンクションをここで止める。
  // 短い名前を通すと、開いているノートを別名で動かせたり、控えが別のノートとして分かれたりする。
  const real = path.relative(realpath(root), realpath(existing))
  if (outside(real)) throw new Error('path not allowed')
  const realParts = real === '' ? [] : real.split(path.sep)
  if (realParts.some(isHiddenOrBlocked)) throw new Error('path not allowed')
  if (realParts.length !== found || realParts.some((part, i) => spelled(part) !== spelled(parts[i]))) {
    throw new Error('path not allowed')
  }
  return path.join(root, ...parts)
}

export function resolveNotePath(root, rel, options) {
  if (typeof rel !== 'string' || !rel.toLowerCase().endsWith('.md')) throw new Error('path not allowed')
  return resolveInside(root, rel, options)
}

// フォルダーの場所。名前に点を付けた隠しフォルダーや、Vaultの外は断る（Claude用の NoteDock と同じ）。
export function resolveFolderPath(root, rel, options) {
  if (typeof rel !== 'string' || /\.md$/i.test(rel)) throw new Error('path not allowed')
  return resolveInside(root, rel, options)
}

export function resolveAssetPath(root, rel, options) {
  if (typeof rel !== 'string' || !ASSET_EXT.has(path.extname(rel).toLowerCase())) {
    throw new Error('path not allowed')
  }
  return resolveInside(root, rel, options)
}

export function listNotes(root) {
  const notes = []
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (BLOCKED.has(entry.name.toLowerCase())) continue
        walk(path.join(dir, entry.name), `${prefix}${entry.name}/`)
      } else if (entry.name.toLowerCase().endsWith('.md')) {
        notes.push(`${prefix}${entry.name}`)
      }
    }
  }
  walk(root, '')
  return notes
}

// ファイル欄と置き場所の一覧に出すフォルダー。何も入っていないフォルダーも、画像などノート以外だけが入ったフォルダーも出す。
// 隠しフォルダーとシンボリックリンクは出さない。
export function listFolders(root) {
  const folders = []
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink() || !entry.isDirectory()) continue
      if (BLOCKED.has(entry.name.toLowerCase())) continue
      folders.push(`${prefix}${entry.name}`)
      walk(path.join(dir, entry.name), `${prefix}${entry.name}/`)
    }
  }
  walk(root, '')
  return folders.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}
