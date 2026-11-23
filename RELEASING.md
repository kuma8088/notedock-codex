# リリースの作り方

NoteDock for Codex のリリースは、2つのタグで出します。

| タグ | 中身 |
|---|---|
| `server-v<版>` | Releases に、サーバーの本体（`notedock-server-aarch64-apple-darwin`）、`THIRD-PARTY-NOTICES.txt`、`SHA256SUMS` を置く |
| `v<版>` | プラグインの `bin/`（起動用のプログラム、`stub.json`、`release.json`）を入れたコミット。利用者は `kuma8088/notedock-codex@v<版>` で、この版を入れられる |

先にサーバーの Releases を出し、そのあとで `release.json` を main に入れます。逆にすると、main の `release.json` がまだない Releases を指し、そのあいだに入れた利用者のボタンが失敗します。

Deno で作った本体は、同じ手順で作り直しても同じ指紋になるとは限りません。そのため `release.json` には、Releases に置くファイルそのものの指紋を書きます。作り直したら、Releases のファイルと `release.json` の両方を差し替えます。

## 0. 用意

- Apple シリコンの Mac、Deno 2.7.5、Go 1.25、Node.js 22 以上、Python 3、`gh`（このリポジトリに書き込めるアカウントでログイン済み）
- Deno の土台（`denort-aarch64-apple-darwin.zip`）がキャッシュにあること。ないときは、`NOTEDOCK_ALLOW_DOWNLOAD=1` を付けると Deno が取りに行く
- 版を上げる：`app/package.json`、`plugins/notedock/.codex-plugin/plugin.json`、`app/server/mcp.mjs`（`new McpServer({ name: 'notedock', version: '…' })`）の3か所。`app/dist/` を作り直してコミットする（版が `dist/server.mjs` に入るため）
- `CHANGELOG.md` に、その版の項を書く。見出しの「（未公開）」は、出す日付に直す
- `README.md` の先頭に「公開前に決めること」のコメントが残っていれば、決めた内容に直してからコメントを消す
- 以上を main にコミットして push し、作業フォルダーに変更がないこと。タグはこのあとに付ける

## 1. 材料を作る（手元）

```sh
sh scripts/build-release.sh 0.1.0
```

`release-out/0.1.0/` に次のものができます（Git には入りません）。スクリプトは毎回 `release-out/<版>/` を消してから作り直します。前に作った `release-out/` の中身は使わず、Releases に置くファイルとプラグインに入れるファイルは、必ず同じ1回の実行で作ったものにします（本体の指紋は作るたびに変わるため）。

- Releases に置くもの：`notedock-server-aarch64-apple-darwin`、`THIRD-PARTY-NOTICES.txt`、`SHA256SUMS`
- プラグインに入れるもの：`plugin-bin/notedock`、`plugin-bin/stub.json`、`plugin-bin/release.json`

スクリプトは次の順に進み、どこかで失敗したら止まります。

1. 3か所の版がそろっているか、Deno と Go の版
2. 本体の `npm ci`・`npm test`・`npm run build`。作った `app/dist/` がコミットしたものと同じか
3. 本体を1つのファイルにする（`deno compile`。node_modules のない一時フォルダーで、`server.mjs` と `panel.html` だけから。権限はファイルの読み書き・環境変数・OS の情報・`/usr/bin/trash` の実行だけ）。`codesign -v`
4. 起動用のプログラムの `go vet`・`go test`・ビルド（Apple シリコン用、`-trimpath`）。`codesign -v`、作った人のホームフォルダーの場所が入っていないか
5. `stub.json` を本体から作る（`scripts/make-stub.py`）
6. `stub.json` と本体の答えを比べる試験（`TestStubMatchesServer`）。本体と `stub.json` を渡して動かし、合格の行がなければ止める（飛ばされた場合も止める）
7. `release.json`（取ってくる場所は `https://github.com/kuma8088/notedock-codex/releases/download/server-v<版>/`）と `SHA256SUMS`

## 2. サーバーの Releases を出す

```sh
git tag -a server-v0.1.0 -m "NoteDock for Codex server 0.1.0" main
git push origin server-v0.1.0
gh release create server-v0.1.0 --repo kuma8088/notedock-codex --draft --prerelease \
  --title "NoteDock for Codex server 0.1.0" --notes "サーバーの本体（Apple シリコンの Mac 用）。プラグイン v0.1.0 が初回に取ってきます。" \
  release-out/0.1.0/notedock-server-aarch64-apple-darwin \
  release-out/0.1.0/THIRD-PARTY-NOTICES.txt \
  release-out/0.1.0/SHA256SUMS
gh release view server-v0.1.0 --repo kuma8088/notedock-codex --json isDraft,isPrerelease,assets
gh release edit server-v0.1.0 --repo kuma8088/notedock-codex --draft=false --prerelease
```

下書きのうちは、取ってくる場所の URL から取れません。公開（`--draft=false`）してから次へ進みます。

## 3. Releases から取り直して、release.json と照合する

Releases に置いたファイルを取り直し、`release.json` の大きさ・指紋と照合してから、プラグインの `bin/` に入れます。リポジトリが非公開のあいだも取れるように、ログインした `gh` で取ります。

```sh
A="$(mktemp -d)"
gh release download server-v0.1.0 --repo kuma8088/notedock-codex --dir "$A"
sh scripts/stage-plugin.sh 0.1.0 "$A"
```

`stage-plugin.sh` は、`release.json` の版・ファイル名・大きさ・指紋が、手元で作った本体と取り直した本体の両方に合うか、取り直したものが `SHA256SUMS` と合うかを確かめ、ずれていれば何も入れずに止まります。

## 4. プラグインの bin/ を main に入れ、v<版> のタグを付ける

3 の照合が通ってから行います。

```sh
git add plugins/notedock/bin
git commit -m "プラグインの bin を server-v0.1.0 に合わせる"
git ls-files -s plugins/notedock/bin/notedock   # 100755 で始まること
git push origin main
git tag -a v0.1.0 -m "NoteDock for Codex 0.1.0" main
git push origin v0.1.0
```

## 5. ログインなしで取って、指紋を確かめる（リポジトリを公開したあと）

利用者の起動用のプログラムは、ログインしないで取りに行きます。非公開のあいだは取れないので、公開してから確かめます。

```sh
d="$(mktemp -d)"
base="$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["base_url"])' plugins/notedock/bin/release.json)"
for f in notedock-server-aarch64-apple-darwin THIRD-PARTY-NOTICES.txt SHA256SUMS; do curl -fsSL -o "$d/$f" "$base$f"; done
(cd "$d" && shasum -a 256 -c SHA256SUMS)
```

## 6. 入れて確かめる

まず、ふだん使う `~/.codex` とは別の場所で、コマンドで入るかを確かめます（Codexアプリはこの場所を見ないので、画面の確かめにはなりません）。

```sh
export CODEX_HOME="$(mktemp -d)"
codex plugin marketplace add kuma8088/notedock-codex@v0.1.0
codex plugin add notedock@notedock --json
ls -l "$CODEX_HOME"/plugins/cache/notedock/notedock/*/bin/
```

`bin/notedock` が実行できる印のまま入り、`release.json` の版が合っていることを見ます。Codexアプリの画面での確かめ（`.md` を Visual Editor で開き、ボタンで取ってきて、本物のパネルに替わり、編集して保存できる）は、ふだん使っていない Mac か検証用の仮想マシンで行います。

## 途中で止まったとき

- タグを付けたあとに本体を直すことになったら、同じタグは置き直さず、次の版として出す。
- 2 のあと 4 の前に止めても、利用者には新しい版は届かない（main の `release.json` は前の版を指したまま）。ただし最初の版（0.1.0）では、4 までは main に `bin/` がないので、プラグインを入れても起動できない。公開（リポジトリを公開にすること）は 4 のあとにする。

## 試験のための切り替え（利用者の環境では使わない）

起動用のプログラムと本体は、次の環境変数があると動きを変えます。プラグインの `.mcp.json` には書いていないので、Codexアプリから起動したときは使われません。リリースの試験（`go test`、`stub_test`）と、取ってくる流れを手元の試験用のサーバーで確かめるために残しています。

- `NOTEDOCK_SERVER_DIR`：本体を置く場所を変える
- `NOTEDOCK_LAUNCHER_LOG`、`NOTEDOCK_LAUNCHER_TRACE`：動きの記録を残す
- `NOTEDOCK_LAUNCHER_TEST_DELAY_MS`：わざと遅く答える
- `NOTEDOCK_TRASH_DIR`（本体）：消したノートを、Mac のゴミ箱ではなくこのフォルダーに移す
- `NOTE_ROOT`（本体）：編集できるフォルダーの候補を足す

また、`release.json` の取ってくる場所は https のほか、手元の試験用のサーバーで試すために `127.0.0.1` と `localhost` の http も受け付けます。それ以外の http は受け付けません。
