// 画面の試験用：Codexのパネルとの接続の代わり。fetch はそのまま試験用のサーバー（panel-server.mjs）へ送る。
import { PanelEventSource } from '../../src/panel-events.mjs'

globalThis.EventSource = PanelEventSource
export async function openInHost() { return false }
export function panelInline() { return false }
export async function panelNote() { return { path: window.FIRST_NOTE ?? null } }
// この試験のサーバーには、編集できるフォルダーの切り替えはない（test/browser/project-folder-check.py で試す）。
export async function locateNote() { return { scope: 'outside' } }
// 会話へ伝える機能は、この試験では扱わない（test/browser/ai-context-check.py で試す）。
// ホストは前の内容を持っておらず（hostHasContext は false）、送ろうとした内容は受け取ったことにする（知らせを出さず、画面を変えない）。
export function hostHasContext() { return false }
export function logToHost() {}
export function onPanelTeardown() {}
export async function updateNoteContext() {}
