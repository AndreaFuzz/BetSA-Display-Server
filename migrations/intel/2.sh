#!/usr/bin/env bash
# ======================================================================
#  Migration 2 (Intel): set timezone to Africa/Johannesburg
#                       and enable NTP synchronisation
# ======================================================================
set -euo pipefail

LOG="/var/log/betsa-migration-intel-2.log"
TARGET_TZ="Africa/Johannesburg"
NTP_CONF="/etc/systemd/timesyncd.conf"
PREFERRED_NTP="za.pool.ntp.org"

# ---------- simple logging setup --------------------------------------
mkdir -p "$(dirname "$LOG")"
touch "$LOG"
exec > >(tee -a "$LOG") 2>&1
echo "[$(date '+%F %T')] --- Migration intel/2.sh starting ---"

# ---------- set the timezone ------------------------------------------
CURRENT_TZ=$(timedatectl show -p Timezone --value || true)

if [[ "$CURRENT_TZ" != "$TARGET_TZ" ]]; then
  echo "Changing timezone from '${CURRENT_TZ:-unknown}' to '${TARGET_TZ}'"
  timedatectl set-timezone "$TARGET_TZ"
else
  echo "Timezone already set to '${TARGET_TZ}'"
fi

# ---------- ensure systemd-timesyncd present/enabled ------------------
if ! systemctl list-unit-files | grep -q '^systemd-timesyncd.service'; then
  echo "Installing systemd-timesyncd package"
  if command -v apt-get &>/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq systemd-timesyncd
  elif command -v dnf &>/dev/null; then
    dnf -y install systemd-timesyncd
  else
    echo "Package manager not detected; skipping install"
  fi
fi

echo "Enabling systemd-timesyncd"
systemctl enable --now systemd-timesyncd.service

# ---------- configure preferred NTP server ----------------------------
if grep -q '^NTP=' "$NTP_CONF" 2>/dev/null; then
  echo "Updating NTP server to '${PREFERRED_NTP}' in ${NTP_CONF}"
  sed -i.bak 's/^NTP=.*/NTP='${PREFERRED_NTP}'/' "$NTP_CONF"
else
  echo "Setting NTP server to '${PREFERRED_NTP}' in ${NTP_CONF}"
  sed -i.bak '/^\[Time\]/a NTP='${PREFERRED_NTP} "$NTP_CONF"
fi

# ---------- restart service and force initial sync --------------------
systemctl restart systemd-timesyncd.service
timedatectl set-ntp true
echo "Waiting briefly for initial time synchronisation…"
sleep 5
timedatectl status

echo "[$(date '+%F %T')] Migration intel/2.sh completed successfully"
