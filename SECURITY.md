# セキュリティの問題（脆弱性）を見つけたとき

NoteDock for Codex のセキュリティの問題を見つけたら、誰でも見られる Issue には書かないでください。たとえば、ノートが外に出てしまう、AI やほかのプログラムからノートを読み書きできてしまう、編集できるフォルダーの外のファイルを書き換えられてしまう、といった問題です。

代わりに、GitHub にある、非公開で報告できる機能を使ってください。

1. このリポジトリの「Security」のタブを開く
2. 「Report a vulnerability」を押す
3. 何が起きるか、どうすれば同じことが起きるかを書いて送る

報告の中に、あなたのノートの中身や、ノートのフォルダーの場所は書かないでください。必要なときは、こちらから聞きます。

## インターネットとのやりとり

プラグインがインターネットにつなぐのは、初めて使うときに「サーバーを取ってくる」ボタンを押したときだけです。取ってくる場所は、このリポジトリの GitHub Releases です。取ってきたファイルは、プラグインの `bin/release.json` に書いた大きさと指紋（SHA-256）が合うときだけ使い、合わなければ消します。指紋はプラグインと同じリポジトリに書いているので、Releases のファイルが差し替えられたときは防げますが、このリポジトリそのものを書き換えられたときの守りにはなりません。

## 対象になるバージョン

いま修正の対象にしているのは、いちばん新しいバージョンだけです。古いバージョンで見つけた問題は、新しいバージョンでも起きるかを確認してから知らせてもらえると助かります。

## 作者について

作者は個人（`kuma8088`）で、空いた時間に開発しています。返事までに日にちがかかることがあります。

---

## Reporting a vulnerability (English)

Please do not open a public issue. Use "Report a vulnerability" on the repository's Security tab, and describe what happens and how to reproduce it. Do not include the contents or location of your notes. Only the latest version is supported. The plugin connects to the internet only when you press the download button on first use; the downloaded server is used only if its size and SHA-256 match `bin/release.json` in the plugin. The author is an individual (`kuma8088`), so replies may take a few days.
