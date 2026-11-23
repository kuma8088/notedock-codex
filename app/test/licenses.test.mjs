import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { collectPackages, embeddedPackages, markedPackages, packageDir, renderNotices } from '../licenses.mjs'

// entries: [dir, package.json or null, { file: text }]
function fixture(entries) {
  const root = mkdtempSync(join(tmpdir(), 'licenses-'))
  for (const [dir, pkg, files] of entries) {
    mkdirSync(join(root, dir), { recursive: true })
    if (pkg) writeFileSync(join(root, dir, 'package.json'), JSON.stringify(pkg))
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, dir, name)), { recursive: true })
      writeFileSync(join(root, dir, name), text)
    }
  }
  return root
}

const meta = (...inputs) => ({ outputs: { out: { inputs: Object.fromEntries(inputs.map((i) => [i, {}])) } } })
const within = (root, fn) => { try { return fn() } finally { rmSync(root, { recursive: true, force: true }) } }

test('packageDir finds the package of a bundled file, scoped and nested', () => {
  assert.equal(packageDir('node_modules/a/lib/x.js'), 'node_modules/a')
  assert.equal(packageDir('node_modules/@s/b/x.js'), 'node_modules/@s/b')
  assert.equal(packageDir('node_modules/a/node_modules/@s/c/d/x.js'), 'node_modules/a/node_modules/@s/c')
  assert.equal(packageDir('src/main.mjs'), null)
})

test('markedPackages reads the path comments other bundlers leave', () => {
  const text = '// ../../node_modules/.pnpm/langium@4.4.0/node_modules/langium/lib/a.js\n// node_modules/@s/b/x.js'
  const marked = markedPackages(text)
  assert.deepEqual([...marked.keys()].sort(), ['@s/b', 'langium'])
  assert.deepEqual([...marked.get('langium')], ['4.4.0'])
  assert.deepEqual([...marked.get('@s/b')], [])
  const scoped = markedPackages('// node_modules/.pnpm/@chevrotain+gast@13.2.0/node_modules/@chevrotain/gast/lib/a.js')
  assert.deepEqual([...scoped.get('@chevrotain/gast')], ['13.2.0'])
  const peer = markedPackages('// node_modules/.pnpm/foo@1.0.0(bar@2.0.0)/node_modules/foo/a.js')
  assert.deepEqual([...peer.get('foo')], ['1.0.0'])
})

test('every bundled package is listed once with all its license and notice files and where it is', () => {
  const root = fixture([
    ['src', null, { 'main.mjs': '' }],
    ['node_modules/a', { name: 'a', version: '1.0.0', license: 'MIT', repository: 'github:x/a' },
      { LICENSE: 'MIT text a', NOTICE: 'notice a', 'ThirdPartyNotices.txt': 'tp a', 'license-update.mjs': 'script body' }],
    ['node_modules/@s/b', { name: '@s/b', version: '2.0.0', license: 'Apache-2.0' }, { 'LICENSE.txt': 'apache text' }],
    ['node_modules/khroma', { name: 'khroma', version: '2.1.0' }, { license: 'MIT text khroma' }],
    ['node_modules/dompurify', { name: 'dompurify', version: '3.0.0', license: '(MPL-2.0 OR Apache-2.0)' }, { LICENSE: 'apache', 'LICENSE-MPL': 'mpl' }],
  ])
  within(root, () => {
    const packages = collectPackages([
      ['panel.html', meta('src/main.mjs', 'node_modules/a/x.js', 'node_modules/@s/b/y.js', 'node_modules/khroma/z.js', 'node_modules/dompurify/d.js')],
      ['server.mjs', meta('node_modules/a/w.js')],
    ], root)
    assert.deepEqual(packages.map((p) => [p.name, p.license, p.files.join('+')]),
      [['@s/b', 'Apache-2.0', 'panel.html'], ['a', 'MIT', 'panel.html+server.mjs'], ['dompurify', 'Apache-2.0', 'panel.html'], ['khroma', 'MIT', 'panel.html']])
    const text = renderNotices(packages)
    for (const part of ['MIT text a', 'notice a', 'tp a', 'apache text', 'MIT text khroma', 'mpl', 'Source: github:x/a',
      '- a 1.0.0 (MIT) in panel.html, server.mjs', 'dompurify is offered under (MPL-2.0 OR Apache-2.0); it is used here under Apache-2.0.']) {
      assert.ok(text.includes(part), part)
    }
    assert.ok(!text.includes('script body'), 'a script named like a license file is not a notice')
  })
})

test('the build stops on an unreviewed license, a missing license file, or a file from elsewhere', () => {
  const root = fixture([
    ['node_modules/g', { name: 'g', version: '1.0.0', license: 'GPL-3.0' }, { LICENSE: 'gpl' }],
    ['node_modules/n', { name: 'n', version: '1.0.0', license: 'MIT' }, {}],
    ['node_modules/khroma', { name: 'khroma', version: '9.0.0' }, { license: 'new terms?' }],
  ])
  within(root, () => {
    assert.throws(() => collectPackages([['panel.html', meta('node_modules/g/x.js')]], root), /Unreviewed license for g@1.0.0/)
    assert.throws(() => collectPackages([['panel.html', meta('node_modules/n/x.js')]], root), /No license file in n@1.0.0/)
    assert.throws(() => collectPackages([['panel.html', meta('node_modules/khroma/x.js')]], root), /Unreviewed license for khroma@9.0.0/)
    assert.throws(() => collectPackages([['panel.html', meta('vendor/x.js')]], root), /outside our sources/)
  })
})

test('code another package carries inside it must be in the manifest, and the manifest cannot go stale', () => {
  const root = fixture([
    ['node_modules/host', { name: 'host', version: '1.0.0', license: 'MIT' }, { LICENSE: 'host', 'dist/x.js': '// node_modules/inner/a.js\n/* Copyright 2020 Someone */' }],
    ['embedded/inner-1.0.0', null, { LICENSE: 'inner license text' }],
    ['embedded/hidden', null, { LICENSE: 'hidden license text' }],
  ])
  within(root, () => {
    const packages = collectPackages([['panel.html', meta('node_modules/host/dist/x.js')]], root)
    const base = join(root, 'embedded')
    assert.throws(() => embeddedPackages(packages, [], base, root), /host carries inner inside it/)
    const inner = { name: 'inner', version: '1.0.0', license: 'MIT', inside: 'host', source: 'https://example.test/inner', dir: 'inner-1.0.0' }
    const hidden = { name: 'hidden', version: '1.x', license: 'Apache-2.0', inside: 'host', source: 'https://example.test/hidden', dir: 'hidden', marker: 'Copyright 2020 Someone' }
    const text = renderNotices(packages, embeddedPackages(packages, [inner, hidden], base, root))
    for (const part of ['- inner 1.0.0 (MIT) inside host', 'inner license text', 'hidden license text', 'Source: https://example.test/hidden']) assert.ok(text.includes(part), part)
    assert.throws(() => embeddedPackages(packages, [inner, { ...hidden, marker: 'Copyright 1999 Gone' }], base, root), /hidden is no longer found inside host/)
    assert.throws(() => embeddedPackages(packages, [{ ...inner, license: 'GPL-2.0' }, hidden], base, root), /Unreviewed license for inner/)
    assert.throws(() => embeddedPackages(packages, [inner, { ...hidden, inside: 'other' }, { ...hidden, name: 'x', inside: 'host', marker: 'nowhere' }], base, root), /x is no longer found inside host/)
  })
})

test('a version update inside a bundled package stops the build until the notices are updated', () => {
  const root = fixture([
    ['node_modules/host', { name: 'host', version: '1.0.0', license: 'MIT' }, { LICENSE: 'host',
      'dist/x.js': '// node_modules/.pnpm/inner@2.0.0/node_modules/inner/a.js\n// node_modules/.pnpm/shared@9.9.9/node_modules/shared/b.js' }],
    ['node_modules/shared', { name: 'shared', version: '1.0.0', license: 'MIT' }, { LICENSE: 'shared' }],
    ['embedded/inner-1.0.0', null, { LICENSE: 'inner license text' }],
  ])
  within(root, () => {
    const packages = collectPackages([['panel.html', meta('node_modules/host/dist/x.js', 'node_modules/shared/s.js')]], root)
    const inner = { name: 'inner', version: '1.0.0', license: 'MIT', inside: 'host', source: 'https://example.test/inner', dir: 'inner-1.0.0' }
    assert.throws(() => embeddedPackages(packages, [inner], join(root, 'embedded'), root), /host carries (inner@2\.0\.0|shared@9\.9\.9), but the notices list/)
  })
})

test('elkjs (EPL-2.0) keeps its copyright notice and says where its source code is', () => {
  const root = fixture([['node_modules/elkjs', { name: 'elkjs', version: '0.9.3', license: 'EPL-2.0' }, { 'LICENSE.md': 'epl' }]])
  within(root, () => {
    const text = renderNotices(collectPackages([['panel.html', meta('node_modules/elkjs/lib/x.js')]], root))
    assert.match(text, /Copyright \(c\) 2017 and 2021 Kiel University and others/)
    assert.match(text, /https:\/\/github\.com\/kieler\/elkjs \(release 0\.9\.3\)/)
    assert.match(text, /\(ELK\) 0\.9\.x, whose source code is available at\nhttps:\/\/github\.com\/eclipse-elk\/elk/)
  })
})
