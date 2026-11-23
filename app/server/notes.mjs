import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { resolveNotePath } from './paths.mjs'

const SOURCE_ONLY_BYTES = 1_000_000
// ノートの大きさの上限。これより大きいノートは、開けても保存できないので、初めから編集できない状態で開く。
export const MAX_NOTE_BYTES = 20 * 1024 * 1024
const FRONTMATTER = /^---\n([\s\S]*?)\n---(?:\n|$)/

export function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

export function hashText(text) {
  return hashBytes(Buffer.from(text, 'utf8'))
}

function classify(bytes) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  let text
  try {
    text = decoder.decode(bytes)
  } catch {
    return { text: new TextDecoder('utf-8').decode(bytes), reason: 'not-utf8' }
  }
  if (text.startsWith('﻿')) return { text, reason: 'bom' }
  const crlf = (text.match(/\r\n/g) ?? []).length
  const loneCr = (text.replace(/\r\n/g, '').match(/\r/g) ?? []).length
  const lf = (text.replace(/\r\n/g, '').match(/\n/g) ?? []).length
  if (loneCr > 0 || (crlf > 0 && lf > 0)) return { text, reason: 'mixed-eol' }
  if (crlf > 0) return { text, reason: 'crlf' }
  const front = text.match(FRONTMATTER)
  if (front && /^excalidraw-plugin:/m.test(front[1])) return { text, reason: 'excalidraw' }
  return { text, reason: null }
}

// 読むときの上限。これより大きいファイルは、読み込む前に断る（画面に送れる大きさではないため）。
export const MAX_READ_BYTES = 100 * 1024 * 1024

export function readNote(root, rel) {
  const file = resolveNotePath(root, rel)
  if (fs.statSync(file).size > MAX_READ_BYTES) throw tooLarge()
  const bytes = fs.readFileSync(file)
  const { text, reason } = bytes.length > MAX_NOTE_BYTES
    ? { text: new TextDecoder('utf-8').decode(bytes), reason: 'too-large' }
    : classify(bytes)
  return {
    path: rel,
    text,
    hash: hashBytes(bytes),
    editable: reason === null,
    reason,
    sourceOnly: bytes.length > SOURCE_ONLY_BYTES,
  }
}

export function writeNote(root, rel, text, baseHash, backups) {
  const file = resolveNotePath(root, rel)
  // 外からとても大きくなったファイルは、読めないので編集できない（「本文を減らせば保存できる」とは言わない）。
  if (fs.statSync(file).size > MAX_NOTE_BYTES) throw new Error('not editable')
  const current = readNote(root, rel)
  if (!current.editable) throw new Error('not editable')
  if (current.hash !== baseHash) {
    return { conflict: true, current: current.text, hash: current.hash }
  }
  if (typeof text !== 'string') throw new Error('text required')
  if (Buffer.byteLength(text, 'utf8') > MAX_NOTE_BYTES) throw tooLarge()
  backups.save(rel, current.text, 'previous')
  backups.snapshot(rel, current.text)
  const mode = fs.statSync(file).mode & 0o777
  // 一時ファイルの名前は推測できないようにし、同じ名前のファイルがあれば書かない（そこに置かれたリンクの先へ書かないため）。
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(8).toString('hex')}.tmp`)
  let created = false
  try {
    // 作れた時点で自分のものと覚える。書いている途中で失敗しても片付けるため。
    const fd = fs.openSync(temp, 'wx', mode)
    created = true
    try {
      fs.writeFileSync(fd, text)
    } finally {
      fs.closeSync(fd)
    }
    fs.chmodSync(temp, mode)
    // 一時ファイルを書いている間の変更に気づくため、置き換える直前にもう一度比べる。
    if (hashBytes(fs.readFileSync(file)) !== baseHash) {
      const latest = readNote(root, rel)
      fs.rmSync(temp, { force: true })
      return { conflict: true, current: latest.text, hash: latest.hash }
    }
    fs.renameSync(temp, file)
  } catch (error) {
    // 自分で作った一時ファイルだけを片付ける。
    if (created) fs.rmSync(temp, { force: true })
    // 一時ファイルの名前がぶつかったのは、ノートの衝突ではない（409 にしない）。
    if (!created && error.code === 'EEXIST') throw new Error('temporary file exists')
    throw error
  }
  return { conflict: false, hash: hashText(text) }
}

export function tooLarge() {
  return Object.assign(new Error('too large'), { status: 413 })
}

export function createNote(root, rel, text) {
  const file = resolveNotePath(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, { flag: 'wx' })
  return readNote(root, rel)
}
