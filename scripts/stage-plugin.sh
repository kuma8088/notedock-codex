#!/bin/sh
# build-release.sh が作った起動用のプログラム・stub.json・release.json を plugins/notedock/bin/ に入れる。
# 使い方：sh scripts/stage-plugin.sh <版> <Releases から取ってきた資産のフォルダー>
#   2つ目には、server-v<版> の Releases から取ってきた本体・SHA256SUMS を置いたフォルダーを渡す（RELEASING.md の段階3）。
#   release.json の大きさと指紋が、手元で作った本体と、Releases から取ってきた本体の両方に合わなければ止める。
set -eu
VERSION="${1:?版を渡してください（例：0.1.0）}"
ASSETS="${2:?Releases から取ってきた資産のフォルダーを渡してください}"
cd "$(dirname "$0")/.."
OUT="release-out/${VERSION}"
SRC="${OUT}/plugin-bin"
SERVER=notedock-server-aarch64-apple-darwin
for f in "${SRC}/notedock" "${SRC}/stub.json" "${SRC}/release.json" "${OUT}/${SERVER}" "${ASSETS}/${SERVER}" "${ASSETS}/SHA256SUMS"; do
  [ -f "$f" ] || { echo "ありません: $f" >&2; exit 1; }
done
[ -f plugins/notedock/THIRD-PARTY-NOTICES.txt ] || { echo "plugins/notedock/THIRD-PARTY-NOTICES.txt がありません" >&2; exit 1; }

want="$(python3 -I -c 'import json,sys
r=json.load(open(sys.argv[1])); a=r["assets"]["darwin-arm64"]
assert r["version"]==sys.argv[2], "release.json の版が "+r["version"]
assert a["file"]==sys.argv[3], "release.json のファイル名が "+a["file"]
print(a["size"], a["sha256"])' "${SRC}/release.json" "${VERSION}" "${SERVER}")"
for f in "${OUT}/${SERVER}" "${ASSETS}/${SERVER}"; do
  got="$(stat -f %z "$f") $(shasum -a 256 "$f" | awk '{print $1}')"
  if [ "$got" != "$want" ]; then
    echo "release.json（${want}）と ${f}（${got}）が合いません。Releases のファイルと release.json は、同じ build-release.sh の実行で作ったものにしてください。" >&2
    exit 1
  fi
done
( cd "${ASSETS}" && shasum -a 256 -c SHA256SUMS )

mkdir -p plugins/notedock/bin
cp "${SRC}/notedock" "${SRC}/stub.json" "${SRC}/release.json" plugins/notedock/bin/
chmod 755 plugins/notedock/bin/notedock
codesign -v plugins/notedock/bin/notedock
shasum -a 256 plugins/notedock/bin/*
