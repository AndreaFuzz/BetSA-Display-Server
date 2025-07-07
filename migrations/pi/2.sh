#!/usr/bin/env bash
set -euo pipefail

# ---------------- configuration -----------------------------------------
TARGET="/usr/local/bin/betsa-launch-chrome.sh"   # file to replace
LOG_DIR="/opt/betsa-display-screens/log"         # preferred log dir
FALLBACK_DIR="/tmp"                              # fallback if needed

# ---------------- logging setup -----------------------------------------
if mkdir -p "$LOG_DIR" 2>/dev/null; then
  LOG="$LOG_DIR/betsa-migration-2.log"
else
  LOG="$FALLBACK_DIR/betsa-migration-2.log"
fi

touch "$LOG" 2>/dev/null || LOG="/dev/null"      # last-ditch fallback
exec > >(tee -a "$LOG") 2>&1

echo "[$(date '+%F %T')] --- Migration 2: replace launch script & restart kiosk ---"

# ---------------- handle missing file -----------------------------------
if [ ! -f "$TARGET" ]; then
  echo "Target file $TARGET not found; nothing to migrate."
  echo "Migration 2 completed successfully (no changes required)"
  exit 0
fi

# ---------------- do the work ------------------------------------------
echo "Creating backup of current launch script"
cp "$TARGET" "${TARGET}.bak.$(date '+%Y%m%d_%H%M%S')"

echo "Writing new launcher contents to $TARGET"
cat > "$TARGET" <<'EOF_LAUNCHER'
#!/usr/bin/env bash
set -e
ADMIN=admin
EXT_DIR="/opt/betsa-ext"
PROFILE_TEMPLATE="/opt/betsa-profile-template"
export DISPLAY=:0

# Disable DPMS/screensaver
xset s off
xset s noblank
xset -dpms

# Empty Openbox config → no key bindings
OB_CONF="/home/${ADMIN}/.config/openbox"
mkdir -p "$OB_CONF"
cat >"$OB_CONF/rc.xml" <<'OBEOF'
<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <keyboard/>
  <mouse/>
</openbox_config>
OBEOF
chown -R ${ADMIN}:${ADMIN} "$OB_CONF"

# Prepare Chromium profiles
for p in 1 2; do
  TARGET="/home/${ADMIN}/.config/betsa-profile${p}"
  if [ ! -d "$TARGET/Default" ]; then
    mkdir -p "$TARGET"
    cp -a "$PROFILE_TEMPLATE"/* "$TARGET"/
    chown -R ${ADMIN}:${ADMIN} "$TARGET"
  fi
done

# Detect HDMI outputs (retry for slow second monitor)
tries=15
while :; do
  outputs=$(xrandr --query | awk '/ connected/ && /HDMI/ {print $1}')
  primary=$(echo "$outputs" | head -n1)
  secondary=$(echo "$outputs" | sed -n '2p')
  [ -n "$primary" ] && break
  sleep 1
done
while [ -z "$secondary" ] && [ $tries -gt 0 ]; do
  sleep 1
  secondary=$(xrandr --query | awk '/ connected/ && /HDMI/ {print $1}' | sed -n '2p')
  tries=$((tries-1))
done

xrandr --output "$primary" --auto --primary
[ -n "$secondary" ] && xrandr --output "$secondary" --auto --right-of "$primary"

COMMON_FLAGS="--kiosk --incognito --disable-crashpad --no-first-run \
--no-default-browser-check --disable-sync \
--disable-features=PrivacySandboxSettings4,ChromeWhatsNewUI \
--disable-extensions-except=${EXT_DIR} --load-extension=${EXT_DIR}"

chromium $COMMON_FLAGS --user-data-dir=/home/${ADMIN}/.config/betsa-profile1 \
  --remote-debugging-port=9222 about:blank &

if [ -n "$secondary" ]; then
  sleep 1
  chromium $COMMON_FLAGS --user-data-dir=/home/${ADMIN}/.config/betsa-profile2 \
    --remote-debugging-port=9223 about:blank &
  width=$(xrandr | awk -v o="$primary" '$1==o {sub(/x.*/, "", $4); print $4}')
  tries=20
  while [ $tries -gt 0 ]; do
    if wmctrl -r chromium -N betsa-second 2>/dev/null; then
      wmctrl -r betsa-second -e 0,$width,0,-1,-1
      break
    fi
    tries=$((tries-1))
    sleep 0.2
  done
fi
wait
EOF_LAUNCHER

chmod +x "$TARGET"
echo "New launcher written and made executable."

# ---------------- restart service ---------------------------------------
echo "Restarting x11-kiosk.service to apply changes..."
if systemctl restart x11-kiosk.service; then
  echo "x11-kiosk.service restarted successfully."
else
  echo "ERROR: failed to restart x11-kiosk.service"
  exit 1
fi

echo "Migration 2 completed successfully"
