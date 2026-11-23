// 日付の計算のテストを、3つの時間帯で流す。sh の書き方を使わないので、Windows でも動く。
import { spawnSync } from 'node:child_process'

const files = ['test/periodic.test.mjs', 'test/calendar.test.mjs']
for (const tz of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
  console.log(`# TZ=${tz}`)
  const run = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: { ...process.env, TZ: tz } })
  if (run.status !== 0) process.exit(run.status ?? 1)
}
