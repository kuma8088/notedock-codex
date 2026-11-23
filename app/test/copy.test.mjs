import assert from 'node:assert/strict'
import { test } from 'node:test'

import { copyText } from '../src/copy.mjs'

test('コピーはまずクリップボードの機能で行う', async () => {
  const written = []
  const ok = await copyText('/a/b.md', { clipboard: { writeText: async (text) => written.push(text) }, execCopy: () => assert.fail('使わない') })
  assert.equal(ok, true)
  assert.deepEqual(written, ['/a/b.md'])
})

test('クリップボードの機能が断られたら、選択してコピーする方法を試す', async () => {
  const copied = []
  const ok = await copyText('/a/b.md', {
    clipboard: { writeText: async () => { throw new Error('denied') } },
    execCopy: (text) => copied.push(text) > 0,
  })
  assert.equal(ok, true)
  assert.deepEqual(copied, ['/a/b.md'])
})

test('どちらもできなければ false を返し、画面で手でコピーしてもらう', async () => {
  assert.equal(await copyText('/a/b.md', { clipboard: undefined, execCopy: () => false }), false)
  assert.equal(await copyText('/a/b.md', { clipboard: undefined, execCopy: () => { throw new Error('no') } }), false)
})
