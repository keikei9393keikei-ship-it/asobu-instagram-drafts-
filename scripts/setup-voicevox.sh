#!/usr/bin/env bash
# scripts/setup-voicevox.sh — VOICEVOX ENGINE（Linux・CPU版）を入れる。次のセッションからは1回流せば使える。
#
#   bash scripts/setup-voicevox.sh
#
# 入れ先：  ~/.cache/voicevox/engine/run   （VOICEVOX_HOME で変えられる）
# 配布元：  VOICEVOX 公式の GitHub リリース（VOICEVOX/voicevox_engine）
#           github.com と release-assets.githubusercontent.com に届く必要がある。
#
# すでに入っていれば何もしない。ダウンロードが止められたときは、止められた URL とエラーを出して終わる。
# （VOICEVOX 以外の読み上げで代用しない。声は VOICEVOX:ずんだもん だけ。）
set -euo pipefail

VERSION="0.25.2"
ASSET="voicevox_engine-linux-cpu-x64-${VERSION}.7z.001"
URL="https://github.com/VOICEVOX/voicevox_engine/releases/download/${VERSION}/${ASSET}"
EXPECTED_BYTES=1815385564          # 配布ファイルの大きさ。途中で切れたものを入れないための確認
HOME_DIR="${VOICEVOX_HOME:-$HOME/.cache/voicevox}"
ENGINE_DIR="$HOME_DIR/engine"

if [ -x "$ENGINE_DIR/run" ]; then
  echo "VOICEVOX ENGINE は入っています: $ENGINE_DIR/run"
  exit 0
fi

mkdir -p "$HOME_DIR"
cd "$HOME_DIR"

# 7z が要る（なければ入れる）
if ! command -v 7z >/dev/null 2>&1; then
  echo "7z を入れます（apt-get install p7zip-full）"
  apt-get install -y -q p7zip-full >/dev/null
fi

echo "ダウンロード: $URL"
if ! curl -fSL --retry 4 -C - -o "$ASSET" "$URL"; then
  echo "ERROR: ダウンロードできませんでした。" >&2
  echo "  URL    : $URL" >&2
  echo "  ドメイン: github.com / release-assets.githubusercontent.com" >&2
  echo "  この環境のネットワーク設定で止められている可能性があります（VOICEVOX 以外では代用しません）。" >&2
  exit 1
fi

ACTUAL=$(stat -c %s "$ASSET")
if [ "$ACTUAL" != "$EXPECTED_BYTES" ]; then
  echo "ERROR: ファイルの大きさが違います（$ACTUAL / $EXPECTED_BYTES）。もう一度流してください。" >&2
  exit 1
fi

echo "展開しています（約25秒・3.8GB）"
rm -rf linux-cpu-x64 "$ENGINE_DIR"
7z x -y -bso0 -bsp0 "$ASSET" -o.
mv linux-cpu-x64 "$ENGINE_DIR"
rm -f "$ASSET"                      # 1.8GB なので、展開できたら消す

# 動作確認：立ち上げて、バージョンが返れば OK
( cd "$ENGINE_DIR" && ./run --host 127.0.0.1 --port 50021 >"$HOME_DIR/engine-setup.log" 2>&1 & echo $! >"$HOME_DIR/engine-setup.pid" )
ok=0
for _ in $(seq 1 90); do
  if curl -fs -m 2 http://127.0.0.1:50021/version >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
kill "$(cat "$HOME_DIR/engine-setup.pid")" 2>/dev/null || true
if [ "$ok" != 1 ]; then
  echo "ERROR: 入れたあと ENGINE が立ち上がりませんでした。ログ: $HOME_DIR/engine-setup.log" >&2
  exit 1
fi
echo "OK: VOICEVOX ENGINE ${VERSION} を入れました: $ENGINE_DIR/run"
