import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { PERIODS } from '../src/periodic.mjs'
import { resolveFolderPath, resolveNotePath } from './paths.mjs'

// フォルダーごとの設定（画像の置き場、日付ごとのノートの置き場とひな形）。
// Vaultの外（控えと同じ場所の settings/<フォルダーの目印>.json）に置き、パネルの「設定」で決める。
// Vaultの中のファイルは読まない。同期やGitで入ってきたファイルの設定が、知らないうちに使われないように。

// 画像の置き場を決めていないときの場所（Claude用の NoteDock と同じ）。
export const DEFAULT_ATTACHMENT_DIR = 'attachments'

export class BadSettings extends Error {
  constructor(message) {
    super(message)
    this.status = 400
    this.body = { error: 'bad-settings', message }
  }
}

const KIND_LABEL = { daily: '日のノート', weekly: '週のノート', monthly: '月のノート', quarterly: '四半期のノート', yearly: '年のノート' }
const OUTSIDE_FOLDER = '__outside__'
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const trimSlash = (value) => value.replace(/\/+$/, '')

function folder(root, value, label) {
  if (typeof value !== 'string') throw new BadSettings(`${label}の書き方が正しくありません`)
  const rel = trimSlash(value)
  if (rel === '') throw new BadSettings(`${label}に、一番上のフォルダーは選べません`)
  // __outside__ は、パネルがフォルダーの外のノートに付ける印。その名前のフォルダーのノートは開けないので断る。
  if (rel.split('/')[0] === OUTSIDE_FOLDER) throw new BadSettings(`${label}に、この場所は使えません：${value}`)
  let full
  try {
    full = resolveFolderPath(root, rel)
  } catch {
    throw new BadSettings(`${label}に、この場所は使えません：${value}`)
  }
  // まだないフォルダーは、使うときに作る。あるのがフォルダーでなければ断る。
  let stat = null
  try {
    stat = fs.statSync(full)
  } catch {}
  if (stat && !stat.isDirectory()) throw new BadSettings(`${label}に、フォルダーでないものは選べません：${value}`)
  return rel
}

function attachmentDir(root, value) {
  return value === undefined || value === null ? null : folder(root, value, '画像の置き場')
}

function periodic(root, value, { requireTemplates = false } = {}) {
  if (value === undefined || value === null) return null
  if (!isObject(value)) throw new BadSettings('日付ごとのノートの設定の書き方が正しくありません')
  const result = { root: folder(root, value.root, '日付ごとのノートの置き場'), templates: {} }
  if (value.templates === undefined || value.templates === null) return result
  if (!isObject(value.templates)) throw new BadSettings('ひな形の設定の書き方が正しくありません')
  for (const [key, template] of Object.entries(value.templates)) {
    if (!PERIODS.includes(key)) throw new BadSettings(`ひな形の種類が分かりません：${key}`)
    if (template === null || template === '') continue
    if (typeof template !== 'string') throw new BadSettings(`ひな形（${KIND_LABEL[key]}）の書き方が正しくありません`)
    try {
      resolveNotePath(root, template)
    } catch {
      throw new BadSettings(`ひな形（${KIND_LABEL[key]}）に、このノートは使えません：${template}`)
    }
    // 保存するときは、打ち間違いにその場で気づけるよう、ノートがあるかも見る。
    // 読むときは見ない（あとで消えたら、作るときに理由を出して止める）。
    if (requireTemplates && !fs.statSync(resolveNotePath(root, template), { throwIfNoEntry: false })?.isFile()) {
      throw new BadSettings(`ひな形（${KIND_LABEL[key]}）のノートが見つかりません：${template}`)
    }
    result.templates[key] = template
  }
  return result
}

// 「設定」で保存するときに確かめる。使えない項目があれば、どれも保存しない。
// 両方の項目がそろっていなければ断る。足りない項目を「決めていない」として上書きしないように。
export function checkVaultSettings(root, input) {
  if (!isObject(input) || !Object.hasOwn(input, 'attachmentDir') || !Object.hasOwn(input, 'periodic')) {
    throw new BadSettings('設定の書き方が正しくありません')
  }
  return { attachmentDir: attachmentDir(root, input.attachmentDir), periodic: periodic(root, input.periodic, { requireTemplates: true }) }
}

// 問い合わせのたびに読む。使えない項目は使わず（null）、理由を errors に入れる。
// errors の field は 'file'（ファイル全体が読めない）、'attachmentDir'、'periodic'。
export function readVaultSettings(file, root) {
  const empty = { attachmentDir: null, periodic: null, errors: [] }
  if (!file) return empty
  let json
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return empty
    return { ...empty, errors: [{ field: 'file', message: '設定ファイルを読めません。「設定」で保存し直してください' }] }
  }
  if (!isObject(json)) return { ...empty, errors: [{ field: 'file', message: '設定ファイルの書き方が正しくありません。「設定」で保存し直してください' }] }
  const result = { ...empty, errors: [] }
  for (const [field, read] of [['attachmentDir', attachmentDir], ['periodic', periodic]]) {
    try {
      result[field] = read(root, json[field])
    } catch (error) {
      result.errors.push({ field, message: error.message })
    }
  }
  return result
}

export function writeVaultSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temp, file)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
}
