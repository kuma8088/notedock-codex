import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// パネルの画面に入れる通信の制限。許すものを、ここに書いたものだけに決めておく。
// 変えるときは、なぜ要るのかを src/panel-csp.json の comment に書き、ここも直す。
const { policy } = JSON.parse(readFileSync(new URL('../src/panel-csp.json', import.meta.url), 'utf8'))
const directives = Object.fromEntries(policy.split(';').map((part) => part.trim().split(/\s+/)).filter((words) => words[0]).map(([name, ...values]) => [name, values]))

test('通信の制限は、決めたものだけを許す', () => {
  assert.deepEqual(directives, {
    'default-src': ["'none'"],
    'script-src': ["'unsafe-inline'"],
    'style-src': ["'unsafe-inline'"],
    'img-src': ['data:'],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
  })
})
