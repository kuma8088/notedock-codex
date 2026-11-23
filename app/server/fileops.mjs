// ファイル欄の操作（フォルダーを作る、動かす・名前を変える、ゴミ箱に移す）。
// どれもVaultの中だけ。隠しフォルダー、シンボリックリンク、外への移動は断る。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { movedPath, rewriteLinks } from '../src/linkrewrite.mjs'
import { readNote, writeNote } from './notes.mjs'
import { listFolders, listNotes, resolveInside } from './paths.mjs'

export { listFolders }

const spelled = (value) => value.normalize('NFC').toLowerCase()

function notAllowed() {
  return new Error('path not allowed')
}

function missing(what) {
  return Object.assign(new Error(`${what} not found`), { code: 'ENOENT' })
}

export function createFolder(root, rel) {
  const full = resolveInside(root, rel)
  // 上のフォルダーがなければ ENOENT、すでにあれば EEXIST で断る。
  fs.mkdirSync(full)
  return { path: rel }
}

// 動かしたときにリンクが変わるノートを探す。書き換えはしない。
// エディターで編集できない形のノート（改行がCRLFなど）は書き換えず、blocked として名前を返す。
export function planMove(root, from, to) {
  const source = resolveInside(root, from)
  const isFolder = fs.statSync(source).isDirectory()
  const mapPath = (item) => movedPath(item, from, to, isFolder) ?? item
  const notes = listNotes(root)
  const knownBefore = new Set(notes)
  const knownAfter = new Set(notes.map(mapPath))
  const changes = []
  const blocked = []
  for (const note of notes) {
    let current
    try {
      current = readNote(root, note)
    } catch {
      // 読めないノート（権限がない、同じ名前のフォルダーなど）は、書き換えられないものとして名前を返す。
      if (fs.existsSync(path.join(root, note)) && !fs.statSync(path.join(root, note)).isDirectory()) blocked.push(note)
      continue
    }
    if (!current.text.includes('](') && !current.text.includes('[[') && !current.text.includes(']:')) continue
    const newNote = mapPath(note)
    const after = rewriteLinks(current.text, { notePath: note, newNotePath: newNote, mapPath, knownBefore, knownAfter })
    if (after === current.text) continue
    if (current.editable) changes.push({ from: note, to: newNote, before: current.text, after, hash: current.hash })
    else blocked.push(note)
  }
  return { isFolder, changes, blocked }
}

function checkMove(root, from, to) {
  const source = resolveInside(root, from)
  const dest = resolveInside(root, to)
  if (!fs.existsSync(source)) throw missing('source')
  const isFolder = fs.statSync(source).isDirectory()
  if (!isFolder && !to.toLowerCase().endsWith('.md')) throw notAllowed()
  if (isFolder && spelled(to).startsWith(`${spelled(from)}/`)) throw notAllowed()
  if (!fs.existsSync(path.dirname(dest))) throw missing('folder')
  if (fs.existsSync(dest)) {
    // 大文字と小文字だけを変える名前の変更は、Macでは同じファイルに見える。本当に同じファイルのときだけ許す。
    const a = fs.statSync(source)
    const b = fs.statSync(dest)
    if (a.dev !== b.dev || a.ino !== b.ino) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
  }
  return { source, dest, isFolder }
}

// 動かしてから、リンクを書き換える。書き換えは一時ファイルに書いて置き換え、
// 直前に計画したときと同じ中身かを確かめる（writeNote）。違っていたノートは skipped で返す。
export function moveItem(root, from, to, { rewrite = false, backups = null } = {}) {
  const { source, dest, isFolder } = checkMove(root, from, to)
  const plan = rewrite ? planMove(root, from, to) : { changes: [], blocked: [] }
  const movedNotes = isFolder
    ? listNotes(root).filter((rel) => movedPath(rel, from, to, true)).map((rel) => [rel, movedPath(rel, from, to, true)])
    : [[from, to]]
  fs.renameSync(source, dest)
  for (const [old, next] of movedNotes) {
    try {
      backups?.rename(old, next)
    } catch {
      // 履歴を移せなくても、ノートを動かしたことは取り消さない。
    }
  }
  let rewritten = 0
  const skipped = [...plan.blocked]
  const failed = []
  for (const change of plan.changes) {
    try {
      const saved = backups
        ? writeNote(root, change.to, change.after, change.hash, backups)
        : writeNote(root, change.to, change.after, change.hash, { save() {}, snapshot() {} })
      if (saved.conflict) skipped.push(change.to)
      else rewritten += 1
    } catch {
      failed.push(change.to)
    }
  }
  return { path: to, isFolder, rewritten, skipped, failed }
}

// ゴミ箱へ移す。Macは macOS の trash コマンドを使うので、Finderの「戻す」で元の場所へ戻せる。
// Windowsは、Vaultの一番上の .trash フォルダーへ移す（Obsidianの「.trash フォルダーへ移す」と同じ形）。
// Windows標準のごみ箱は、大きすぎるときや使わない設定のときに、黙って完全に消してしまうため使わない。
// 同じドライブの中で名前を変えるだけなので、消えることはない。
// .trash は名前が点で始まるので、エディターの一覧には出ず、エディターからは開けない。戻すときはエクスプローラーで移す。
// trashDir を渡したとき（テスト）は、その中へ名前を変えて移すだけにする。
const TRASH = '/usr/bin/trash'
export const VAULT_TRASH = '.trash'

// Vaultの .trash が、本物のフォルダーとしてVaultの中にあるかを確かめる。リンクやファイルなら断る。
function vaultTrashDir(root) {
  const dir = path.join(root, VAULT_TRASH)
  let stat = null
  try {
    stat = fs.lstatSync(dir)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!stat) fs.mkdirSync(dir)
  else if (stat.isSymbolicLink() || !stat.isDirectory()) throw notAllowed()
  // ジャンクションなど、リンクに見えないものでVaultの外を指していないか
  const real = fs.realpathSync.native(dir)
  const expected = path.join(fs.realpathSync.native(root), VAULT_TRASH)
  if (spelled(real) !== spelled(expected)) throw notAllowed()
  return dir
}

export function trashItem(root, rel, { trashDir = null, run = execFileSync, platform = process.platform, exists = fs.existsSync } = {}) {
  const source = resolveInside(root, rel)
  if (!fs.existsSync(source)) throw missing('item')
  if (!trashDir && platform === 'win32') trashDir = vaultTrashDir(root)
  if (!trashDir) {
    // trash コマンドがない古いmacOSでは、ほかの方法で消したりせず、理由を返して止める。
    if (!exists(TRASH)) throw Object.assign(new Error('no trash command'), { status: 501 })
    // 止まったままにならないよう時間を区切り、出力はサーバーの通信に混ぜない。
    try {
      run(TRASH, [source], { timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      // コマンドのエラーの文には、ファイルの場所が入っている。画面には理由だけを返す。
      throw new Error('trash failed')
    }
    if (fs.existsSync(source)) throw new Error('still there')
    return path.basename(source)
  }
  const isDir = fs.statSync(source).isDirectory()
  const ext = isDir ? '' : path.extname(source)
  const base = path.basename(source, ext)
  const nameAt = (n) => path.join(trashDir, n === 1 ? `${base}${ext}` : `${base} ${n}${ext}`)
  let dest = nameAt(1)
  if (isDir) {
    // フォルダーは、同じ名前のフォルダーの上へは名前を変えられない（Windowsは断り、Macは空のときだけ置き換わる）ので、
    // 既にある中身を消すことはない。
    for (let n = 2; fs.existsSync(dest); n += 1) dest = nameAt(n)
    fs.renameSync(source, dest)
    return dest
  }
  // ファイルは、名前を先に押さえてから移す。調べてから移すまでの間に、ほかのアプリ（同期のアプリなど）が
  // 同じ名前で置いたファイルを、上書きして消してしまわないように。
  for (let n = 2; ; n += 1) {
    try {
      fs.closeSync(fs.openSync(dest, 'wx'))
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      dest = nameAt(n)
    }
  }
  try {
    fs.renameSync(source, dest)
  } catch (error) {
    // 移せなかったときは、押さえた空のファイルを片付ける。元のファイルはそのまま。
    try {
      if (fs.statSync(dest).size === 0) fs.unlinkSync(dest)
    } catch {}
    throw error
  }
  return dest
}
