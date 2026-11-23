import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { createBackups } from './backups.mjs'
import { MAX_NOTE_BYTES, MAX_READ_BYTES, createNote, readNote, tooLarge, writeNote } from './notes.mjs'
import { createFolder, listFolders, moveItem, planMove, trashItem } from './fileops.mjs'
import { movedPath } from '../src/linkrewrite.mjs'
import { listNotes, resolveAssetPath, resolveInside, resolveNotePath } from './paths.mjs'
import { openPeriodic, periodicMonth } from './periodic.mjs'
import { DEFAULT_ATTACHMENT_DIR, checkVaultSettings, readVaultSettings, writeVaultSettings } from './vault-settings.mjs'

const NO_PERIODIC = '日付ごとのノートの置き場が決まっていません。上の「設定」で決められます'
const MAX_ATTACHMENT = 25 * 1024 * 1024
// The panel's marker for a note read through the host. A real folder with this name is never served.
const OUTSIDE_FOLDER = '__outside__'
const spelled = (value) => value.normalize('NFC').toLowerCase()
const isOutsideMarker = (rel) => typeof rel === 'string' && rel.split('/')[0] === OUTSIDE_FOLDER
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
}

// item がこのタブを開いたノートか、それを含むフォルダーか。
function holdsOpened(item, opened) {
  if (typeof item !== 'string' || !opened) return false
  const a = spelled(item)
  const b = spelled(opened)
  return a === b || b.startsWith(`${a}/`)
}

function statusOf(error) {
  if (error.message === 'path not allowed') return 400
  if (error.code === 'ENOENT') return 404
  if (error.code === 'EEXIST') return 409
  if (error.message === 'not editable') return 403
  return 500
}

// A stat-only fingerprint, so polling never reads note text.
function fingerprint(file) {
  try {
    const stat = fs.statSync(file)
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`
  } catch {
    return 'missing'
  }
}

function nativePath(file) {
  try {
    return fs.realpathSync.native(file)
  } catch {
    return file
  }
}

function realFolder(root) {
  try {
    return fs.realpathSync(root)
  } catch {
    return null
  }
}

// 控えを片付ける。どのフォルダーの目印の下も見る。フォルダーが決まっていなくても動く（Codex版は呼び出しごとにフォルダーを決めるため）。
export function pruneBackups(backupDir) {
  try {
    createBackups(backupDir).prune()
  } catch {}
  let names = []
  try {
    names = fs.readdirSync(backupDir)
  } catch {
    return
  }
  for (const name of names.filter((item) => /^[0-9a-f]{16}$/.test(item))) {
    const folder = path.join(backupDir, name)
    // もう1つのエディターが同時に片付けて、フォルダーが消えていることがある。止まらずに次へ進む。
    try {
      createBackups(folder).prune()
      if (fs.readdirSync(folder).length === 0) fs.rmdirSync(folder)
    } catch {}
  }
}

export function createCore({ root, backupDir }) {
  // Without a configured folder nothing is editable. Notes still open read-only through the host.
  // A configured folder that cannot be found (renamed, moved, a disk not attached) is treated the
  // same way, so the server still starts and every other note keeps opening.
  const realRoot = root ? realFolder(root) : null
  // フォルダーの目印。ディスクの上の実際の名前から作るので、設定の大文字小文字の書き方が違っても同じになる。
  const nativeRoot = realRoot ? nativePath(realRoot) : null
  const rootId = realRoot ? crypto.createHash('sha256').update(nativeRoot).digest('hex').slice(0, 16) : 'none'
  // 控えは、フォルダーごとの目印（rootId）の下に分けて置く。2つのフォルダーの同じ名前のノートで、
  // 「履歴」にほかのフォルダーの中身が出て、それで上書きできてしまわないように。
  const store = realRoot ? createBackups(path.join(backupDir, rootId)) : null
  // フォルダーごとの設定。Vaultの外の、控えと同じ場所に置く。
  const settingsPath = realRoot ? path.join(backupDir, 'settings', `${rootId}.json`) : null
  // 「開いているノートをAIに伝える」。最初はオフ。フォルダーごとに、どのタブからも同じ値を使う。
  const sharePath = realRoot ? path.join(backupDir, 'settings', `${rootId}.share.json`) : null
  const readShare = () => {
    try {
      return JSON.parse(fs.readFileSync(sharePath, 'utf8'))?.on === true
    } catch {
      return false
    }
  }
  const conflict = (body) => Object.assign(new Error(body.message), { status: 409, body })
  const settingsView = (settings) => ({
    attachmentDir: settings.attachmentDir,
    periodic: settings.periodic,
    errors: settings.errors.map((error) => error.message),
    defaultAttachmentDir: DEFAULT_ATTACHMENT_DIR,
  })
  // 日付ごとのノートの置き場。決まっていない、または設定が読めないときは作らない。
  const loadPeriodic = () => {
    const settings = readVaultSettings(settingsPath, realRoot)
    const problems = settings.errors.filter((error) => error.field !== 'attachmentDir')
    if (problems.length) throw conflict({ error: 'bad-settings', message: problems.map((error) => error.message).join('。') })
    if (!settings.periodic) throw conflict({ error: 'no-periodic-root', message: NO_PERIODIC })
    return settings.periodic
  }
  // 画像の置き場。決めていなければ attachments。決めた場所が使えない、または設定が読めないときは、ほかの場所に入れずに止める。
  const attachmentFolder = () => {
    const settings = readVaultSettings(settingsPath, realRoot)
    const problems = settings.errors.filter((error) => error.field !== 'periodic')
    if (problems.length) throw conflict({ error: 'bad-settings', message: problems.map((error) => error.message).join('。') })
    return settings.attachmentDir ?? DEFAULT_ATTACHMENT_DIR
  }
  // 控えの名前は、ノートのディスクの上の実際の名前で決める。リンクから大文字小文字や濁点の書き方が違う名前で
  // 開いても同じ「履歴」に入り、大文字小文字を区別するドライブでは別のノートが混ざらない。
  const onDisk = (rel) => {
    try {
      const real = path.relative(nativeRoot, fs.realpathSync.native(resolveNotePath(realRoot, rel)))
      if (real === '' || real === '..' || real.startsWith(`..${path.sep}`) || path.isAbsolute(real)) return rel
      return real.split(path.sep).join('/')
    } catch {
      return rel
    }
  }
  const backups = store
    ? {
        save: (rel, text, kind) => store.save(onDisk(rel), text, kind),
        snapshot: (rel, text) => store.snapshot(onDisk(rel), text),
        list: (rel) => store.list(onDisk(rel)),
        read: (rel, id) => store.read(onDisk(rel), id),
        // 動かしたあとに呼ばれる。元の名前はそろえずに使う（ファイル欄の名前はディスクの上の名前）。
        // そろえると、大文字小文字だけを変えた名前の変更で、元の名前が新しい名前に直されて、履歴が移らない。
        rename: (from, to) => store.rename(from, onDisk(to)),
        // 書きかけの下書き。ノートがなくても、名前の決め方は控えと同じ。
        readDraft: (rel) => store.readDraft(onDisk(rel)),
        writeDraft: (rel, draft) => store.writeDraft(onDisk(rel), draft),
        clearDraft: (rel) => store.clearDraft(onDisk(rel)),
        clearDraftIfTypedBefore: (rel, typedAt) => store.clearDraftIfTypedBefore(onDisk(rel), typedAt),
      }
    : null
  // 控えを片付ける。どのフォルダーの目印の下も見るので、フォルダーを移したり替えたりしたあとの古い控えも、
  // 期限が来れば消える。前の置き方（目印なし、控えの場所の直下）の控えも同じ。「履歴」には出さない。
  function prune() {
    if (!realRoot) return
    pruneBackups(backupDir)
  }
  let notesCache = null
  let notesCachedAt = 0

  function notes() {
    if (!notesCache || Date.now() - notesCachedAt > 10_000) {
      const visible = (list) => list.filter((rel) => !isOutsideMarker(rel))
      // notes は一覧と「探す」に出すノート、known はリンクの行き先に使うノート。今は同じもの。
      const all = visible(listNotes(realRoot))
      notesCache = {
        notes: all,
        known: all,
        folders: visible(listFolders(realRoot)),
      }
      notesCachedAt = Date.now()
    }
    return notesCache
  }

  // The host-attached path only says which file was opened. Whether it may be edited is decided here.
  function locate(hostPath) {
    if (!realRoot || typeof hostPath !== 'string' || !path.isAbsolute(hostPath)) return null
    let real
    try {
      real = fs.realpathSync(hostPath)
    } catch {
      return null
    }
    if (!real.startsWith(realRoot + path.sep)) return null
    // Windowsでは区切りが \ なので、ほかの場所と同じ / の形にそろえる（そろえないと、開いたノートの名前と比べられない）。
    const slashed = (value) => value.split(path.sep).join('/')
    const rel = slashed(path.relative(realRoot, real))
    if (isOutsideMarker(rel)) return null
    // A link inside the folder that points elsewhere in it must not change which note is being edited.
    const asOpened = slashed(path.relative(realRoot, path.resolve(hostPath)))
    const asOpenedViaRoot = slashed(path.relative(root, path.resolve(hostPath)))
    if (spelled(asOpened) !== spelled(rel) && spelled(asOpenedViaRoot) !== spelled(rel)) return null
    try {
      resolveNotePath(realRoot, rel)
      return rel
    } catch {
      return null
    }
  }

  function route(method, url, body, { editable, opened }) {
    const rel = url.searchParams.get('path')
    if (isOutsideMarker(rel)) throw new Error('path not allowed')
    // ファイル欄の移動は、元と先の両方を確かめる。
    for (const item of [url.searchParams.get('from'), url.searchParams.get('to'), body?.from, body?.to]) {
      if (isOutsideMarker(item)) throw new Error('path not allowed')
    }
    // The user chose the folder at install, so a panel opened inside it may edit its notes.
    // Saving needs the hash of the current file, so a note that was not read, or changed since, is not overwritten.
    // 日付のノートがあるかを調べるだけ（dryRun）なら、何も書かないので書き込めないタブでも答える。
    const probe = url.pathname === '/api/periodic/open' && body?.dryRun === true
    const write = method !== 'GET' && !probe
    if (write && !editable) return [403, { error: 'read only' }]
    switch (`${method} ${url.pathname}`) {
      case 'GET /api/health':
        return [200, { ok: true, root: realRoot ? path.basename(realRoot) : '', rootId, rootPaths: realRoot ? [realRoot] : [] }]
      case 'GET /api/note':
      {
        const note = readNote(realRoot, rel)
        // Say so up front, so nobody types into a note this panel cannot save.
        return [200, editable ? note : { ...note, editable: false, reason: note.reason ?? 'outside-tab' }]
      }
      case 'PUT /api/note': {
        const { text, baseHash } = body
        const saved = writeNote(realRoot, rel, text, baseHash, backups)
        // 保存できたら、その保存より前に打った下書きを消す。消せなくても保存の応答は変えない。
        if (!saved.conflict && typeof body.typedAt === 'number') {
          try {
            backups?.clearDraftIfTypedBefore(rel, body.typedAt)
          } catch {}
        }
        return [saved.conflict ? 409 : 200, saved]
      }
      // 書きかけの下書き。ノートがなくても書ける。パスだけを確かめ、ノートは読まない。
      case 'GET /api/draft': {
        resolveNotePath(realRoot, rel)
        if (url.searchParams.get('root') !== rootId) return [200, { draft: null }]
        return [200, { draft: backups.readDraft(rel) }]
      }
      case 'PUT /api/draft': {
        resolveNotePath(realRoot, rel)
        if (url.searchParams.get('root') !== rootId) return [200, { ok: false, reason: 'other-root' }]
        const draft = body?.draft
        // 時刻は、あるなら有限の数でなければ断る（比べられない時刻の下書きを置かないため）。
        const timeOk = (value) => value === undefined || (typeof value === 'number' && Number.isFinite(value))
        const valid =
          draft !== null &&
          typeof draft === 'object' &&
          !Array.isArray(draft) &&
          typeof draft.text === 'string' &&
          typeof draft.baseText === 'string' &&
          timeOk(draft.time) &&
          timeOk(draft.savedAt) &&
          Buffer.byteLength(draft.text, 'utf8') <= MAX_NOTE_BYTES &&
          Buffer.byteLength(draft.baseText, 'utf8') <= MAX_NOTE_BYTES
        if (!valid) return [400, { error: 'bad draft' }]
        // 決まった項目だけを残す（ほかの項目は捨てる）。
        const kept = { text: draft.text, baseText: draft.baseText }
        if (typeof draft.baseHash === 'string') kept.baseHash = draft.baseHash
        if (draft.time !== undefined) kept.time = draft.time
        if (draft.savedAt !== undefined) kept.savedAt = draft.savedAt
        backups.writeDraft(rel, kept)
        return [200, { ok: true }]
      }
      case 'POST /api/draft/clear': {
        resolveNotePath(realRoot, rel)
        if (url.searchParams.get('root') !== rootId) return [200, { ok: false, reason: 'other-root' }]
        backups.clearDraft(rel)
        return [200, { ok: true }]
      }
      // Always empty, and an existing note is refused, so this can never replace text.
      case 'POST /api/note': {
        const created = createNote(realRoot, rel, '')
        notesCache = null
        // 前に同じ名前でエディターの外から消したノートの下書きが残っていると、新しいノートで「反映しますか？」が出るので消す。
        // 消せなくても、作れたことは変えない。
        try {
          backups?.clearDraft(rel)
        } catch {}
        return [201, created]
      }
      // Only for Cmd+Click, which hands a note in the folder to the host to open in its own tab.
      // A missing note gets 404, so the panel offers to create it in this tab instead of a dead end.
      case 'GET /api/absolute': {
        const file = resolveNotePath(realRoot, rel)
        if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return [404, { error: 'not found' }]
        return [200, { path: file }]
      }
      case 'GET /api/notes':
        return [200, { ...notes(), canCreate: editable }]
      case 'GET /api/fingerprint':
        return [200, { fingerprint: fingerprint(resolveNotePath(realRoot, rel)) }]
      case 'GET /api/file': {
        const file = resolveAssetPath(realRoot, rel)
        if (fs.statSync(file).size > MAX_READ_BYTES) throw tooLarge()
        return [200, { base64: fs.readFileSync(file).toString('base64'), mime: MIME[path.extname(file).toLowerCase()] }]
      }
      case 'POST /api/backup':
        readNote(realRoot, rel)
        if (typeof body?.text !== 'string') return [400, { error: 'text required' }]
        if (Buffer.byteLength(body.text, 'utf8') > MAX_NOTE_BYTES) throw tooLarge()
        backups.save(rel, body.text, 'conflict')
        return [200, { ok: true }]
      case 'GET /api/backups':
        readNote(realRoot, rel)
        return [200, { backups: backups.list(rel) }]
      case 'GET /api/backup': {
        readNote(realRoot, rel)
        const text = backups.read(rel, url.searchParams.get('id'))
        return text === null ? [404, { error: 'not found' }] : [200, { text }]
      }
      case 'POST /api/attachment': {
        const name = path.basename(url.searchParams.get('name') ?? 'image.png')
        const ext = path.extname(name).toLowerCase()
        const stem = path.basename(name, ext).replace(/[^\p{L}\p{N}_-]+/gu, '-') || 'image'
        const now = new Date()
        const stamp = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().replace(/\D/g, '').slice(0, 14)
        const target = `${attachmentFolder()}/${stem}-${stamp}${ext}`
        const file = resolveAssetPath(realRoot, target)
        if (typeof body?.base64 !== 'string') return [400, { error: 'base64 required' }]
        // 大きすぎるものは、元の形に戻す前に断る（戻すだけでメモリーを使うため）。
        if (body.base64.length > Math.ceil(MAX_ATTACHMENT / 3) * 4 + 4) throw tooLarge()
        const bytes = Buffer.from(body.base64, 'base64')
        if (bytes.length > MAX_ATTACHMENT) throw tooLarge()
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, bytes, { flag: 'wx' })
        return [201, { path: target }]
      }
      // ファイル欄の操作。どれもVaultの中だけで、隠しフォルダーと外は resolveInside が断る。
      case 'POST /api/folder':
        createFolder(realRoot, rel)
        notesCache = null
        return [201, { path: rel }]
      case 'GET /api/item': {
        const full = resolveInside(realRoot, rel)
        if (!fs.statSync(full).isDirectory()) return [200, { isFolder: false, notes: 1, others: 0 }]
        // フォルダーを消す前に、中のノートとほかのファイル（画像など）の数を知らせる。
        let notesInside = 0
        let others = 0
        const walk = (dir) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.')) continue
            if (entry.isDirectory()) walk(path.join(dir, entry.name))
            else if (entry.name.toLowerCase().endsWith('.md')) notesInside += 1
            else others += 1
          }
        }
        walk(full)
        return [200, { isFolder: true, notes: notesInside, others }]
      }
      case 'GET /api/move-plan': {
        const plan = planMove(realRoot, url.searchParams.get('from'), url.searchParams.get('to'))
        return [200, { notes: plan.changes.map((change) => change.from), blocked: plan.blocked }]
      }
      case 'POST /api/move': {
        // Codexはこのタブを開いたノートの場所を覚えているので、動かすとこのタブで保存できなくなる。
        if (holdsOpened(body.from, opened)) return [409, { error: 'opened note' }]
        const result = moveItem(realRoot, body.from, body.to, { rewrite: Boolean(body.rewrite), backups })
        notesCache = null
        return [200, result]
      }
      case 'POST /api/trash': {
        if (holdsOpened(rel, opened)) return [409, { error: 'opened note' }]
        const trashDir = process.env.NOTEDOCK_TRASH_DIR || null
        // ゴミ箱に入れると名前を引けなくなるので、中のノートの下書きの名前は先に決めておく。
        const inside = backups
          ? listNotes(realRoot)
              .filter((note) => movedPath(note, rel, rel, true) !== null)
              .map((note) => onDisk(note))
          : []
        const dest = trashItem(realRoot, rel, { trashDir })
        for (const note of inside) {
          try {
            store.clearDraft(note)
          } catch {}
        }
        notesCache = null
        return [200, { trashed: path.basename(dest) }]
      }
      // 日付のノート。決まりはClaude用の NoteDock と同じ。
      case 'GET /api/periodic': {
        const settings = readVaultSettings(settingsPath, realRoot)
        const problems = settings.errors.filter((error) => error.field !== 'attachmentDir')
        const month = periodicMonth(realRoot, url.searchParams.get('month'), problems.length ? null : settings.periodic)
        // 設定が壊れているときは、「決まっていない」ではなく、その理由を画面に出す。
        return [200, problems.length ? { ...month, message: problems.map((error) => error.message).join('。') } : month]
      }
      case 'POST /api/periodic/open': {
        const opened = openPeriodic(realRoot, body, loadPeriodic)
        if (body?.dryRun === true) return [200, opened]
        notesCache = null
        return [opened.created ? 201 : 200, opened]
      }
      case 'GET /api/settings':
        return [200, settingsView(readVaultSettings(settingsPath, realRoot))]
      case 'PUT /api/settings': {
        const settings = checkVaultSettings(realRoot, body)
        try {
          writeVaultSettings(settingsPath, settings)
        } catch {
          // 応答にファイルの場所が入らないよう、理由はまとめて返す。
          return [500, { error: 'settings-write-failed', message: '設定を保存できませんでした' }]
        }
        return [200, settingsView(readVaultSettings(settingsPath, realRoot))]
      }
      case 'GET /api/share':
        return [200, { on: readShare() }]
      case 'PUT /api/share': {
        if (typeof body?.on !== 'boolean') return [400, { error: 'bad-share', message: 'on は true か false で指定してください' }]
        try {
          writeVaultSettings(sharePath, { on: body.on })
        } catch {
          return [500, { error: 'share-write-failed', message: '設定を保存できませんでした' }]
        }
        return [200, { on: readShare() }]
      }
      default:
        return [404, { error: 'not found' }]
    }
  }

  return {
    rootId,
    settingsPath,
    locate,
    // A panel opened on a file: editable only when the file is a note in the folder, and that note stays put.
    scopeOf(hostPath) {
      const opened = locate(hostPath)
      return { editable: Boolean(opened), opened }
    },
    prune,
    request(method, target, body, scope = { editable: false, opened: null }) {
      if (!realRoot) return { status: 403, data: { error: 'no folder configured' } }
      // Older callers pass the opened note's path (or null) instead of a scope.
      if (scope === null || typeof scope === 'string') scope = { editable: Boolean(scope), opened: scope }
      try {
        const [status, data] = route(method, new URL(target, 'http://panel.invalid'), body, scope)
        return { status, data }
      } catch (error) {
        // 日付のノートの依頼の誤り（400）と、設定ファイルの誤り（409、理由つき）。
        // 自分で付けた HTTP の番号だけをそのまま使う（コマンドの終了コードなどは番号として使わない）。
        if (Number.isInteger(error.status) && error.status >= 400 && error.status < 600) return { status: error.status, data: error.body ?? { error: error.message } }
        // ファイルの操作のエラーは、種類だけを返す（文にはファイルの場所がそのまま入っているため）。
        if (error.code && error.syscall) return { status: statusOf(error), data: { error: error.code, code: error.code } }
        // ここまで来たものは、自分で決めた短い文だけを返す。ほかの文にはファイルの場所が入っていることがある。
        const status = statusOf(error)
        return { status, data: { error: status === 500 ? 'server error' : error.message } }
      }
    },
  }
}
