import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { listFolders, listNotes, resolveInside, resolveNotePath } from '../server/paths.mjs'

// Windowsで同じファイルを開いたときに、Vaultの外や隠しフォルダーへ抜けないことを確かめる。
// Windowsだけの規則は platform: 'win32' を渡して、Macの上で確かめる。
const win = { platform: 'win32' }

function makeRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paths-')))
  fs.mkdirSync(path.join(root, 'notes'))
  fs.writeFileSync(path.join(root, 'notes', 'a.md'), '# a\n')
  fs.mkdirSync(path.join(root, '.git'))
  fs.writeFileSync(path.join(root, '.git', 'config.md'), 'secret\n')
  return root
}

test('ふつうの場所はそのまま開ける', () => {
  const root = makeRoot()
  assert.equal(resolveNotePath(root, 'notes/a.md'), path.join(root, 'notes', 'a.md'))
  assert.equal(resolveNotePath(root, 'notes/new.md'), path.join(root, 'notes', 'new.md'))
  assert.equal(resolveNotePath(root, 'notes/日本語 のノート.md'), path.join(root, 'notes', '日本語 のノート.md'))
})

test('Windowsでは、バックスラッシュを含む場所は断る（Windowsでは区切りになり、..で外へ出られる）', () => {
  const root = makeRoot()
  for (const rel of ['notes\\a.md', '..\\outside.md', 'notes\\..\\..\\x.md', 'notes/..\\x.md', '\\\\server\\share\\x.md']) {
    assert.throws(() => resolveNotePath(root, rel, win), /path not allowed/, rel)
  }
})

test('Windowsでは、ドライブ名やコロンを含む場所は断る（C:、別のデータストリーム）', () => {
  const root = makeRoot()
  for (const rel of ['C:/x.md', 'C:x.md', 'notes/a.md:stream', 'notes/a:b.md']) {
    assert.throws(() => resolveNotePath(root, rel, win), /path not allowed/, rel)
  }
})

test('Windowsでは、使えない文字と制御文字は断る', () => {
  const root = makeRoot()
  for (const rel of ['notes/a*.md', 'notes/a?.md', 'notes/a".md', 'notes/a<b.md', 'notes/a>b.md', 'notes/a|b.md', 'notes/a\u0001.md', 'notes/a\tb.md']) {
    assert.throws(() => resolveNotePath(root, rel, win), /path not allowed/, JSON.stringify(rel))
  }
})

test('Windowsでは、予約名は、拡張子があってもなくても、大文字小文字を問わず断る', () => {
  const root = makeRoot()
  for (const rel of ['CON.md', 'con.md', 'notes/nul.md', 'Aux/x.md', 'prn.md', 'COM1.md', 'lpt9.md', 'notes/CON.tar.md', 'COM¹.md', 'conin$.md', 'CONOUT$.md']) {
    assert.throws(() => resolveNotePath(root, rel, win), /path not allowed/, rel)
  }
  // 予約名で始まるだけの名前は開ける
  assert.equal(resolveNotePath(root, 'notes/console.md', win), path.join(root, 'notes', 'console.md'))
  assert.equal(resolveNotePath(root, 'notes/COM10.md', win), path.join(root, 'notes', 'COM10.md'))
})

test('Windowsでは、最後が空白や点で終わる名前は断る（Windowsでは削られて別の名前になる）', () => {
  const root = makeRoot()
  for (const rel of ['notes /a.md', 'notes./a.md', 'notes/a.md ', 'notes/a.md.']) {
    assert.throws(() => resolveInside(root, rel, win), /path not allowed/, JSON.stringify(rel))
  }
})

test('node_modules は大文字小文字を変えても断る', () => {
  const root = makeRoot()
  for (const rel of ['NODE_MODULES/x.md', 'Node_Modules/x.md', 'notes/node_modules/x.md']) {
    assert.throws(() => resolveNotePath(root, rel), /path not allowed/, rel)
  }
})

test('実際の名前が隠しフォルダーなら、別名（Windowsの短い名前など）で指しても断る', () => {
  const root = makeRoot()
  // Windowsでは .git に GIT~1 のような短い名前が付き、文字だけでは見分けられない。
  // 実際の場所に直してから確かめることを、別名を返す realpath で再現する。
  const realpath = (p) => p.replace(`${path.sep}GIT~1`, `${path.sep}.git`)
  fs.mkdirSync(path.join(root, 'GIT~1'))
  fs.writeFileSync(path.join(root, 'GIT~1', 'config.md'), 'x\n')
  assert.throws(() => resolveNotePath(root, 'GIT~1/config.md', { realpath }), /path not allowed/)
  assert.throws(() => resolveNotePath(root, 'GIT~1/new.md', { realpath }), /path not allowed/)
  // 別名でない ~1 を含む名前は開ける
  fs.writeFileSync(path.join(root, 'notes', 'report~1.md'), 'x\n')
  assert.equal(resolveNotePath(root, 'notes/report~1.md'), path.join(root, 'notes', 'report~1.md'))
})

test('実際の場所がVaultの外なら断る', () => {
  const root = makeRoot()
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'outside-')))
  const realpath = (p) => p.replace(path.join(root, 'notes'), outside)
  assert.throws(() => resolveNotePath(root, 'notes/a.md', { realpath }), /path not allowed/)
})

test('Vaultの場所そのものが別名で渡されても、中の場所は開ける', () => {
  const real = makeRoot()
  const linkParent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'link-')))
  const link = path.join(linkParent, 'vault')
  fs.symlinkSync(real, link)
  assert.equal(resolveNotePath(link, 'notes/a.md'), path.join(link, 'notes', 'a.md'))
})

test('Macでは、Windowsでだけ使えない名前も開ける（Macでは普通の名前なので）', () => {
  const root = makeRoot()
  const mac = { platform: 'darwin' }
  for (const rel of ['notes/AIとは?.md', 'notes/A | B.md', 'notes/"quote".md', 'notes/a:b.md', 'notes/con.md', 'notes/nul.md', 'notes/end.', 'notes/sp ']) {
    assert.equal(resolveInside(root, rel, mac), path.join(root, ...rel.split('/')), rel)
  }
  // 隠しフォルダーとVaultの外は、Macでも断る
  for (const rel of ['.git/config.md', '../x.md', 'notes/../../x.md', 'NODE_MODULES/x.md']) {
    assert.throws(() => resolveInside(root, rel, mac), /path not allowed/, rel)
  }
})

test('隠しフォルダーでなくても、実際の名前と違う別名（Windowsの短い名前）で指したら断る', () => {
  const root = makeRoot()
  fs.mkdirSync(path.join(root, 'My Long Folder'))
  fs.writeFileSync(path.join(root, 'My Long Folder', 'a.md'), 'x\n')
  fs.mkdirSync(path.join(root, 'MYLONG~1'))
  fs.writeFileSync(path.join(root, 'MYLONG~1', 'a.md'), 'x\n')
  const realpath = (p) => p.replace(`${path.sep}MYLONG~1`, `${path.sep}My Long Folder`)
  assert.throws(() => resolveNotePath(root, 'MYLONG~1/a.md', { realpath }), /path not allowed/)
  assert.throws(() => resolveNotePath(root, 'MYLONG~1/new.md', { realpath }), /path not allowed/)
  // 本当の名前なら、大文字小文字が違っても開ける
  assert.equal(resolveNotePath(root, 'my long folder/a.md', { realpath }), path.join(root, 'my long folder', 'a.md'))
})

test('Vaultが隠しフォルダーの中にあっても、中のノートは開ける', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hidden-parent-')))
  const root = path.join(base, '.vault', 'notes-root')
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(root, 'sub', 'a.md'), 'x\n')
  assert.equal(resolveNotePath(root, 'sub/a.md'), path.join(root, 'sub', 'a.md'))
})

test('一覧には、大文字小文字を変えた node_modules も出さない', () => {
  const root = makeRoot()
  fs.mkdirSync(path.join(root, 'Node_Modules'))
  fs.writeFileSync(path.join(root, 'Node_Modules', 'x.md'), 'x\n')
  assert.ok(!listNotes(root).some((rel) => rel.toLowerCase().startsWith('node_modules/')))
  assert.ok(!listFolders(root).some((rel) => rel.toLowerCase() === 'node_modules'))
})

test('archives や test-copies のような名前のフォルダーも、ほかのフォルダーと同じく一覧に出す', () => {
  const root = makeRoot()
  for (const dir of ['archives', 'test-copies', 'a/archives', '.checkbox-backups']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
    fs.writeFileSync(path.join(root, dir, 'x.md'), 'x\n')
  }
  assert.deepEqual(listNotes(root).filter((rel) => rel.endsWith('/x.md')).sort(), ['a/archives/x.md', 'archives/x.md', 'test-copies/x.md'])
  const folders = listFolders(root)
  assert.ok(['archives', 'test-copies', 'a/archives'].every((dir) => folders.includes(dir)), folders.join(','))
  // 名前がドットで始まるフォルダーは、今までどおり出さない
  assert.ok(!folders.includes('.checkbox-backups'))
})
