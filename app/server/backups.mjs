import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DAY = 24 * 60 * 60 * 1000
const KEEP = { previous: DAY, snapshot: 7 * DAY, conflict: 7 * DAY }
const SNAPSHOT_GAP = 5 * 60 * 1000
const MAX_PREVIOUS = 200
// パネルの localStorage の下書きの期限（src/drafts.mjs の DRAFT_DAYS）と同じ日数にしておく。変えるときは両方を変える。
const DRAFT_KEEP = 30 * DAY
const DRAFT_TMP_KEEP = DAY
const DRAFT_NAME = 'draft.json'
const DRAFT_TMP = /^\.draft-.*\.tmp$/
const BACKUP_NAME = /^(previous|snapshot|conflict)-(\d+)-\d+\.md$/

// 控えのフォルダーの名前は、ノートの場所から作る。綴りの違い（大文字小文字、濁点の書き方）は、
// 呼ぶ側（core.mjs）がディスクの上の実際の名前にそろえてから渡す。ここで文字だけでそろえると、
// 大文字小文字を区別するドライブで、別々のノートの控えが混ざるため。
export function createBackups(dir, { now = Date.now } = {}) {
  let counter = 0
  const folder = (rel) => path.join(dir, crypto.createHash('sha1').update(rel).digest('hex').slice(0, 20))

  function entries(rel) {
    let names
    try {
      names = fs.readdirSync(folder(rel))
    } catch {
      return []
    }
    return names
      .flatMap((name) => {
        const match = name.match(BACKUP_NAME)
        return match ? [{ name, kind: match[1], time: Number(match[2]) }] : []
      })
      .sort((a, b) => b.time - a.time)
  }

  function save(rel, text, kind) {
    const target = folder(rel)
    const prepare = () => {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(target, '_path.txt'), rel)
    }
    prepare()
    const latest = entries(rel).find((entry) => entry.kind === kind)
    // 読み比べる直前に、ほかのエディターの片付けがその控えを消していたら、違う中身とみなして書く。
    let same = false
    try {
      same = Boolean(latest) && fs.readFileSync(path.join(target, latest.name), 'utf8') === text
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (same) return
    counter += 1
    const file = path.join(target, `${kind}-${now()}-${counter}.md`)
    try {
      fs.writeFileSync(file, text, { mode: 0o600 })
    } catch (error) {
      // ほかのエディターの片付けが、ちょうどこのフォルダーを消したところ。作り直して1回だけやり直す。
      if (error.code !== 'ENOENT') throw error
      prepare()
      fs.writeFileSync(file, text, { mode: 0o600 })
    }
    if (kind === 'previous') {
      for (const old of entries(rel).filter((entry) => entry.kind === 'previous').slice(MAX_PREVIOUS)) {
        fs.rmSync(path.join(target, old.name), { force: true })
      }
    }
  }

  function snapshot(rel, text) {
    const latest = entries(rel).find((entry) => entry.kind === 'snapshot')
    if (latest && now() - latest.time < SNAPSHOT_GAP) return false
    save(rel, text, 'snapshot')
    return true
  }

  function list(rel) {
    return entries(rel).map((entry) => ({
      id: entry.name,
      kind: entry.kind,
      time: entry.time,
    }))
  }

  function read(rel, id) {
    if (!entries(rel).some((entry) => entry.name === id)) return null
    return fs.readFileSync(path.join(folder(rel), id), 'utf8')
  }

  function prune() {
    let folders
    try {
      folders = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of folders) {
      if (!item.isDirectory()) continue
      const base = path.join(dir, item.name)
      // もう1つのエディターが同時に片付けて、フォルダーが消えていることがある。止まらずに次へ進む。
      try {
        for (const name of fs.readdirSync(base)) {
          const match = name.match(BACKUP_NAME)
          if (match && now() - Number(match[2]) > KEEP[match[1]]) fs.rmSync(path.join(base, name), { force: true })
          // 下書きは更新時刻から30日、書きかけの一時ファイルは1日で片付ける。
          const limit = name === DRAFT_NAME ? DRAFT_KEEP : DRAFT_TMP.test(name) ? DRAFT_TMP_KEEP : 0
          if (limit) {
            try {
              if (now() - fs.statSync(path.join(base, name)).mtimeMs > limit) fs.rmSync(path.join(base, name), { force: true })
            } catch (error) {
              if (error.code !== 'ENOENT') throw error
            }
          }
        }
        // 控えが1つも残っていないノートのフォルダーは片付ける（どのノートかを書いた _path.txt だけのもの、または空）。
        // フォルダーごとまとめて消すと、その間にほかのエディターが書いた控えまで消してしまうので、
        // _path.txt だけを消してから、空のときにだけ消える消し方でフォルダーを消す。
        const left = fs.readdirSync(base)
        if (left.length === 0 || (left.length === 1 && left[0] === '_path.txt')) {
          if (left.length === 1) fs.rmSync(path.join(base, '_path.txt'), { force: true })
          fs.rmdirSync(base)
        }
      } catch {}
    }
  }

  // ノートを動かしたり名前を変えたりしたときに、履歴も新しい場所へ移す。
  function rename(from, to) {
    const source = folder(from)
    const target = folder(to)
    if (source === target) return
    // 移動元に下書きがないのに移動先にあれば、それは前のノートの古い下書き。残すと別のノートに混ざる。
    if (!fs.existsSync(path.join(source, DRAFT_NAME))) fs.rmSync(path.join(target, DRAFT_NAME), { force: true })
    if (!fs.existsSync(source)) return
    fs.mkdirSync(target, { recursive: true, mode: 0o700 })
    for (const name of fs.readdirSync(source)) {
      if (name !== '_path.txt') fs.renameSync(path.join(source, name), path.join(target, name))
    }
    fs.writeFileSync(path.join(target, '_path.txt'), to)
    fs.rmSync(source, { recursive: true, force: true })
  }

  // 下書き（まだ保存していない打ちかけの本文）。ノートごとのフォルダーに draft.json として置く。
  function readDraft(rel) {
    try {
      const draft = JSON.parse(fs.readFileSync(path.join(folder(rel), DRAFT_NAME), 'utf8'))
      if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return null
      if (typeof draft.text !== 'string' || typeof draft.baseText !== 'string') return null
      return draft
    } catch {
      return null
    }
  }

  function writeDraft(rel, draft) {
    const target = folder(rel)
    const body = JSON.stringify(draft)
    const attempt = () => {
      const tmp = path.join(target, `.draft-${crypto.randomBytes(6).toString('hex')}.tmp`)
      try {
        fs.writeFileSync(tmp, body, { flag: 'wx', mode: 0o600 })
        fs.renameSync(tmp, path.join(target, DRAFT_NAME))
      } catch (error) {
        fs.rmSync(tmp, { force: true })
        throw error
      }
    }
    fs.mkdirSync(target, { recursive: true, mode: 0o700 })
    try {
      attempt()
    } catch (error) {
      // ほかのエディターの片付けが、ちょうどこのフォルダーを消したところ。作り直して1回だけやり直す。
      if (error.code !== 'ENOENT') throw error
      fs.mkdirSync(target, { recursive: true, mode: 0o700 })
      attempt()
    }
  }

  function clearDraft(rel) {
    fs.rmSync(path.join(folder(rel), DRAFT_NAME), { force: true })
  }

  function clearDraftIfTypedBefore(rel, typedAt) {
    const draft = readDraft(rel)
    if (!draft || typeof draft.time !== 'number' || draft.time > typedAt) return false
    clearDraft(rel)
    return true
  }

  return { rename, save, snapshot, list, read, prune, readDraft, writeDraft, clearDraft, clearDraftIfTypedBefore }
}
