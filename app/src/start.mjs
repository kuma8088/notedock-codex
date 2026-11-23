// Which note a panel shows first. A note the host opened always wins. Opened without a file (the AI called open_note;
// there is no left rail or More tools entry any more), the last note that still exists; the small panel in a chat opens none by itself.
export function firstNote({ path, inline, recent, notes }) {
  if (path) return path
  if (inline) return null
  const known = new Set(notes)
  return recent.find((item) => !item.startsWith('__outside__/') && known.has(item)) ?? null
}
