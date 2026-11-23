// エディターの控えを置く場所。設定 NOTE_BACKUP_DIR があればそれを使う。
// Macは ~/Library/Application Support の下。Windowsは %LOCALAPPDATA% の下（ほかのアプリと同じ置き場所）。
// Claude用の NoteDock（NoteDock フォルダー）と控えが混ざらないように、名前を分ける。
import os from 'node:os'
import path from 'node:path'

const NAME = 'NoteDockCodex'

export function defaultBackupDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (env.NOTE_BACKUP_DIR) return env.NOTE_BACKUP_DIR
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local')
    return path.win32.join(local, NAME)
  }
  return path.posix.join(home, 'Library/Application Support', NAME)
}
