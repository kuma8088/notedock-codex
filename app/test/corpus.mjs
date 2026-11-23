// コピーのフォルダーの全ノートで、開いて保存しても1バイトも変わらないことと、1か所の編集でほかが変わらないことを確かめる。
// 使い方: node test/corpus.mjs <コピーのフォルダー>
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { EditorState } from '@codemirror/state'

import { createBackups } from '../server/backups.mjs'
import { hashBytes, readNote, writeNote } from '../server/notes.mjs'
import { listNotes } from '../server/paths.mjs'
import { noteMarkdown } from '../src/markdown-ext.mjs'
import { findCallouts, noteContext, previewField, setMode } from '../src/preview.mjs'

const root = fs.realpathSync(process.argv[2])
const backups = createBackups(fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-bak-')))
const notes = listNotes(root)
const known = new Set(notes)
const stat = { total: 0, editable: 0, readonly: {}, sourceOnly: 0, failures: [], slow: [], callouts: 0 }

for (const rel of notes) {
  stat.total += 1
  const file = path.join(root, rel)
  const before = fs.readFileSync(file)
  let note
  try {
    note = readNote(root, rel)
  } catch (error) {
    stat.failures.push([rel, `read: ${error.message}`])
    continue
  }
  if (note.sourceOnly) stat.sourceOnly += 1
  if (!note.editable) {
    stat.readonly[note.reason] = (stat.readonly[note.reason] ?? 0) + 1
  }
  try {
    const started = performance.now()
    let state = EditorState.create({
      doc: note.text,
      extensions: [noteMarkdown(), noteContext.of({ path: rel, known }), ...(note.sourceOnly ? [] : [previewField])],
    })
    if (state.doc.toString() !== note.text && note.editable) stat.failures.push([rel, 'doc differs'])
    if (!note.sourceOnly) {
      stat.callouts += findCallouts(state).length
      state = state.update({ selection: { anchor: Math.floor(note.text.length / 2) } }).state
      state = state.update({ effects: setMode.of('reading') }).state
      state = state.update({ effects: setMode.of('source') }).state
      state = state.update({ effects: setMode.of('live') }).state
      if (state.doc.toString() !== note.text && note.editable) stat.failures.push([rel, 'doc differs after modes'])
    }
    const took = performance.now() - started
    if (took > 400) stat.slow.push([rel, Math.round(took), note.text.length])
  } catch (error) {
    stat.failures.push([rel, `preview: ${error.message}`])
  }
  if (!note.editable) continue
  stat.editable += 1
  // 同じ内容で保存しても変わらない。
  const same = writeNote(root, rel, note.text, note.hash, backups)
  if (same.conflict || hashBytes(fs.readFileSync(file)) !== hashBytes(before)) stat.failures.push([rel, 'same-save changed bytes'])
  // 1か所だけ編集して、その部分以外が変わらないことを確かめて戻す。
  let at = Math.floor(note.text.length / 2)
  // 絵文字の途中で切らない。エディターの編集で起きない切り方なので、試験の側で避ける。
  const code = note.text.charCodeAt(at - 1)
  if (code >= 0xd800 && code <= 0xdbff) at += 1
  const marker = 'EDIT-MARK'
  const edited = note.text.slice(0, at) + marker + note.text.slice(at)
  const saved = writeNote(root, rel, edited, same.hash, backups)
  const after = fs.readFileSync(file, 'utf8')
  if (after !== edited) stat.failures.push([rel, 'edit mismatch'])
  writeNote(root, rel, note.text, saved.hash, backups)
  if (!fs.readFileSync(file).equals(before)) stat.failures.push([rel, 'restore mismatch'])
}

stat.slow.sort((a, b) => b[1] - a[1])
stat.slowTop = stat.slow.slice(0, 8)
stat.slowCount = stat.slow.length
delete stat.slow
stat.failureCount = stat.failures.length
stat.failures = stat.failures.slice(0, 20)
console.log(JSON.stringify(stat, null, 1))
