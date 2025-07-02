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

# ---------- static configuration ----------
DESKTOP_USER=admin
export DISPLAY=:0
export XAUTHORITY=/home/${DESKTOP_USER}/.Xauthority
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}

BROWSER=$(command -v ungoogled-chromium || command -v chromium)
EXT_DIR="/opt/betsa-ext"

# profile directories (one per display)
PROFILE_DIR1=/home/${DESKTOP_USER}/.config/single-profile
PROFILE_DIR2=/home/${DESKTOP_USER}/.config/single-profile-2
PROFILE_TEMPLATE=/opt/betsa-profile-template

# ---------- one-off X and D-Bus prep ----------
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  BUS_ADDR=unix:path=${XDG_RUNTIME_DIR}/bus
  if ! busctl --user status >/dev/null 2>&1; then
    dbus-daemon --session --address="$BUS_ADDR" --fork --nopidfile
  fi
  export DBUS_SESSION_BUS_ADDRESS=$BUS_ADDR
fi

/usr/bin/xmodmap - <<'XMAP'
keycode 70 = NoSymbol
keycode 23 = NoSymbol
keycode 28 = NoSymbol
XMAP

# ---------- helper : ensure profile skeleton ----------
prepare_profile() {
  local dir=$1
  if [ ! -d "$dir/Default" ]; then
    mkdir -p "$dir"
    cp -a "${PROFILE_TEMPLATE}/." "$dir/"
  fi
}

prepare_profile "$PROFILE_DIR1"
prepare_profile "$PROFILE_DIR2"

# ---------- main supervisor loop ----------
while true; do
  # kill any leftover Chromium instances
  pkill -f "$BROWSER" || true
  sleep 1

  # detect connected HDMI (or any) monitors
  mapfile -t MONITORS < <(xrandr --query | awk '/ connected/{print $1}')
  PRIMARY=${MONITORS[0]}
  SECONDARY=${MONITORS[1]:-}

  # make the primary monitor primary and at 0x0
  xrandr --output "$PRIMARY" --auto --primary --pos 0x0

  # if a second monitor exists, place it to the right of the first
  if [ -n "$SECONDARY" ]; then
    # width of primary to use as x-offset
    PRIM_WIDTH=$(xrandr --query | awk -v mon="$PRIMARY" '$0~mon" connected"{match($0,/([0-9]+)x[0-9]+/,a);print a[1]}')
    xrandr --output "$SECONDARY" --auto --pos ${PRIM_WIDTH}x0
  fi

  # calculate window sizes (one per monitor)
  WIN1_SIZE=$(xrandr --current | awk -v mon="$PRIMARY" '$0~mon" connected"{match($0,/([0-9]+x[0-9]+)/,a);print a[1]}' | sed 's/x/,/')
  if [ -n "$SECONDARY" ]; then
    WIN2_SIZE=$(xrandr --current | awk -v mon="$SECONDARY" '$0~mon" connected"{match($0,/([0-9]+x[0-9]+)/,a);print a[1]}' | sed 's/x/,/')
    # x-offset for window position equals primary width
    WIN2_POS=$(xrandr --query | awk -v mon="$PRIMARY" '$0~mon" connected"{match($0,/([0-9]+)x[0-9]+/,a);print a[1]}'),0
  fi

  # ---------- launch browsers ----------
  "$BROWSER" \
    --kiosk --start-fullscreen --incognito \
    --disable-crashpad --no-first-run --no-default-browser-check \
    --disable-sync --disable-features=PrivacySandboxSettings4,ChromeWhatsNewUI \
    --disable-extensions-except="$EXT_DIR" --load-extension="$EXT_DIR" \
    --window-position=0,0 --window-size="${WIN1_SIZE}" \
    --user-data-dir="$PROFILE_DIR1" \
    --remote-debugging-port=9222 about:blank &

  if [ -n "$SECONDARY" ]; then
    "$BROWSER" \
      --kiosk --start-fullscreen --incognito \
      --disable-crashpad --no-first-run --no-default-browser-check \
      --disable-sync --disable-features=PrivacySandboxSettings4,ChromeWhatsNewUI \
      --disable-extensions-except="$EXT_DIR" --load-extension="$EXT_DIR" \
      --window-position="${WIN2_POS:-0,0}" --window-size="${WIN2_SIZE:-${WIN1_SIZE}}" \
      --user-data-dir="$PROFILE_DIR2" \
      --remote-debugging-port=9223 about:blank &
  fi

  # wait until any browser exits, then restart both
  wait -n
  echo "[$(date)] Chromium quit - restarting" >>/home/${DESKTOP_USER}/chromium-autostart.log
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
