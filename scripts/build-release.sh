#!/bin/sh
# NoteDock for Codex のリリースの材料を作る（push・タグ・Releases への置き場の作成はしない）。
#
# 使い方：sh scripts/build-release.sh <版>      例：sh scripts/build-release.sh 0.1.0
#
# 作るもの（release-out/<版>/。Git には入れない）：
#   notedock-server-aarch64-apple-darwin  本体（Deno で1つにしたサーバー）。Releases に置く
#   THIRD-PARTY-NOTICES.txt               本体に入っているほかのソフトのライセンス。Releases に置く
#   SHA256SUMS                            上の2つの指紋。Releases に置く
#   plugin-bin/notedock                   起動用のプログラム（Go、Apple シリコン用）
#   plugin-bin/stub.json                  本体が答えた道具の一覧などの写し（準備中に返す）
#   plugin-bin/release.json               本体の版・取ってくる場所・大きさ・指紋
#
# 順番：本体の試験とビルド → 本体を1つのファイルにする → 起動用のプログラムの試験とビルド
#       → stub.json を本体から作る → stub.json と本体を比べる試験（飛ばしたら止める）→ release.json と SHA256SUMS
#
# 環境変数：
#   REPO                     取ってくる場所のリポジトリ（既定 kuma8088/notedock-codex）
#   DENO_VERSION             使う Deno の版（既定 2.7.5。違えば止める）
#   NOTEDOCK_ALLOW_DOWNLOAD  1 のときだけ、Deno が土台（denort）を取りに行くのを許す。既定はキャッシュだけ
#   SKIP_NPM_CI              1 のとき npm ci をしない（手元の node_modules を使う）
set -eu

VERSION="${1:-}"
if ! printf '%s\n' "$VERSION" | grep -Eq '^0\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$'; then
  echo "版を 0.x.y か 0.x.y-rc.n の形で渡してください: '$VERSION'" >&2
  exit 2
fi
REPO="${REPO:-kuma8088/notedock-codex}"
DENO_VERSION="${DENO_VERSION:-2.7.5}"
TAG="server-v$VERSION"
TARGET=aarch64-apple-darwin
SERVER="notedock-server-$TARGET"

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
OUT="$ROOT/release-out/$VERSION"

# 版が全部そろっているか（package.json、plugin.json、本体が名乗る版）
pkg_v="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' app/package.json | head -n 1)"
plug_v="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' plugins/notedock/.codex-plugin/plugin.json | head -n 1)"
srv_v="$(sed -n "s/.*new McpServer({ name: 'notedock', version: '\([^']*\)' }.*/\1/p" app/server/mcp.mjs | head -n 1)"
for pair in "app/package.json:$pkg_v" "plugins/notedock/.codex-plugin/plugin.json:$plug_v" "app/server/mcp.mjs:$srv_v"; do
  if [ "${pair##*:}" != "$VERSION" ]; then
    echo "版がそろっていません: ${pair%%:*} は '${pair##*:}'、渡した版は '$VERSION'" >&2
    exit 1
  fi
done

# 道具の版
actual_deno="$(deno eval 'console.log(Deno.version.deno)')"
if [ "$actual_deno" != "$DENO_VERSION" ]; then
  echo "Deno の版が $DENO_VERSION ではありません: ${actual_deno}（違う版で作ると本体の大きさが変わります）" >&2
  exit 1
fi
case "$(go env GOVERSION)" in
  go1.25.*) ;;
  *) echo "Go の版が 1.25 ではありません: $(go env GOVERSION)" >&2; exit 1 ;;
esac

rm -rf "$OUT"
mkdir -p "$OUT/plugin-bin"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== 1. 本体の試験とビルド"
(
  cd app
  if [ "${SKIP_NPM_CI:-}" != "1" ]; then npm ci; fi
  npm test
  npm run build
)
# リポジトリに入っている dist/ と、いま作ったものが同じか
if ! git diff --exit-code --quiet -- app/dist; then
  echo "app/dist がコミットしたものと違います。作り直した dist をコミットしてから、もう一度実行してください。" >&2
  exit 1
fi

echo "== 2. 本体を1つのファイルにする（Deno ${DENO_VERSION}）"
# node_modules のない場所で作る（あると中に入って約300MBになる）
mkdir -p "$WORK/srv"
cp app/dist/server.mjs app/dist/panel.html "$WORK/srv/"
if [ "${NOTEDOCK_ALLOW_DOWNLOAD:-}" = "1" ]; then
  CACHED=""
else
  CACHED="--cached-only"
fi
# 権限：ファイルの読み書き、環境変数、OS の情報、ゴミ箱（/usr/bin/trash）の実行だけ。ネットへの接続は与えない
( cd "$WORK/srv" && deno compile $CACHED --no-check --no-prompt \
    --allow-read --allow-write --allow-env --allow-sys --allow-run=/usr/bin/trash \
    --include panel.html --target "$TARGET" --output "$OUT/$SERVER" server.mjs )
codesign -v "$OUT/$SERVER"
# 本体のライセンスの一覧：画面とサーバーに入れた npm のライブラリ（build.mjs が書き出す）に、実行環境 Deno を足す
{
  cat app/dist/THIRD-PARTY-NOTICES.txt
  printf '\n========================================================================\n'
  printf 'Deno  (MIT)  サーバーの本体に入る実行環境\n'
  printf '========================================================================\n'
  grep -v '^# ' scripts/licenses/deno.txt
} > "$OUT/THIRD-PARTY-NOTICES.txt"

echo "== 3. 起動用のプログラムの試験とビルド（Apple シリコン用だけ）"
(
  cd launcher
  go vet ./...
  go test ./... -count=1
  CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags="-s -w -buildid=" -o "$OUT/plugin-bin/notedock" .
)
codesign -v "$OUT/plugin-bin/notedock"
if strings -a "$OUT/plugin-bin/notedock" | grep -q "$HOME"; then
  echo "起動用のプログラムに、作った人のホームフォルダーの場所が入っています" >&2
  exit 1
fi

echo "== 4. stub.json を本体から作る"
python3 -I scripts/make-stub.py "$OUT/$SERVER" "$OUT/plugin-bin/stub.json"

echo "== 5. stub.json と本体を比べる（飛ばしたら止める）"
STUBLOG="$WORK/stub-test.log"
( cd launcher && NOTEDOCK_REAL_SERVER="$OUT/$SERVER" NOTEDOCK_STUB="$OUT/plugin-bin/stub.json" \
    go test -run TestStubMatchesServer -v -count=1 . ) | tee "$STUBLOG"
if ! grep -q -- '--- PASS: TestStubMatchesServer' "$STUBLOG"; then
  echo "TestStubMatchesServer が合格していません（飛ばされた場合も止めます）" >&2
  exit 1
fi

echo "== 6. release.json と SHA256SUMS"
size="$(stat -f %z "$OUT/$SERVER")"
sum="$(shasum -a 256 "$OUT/$SERVER" | awk '{print $1}')"
cat > "$OUT/plugin-bin/release.json" <<EOF
{
 "version": "$VERSION",
 "base_url": "https://github.com/$REPO/releases/download/$TAG/",
 "assets": {
  "darwin-arm64": {
   "file": "$SERVER",
   "size": $size,
   "sha256": "$sum"
  }
 }
}
EOF
( cd "$OUT" && shasum -a 256 "$SERVER" THIRD-PARTY-NOTICES.txt > SHA256SUMS && cat SHA256SUMS )

echo
echo "できました: $OUT"
echo "Releases（タグ ${TAG}）に置くもの: ${SERVER}、THIRD-PARTY-NOTICES.txt、SHA256SUMS"
echo "プラグインに入れるもの: sh scripts/stage-plugin.sh $VERSION"
