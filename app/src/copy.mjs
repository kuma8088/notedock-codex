// 文字をクリップボードへ入れる。埋め込みの画面では断られることがあるので、2つの方法を順に試す。
// どちらもできなければ false を返す。そのときは画面に出して、手でコピーしてもらう。
export async function copyText(text, { clipboard, execCopy }) {
  try {
    await clipboard.writeText(text)
    return true
  } catch {
    // 次の方法へ。
  }
  try {
    return Boolean(execCopy(text))
  } catch {
    return false
  }
}
