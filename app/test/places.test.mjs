import assert from 'node:assert/strict'
import { test } from 'node:test'

import { defaultBackupDir } from '../server/places.mjs'

test('Macの控えの場所は、Application Support の下', () => {
  assert.equal(
    defaultBackupDir({ platform: 'darwin', env: {}, home: '/Users/a' }),
    '/Users/a/Library/Application Support/NoteDockCodex',
  )
})

test('Windowsの控えの場所は、LOCALAPPDATA の下', () => {
  assert.equal(
    defaultBackupDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, home: 'C:\\Users\\a' }),
    'C:\\Users\\a\\AppData\\Local\\NoteDockCodex',
  )
})

test('Windowsで LOCALAPPDATA がないときは、ホームの AppData\\Local の下', () => {
  assert.equal(
    defaultBackupDir({ platform: 'win32', env: {}, home: 'C:\\Users\\a' }),
    'C:\\Users\\a\\AppData\\Local\\NoteDockCodex',
  )
})

test('設定 NOTE_BACKUP_DIR があれば、どのOSでもそれを使う', () => {
  assert.equal(defaultBackupDir({ platform: 'win32', env: { NOTE_BACKUP_DIR: 'D:\\bak' }, home: 'C:\\Users\\a' }), 'D:\\bak')
  assert.equal(defaultBackupDir({ platform: 'darwin', env: { NOTE_BACKUP_DIR: '/tmp/b' }, home: '/Users/a' }), '/tmp/b')
})
