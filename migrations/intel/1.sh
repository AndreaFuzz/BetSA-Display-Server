#!/usr/bin/env bash
# ======================================================================
#  Migration 1 (Intel): replace /usr/local/bin/launch-browsers.sh
# ======================================================================
set -euo pipefail

TARGET="/usr/local/bin/launch-browsers.sh"
LOG="/var/log/betsa-migration-intel-1.log"

# ------------- simple logging setup -----------------------------------
mkdir -p "$(dirname "$LOG")"
touch "$LOG"
exec > >(tee -a "$LOG") 2>&1
echo "[$(date '+%F %T')] --- Migration intel/1.sh starting ---"

# ------------- backup old script if present ---------------------------
if [ -f "$TARGET" ]; then
  cp "$TARGET" "${TARGET}.bak.$(date '+%Y%m%d_%H%M%S')"
  echo "Backed up previous launch script"
fi

# ------------- write new content --------------------------------------
cat >"$TARGET" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

# --------------------------------------------------
# basic environment
# --------------------------------------------------
DESKTOP_USER=admin
export DISPLAY=:0
export XAUTHORITY=/home/${DESKTOP_USER}/.Xauthority
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}

if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  BUS_ADDR=unix:path=${XDG_RUNTIME_DIR}/bus
  if ! busctl --user status &>/dev/null; then
    dbus-daemon --session --address="$BUS_ADDR" --fork --nopidfile
  fi
  export DBUS_SESSION_BUS_ADDRESS=$BUS_ADDR
fi

/usr/bin/xmodmap - <<'XMAP'
keycode 70 = NoSymbol
keycode 23 = NoSymbol
keycode 28 = NoSymbol
XMAP

# --------------------------------------------------
# paths and constants
# --------------------------------------------------
BROWSER=$(command -v ungoogled-chromium || command -v chromium)
EXT_DIR="/opt/betsa-ext"
EXT_ID="lkdpgjnbcailmlgeabecblcbokckgamn"

PROFILE_DIR1=/home/${DESKTOP_USER}/.config/single-profile-1
PROFILE_DIR2=/home/${DESKTOP_USER}/.config/single-profile-2
PREF1="${PROFILE_DIR1}/Default/Preferences"
PREF2="${PROFILE_DIR2}/Default/Preferences"

write_pref () {
  local pref_file=$1
  mkdir -p "$(dirname "$pref_file")"
  cat >"$pref_file" <<JSON
{
  "extensions": {
    "ui": { "developer_mode": true },
    "settings": {
      "${EXT_ID}": {
        "state": 1,
        "incognito": true
      }
    }
  }
}
JSON
}

# --------------------------------------------------
# main supervisor loop
# --------------------------------------------------
while true; do
  pkill -f "$BROWSER" || true
  sleep 1

  # detect monitors
  mapfile -t MONITORS < <(xrandr --query | awk '/ connected/{print $1}')
  PRIMARY=${MONITORS[0]}
  SECONDARY=${MONITORS[1]:-}

  # place monitors
  xrandr --output "$PRIMARY" --auto --primary --pos 0x0
  PRIM_WIDTH=$(xrandr --query | awk -v mon="$PRIMARY" '$0~mon" connected" {match($0,/([0-9]+)x[0-9]+/,a);print a[1]}')

  if [ -n "$SECONDARY" ]; then
    xrandr --output "$SECONDARY" --auto --pos ${PRIM_WIDTH}x0
  fi

  # window sizes and positions
  WIN1_SIZE=$(xrandr --query | awk -v mon="$PRIMARY" '$0~mon" connected" {match($0,/([0-9]+x[0-9]+)/,a);print a[1]}' | sed 's/x/,/')
  WIN1_POS="0,0"

  if [ -n "$SECONDARY" ]; then
    WIN2_SIZE=$(xrandr --query | awk -v mon="$SECONDARY" '$0~mon" connected" {match($0,/([0-9]+x[0-9]+)/,a);print a[1]}' | sed 's/x/,/')
    WIN2_POS="${PRIM_WIDTH},0"
  fi

  # rewrite Preferences every loop
  write_pref "$PREF1"
  [ -n "$SECONDARY" ] && write_pref "$PREF2"

  # launch first browser
  "$BROWSER" \
    --kiosk --start-fullscreen --incognito \
    --disable-crashpad --no-first-run --no-default-browser-check \
    --disable-features=PrivacySandboxSettings4,ChromeWhatsNewUI \
    --disable-extensions-except="$EXT_DIR" --load-extension="$EXT_DIR" \
    --window-position=$WIN1_POS --window-size=$WIN1_SIZE \
    --user-data-dir="$PROFILE_DIR1" \
    --remote-debugging-port=9222 \
    about:blank &

  # launch second browser if a second monitor is present
  if [ -n "$SECONDARY" ]; then
    "$BROWSER" \
      --kiosk --start-fullscreen --incognito \
      --disable-crashpad --no-first-run --no-default-browser-check \
      --disable-features=PrivacySandboxSettings4,ChromeWhatsNewUI \
      --disable-extensions-except="$EXT_DIR" --load-extension="$EXT_DIR" \
      --window-position=$WIN2_POS --window-size=$WIN2_SIZE \
      --user-data-dir="$PROFILE_DIR2" \
      --remote-debugging-port=9223 \
      about:blank &
  fi

  # wait until any Chromium process exits, then restart both
  wait -n
  echo "[ $(date) ] Chromium quit - restarting" >>/home/${DESKTOP_USER}/chromium-autostart.log
  sleep 2
done
EOF

echo "New launch-browsers.sh written"

# ------------- make executable -----------------------------------------
chmod +x "$TARGET"
echo "Set executable bit"

# ------------- restart the service -------------------------------------
if systemctl is-enabled --quiet betsa-browsers.service; then
  systemctl restart betsa-browsers.service
  echo "Restarted betsa-browsers.service"
else
  echo "Service betsa-browsers.service not enabled; skipped restart"
fi

echo "Migration intel/1.sh completed successfully"
 