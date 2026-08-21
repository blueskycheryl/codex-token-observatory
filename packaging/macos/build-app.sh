#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST="$ROOT/dist"
APP="$DIST/Codex Token Observatory.app"
CONTENTS="$APP/Contents"
RESOURCES="$CONTENTS/Resources"
BUNDLE="$RESOURCES/app"

rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$BUNDLE"

cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>Codex Token Observatory</string>
  <key>CFBundleExecutable</key>
  <string>launch</string>
  <key>CFBundleIdentifier</key>
  <string>local.codex.token-observatory</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Codex Token Observatory</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>0.1.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
PLIST

rsync -a --delete \
  --exclude 'dist' \
  --exclude '.git' \
  --exclude '.DS_Store' \
  --exclude 'packaging/macos/build-app.sh' \
  "$ROOT/" "$BUNDLE/"

cat > "$CONTENTS/MacOS/launch" <<'LAUNCH'
#!/bin/zsh
set -u

APP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$APP_ROOT/Resources/app"
PORT="${CODEX_TOKEN_OBSERVER_PORT:-4399}"
URL="http://127.0.0.1:${PORT}"
LOG_DIR="$HOME/Library/Logs/Codex Token Observatory"
LOG_FILE="$LOG_DIR/observer.log"
mkdir -p "$LOG_DIR"

find_node() {
  local candidate
  for candidate in \
    "$HOME/.volta/bin/node" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node; do
    if [[ -x "$candidate" ]]; then
      print -r -- "$candidate"
      return 0
    fi
  done

  local nvm_node
  nvm_node="$(find "$HOME/.nvm/versions/node" -type f -path '*/bin/node' -perm -111 2>/dev/null | tail -1)"
  if [[ -n "$nvm_node" ]]; then
    print -r -- "$nvm_node"
    return 0
  fi

  command -v node 2>/dev/null || true
}

find_codex() {
  local candidate
  for candidate in \
    /Applications/ChatGPT.app/Contents/Resources/codex \
    "$HOME/.volta/bin/codex" \
    /opt/homebrew/bin/codex \
    /usr/local/bin/codex \
    /usr/bin/codex; do
    if [[ -x "$candidate" ]]; then
      print -r -- "$candidate"
      return 0
    fi
  done

  local nvm_codex
  nvm_codex="$(find "$HOME/.nvm/versions/node" -type f -path '*/bin/codex' -perm -111 2>/dev/null | tail -1)"
  if [[ -n "$nvm_codex" ]]; then
    print -r -- "$nvm_codex"
    return 0
  fi

  command -v codex 2>/dev/null || true
}

NODE_BIN="$(find_node)"
if [[ -z "$NODE_BIN" ]]; then
  osascript -e 'display dialog "未找到 Node.js。请先安装 Node.js 18+，然后重新打开 Codex Token Observatory。" with title "Codex Token Observatory" buttons {"知道了"} default button "知道了"'
  exit 1
fi

CODEX_BIN="$(find_codex)"
if [[ -n "$CODEX_BIN" ]]; then
  export CODEX_BIN
else
  print -r -- "WARN: Codex CLI not found; set CODEX_BIN before launching for live usage." >>"$LOG_FILE"
fi

if /usr/bin/curl -fsS --max-time 1 "$URL/api/health" >/dev/null 2>&1; then
  /usr/bin/open "$URL"
  exit 0
fi

print -r -- "Starting observer: node=$NODE_BIN codex=${CODEX_BIN:-not-found} codexHome=${CODEX_HOME:-$HOME/.codex} piHome=${PI_HOME:-$HOME/.pi/agent}" >>"$LOG_FILE"
nohup /bin/zsh -lc 'exec "$1" "$2" --open' _ "$NODE_BIN" "$APP_DIR/scripts/observer.mjs" >>"$LOG_FILE" 2>&1 &
disown $! 2>/dev/null || true

for _ in {1..30}; do
  if /usr/bin/curl -fsS --max-time 1 "$URL/api/health" >/dev/null 2>&1; then
    /usr/bin/open "$URL"
    exit 0
  fi
  sleep 0.2
done

/usr/bin/open "$URL"
LAUNCH

chmod +x "$CONTENTS/MacOS/launch"
mkdir -p "$DIST"
 ditto -c -k --sequesterRsrc --keepParent "$APP" "$DIST/Codex-Token-Observatory-macOS.zip"

echo "Built: $APP"
echo "Archive: $DIST/Codex-Token-Observatory-macOS.zip"
