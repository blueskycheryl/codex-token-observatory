#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST="$ROOT/dist"
STAGE="$DIST/Codex Token Observatory Source"
ARCHIVE="$DIST/Codex-Token-Observatory-Source.zip"

rm -rf "$STAGE" "$ARCHIVE"
mkdir -p "$STAGE"
rsync -a --delete \
  --exclude 'dist' \
  --exclude '.git' \
  --exclude '.DS_Store' \
  --exclude '*.swp' \
  --exclude '*~' \
  "$ROOT/" "$STAGE/"

ditto -c -k --sequesterRsrc --keepParent "$STAGE" "$ARCHIVE"
rm -rf "$STAGE"
echo "Built: $ARCHIVE"
