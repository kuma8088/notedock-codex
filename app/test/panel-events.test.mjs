import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PanelEventSource } from '../src/panel-events.mjs'

const json = (value) => new Response(JSON.stringify(value), { status: 200 })

function events() {
  const seen = []
  const source = new PanelEventSource('/api/events?path=a.md', { start: false })
  source.addEventListener('changed', () => seen.push('changed'))
  source.addEventListener('removed', () => seen.push('removed'))
  return { source, seen }
}

test('a change is reported only after the file holds still for one poll', async (t) => {
  const { source, seen } = events()
  const real = globalThis.fetch
  t.after(() => {
    globalThis.fetch = real
    source.close()
  })
  let fingerprint = 'one'
  globalThis.fetch = async (url) => (url.startsWith('/api/fingerprint') ? json({ fingerprint }) : json({ path: 'a.md' }))
  source.pollMs = 1e6
  await source.poll(true)
  fingerprint = 'two'
  await source.poll(false)
  assert.deepEqual(seen, [])
  await source.poll(false)
  assert.deepEqual(seen, ['changed'])
  await source.poll(false)
  assert.deepEqual(seen, ['changed'])
})

test('nothing is delivered after close, even with a read in flight', async (t) => {
  const { source, seen } = events()
  const real = globalThis.fetch
  t.after(() => {
    globalThis.fetch = real
  })
  let release
  globalThis.fetch = (url) => (url.startsWith('/api/note') ? new Promise((resolve) => { release = () => resolve(json({ path: 'a.md' })) }) : Promise.resolve(json({ fingerprint: 'x' })))
  const pending = source.publish('x')
  await new Promise((resolve) => setTimeout(resolve, 0))
  source.close()
  release()
  await pending
  assert.deepEqual(seen, [])
})

test('a removed file is reported as removed', async () => {
  const { source, seen } = events()
  await source.publish('missing')
  assert.deepEqual(seen, ['removed'])
  source.close()
})

test('fingerprint の応答の rootId が、開いたときの root と違えば rootchanged を1回だけ知らせる', async (t) => {
  const real = globalThis.fetch
  const source = new PanelEventSource('/api/events?path=a.md&root=aaaa', { start: false })
  t.after(() => {
    globalThis.fetch = real
    source.close()
  })
  const seen = []
  source.addEventListener('rootchanged', (event) => seen.push(event.data))
  let rootId = 'aaaa'
  globalThis.fetch = async () => json({ fingerprint: 'x', rootId })
  source.pollMs = 1e6
  await source.poll(true)
  await source.poll(false)
  assert.deepEqual(seen, [])
  rootId = 'bbbb'
  await source.poll(false)
  await source.poll(false)
  assert.deepEqual(seen, ['bbbb'])
})

test('root がない（none）ときや、応答に rootId がないときは知らせない', async (t) => {
  const real = globalThis.fetch
  t.after(() => {
    globalThis.fetch = real
  })
  for (const [url, reply] of [['/api/events?path=a.md&root=none', { fingerprint: 'x', rootId: 'bbbb' }], ['/api/events?path=a.md&root=aaaa', { fingerprint: 'x' }]]) {
    const source = new PanelEventSource(url, { start: false })
    const seen = []
    source.addEventListener('rootchanged', () => seen.push(1))
    globalThis.fetch = async () => json(reply)
    source.pollMs = 1e6
    await source.poll(true)
    await source.poll(false)
    source.close()
    assert.deepEqual(seen, [])
  }
})
