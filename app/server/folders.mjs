import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveNotePath } from './paths.mjs'

// 編集できるフォルダーを、呼び出しのたびに、その呼び出しだけで決める。
// 候補は NOTE_ROOT、Codex が付ける sandboxCwd、前に NoteDock で使ったことのあるフォルダーの順。
// ノートを含み、確かめを通った最初の候補を、そのノートの編集できるフォルダーにする。どれにも当たらなければ読むだけ。

const OUTSIDE_FOLDER = '__outside__'
const DATE = /^\d{4}-\d{2}-\d{2}$/
const spelled = (value) => value.normalize('NFC').toLowerCase()
const slashed = (value) => value.split(path.sep).join('/')

// フォルダーの目印。native の realpath（ディスクの上の実際の大文字小文字）から作る（core.mjs と同じ）。
export const rootIdOf = (native) => crypto.createHash('sha256').update(native).digest('hex').slice(0, 16)

function real(file) {
  try {
    return fs.realpathSync(file)
  } catch {
    return null
  }
}

export function nativeOf(file) {
  try {
    return fs.realpathSync.native(file)
  } catch {
    return file
  }
}

// b が a の中（a そのものは含めない）か。
const inside = (a, b) => b.startsWith(a.endsWith(path.sep) ? a : a + path.sep)

// プロジェクトなしの会話の作業フォルダー（~/Documents/Codex/日付/名前）か。
export function isCodexWorkdir(folder, home = os.homedir()) {
  const h = nativeOf(real(home) ?? home)
  if (!inside(h, folder)) return false
  const parts = path.relative(h, folder).split(path.sep)
  return parts.length === 4 && parts[0] === 'Documents' && parts[1] === 'Codex' && DATE.test(parts[2])
}

// 広すぎるフォルダーか。一覧ではなく構造の規則で決める。
// 大文字小文字だけを変えた綴り（~/documents など）で規則を素通りしないよう、フォルダー・ホーム・控えの置き場を
// native の realpath（ディスクの上の実際の大文字小文字）に直してから比べる。当たれば理由を返す。迷う形は断る側に倒す。
export function tooBroad(given, { home = os.homedir(), backupDir } = {}) {
  const folder = nativeOf(given)
  const h = nativeOf(real(home) ?? home)
  if (folder === h || inside(folder, h)) return 'home'
  if (backupDir) {
    const b = nativeOf(real(backupDir) ?? path.resolve(backupDir))
    if (folder === b || inside(folder, b) || inside(b, folder)) return 'backups'
  }
  if (!inside(h, folder)) {
    const depth = folder.split(path.sep).filter(Boolean).length
    return depth <= 2 ? 'top' : null
  }
  const parts = path.relative(h, folder).split(path.sep)
  const hidden = parts.findIndex((part) => part.startsWith('.'))
  if (hidden !== -1) {
    // Codex の worktree（隠しフォルダーの下の worktrees/<…>/<…>）だけは認める。worktrees そのものと、すぐ下は断る。
    const worktree = hidden === 0 && parts[1] === 'worktrees' && parts.length >= 4 && !parts.slice(1).some((part) => part.startsWith('.'))
    return worktree ? null : 'hidden'
  }
  if (parts[0] === 'Library') {
    // iCloud と CloudStorage は、入れ物（すぐ下）より下だけを認める。
    const cloud = (parts[1] === 'Mobile Documents' || parts[1] === 'CloudStorage') && parts.length >= 4
    return cloud ? null : 'library'
  }
  if (parts[0] === 'Documents') {
    if (parts.length === 1) return 'documents'
    // ~/Documents/Codex と日付のフォルダーそのものは断る（日付でない名前も、迷う形なので断る）。その下の作業フォルダーは認める。
    if (parts[1] === 'Codex' && parts.length <= 3) return 'documents'
  }
  return null
}

// Codex が _meta に入れる codex/sandbox-state の sandboxCwd（file: の URI）。古い名前 -meta も読む。
export function sandboxCwdOf(meta) {
  const state = meta?.['codex/sandbox-state'] ?? meta?.['codex/sandbox-state-meta']
  if (state === undefined || state === null) return { kind: 'none' }
  if (typeof state !== 'object') return { kind: 'invalid' }
  const uri = state.sandboxCwd
  if (uri === undefined || uri === null) return { kind: 'none' }
  if (typeof uri !== 'string' || !uri.startsWith('file:')) return { kind: 'invalid' }
  let file
  try {
    file = fileURLToPath(uri)
  } catch {
    return { kind: 'invalid' }
  }
  if (!path.isAbsolute(file)) return { kind: 'invalid' }
  return { kind: 'path', path: file }
}

// 候補ごとの確かめ（今の locate() と同じもの）。candidate は realpath（native でないほう）。
// 開いた道と realpath が食い違わないことを、候補の綴り・ほかの綴り・開いた道の祖先のうち realpath が候補と同じもの、
// のどれかから見た相対パスで確かめる。リンクの先にある候補を、リンク側の道で開いたときもこれで分かる。
export function locateIn(candidate, hostPath, spellings = []) {
  if (typeof hostPath !== 'string' || !path.isAbsolute(hostPath)) return null
  const realNote = real(hostPath)
  if (!realNote || !inside(candidate, realNote)) return null
  const rel = slashed(path.relative(candidate, realNote))
  if (rel.split('/')[0] === OUTSIDE_FOLDER) return null
  const opened = path.resolve(hostPath)
  const views = [candidate, ...spellings.filter((item) => typeof item === 'string' && path.isAbsolute(item))]
  for (let folder = path.dirname(opened); ; folder = path.dirname(folder)) {
    if (real(folder) === candidate) views.push(folder)
    if (folder === path.dirname(folder)) break
  }
  if (!views.some((view) => spelled(slashed(path.relative(view, opened))) === spelled(rel))) return null
  try {
    resolveNotePath(candidate, rel)
    return rel
  } catch {
    return null
  }
}

const recordPath = (backupDir, id) => path.join(backupDir, 'settings', `${id}.root.json`)
const settingsFile = (backupDir, id) => path.join(backupDir, 'settings', `${id}.json`)

function readRecord(backupDir, id) {
  try {
    return JSON.parse(fs.readFileSync(recordPath(backupDir, id), 'utf8'))
  } catch {
    return null
  }
}

// 「使ったことがある」か。今の設定ファイルか、新しい記録（path が同じもの）があれば使ったことがある。
// 記録の path が違うときは、目印の取り違えとみて数えない。控えのフォルダーだけでは数えない。
export function isUsed(backupDir, native) {
  const id = rootIdOf(native)
  const record = readRecord(backupDir, id)
  if (record) return record.path === native
  return fs.existsSync(recordPath(backupDir, id)) ? false : fs.existsSync(settingsFile(backupDir, id))
}

// 新しい記録を書く。すでにあれば書かない。書いたら true。
export function writeRecord(backupDir, native, now = Date.now) {
  const file = recordPath(backupDir, rootIdOf(native))
  if (fs.existsSync(file)) return false
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ path: native, firstUsedAt: now() }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temp, file)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
  return true
}

// プロジェクトなしの作業フォルダーの記録のうち、その作業フォルダーが消えたものを、設定と一緒に片付ける。
// 控え（<rootId> のフォルダー）は、ほかの控えと同じ期限で片付く（pruneBackups が期限切れを消し、空になったフォルダーを消す）。
// ほかの記録は、実在しなくても消さない（外付けのディスクなどが一時的に見えないだけのことがあるため）。
export function pruneRecords(backupDir, { home = os.homedir() } = {}) {
  let names = []
  try {
    names = fs.readdirSync(path.join(backupDir, 'settings'))
  } catch {
    return []
  }
  const removed = []
  for (const name of names) {
    const match = name.match(/^([0-9a-f]{16})\.root\.json$/)
    if (!match) continue
    const record = readRecord(backupDir, match[1])
    if (typeof record?.path !== 'string' || !isCodexWorkdir(record.path, home) || fs.existsSync(record.path)) continue
    for (const file of [`${match[1]}.json`, `${match[1]}.share.json`, name]) fs.rmSync(path.join(backupDir, 'settings', file), { force: true })
    removed.push(match[1])
  }
  return removed
}

function isFolder(file) {
  try {
    return fs.statSync(file).isDirectory()
  } catch {
    return false
  }
}

// 決め方の本体。結果は { editable: true, source, folder, native, rootId, path } か { editable: false, reasons }。
// source は 'note-root'・'sandbox'・'used'。記録の世代番号は、記録や設定ファイルを書いたら上げる（bump）。
export function createResolver({ noteRoot, backupDir, home = os.homedir(), ttlMs = 2000, now = Date.now }) {
  let generation = 0
  const cache = new Map()
  const options = { home, backupDir }

  function hit(source, folder, rel) {
    const native = nativeOf(folder)
    return { editable: true, source, folder, native, rootId: rootIdOf(native), path: rel }
  }

  function compute(hostPath, meta) {
    const reasons = []
    if (typeof hostPath !== 'string' || !path.isAbsolute(hostPath)) return { editable: false, reasons: ['no-file'] }
    const realNote = real(hostPath)
    if (!realNote) return { editable: false, reasons: ['missing'] }
    // 1. NOTE_ROOT
    if (noteRoot) {
      const folder = real(noteRoot)
      if (!folder || !isFolder(folder)) reasons.push('note-root-missing')
      else if (tooBroad(folder, options)) reasons.push('note-root-too-broad')
      else {
        const rel = locateIn(folder, hostPath, [noteRoot])
        if (rel) return hit('note-root', folder, rel)
        reasons.push('note-root-outside')
      }
    }
    // 2. sandboxCwd
    const cwd = sandboxCwdOf(meta)
    if (cwd.kind === 'none') reasons.push('sandbox-none')
    else if (cwd.kind === 'invalid') reasons.push('sandbox-invalid')
    else {
      const folder = real(cwd.path)
      if (!folder || !isFolder(folder)) reasons.push('sandbox-missing')
      else if (tooBroad(folder, options)) reasons.push('sandbox-too-broad')
      else {
        const rel = locateIn(folder, hostPath, [cwd.path])
        if (rel) return hit('sandbox', folder, rel)
        reasons.push('sandbox-outside')
      }
    }
    // 3. 使ったことのあるフォルダー（いちばん内側から外へ）
    for (let folder = path.dirname(realNote); ; folder = path.dirname(folder)) {
      if (isUsed(backupDir, nativeOf(folder))) {
        if (tooBroad(folder, options)) reasons.push('used-too-broad')
        else {
          const rel = locateIn(folder, hostPath)
          if (rel) return hit('used', folder, rel)
          reasons.push('used-outside')
        }
      }
      if (folder === path.dirname(folder)) break
    }
    return { editable: false, reasons }
  }

  return {
    // fresh: 書き込みのときは使い回さずに決め直す。
    decide(hostPath, meta, { fresh = false } = {}) {
      const state = meta?.['codex/sandbox-state'] ?? meta?.['codex/sandbox-state-meta']
      const cwd = state?.sandboxCwd
      const key = JSON.stringify([hostPath, typeof cwd === 'string' ? cwd : String(cwd), generation])
      const cached = cache.get(key)
      if (!fresh && cached && now() - cached.at < ttlMs) return cached.value
      const value = compute(hostPath, meta)
      if (cache.size > 200) cache.clear()
      cache.set(key, { at: now(), value })
      return value
    },
    bump() {
      generation += 1
      cache.clear()
    },
    get generation() {
      return generation
    },
  }
}
