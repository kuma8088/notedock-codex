// One self-contained panel page and one server file: the host loads a single resource and there is
// nothing else it could fetch.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'

import { build } from 'esbuild'

import { collectPackages, embeddedPackages, renderNotices } from './licenses.mjs'
import { isSetupPage } from './src/launcher-swap.mjs'

await mkdir('dist', { recursive: true })
const web = await build({
  entryPoints: { main: 'src/main.mjs', style: 'src/style.css' },
  bundle: true,
  format: 'esm',
  splitting: false,
  minify: true,
  write: false,
  metafile: true,
  outdir: 'dist/web',
  // The panel refuses data: fonts, so embedding them would only make every tab slower to open.
  loader: { '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty' },
  logLevel: 'warning',
})
const output = (name) => web.outputFiles.find((file) => file.path.endsWith(name)).text
const panelStyle = await readFile('src/panel.css', 'utf8')
let html = await readFile('public/index.html', 'utf8')
html = html.replace('<link rel="stylesheet" href="/assets/style.css">', () => `<style>${output('style.css')}\n${panelStyle}</style>`)
html = html.replace('<script type="module" src="/assets/main.js"></script>', () => `<script type="module">${output('main.js').replace(/<\/script/gi, '<\\/script')}</script>`)
if (html.includes('/assets/')) throw new Error('A file reference is left in the panel page.')
// 起動用のプログラムの仮のパネル（setup.html）は、読み直した画面にこの印の文字がないことで本物と見分ける。本物に入れてはいけない。
if (isSetupPage(html)) throw new Error('The panel page carries the setup page mark.')
// The panel's own limit on what it may load, on top of the one the host applies. Nothing outside the page:
// no network requests, and images only as data:. Diagrams can name outside images; this stops them.
const { policy } = JSON.parse(await readFile('src/panel-csp.json', 'utf8'))
const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`
html = html.replace('<meta charset="utf-8">', () => `<meta charset="utf-8">\n${cspMeta}`)
if (!html.includes(cspMeta)) throw new Error('The panel page has no Content-Security-Policy.')
html = html.replace('<!doctype html>', '<!doctype html>\n<!-- Third-party licenses: THIRD-PARTY-NOTICES.txt -->')
await writeFile('dist/panel.html', html)
const server = await build({
  entryPoints: { server: 'server/mcp.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  banner: { js: "// Third-party licenses: THIRD-PARTY-NOTICES.txt\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  metafile: true,
  logLevel: 'warning',
})
// Ship the license texts of every bundled package next to the two files.
const packages = collectPackages([['panel.html', web.metafile], ['server.mjs', server.metafile]])
const manifest = JSON.parse(await readFile('licenses/embedded.json', 'utf8')).packages
const embedded = embeddedPackages(packages, manifest, 'licenses/embedded')
await writeFile('dist/THIRD-PARTY-NOTICES.txt', renderNotices(packages, embedded))
await copyFile('LICENSE', 'dist/LICENSE')
console.log(JSON.stringify({ panelBytes: Buffer.byteLength(html), thirdPartyPackages: packages.length, embeddedPackages: embedded.length }))
