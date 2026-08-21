#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST="$ROOT/dist"
STAGE="$DIST/Codex Token Observatory Windows"
ARCHIVE="$DIST/Codex-Token-Observatory-Windows.zip"

rm -rf "$STAGE" "$ARCHIVE"
mkdir -p "$STAGE"
rsync -a --delete \
  --exclude 'dist' \
  --exclude '.git' \
  --exclude '.DS_Store' \
  --exclude 'packaging' \
  "$ROOT/" "$STAGE/"
cp "$ROOT/packaging/windows/start-observer.cmd" "$STAGE/"
cp "$ROOT/packaging/windows/README-Windows.txt" "$STAGE/"

 ditto -c -k --sequesterRsrc --keepParent "$STAGE" "$ARCHIVE"
rm -rf "$STAGE"
echo "Built: $ARCHIVE"
