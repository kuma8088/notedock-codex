# NoteDock for Codex

[English](#english)

Codexアプリ（デスクトップ版）で、Markdownのノートを、見出しや表がきれいに表示された状態のまま編集するためのプラグインです。Codexアプリで `.md` のファイルを開いたときのタブの中で動きます。

- 見出しや表、チェックボックスを、仕上がりの見た目のまま編集できます。「ソース」に切り替えれば、記号も含めた元の文章のまま編集できます。
- ノートは、最初は「閲覧」で開きます。「編集」を押すか Cmd+E で、書けるようになります。
- 入力すると自動で保存します。保存の直前には、ノートの控え（バックアップ）を残します。
- ファイルの一覧、目次、日付ごとのノートを開けるカレンダー、ノートを探す機能があります。ファイルの一覧でノートを移動したり名前を変えたりすると、そのノートへのリンクも、確認のうえで書き直します。
- 数式（KaTeX）と Mermaid の図を表示できます。図の中に書いたリンク（`click` や `link`）は取り除くので、図を押してもどこにも移りません。
- Obsidian 独自の書き方の一部（`[[内部リンク]]`、コールアウト、ハイライト、タグ、コメント、ノートの先頭に書く、タグや日付などの情報）に対応しています。

これは Codex や OpenAI、Obsidian の公式のものではありません。

## まずコピーで試してください

このエディターは、自動で保存してノートのファイルを書き換えます。初めて使うときは、ノートのフォルダーのコピーか、Git で管理しているフォルダーで試してください。

## 動作を確かめた環境

| 対象 | 確かめたもの |
|---|---|
| Mac | Apple シリコンの Mac、macOS 27 |
| Codexアプリ | 26.1027、26.1111、26.1117 |

Node.js は要りません。Intel の Mac は対象外です。Windows と Linux の Codexアプリでは使えません（下の「Windows について」）。

## インストール

**これはプレビュー版です。** まだ開発の途中なので、思わぬ動きをすることがあります。

必要なもの：

- Codexアプリ（Apple シリコンの Mac のデスクトップ版）
- 初めて使うときだけ、インターネットへのつながり（下の「初めて使うとき」）

ターミナルで次の2つのコマンドを実行します。Codexアプリは終了しておいてください。

```sh
codex plugin marketplace add kuma8088/notedock-codex
codex plugin add notedock@notedock
```

版ごとのタグを付けて公開したあとは、`kuma8088/notedock-codex@v0.1.0` のようにタグを指定して、決まった版を入れられます。

入れたあと、Codexアプリを起動し、`.md` のファイルを開きます。初めてのときは Codexアプリにもとからある表示で開くので、右上の「Open」ボタンの右の矢印から「Visual Editor」を選びます。ここで選んだものは、すべての `.md` に効きます。自分で開く入口は `.md` のファイルだけです（左の列や「More tools」には出ません）。ただし、Codex の AI がエディターを開く道具（`open_note`）を呼んで、エディターを開くことはあります。

### 初めて使うとき

NoteDock は、初めて Visual Editor で開いたときに「サーバーを取ってくる」ボタンを出します。押すと、GitHub から約88MB のファイルを取ってきて、指紋（SHA-256）を確かめてから使います。取ってくるのは版ごとに1回で、2回目からはネットにつながっていなくても使えます。新しい版に上げたときは、もう一度ボタンが出ます。古い版のファイルは自動では消えません。

- 取ってきたファイルは `~/Library/Caches/NoteDockCodex/server/` に置きます。Mac が空きを作るためにこの場所を片付けたときは、もう一度ボタンが出ます。
- 取ってきたあとも読むだけの画面や前の画面が出たときは、そのタブを閉じて開き直してください。

### 使えない環境

会社のプロキシ（社内ネットから外に出るための中継）を通さないとインターネットにつながらない環境では、ファイルを取ってこられません。今の版では、この環境は対象外です。

### 更新と削除

```sh
codex plugin marketplace upgrade   # 新しい版を取り直す
codex plugin remove notedock@notedock   # プラグインを削除する
codex plugin marketplace remove notedock   # マーケットプレイスの登録も消す
```

## 編集できるノート

設定は要りません。編集できるフォルダーは、NoteDock が次の順で決めます。

1. Codexアプリの会話で選んでいるプロジェクトのフォルダー。会話を始めて Codex からフォルダーが届くと、そのフォルダーの中のノートを編集できるようになります。プロジェクトなしの会話では、その会話の作業フォルダー（`~/Documents/Codex/日付/…`）の中です。NoteDock がそこに自分でノートを作ることはありません
2. 前にこのエディターでノートを保存したことのあるフォルダー。会話を始める前に開いたノートでも、このフォルダーの中なら編集できます

どちらにも当たらないノートは、読み取り専用で開きます。会話を始める前に開いたノートは、会話が始まってフォルダーが届くと、何もしなくても編集できる状態に切り替わります。

ホームフォルダーそのもの、「書類」そのもの、`~/Library` の中（iCloud Drive などの中のフォルダーは除く）、ホームの下の名前がドット（`.`）で始まるフォルダー（Codex が作る worktree は除く）のように、広すぎる場所や隠れた場所は、編集できるフォルダーにしません。

- フォルダーの外のノートは、読み取り専用で開きます。外のノートを開いたタブでは、フォルダーの中のノートも読み取り専用になり、新しいノートを作ることも、「設定」を開くこともできません。
- フォルダーが見つからないとき（名前を変えた、動かした、外付けのディスクをつないでいない、Mac のアクセス許可がない、など）は、すべて読み取り専用になります。「デスクトップ」「iCloud Drive」の中のフォルダーでは、まだ確かめていません。

次のノートは、中身を壊さないために、読み取り専用で開きます。

- 文字コードが UTF-8 でないノート
- 先頭に BOM が付いているノート
- 改行が CRLF（Windows の形式）のノート、改行の形式が混ざっているノート
- Excalidraw で描いた図のノート
- 20MB を超えるノート（100MB を超えるファイルは開きません）

1MB を超えるノートは、「ソース」の表示でしか開けません。

次のものは、ファイルの一覧にも「探す」にも出ません。

- 名前がドット（`.`）で始まるフォルダーとファイル（`.git` や `.obsidian` など）
- `node_modules` フォルダー
- シンボリックリンクのノートとフォルダー

これらは、エディターの一覧やリンクからは開けません。Codexアプリのファイルの一覧から開くと、読み取り専用になります。

ハードリンクのノートは、保存するとハードリンクではなくなります（新しいファイルを書いてから置き換えるため）。

## 控え（バックアップ）

ノートを保存するとき、書き換える前の中身を控えとして残します。控えは、エディターの「履歴」から見たり、元に戻したりできます。

| 種類 | 残すとき | 残す期間 |
|---|---|---|
| 保存のたびの控え | 保存するたび | 1日（1つのノートにつき200個まで） |
| 定期的な控え | 前の定期的な控えから5分以上あけて保存したとき | 7日 |
| ほかの変更と重なったときなど | ・ほかのアプリでも同じ行が書き換えられて、どちらかを選んだとき（選ばなかった方）<br>・ノートが消えたとき<br>・「履歴」から戻す直前 | 7日 |

期限が切れた控えは、エディターが起動したときと、動いている間は1時間ごとに削除します。

控えは、ノートのフォルダーの外の、次の場所に置きます。ノートの中身のコピーと、ノートがどこにあるかの情報が入ります。

- Mac：`~/Library/Application Support/NoteDockCodex/`

「設定」で選んだ内容（画像の置き場所、日付ごとのノートの置き場所）も、同じ場所の `settings/` に保存します。

ノートのフォルダーを移動したり名前を変えたりすると、それまでの「履歴」と「設定」は、エディターから見えなくなります。控えのファイルは残っていて、期限が来ると削除します。

## 下書き

まだ保存していない書きかけの内容は、打ってから1秒ほどで、下書きとして Codexアプリの中（`localStorage`）に残します。同じ下書きは、エディターのサーバーを通して、控えと同じ場所に `draft.json` というファイルでも残します。ファイルにも残すのは、Codexアプリの中の下書きが、アプリが急に終了したときに最後の1分ほど消えることがあるからです。

保存できたら、ふつうはどちらの下書きも消します。ただ、ノートを開いたときにサーバーから応答がなかった場合は、ファイルの下書きが残ることがあります。そのときは、次にそのノートを開いたときに、もう一度「反映しますか？」と聞かれることがあります。

保存できないまま閉じた場合、たとえば、ほかのアプリでノートが書き換えられて、エディターが保存を止めている間に閉じた場合は、次にそのノートを開いたときに、2つの下書きのうち新しいほうをノートに反映するかどうかを聞きます。「内容を見る」を押すと、今のノートと並べて見比べられます。

下書きを最後に更新してから30日たつと削除します。Codexアプリの中の下書きはエディターを開いたときに、ファイルの下書きは古い控えを削除するときに一緒に消します。Codexアプリの中の保存場所の容量がいっぱいだと、Codexアプリの中には下書きを残せません。そのときは画面にお知らせが出ます。

## リンクを別のタブで開く

「閲覧」と「編集」の画面で、Cmd キーを押しながらノートへのリンクをクリックすると、リンク先のノートを Codexアプリの別のタブで開きます。ふつうにクリックすると、今のタブの中で開きます。「編集」の画面では、ノートへのリンクのうち、カーソルが入っているものは、クリックしても開きません。

- リンク先のノートがすでにタブで開いているときは、新しいタブが出ないことがあります。
- リンク先のノートがまだないときは、別のタブは開かず、ふつうにクリックしたときと同じく、今のタブで「新しく作りますか。」と聞きます。
- 「ソース」の画面では、リンクを押しても開きません。フォルダーの外のノートを開いたタブからは、リンク先を開けません。
- 別のタブを開くとき、Codexアプリが「Use notedock to open .md files?」と英語で聞いてくることがあります。「Open with notedock」を押してください。
- ここで「Use built-in」を押すと、`.md` を開くときに Codexアプリにもとからある表示（Built-in）が使われるように、設定が切り替わります。この設定はすべての `.md` に効くので、ほかの `.md` も、このエディターでは開かなくなるはずです。設定が書き換わることは、テスト用の Mac（Codexアプリ 26.1111）で確かめました。
- 戻すには、開いたノートの右上にある「Open」ボタンの、右の矢印を押して「Visual Editor」を選びます。「Open」の文字の部分を押すと、ほかのアプリで開いてしまいます。

## ゴミ箱

エディターでノートやフォルダーを消すと、Mac のゴミ箱に移します。すぐに完全に消すことはしません。Finder の「戻す」で元の場所に戻せます。フォルダーを消すときは、中のノートとほかのファイルの数を先に見せます。

`.md` のファイルを開いたタブでは、そのノート自身と、そのノートが入っているフォルダーは、消すことも移動することもできません。

## 画像

貼り付けた画像は、「設定」で選んだフォルダーに入れます。選んでいなければ、ノートのフォルダーのすぐ下に `attachments` フォルダーを作って入れます。1つの画像は25MBまでです。

表示できる画像は、PNG、JPEG、GIF、WebP、SVG、AVIF、BMP です。表示するのは `![](場所)` の形で書いた画像です。

ノートにインターネット上の画像のアドレス（`![](https://…)`）が書いてあっても、エディターは読み込みません。エディターの画面には、ページの外から画像などを読み込んだり、インターネットとやりとりしたりしない設定を入れてあります。Codexアプリ側にも、読み込まない設定を入れてあります。テスト用の Mac で Codexアプリ 26.1111 を使って試したところ、画像は読み込まれず、「画像を開けません」と表示されました。

## 日付ごとのノート

日付ごとのノートをどこに置くかを「設定」で選ぶまでは、「今日のノート」のボタンは出ません。カレンダーが出るはずの所には、代わりに「設定」を開くための案内が出ます。ひな形も「設定」で選べます。

置き場所の中のフォルダーの分け方は決まっていて、変えられません。

| ノート | 保存先の例（置き場所を `Periodic` にした場合） |
|---|---|
| 日のノート | `Periodic/2026/Daily/2026-11-08.md` |
| 週のノート | `Periodic/2026/Weekly/2026-W45.md` |
| 月のノート | `Periodic/2026/Monthly/2026-11.md` |
| 四半期（3か月ごと）のノート | `Periodic/2026/Quarterly/2026-Q4.md` |
| 年のノート | `Periodic/2026/2026.md` |

その年のノートを初めて作ると、`Daily`、`Weekly`、`Monthly`、`Quarterly` の4つのフォルダーが自動でまとめて作られます。週の番号は国際的な決まり（ISO 8601）で数えます。そのため、年をまたぐ週は前の年の週になることがあります。たとえば2027年1月1日を含む週は `2026-W53` で、`Periodic/2026/Weekly/` に入ります。

## AI とのかかわり

ノートを読み書きする機能は、エディターの画面からしか使えない作りにしています。

- Codex の AI からは使えないように設定しています。ただ、この設定どおりに動くかどうかは、Codexアプリのバージョンによります。Codexアプリ 26.1103 と 26.1106 では、AI から使えないことを確かめました。26.1111 では、まだ確かめていません。
- さらにエディターのサーバーは、エディターの画面を表示できるアプリからの求めにだけ応えます（アプリが自分でそう伝えてくるのを信じる仕組みです）。
- Codex の AI が `open_note` でエディターを開いたときは、ファイルを指定しないで開くので、そのエディターからは編集できるフォルダー全体を編集できます。

まだ確かめていないこと：

- エディターの画面に送ったノートの中身が、AI に渡らないか。
- Codexアプリの中の下書きが、ほかのプラグインから読めないか。

エディターの裏で動くプログラムがインターネットにつなぐのは、初めて使うときに「サーバーを取ってくる」ボタンを押したときだけです（GitHub の Releases から本体を取ってきます）。インターネット上の画像については、上の「画像」のところを見てください。

Mermaid の図の中のリンクは、エディターが取り除きます。Codexアプリでも、ノートを見る画面でフローチャートのリンクを押しても、何も開かないことを確かめました。Mermaid の図に入れた画像（`A@{ img: "https://…" }`）や、図の色や形を決める設定の中に書いたURLも、上の設定があるので、読み込まれません。画像を入れた図は「図を描けません」と表示されます。

## 開いているノートを AI に伝える

エディターの上の帯にある「AI」のボタンをオンにすると、開いているノートの場所を、Codex の会話に伝えます。最初はオフです。

- 伝えるのは、フォルダーの中でのノートの場所、フォルダーの場所（フルパス）、選んでいる行の番号だけです。ノートの中身は送りません。中身が要るときは、AI がそのファイルを読みます
- フォルダーの外のノートでは、フォルダーの場所も伝えません
- オンとオフは、同じフォルダーのどのタブにも同じように効きます

## Obsidian との違い

| Obsidian の機能 | このエディターでは |
|---|---|
| `[[内部リンク]]` | クリックするとそのノートが開きます。`[[ノート\|表示名]]` と `[[ノート#見出し]]` に対応しています。ノートの先頭に書いた別名（aliases）では、リンク先を探しません。`[[ノート#^ブロック]]` は、ノートを開くだけで、その場所には移りません |
| `![[埋め込み]]` | `![[ノート]]` も `![[画像.png]]` も、文字のまま表示します。画像は `![](場所)` の形なら表示します |
| コールアウト | note、tip、important、warning、caution の5種類に対応しています。`> [!note]` のように、その記号だけを書いた行で始めた場合です。題名つき（`> [!note] 題名`）、折りたたみ（`[!note]-`）、ほかの種類、入れ子は、引用のまま表示します |
| ハイライト（`==文字==`）、タグ | 見た目を整えて表示します |
| コメント（`%%文字%%`） | 閲覧では隠し、編集では薄く表示します |
| プラグイン用の記述（Dataview など） | 文字のまま表示します |

- 対応していない書き方でも、エディターが文字を消したり書き換えたりすることはありません。
- リンク先のノートがないときは、ノートを作るかを聞きます。フォルダーの外を指すリンクも、リンク先がないものとして表示します。
- ノートを移動したり名前を変えたりしたときに書き直すリンクは、`[[ ]]` と `[文字](場所.md)` だけです。`![[埋め込み]]` と、ノートの情報の欄の中の `[[ ]]` は書き直しません。
- Obsidian を開いたまま同時に使うことは、まだ確かめていません。

## Windows について

今の版は、Apple シリコンの Mac だけで使えます。Windows 用のファイルは、まだ配っていません。

## アンインストールしたあとに残るもの

プラグインを外しても、次のものは自動では消えません。要らなければ、自分で消してください。

- 控えと設定、下書きのファイル（上の「控え」の場所）
- 初めて使うときに取ってきたサーバーのファイル（`~/Library/Caches/NoteDockCodex/`）
- ノートのフォルダーにできた `attachments` フォルダー
- エディターが強制終了したときに残る一時ファイル（`.ノートの名前.md.（ランダムな文字）.tmp` の形）
- Codexアプリの中の下書きと、画面の状態の記録（折りたたみの状態など）
- Codex の設定ファイル（`~/.codex/config.toml`）の、「.md をこのエディターで開く」の行

## 開発する人へ

| 場所 | 中身 |
|---|---|
| `plugins/notedock/` | Codex が入れるプラグイン。`.codex-plugin/plugin.json`、`.mcp.json`、アイコン、`bin/`（起動用のプログラム `notedock`、`stub.json`、`release.json`） |
| `app/` | エディターの本体（画面とサーバー）のソースと試験。`dist/` は組み立てたもの |
| `launcher/` | 起動用のプログラム（Go）。本体がまだないあいだは `stub.json` の答えを返し、ボタンが押されたら Releases から本体を取ってきて、指紋を確かめてから本体に入れ替わる |
| `scripts/` | リリースの材料を作るスクリプト |

```sh
cd app
npm ci
npm test
npm run build
shasum -a 256 dist/panel.html dist/server.mjs
cd ../launcher
go vet ./...
go test ./...
```

リポジトリに入っている `app/dist/` は、この手順で作ったものです。同じ手順で作り直すと、同じハッシュになります（0.1.0 では、`panel.html` が `68fd20de26feef1374e59fa027190b70e15cda867447ecb81c38e182917abeca`、`server.mjs` が `9475c9d9f347dd541bb613c2a3d16ace2c6543a8e73643bfc1e969b73fed46d9`）。ブラウザーで動かすテストは [app/test/README.md](app/test/README.md) を見てください。

手元で試すときは、環境変数 `NOTE_ROOT` にノートのフォルダーを渡すと、そのフォルダーも編集できるフォルダーの候補になります（Codex で選んでいるフォルダーより先に見ます）。

リリースの作り方は [RELEASING.md](RELEASING.md) にあります。サーバーの本体（約88MB）は Releases に置き、リポジトリには入れません。

## ライセンス

MIT ライセンスです（[LICENSE](LICENSE)）。中で使っているほかのソフトのライセンスは、サーバーの本体の分を Releases の `THIRD-PARTY-NOTICES.txt`（もとは `app/dist/THIRD-PARTY-NOTICES.txt` に Deno を足したもの）に、起動用のプログラムの分を `plugins/notedock/THIRD-PARTY-NOTICES.txt` にまとめています。

---

## English

NoteDock for Codex is a plugin for the Codex desktop app. It opens Markdown notes in the file tab and lets you edit them while headings, tables and checkboxes stay formatted. It is not an official product of OpenAI, Codex or Obsidian.

**This is a preview.** It saves automatically and rewrites your note files. Try it on a copy of your notes, or on a folder tracked with Git, first.

### Requirements

- The Codex desktop app on an Apple silicon Mac (tested on macOS 27, Codex app 26.1027, 26.1111 and 26.1117)
- Node.js is not needed
- An internet connection the first time only (see below)

Intel Macs are not supported. Windows and Linux are not supported in this version.

### Install

Quit the Codex app, then run:

```sh
codex plugin marketplace add kuma8088/notedock-codex
codex plugin add notedock@notedock
```

Start the Codex app and open a `.md` file. The first time, it opens in the built-in viewer: use the arrow next to the "Open" button and choose "Visual Editor". The choice applies to every `.md` file. You open the editor only from `.md` files, but the Codex AI can also open it with the `open_note` tool.

To update, run `codex plugin marketplace upgrade`. To uninstall, run `codex plugin remove notedock@notedock`, then `codex plugin marketplace remove notedock`.

### First use

The first time you open a note in the Visual Editor, NoteDock shows a "download the server" button. When you press it, NoteDock downloads a file of about 88 MB from GitHub, checks its SHA-256 fingerprint, and then uses it. This happens once per version; after that it works offline. When you update to a new version, the button appears again. Files for older versions are not removed automatically. The file is kept in `~/Library/Caches/NoteDockCodex/server/`. If macOS clears that folder, the button appears again. If a read-only or old screen stays after the download, close the tab and open the note again.

Networks that reach the internet only through a corporate proxy are not supported in this version: the download does not work there.

### Which notes you can edit

There is nothing to configure. NoteDock decides the editable folder in this order:

1. The project folder selected in your Codex conversation. Once a conversation starts and Codex passes the folder, notes inside it become editable. For a conversation without a project, it is that conversation's work folder (`~/Documents/Codex/<date>/…`). NoteDock never creates notes there on its own.
2. A folder where you have saved a note with this editor before. Notes inside it are editable even before a conversation starts.

Other notes open read-only. A note opened before a conversation starts becomes editable on its own when the conversation passes the folder. Folders that are too broad or hidden (your home folder itself, Documents itself, inside `~/Library` except folders inside iCloud Drive and similar, and dot folders under your home except Codex worktrees) are never used.

### What it does

- Live-preview editing, a source mode, and read mode (Cmd+E switches to edit)
- Autosave, with backups taken before each save (kept 1 to 7 days, under `~/Library/Application Support/NoteDockCodex/`)
- File list, outline, a calendar for daily and periodic notes, search, and link-aware move and rename
- KaTeX math and Mermaid diagrams. Links inside diagrams are removed
- Parts of Obsidian syntax: `[[wikilinks]]`, callouts, highlights, tags, comments and front matter

### AI and your notes

- The tools that read and write notes are meant for the editor panel only. The server answers only connections that say they can show the panel.
- The "AI" button in the top bar is off by default. When on, it tells the Codex conversation where the open note is: its path in the folder, the folder's full path, and the selected line numbers. It does not send the note's text.
- If the Codex AI opens the editor with `open_note`, that editor is not tied to one file and can edit the whole editable folder.
- The only time the plugin connects to the internet is when you press the download button on first use (it downloads the server from GitHub Releases). The panel loads no outside images or files.

### Security

See [SECURITY.md](SECURITY.md). Please report vulnerabilities privately, not in public issues.

### Development

The plugin that Codex installs is `plugins/notedock/`. The editor's source and tests are in `app/` (run `npm ci`, `npm test` and `npm run build` there), and the launcher (Go) is in `launcher/` (run `go test ./...`). For local testing, the `NOTE_ROOT` environment variable adds a notes folder as an editable-folder candidate, checked before the Codex folder. The committed `app/dist/` is built with these steps, and rebuilding gives the same SHA-256 hashes. See [RELEASING.md](RELEASING.md) for how releases are made.

### License

MIT ([LICENSE](LICENSE)). Third-party licenses for the server are in `THIRD-PARTY-NOTICES.txt` on each release, and for the launcher in `plugins/notedock/THIRD-PARTY-NOTICES.txt`.
