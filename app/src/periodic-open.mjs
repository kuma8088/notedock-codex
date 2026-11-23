// 日付のノートのボタンやカレンダーを押したあと、何をするかを決める（Codex用）。
// - probe：先にあるかどうかだけを調べる（dryRun）か。
// - action：調べた結果から、request（作る・開くをサーバーに頼む）、confirm（作るか聞いてから頼む）、
//   open（読むだけで開く）、refuse（このタブでは作れないと知らせる）のどれにするか。
// 書き込めないタブ（フォルダーの外のノートから開いたタブ）は、作る依頼を送ると断られるので、いつも先に調べ、
// あるノートは読むだけで開く。
export function periodicStep({ canCreate, ask, probe }) {
  if (!probe) return { probe: ask || !canCreate }
  if (!canCreate) return probe.exists ? { action: 'open', path: probe.path } : { action: 'refuse' }
  return probe.exists ? { action: 'request' } : { action: 'confirm' }
}
