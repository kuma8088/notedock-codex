const POLL_MS = 1000

// Stands in for EventSource. Like the real one it never delivers an event after close(), so a note that
// was switched away from cannot reach the editor of the next note.
export class PanelEventSource extends EventTarget {
  static CLOSED = 2
  static OPEN = 1
  readyState = PanelEventSource.OPEN
  onopen = null
  onerror = null

  constructor(url, { pollMs = POLL_MS, start = true } = {}) {
    super()
    const target = new URL(url, 'http://panel.invalid')
    this.path = target.searchParams.get('path')
    // 開いたときの編集できるフォルダーの目印。fingerprint の応答の rootId と違えば 'rootchanged' を1回だけ知らせる。
    this.root = target.searchParams.get('root')
    this.rootChanged = false
    this.pollMs = pollMs
    this.known = null
    this.candidate = null
    if (start && !this.path?.startsWith('__outside__/')) this.poll(true)
  }

  // 開いたときのフォルダーの目印を送る。サーバーは、今のフォルダーと違えば中身を返さない（別のフォルダーの同じ名前を読まない）。
  headers() {
    return this.root && this.root !== 'none' ? { headers: { 'x-note-root': this.root } } : {}
  }

  get closed() {
    return this.readyState === PanelEventSource.CLOSED
  }

  // Report a change only once the file has held still for one poll, so a half-written note is not read.
  // A same-size rewrite that keeps its modification time is not noticed, as with any stat-based watch.
  async poll(first) {
    if (this.closed) return
    try {
      const response = await fetch(`/api/fingerprint?path=${encodeURIComponent(this.path)}`, this.headers())
      const { fingerprint, rootId } = await response.json()
      if (this.closed) return
      if (rootId && this.root && this.root !== 'none' && rootId !== this.root && !this.rootChanged) {
        this.rootChanged = true
        this.dispatchEvent(new MessageEvent('rootchanged', { data: rootId }))
      }
      if (fingerprint !== undefined) {
        if (first) {
          this.known = this.candidate = fingerprint
          this.onopen?.()
        } else if (fingerprint !== this.candidate) {
          this.candidate = fingerprint
        } else if (fingerprint !== this.known) {
          this.known = fingerprint
          await this.publish(fingerprint)
        }
      }
    } catch {
      if (!this.closed) this.onerror?.()
    }
    if (!this.closed) setTimeout(() => this.poll(false), this.pollMs).unref?.()
  }

  async publish(fingerprint) {
    if (fingerprint === 'missing') {
      this.dispatchEvent(new MessageEvent('removed', { data: '{}' }))
      return
    }
    const response = await fetch(`/api/note?path=${encodeURIComponent(this.path)}`, this.headers())
    const body = await response.text()
    if (this.closed) return
    this.dispatchEvent(new MessageEvent(response.ok ? 'changed' : 'removed', { data: response.ok ? body : '{}' }))
  }

  close() {
    this.readyState = PanelEventSource.CLOSED
  }
}
