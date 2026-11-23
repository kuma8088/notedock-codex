import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { createResolver, isUsed, locateIn, nativeOf, pruneRecords, rootIdOf, sandboxCwdOf, tooBroad, writeRecord } from '../server/folders.mjs'

// 本物のホームの代わりに、一時的なフォルダーの中に「ホーム」を作る（~/Library などの規則を試すため）。
function world(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folders-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const home = path.join(base, 'home')
  const backupDir = path.join(home, 'Library/Application Support/NoteDockCodex')
  fs.mkdirSync(backupDir, { recursive: true })
  const note = (rel, text = '# x\n') => {
    const file = path.join(home, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
    return file
  }
  const resolver = (options = {}) => createResolver({ backupDir, home, ttlMs: 0, ...options })
  const sandbox = (folder) => ({ 'codex/sandbox-state': { sandboxCwd: pathToFileURL(folder).href } })
  return { base, home, backupDir, note, resolver, sandbox }
}

test('広すぎる：ホーム・それを含むもの・ホームの外の上2階層・隠し・Library・Documents の決まった所・控えの置き場', (t) => {
  const { home, backupDir } = world(t)
  const o = { home, backupDir }
  const h = (rel) => path.join(home, rel)
  assert.equal(tooBroad(home, o), 'home')
  assert.equal(tooBroad(path.dirname(home), o), 'home')
  assert.equal(tooBroad('/', o), 'home')
  assert.equal(tooBroad('/Volumes/x', o), 'top')
  assert.equal(tooBroad('/Volumes', o), 'top')
  assert.equal(tooBroad('/Volumes/x/y', o), null)
  assert.equal(tooBroad(h('.codex'), o), 'hidden')
  assert.equal(tooBroad(h('.config/notes'), o), 'hidden')
  assert.equal(tooBroad(h('proj/.git'), o), 'hidden')
  assert.ok(tooBroad(h('Library'), o))
  assert.equal(tooBroad(h('Library/Mobile Documents'), o), 'library')
  assert.equal(tooBroad(h('Library/Mobile Documents/iCloud~md~obsidian'), o), 'library')
  assert.equal(tooBroad(h('Library/Mobile Documents/iCloud~md~obsidian/Vault'), o), null)
  assert.equal(tooBroad(h('Library/CloudStorage/GoogleDrive-a'), o), 'library')
  assert.equal(tooBroad(h('Library/CloudStorage/GoogleDrive-a/My Drive'), o), null)
  assert.equal(tooBroad(h('Library/Caches/x/y'), o), 'library')
  assert.equal(tooBroad(h('Documents'), o), 'documents')
  assert.equal(tooBroad(h('Documents/Codex'), o), 'documents')
  assert.equal(tooBroad(h('Documents/Codex/2026-11-23'), o), 'documents')
  assert.equal(tooBroad(h('Documents/Codex/something'), o), 'documents')
  assert.equal(tooBroad(h('Documents/Codex/2026-11-23/talk'), o), null)
  assert.equal(tooBroad(h('Documents/notes'), o), null)
  assert.equal(tooBroad(h('srv/vault'), o), null)
  // 控えの置き場を含むフォルダーと、その中。
  const outsideHome = { home, backupDir: '/private/tmp-x/a/b/backups' }
  assert.equal(tooBroad('/private/tmp-x/a/b', outsideHome), 'backups')
  assert.equal(tooBroad('/private/tmp-x/a/b/backups/sub', outsideHome), 'backups')
})

test('広すぎる：Codex の worktree は、worktrees そのものとすぐ下を断り、さらに下を認める（CODEX_HOME がほかの隠しフォルダーでも）', (t) => {
  const { home, backupDir } = world(t)
  const o = { home, backupDir }
  const h = (rel) => path.join(home, rel)
  assert.equal(tooBroad(h('.codex/worktrees'), o), 'hidden')
  assert.equal(tooBroad(h('.codex/worktrees/a1b2'), o), 'hidden')
  assert.equal(tooBroad(h('.codex/worktrees/a1b2/repo'), o), null)
  assert.equal(tooBroad(h('.codex/worktrees/a1b2/repo/docs'), o), null)
  assert.equal(tooBroad(h('.other-codex/worktrees/a1b2/repo'), o), null)
  assert.equal(tooBroad(h('.codex/worktrees/a1b2/.hidden'), o), 'hidden')
  assert.equal(tooBroad(h('.codex/sessions/a/b'), o), 'hidden')
  assert.equal(tooBroad(h('work/.codex/worktrees/a/b'), o), 'hidden')
})

test('広すぎる：大文字小文字だけを変えた綴り（~/documents・~/LIBRARY）でも、3つの候補すべてで規則を素通りしない', (t) => {
  const { home, backupDir, note, resolver, sandbox } = world(t)
  const lower = path.join(home, 'documents')
  // 大文字小文字を区別するディスクでは、この試験は意味がない（別のフォルダーになる）。
  note('Documents/d.md')
  if (!fs.existsSync(path.join(lower, 'd.md'))) return t.skip('大文字小文字を区別するディスク')
  note('LIBRARY/Caches/x/n.md')
  const o = { home, backupDir }
  assert.equal(tooBroad(lower, o), 'documents')
  assert.ok(tooBroad(path.join(home, 'LIBRARY'), o))
  assert.equal(tooBroad(path.join(home, 'LIBRARY/caches'), o), 'library')
  assert.equal(tooBroad(path.join(home, 'library/application support/notedockcodex'), o), 'backups')
  const viaLower = path.join(lower, 'd.md')
  assert.equal(resolver().decide(viaLower, sandbox(lower)).editable, false)
  assert.equal(resolver({ noteRoot: lower }).decide(viaLower, undefined).editable, false)
  fs.mkdirSync(path.join(backupDir, 'settings'), { recursive: true })
  fs.writeFileSync(path.join(backupDir, 'settings', `${rootIdOf(nativeOf(path.join(home, 'Documents')))}.json`), '{}')
  const used = resolver().decide(viaLower, undefined)
  assert.equal(used.editable, false)
  assert.ok(used.reasons.includes('used-too-broad'))
  assert.equal(resolver().decide(path.join(home, 'LIBRARY/Caches/x/n.md'), sandbox(path.join(home, 'LIBRARY/Caches/x'))).editable, false)
})

test('sandboxCwd の読み方：ない・形が読めない・file: の URI', () => {
  assert.deepEqual(sandboxCwdOf(undefined), { kind: 'none' })
  assert.deepEqual(sandboxCwdOf({}), { kind: 'none' })
  assert.deepEqual(sandboxCwdOf({ 'codex/sandbox-state': {} }), { kind: 'none' })
  assert.deepEqual(sandboxCwdOf({ 'codex/sandbox-state': 'x' }), { kind: 'invalid' })
  assert.deepEqual(sandboxCwdOf({ 'codex/sandbox-state': { sandboxCwd: '/Users/a' } }), { kind: 'invalid' })
  assert.deepEqual(sandboxCwdOf({ 'codex/sandbox-state': { sandboxCwd: 'https://x/y' } }), { kind: 'invalid' })
  assert.deepEqual(sandboxCwdOf({ 'codex/sandbox-state': { sandboxCwd: 'file://host/x' } }), { kind: 'invalid' })
  assert.deepEqual(sandboxCwdOf({ 'codex/sandbox-state': { sandboxCwd: 'file:///' } }), { kind: 'path', path: '/' })
  assert.deepEqual(sandboxCwdOf({ 'codex/sandbox-state': { sandboxCwd: 'file:///Users/a/%E3%83%8E' } }), { kind: 'path', path: '/Users/a/ノ' })
  assert.deepEqual(sandboxCwdOf({ 'codex/sandbox-state-meta': { sandboxCwd: 'file:///x/y/z' } }), { kind: 'path', path: '/x/y/z' })
})

test('プロジェクトの会話：sandboxCwd の中のノートは編集できる。外は読むだけ', (t) => {
  const { home, note, resolver, sandbox } = world(t)
  const inside = note('projects/a/docs/n.md')
  const outside = note('projects/b/m.md')
  const r = resolver()
  const got = r.decide(inside, sandbox(path.join(home, 'projects/a')))
  assert.equal(got.editable, true)
  assert.equal(got.source, 'sandbox')
  assert.equal(got.path, 'docs/n.md')
  assert.equal(got.rootId, rootIdOf(nativeOf(path.join(home, 'projects/a'))))
  const out = r.decide(outside, sandbox(path.join(home, 'projects/a')))
  assert.equal(out.editable, false)
  assert.ok(out.reasons.includes('sandbox-outside'))
})

test('プロジェクトなしの会話：作業フォルダー（~/Documents/Codex/日付/名前）の中の .md は編集できる', (t) => {
  const { home, note, resolver, sandbox } = world(t)
  const work = path.join(home, 'Documents/Codex/2026-11-23/talk')
  const file = note('Documents/Codex/2026-11-23/talk/memo.md')
  const got = resolver().decide(file, sandbox(work))
  assert.equal(got.editable, true)
  assert.equal(got.source, 'sandbox')
  assert.equal(got.path, 'memo.md')
  // 作業フォルダーの外のノートは、使ったことがなければ読むだけ。
  const vault = note('vault/Home.md')
  assert.equal(resolver().decide(vault, sandbox(work)).editable, false)
})

test('会話の前（sandboxCwd が /）：広すぎるので飛ばし、使ったことがなければ読むだけ', (t) => {
  const { note, resolver } = world(t)
  const file = note('vault/Home.md')
  const got = resolver().decide(file, { 'codex/sandbox-state': { sandboxCwd: 'file:///' } })
  assert.equal(got.editable, false)
  assert.ok(got.reasons.includes('sandbox-too-broad'))
  assert.equal(resolver().decide(file, undefined).editable, false)
  assert.ok(resolver().decide(file, undefined).reasons.includes('sandbox-none'))
  assert.ok(resolver().decide(file, { 'codex/sandbox-state': { sandboxCwd: 'nope' } }).reasons.includes('sandbox-invalid'))
})

test('使ったことのあるフォルダー：設定ファイルか記録があれば、会話の前でも編集できる。いちばん内側を採る', (t) => {
  const { home, backupDir, note, resolver } = world(t)
  const file = note('srv/outer/inner/docs/n.md')
  const outer = nativeOf(path.join(home, 'srv/outer'))
  const inner = nativeOf(path.join(home, 'srv/outer/inner'))
  const slash = { 'codex/sandbox-state': { sandboxCwd: 'file:///' } }
  assert.equal(resolver().decide(file, slash).editable, false)
  // 外側は今の設定ファイルだけ（記録がない）、内側は新しい記録。
  fs.mkdirSync(path.join(backupDir, 'settings'), { recursive: true })
  fs.writeFileSync(path.join(backupDir, 'settings', `${rootIdOf(outer)}.json`), '{}')
  const a = resolver().decide(file, slash)
  assert.equal(a.source, 'used')
  assert.equal(a.path, 'inner/docs/n.md')
  writeRecord(backupDir, inner)
  const b = resolver().decide(file, slash)
  assert.equal(b.source, 'used')
  assert.equal(b.path, 'docs/n.md')
  assert.equal(b.rootId, rootIdOf(inner))
  // 控えのフォルダーだけでは数えない。
  fs.mkdirSync(path.join(backupDir, rootIdOf(nativeOf(path.join(home, 'srv')))), { recursive: true })
  assert.equal(isUsed(backupDir, nativeOf(path.join(home, 'srv'))), false)
})

test('使ったことのあるフォルダー：記録の path が違えば数えない。広すぎるものは飛ばして1つ外側を見る', (t) => {
  const { home, backupDir, note, resolver } = world(t)
  const file = note('Documents/Codex/2026-11-23/talk/sub/n.md')
  const talk = nativeOf(path.join(home, 'Documents/Codex/2026-11-23/talk'))
  fs.mkdirSync(path.join(backupDir, 'settings'), { recursive: true })
  fs.writeFileSync(path.join(backupDir, 'settings', `${rootIdOf(talk)}.root.json`), JSON.stringify({ path: '/elsewhere' }))
  fs.writeFileSync(path.join(backupDir, 'settings', `${rootIdOf(talk)}.json`), '{}')
  assert.equal(isUsed(backupDir, talk), false)
  assert.equal(resolver().decide(file, undefined).editable, false)
  // 広すぎる（~/Documents/Codex/日付）だけが使ったことがある：飛ばして、ほかになければ読むだけ。
  const day = nativeOf(path.join(home, 'Documents/Codex/2026-11-23'))
  writeRecord(backupDir, day)
  const got = resolver().decide(file, undefined)
  assert.equal(got.editable, false)
  assert.ok(got.reasons.includes('used-too-broad'))
})

test('worktree の例外は、使ったことのあるフォルダーとして当たる場合にも同じ規則', (t) => {
  const { home, backupDir, note, resolver } = world(t)
  const file = note('.codex/worktrees/a1b2/repo/docs/n.md')
  const tree = nativeOf(path.join(home, '.codex/worktrees/a1b2'))
  const repo = nativeOf(path.join(home, '.codex/worktrees/a1b2/repo'))
  writeRecord(backupDir, tree)
  const refused = resolver().decide(file, undefined)
  assert.equal(refused.editable, false)
  assert.ok(refused.reasons.includes('used-too-broad'))
  writeRecord(backupDir, repo)
  const got = resolver().decide(file, undefined)
  assert.equal(got.source, 'used')
  assert.equal(got.path, 'docs/n.md')
  // sandboxCwd として届いた worktree も認める。worktrees のすぐ下は断る。
  const viaCwd = resolver({}).decide(file, { 'codex/sandbox-state': { sandboxCwd: pathToFileURL(repo).href } })
  assert.equal(viaCwd.source, 'sandbox')
  const broad = createResolver({ backupDir: path.join(home, 'other-backups'), home, ttlMs: 0 }).decide(file, { 'codex/sandbox-state': { sandboxCwd: pathToFileURL(tree).href } })
  assert.equal(broad.editable, false)
  assert.ok(broad.reasons.includes('sandbox-too-broad'))
})

test('NOTE_ROOT が先：両方に含まれるときは NOTE_ROOT。見つからない・広すぎるときは飛ばして理由を残す', (t) => {
  const { home, note, resolver, sandbox } = world(t)
  const file = note('vault/sub/n.md')
  const vault = path.join(home, 'vault')
  const both = resolver({ noteRoot: vault }).decide(file, sandbox(path.join(vault, 'sub')))
  assert.equal(both.source, 'note-root')
  assert.equal(both.path, 'sub/n.md')
  const missing = resolver({ noteRoot: path.join(home, 'gone') }).decide(file, sandbox(path.join(vault, 'sub')))
  assert.equal(missing.source, 'sandbox')
  assert.ok(!missing.reasons)
  const r = resolver({ noteRoot: path.join(home, 'gone') }).decide(file, undefined)
  assert.ok(r.reasons.includes('note-root-missing'))
  const broad = resolver({ noteRoot: home }).decide(file, undefined)
  assert.equal(broad.editable, false)
  assert.ok(broad.reasons.includes('note-root-too-broad'))
})

test('リンク：候補がリンクの先にあり、ノートをリンク側の道で開いた場合も、3つの候補すべてで同じノートと分かる', (t) => {
  const { base, home, backupDir, note, resolver, sandbox } = world(t)
  // ~/Dropbox → ~/Library/CloudStorage/Dropbox-a/（実体側）のつもり。
  note('Library/CloudStorage/Dropbox-a/Vault/n.md')
  const realVault = path.join(home, 'Library/CloudStorage/Dropbox-a/Vault')
  fs.symlinkSync(path.join(home, 'Library/CloudStorage/Dropbox-a'), path.join(home, 'Dropbox'))
  const opened = path.join(home, 'Dropbox/Vault/n.md')
  // NOTE_ROOT をリンク側で書いた。
  assert.equal(resolver({ noteRoot: path.join(home, 'Dropbox/Vault') }).decide(opened, undefined).path, 'n.md')
  // NOTE_ROOT を実体側で書いた（設定の綴りでも realpath でもない道で開いている）。
  assert.equal(resolver({ noteRoot: realVault }).decide(opened, undefined).path, 'n.md')
  // sandboxCwd が実体側の綴りで届いた。
  const viaCwd = resolver().decide(opened, sandbox(realVault))
  assert.equal(viaCwd.source, 'sandbox')
  assert.equal(viaCwd.path, 'n.md')
  // 使ったことのあるフォルダー（記録は実体側）。
  writeRecord(backupDir, nativeOf(realVault))
  const used = resolver().decide(opened, undefined)
  assert.equal(used.source, 'used')
  assert.equal(used.path, 'n.md')
  assert.equal(used.rootId, rootIdOf(nativeOf(realVault)))
  void base
})

test('リンク：候補の中のリンクが別のノートを指していても、開いたノートは入れ替わらない（3つの候補とも）', (t) => {
  const { home, backupDir, note, resolver, sandbox } = world(t)
  const target = note('vault/a.md')
  const vault = path.join(home, 'vault')
  fs.symlinkSync(target, path.join(vault, 'alias.md'))
  const opened = path.join(vault, 'alias.md')
  assert.equal(locateIn(fs.realpathSync(vault), opened), null)
  assert.equal(resolver({ noteRoot: vault }).decide(opened, undefined).editable, false)
  assert.equal(resolver().decide(opened, sandbox(vault)).editable, false)
  writeRecord(backupDir, nativeOf(vault))
  assert.equal(resolver().decide(opened, undefined).editable, false)
  // 外を指すリンクのフォルダー、隠しフォルダー、__outside__ も断る。
  note('elsewhere/b.md')
  fs.symlinkSync(path.join(home, 'elsewhere'), path.join(vault, 'linked'))
  assert.equal(resolver().decide(path.join(vault, 'linked/b.md'), sandbox(vault)).editable, false)
  const hidden = note('vault/.hidden/c.md')
  assert.equal(resolver().decide(hidden, sandbox(vault)).editable, false)
  const marker = note('vault/__outside__/d.md')
  assert.equal(resolver().decide(marker, sandbox(vault)).editable, false)
})

test('ファイルなし・道でない値・消えたノートは読むだけ', (t) => {
  const { home, resolver, sandbox } = world(t)
  const r = resolver({ noteRoot: home })
  assert.deepEqual(r.decide(undefined, sandbox(home)), { editable: false, reasons: ['no-file'] })
  assert.deepEqual(r.decide('rel/n.md', sandbox(home)), { editable: false, reasons: ['no-file'] })
  assert.deepEqual(r.decide(path.join(home, 'nothing.md'), sandbox(home)), { editable: false, reasons: ['missing'] })
})

test('使い回し：同じ path・sandboxCwd・世代なら期限まで使い回し、fresh か bump で決め直す', (t) => {
  const { backupDir, note, home } = world(t)
  let clock = 0
  const r = createResolver({ backupDir, home, ttlMs: 1000, now: () => clock })
  const file = note('p/n.md')
  assert.equal(r.decide(file, undefined).editable, false)
  writeRecord(backupDir, nativeOf(path.join(home, 'p')))
  assert.equal(r.decide(file, undefined).editable, false)
  assert.equal(r.decide(file, undefined, { fresh: true }).editable, true)
  fs.rmSync(path.join(backupDir, 'settings'), { recursive: true })
  assert.equal(r.decide(file, undefined).editable, true)
  r.bump()
  assert.equal(r.decide(file, undefined).editable, false)
  clock = 5000
  writeRecord(backupDir, nativeOf(path.join(home, 'p')))
  assert.equal(r.decide(file, undefined).editable, true)
})

test('記録の片付け：プロジェクトなしの作業フォルダーが消えた記録だけ、設定と一緒に片付ける（控えは期限で片付く）', (t) => {
  const { home, backupDir, note } = world(t)
  note('Documents/Codex/2026-11-20/gone/n.md')
  note('Documents/Codex/2026-11-20/kept/n.md')
  const gone = nativeOf(path.join(home, 'Documents/Codex/2026-11-20/gone'))
  const kept = nativeOf(path.join(home, 'Documents/Codex/2026-11-20/kept'))
  writeRecord(backupDir, gone)
  writeRecord(backupDir, kept)
  fs.writeFileSync(path.join(backupDir, 'settings', `${rootIdOf(gone)}.json`), '{}')
  fs.mkdirSync(path.join(backupDir, rootIdOf(gone), 'x'), { recursive: true })
  // 実在しない外付けのディスクの記録は消さない。
  fs.writeFileSync(path.join(backupDir, 'settings', 'ffffffffffffffff.root.json'), JSON.stringify({ path: '/Volumes/gone/Vault' }))
  fs.rmSync(path.join(home, 'Documents/Codex/2026-11-20/gone'), { recursive: true })
  assert.deepEqual(pruneRecords(backupDir, { home }), [rootIdOf(gone)])
  const left = fs.readdirSync(path.join(backupDir, 'settings')).sort()
  assert.deepEqual(left, [`${rootIdOf(kept)}.root.json`, 'ffffffffffffffff.root.json'].sort())
  // 控えは消さない（期限が来れば、ほかの控えと同じく片付く）。
  assert.equal(fs.existsSync(path.join(backupDir, rootIdOf(gone), 'x')), true)
})
