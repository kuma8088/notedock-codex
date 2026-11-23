// Third-party notices for the files we ship. The list comes from esbuild's metafile, so it holds exactly the
// packages whose code ends up in dist/. Some packages already carry other packages inside their own files;
// those are found by the path comments their bundlers leave, and must be listed in licenses/embedded.json.
// The build stops on anything nobody has looked at.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Licenses whose terms we have read for shipping bundled copies. Anything else stops the build.
export const ALLOWED = new Set(['MIT', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'EPL-2.0'])

// A package offering a choice of licenses must have the choice written down here.
const CHOSEN = { dompurify: { '(MPL-2.0 OR Apache-2.0)': 'Apache-2.0' } }

// Packages whose package.json does not say the license, checked by reading the license file of that version.
const DECLARED = { 'khroma@2.1.0': 'MIT' }

// EPL-2.0 asks a distributor of object code to say where the source code is (section 3.1), and to keep the
// copyright notices (section 3.3); minifying drops the ones inside elkjs, so they are written out here.
const SOURCE_NOTES = {
  elkjs: (version) => `elkjs ${version}: Copyright (c) 2017 and 2021 Kiel University and others.
SPDX-License-Identifier: EPL-2.0
We did not change its source code; it is bundled and minified into panel.html as part of Mermaid's layout
support. Its source code is available at https://github.com/kieler/elkjs (release ${version}). elkjs is
compiled with GWT from the Eclipse Layout Kernel (ELK) ${version.split('.').slice(0, 2).join('.')}.x, whose source code is available at
https://github.com/eclipse-elk/elk. The compiled code also contains parts of the GWT runtime and of the Java
libraries ELK uses.`,
}

const NOTICE_NAME = /licen[cs]e|copying|notice|third.?party/i
const CODE_FILE = /\.(c|m)?[jt]sx?$/i
const OWN_SOURCES = /^(src|server)\//

const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

// node_modules/a/node_modules/@b/c/x.js -> node_modules/a/node_modules/@b/c
export function packageDir(input) {
  const match = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//)
  return match ? match[1] : null
}

// Names in the path comments a bundler leaves, e.g. "// ../../node_modules/.pnpm/x@1.0.0/node_modules/x/lib/a.js",
// with the versions a pnpm path gives (an empty set when no path says the version).
export function markedPackages(text) {
  const names = new Map()
  for (const match of text.matchAll(/node_modules\/((?:@[\w.-]+\/)?[\w-][\w.-]*)\//g)) if (!names.has(match[1])) names.set(match[1], new Set())
  for (const match of text.matchAll(/\.pnpm\/(?:@[^+/]+\+)?[^@/]+@([^_/(]+)[^/]*\/node_modules\/((?:@[\w.-]+\/)?[\w-][\w.-]*)\//g)) names.get(match[2]).add(match[1])
  return names
}

export function collectPackages(metafiles, root = '.') {
  const dirs = new Map()
  for (const [label, metafile] of metafiles) {
    for (const output of Object.values(metafile.outputs)) {
      for (const input of Object.keys(output.inputs)) {
        const dir = packageDir(input)
        if (!dir) {
          if (!OWN_SOURCES.test(input)) throw new Error(`Bundled file outside our sources and node_modules: ${input}`)
          continue
        }
        if (!dirs.has(dir)) dirs.set(dir, { files: new Set(), inputs: new Set() })
        dirs.get(dir).files.add(label)
        dirs.get(dir).inputs.add(input)
      }
    }
  }
  return [...dirs].map(([dir, { files, inputs }]) => ({ ...readPackage(join(root, dir), [...files].sort(order)), inputs: [...inputs] }))
    .sort((a, b) => order(a.name, b.name) || order(a.version, b.version))
}

function readPackage(dir, files) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const id = `${pkg.name}@${pkg.version}`
  let license = typeof pkg.license === 'string' ? pkg.license : DECLARED[id]
  if (CHOSEN[pkg.name]?.[license]) license = CHOSEN[pkg.name][license]
  if (!ALLOWED.has(license)) throw new Error(`Unreviewed license for ${id}: ${JSON.stringify(pkg.license ?? null)}`)
  const texts = noticeFiles(dir)
  if (!texts.length) throw new Error(`No license file in ${id}`)
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  return { name: pkg.name, version: pkg.version, license, offered: pkg.license !== license ? pkg.license : null, files,
    repository: repo ?? null, texts, sourceNote: SOURCE_NOTES[pkg.name]?.(pkg.version) ?? null }
}

// Every license, notice or third-party file in the folder, except code.
function noticeFiles(dir) {
  return readdirSync(dir).filter((name) => NOTICE_NAME.test(name) && !CODE_FILE.test(name) && statSync(join(dir, name)).isFile())
    .sort(order).map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8').trim() }))
}

// The packages carried inside bundled packages. Each must be in the manifest (licenses/embedded.json), and each
// manifest entry with a marker must still be found in its host, so the list cannot silently go stale.
// A version in a pnpm path must match the one we list, so an upstream update cannot keep an old license text.
export function embeddedPackages(packages, manifest, base, root = '.') {
  const versions = new Map()
  for (const p of packages) versions.set(p.name, new Set([...(versions.get(p.name) ?? []), p.version]))
  const listed = new Map(manifest.map((entry) => [entry.name, entry]))
  const seen = new Set()
  for (const host of packages) {
    for (const input of host.inputs) {
      const text = readFileSync(join(root, input), 'utf8')
      for (const [name, marked] of markedPackages(text)) {
        if (name === host.name) continue
        const known = versions.get(name) ?? (listed.has(name) ? new Set([listed.get(name).version]) : null)
        if (!known) throw new Error(`${host.name} carries ${name} inside it; add it to licenses/embedded.json`)
        for (const version of marked) {
          if (!known.has(version)) throw new Error(`${host.name} carries ${name}@${version}, but the notices list ${[...known].join(', ')}`)
        }
        if (!versions.has(name)) seen.add(`${host.name}>${name}`)
      }
      for (const entry of manifest) if (entry.marker && entry.inside === host.name && text.includes(entry.marker)) seen.add(`${host.name}>${entry.name}`)
    }
  }
  return manifest.filter((entry) => versions.has(entry.inside)).map((entry) => {
    if (!seen.has(`${entry.inside}>${entry.name}`)) throw new Error(`${entry.name} is no longer found inside ${entry.inside}; check licenses/embedded.json`)
    if (!ALLOWED.has(entry.license)) throw new Error(`Unreviewed license for ${entry.name}@${entry.version}: ${entry.license}`)
    const texts = noticeFiles(join(base, entry.dir))
    if (!texts.length) throw new Error(`No license file for ${entry.name} in ${entry.dir}`)
    return { ...entry, texts }
  }).sort((a, b) => order(a.name, b.name))
}

export function renderNotices(packages, embedded = []) {
  const rule = '='.repeat(72)
  const head = [
    'Third-party software in this distribution',
    '',
    'panel.html and server.mjs contain the open source packages listed below. We did not change their source',
    'code; it is bundled (and minified in panel.html). Each package keeps its own license, and the MIT license',
    'of this software does not apply to them. The full license texts follow the lists.',
    ...packages.filter((p) => p.offered).map((p) => `${p.name} is offered under ${p.offered}; it is used here under ${p.license}.`),
    '',
    ...packages.map((p) => `- ${p.name} ${p.version} (${p.license}) in ${p.files.join(', ')}`),
    '',
    ...(embedded.length ? [
      'These packages are already bundled inside one of the packages above:',
      '',
      ...embedded.map((e) => `- ${e.name} ${e.version} (${e.license}) inside ${e.inside}`),
      '',
    ] : []),
  ]
  const section = (title, lines, texts) => [rule, title, ...lines, rule, '', ...texts.flatMap((t) => [`[${t.name}]`, '', t.text, ''])]
  const body = [
    ...packages.flatMap((p) => section(`${p.name} ${p.version}`,
      [`License: ${p.license}`, ...(p.repository ? [`Source: ${p.repository}`] : []), ...(p.sourceNote ? ['', p.sourceNote] : [])], p.texts)),
    ...embedded.flatMap((e) => section(`${e.name} ${e.version} (inside ${e.inside})`,
      [`License: ${e.license}`, `Source: ${e.source}`, ...(e.note ? ['', e.note] : [])], e.texts)),
  ]
  return [...head, ...body].join('\n')
}
