import assert from 'node:assert/strict'
import { test } from 'node:test'

import { periodicStep } from '../src/periodic-open.mjs'

// カレンダーや「今日のノート」を押したあと、先に調べた結果（dryRun）から何をするか。Codex用だけの決まりを含む。
test('書き込めるタブ：今日のノートは聞かずに作る（調べない）', () => {
  assert.deepEqual(periodicStep({ canCreate: true, ask: false }), { probe: false })
})

test('書き込めるタブ：ほかの日は先に調べ、あれば開き、なければ聞いてから作る', () => {
  assert.deepEqual(periodicStep({ canCreate: true, ask: true }), { probe: true })
  assert.deepEqual(periodicStep({ canCreate: true, ask: true, probe: { exists: true, path: 'P/a.md' } }), { action: 'request' })
  assert.deepEqual(periodicStep({ canCreate: true, ask: true, probe: { exists: false, path: null } }), { action: 'confirm' })
})

test('書き込めないタブ：いつも先に調べ、あれば読むだけで開き、なければ作れないと知らせる', () => {
  assert.deepEqual(periodicStep({ canCreate: false, ask: false }), { probe: true })
  assert.deepEqual(periodicStep({ canCreate: false, ask: true }), { probe: true })
  assert.deepEqual(periodicStep({ canCreate: false, ask: false, probe: { exists: true, path: 'P/a.md' } }), { action: 'open', path: 'P/a.md' })
  assert.deepEqual(periodicStep({ canCreate: false, ask: true, probe: { exists: false, path: null } }), { action: 'refuse' })
})
