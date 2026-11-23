// ブラウザーの試験10個を順に流す。どれかが失敗したら、そこで止めて失敗の番号を返す。
// Python は、python3、python、py の順に探す（Windows のふつうの入れ方では python3 という名前がないため）。
// 引数を渡すと、画面の画像を残す試験（calendar-width-check.py、wrap-indent-check.py、panel-check.py、panel-csp-check.py、project-folder-check.py）に、そのフォルダーを渡す。
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = path.resolve(here, '../..')
const shots = process.argv[2]

function findPython() {
  for (const name of ['python3', 'python', 'py']) {
    const probe = spawnSync(name, ['-I', '-c', 'import playwright'], { stdio: 'ignore', shell: false })
    if (probe.status === 0) return name
  }
  console.error('Playwright の入った Python が見つかりません。test/README.md の「必要なもの」を見てください。')
  process.exit(1)
}

const python = findPython()
const checks = [
  ['image-error-check.py'],
  ['mermaid-link-check.py'],
  ['calendar-width-check.py', ...(shots ? [shots] : [])],
  ['props-enter-check.py'],
  ['wrap-indent-check.py', ...(shots ? [shots] : [])],
  ['panel-check.py', ...(shots ? [shots] : [])],
  // ビルドした本物のパネル（dist/panel.html）を試すので、先にビルドする。
  ['panel-csp-check.py', ...(shots ? [shots] : [])],
  ['ai-context-check.py'],
  // 編集できるフォルダーの決め方（ビルドした本物のパネルを使う）。
  ['project-folder-check.py', ...(shots ? [shots] : [])],
  // 本体を取ってくる前に、前に読んだ本物のパネルが出た場面（ビルドした本物のパネルを使う）。
  ['launcher-swap-check.py', ...(shots ? [shots] : [])],
]
for (const [file, ...args] of checks) {
  if (file === 'panel-csp-check.py') {
    console.log('# npm run build')
    const built = spawnSync(process.execPath, ['build.mjs'], { stdio: 'inherit', cwd: pkg })
    if (built.status !== 0) process.exit(built.status ?? 1)
  }
  console.log(`# ${file}`)
  const run = spawnSync(python, ['-I', path.join(here, file), ...args], { stdio: 'inherit', cwd: pkg })
  if (run.status !== 0) process.exit(run.status ?? 1)
}
