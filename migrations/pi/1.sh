#!/usr/bin/env bash
set -euo pipefail

# ---------------- configuration -----------------------------------------
TARGET="/usr/local/bin/betsa-launch-chrome.sh"           # file to patch
LOG_DIR="/opt/betsa-display-screens/log"                 # preferred log dir
FALLBACK_DIR="/tmp"                                      # fallback if needed

# ---------------- logging setup -----------------------------------------
if mkdir -p "$LOG_DIR" 2>/dev/null; then
  LOG="$LOG_DIR/betsa-migration-1.log"
else
  LOG="$FALLBACK_DIR/betsa-migration-1.log"
fi

touch "$LOG" 2>/dev/null || LOG="/dev/null"              # last-ditch fallback
exec > >(tee -a "$LOG") 2>&1

echo "[$(date '+%F %T')] --- Migration 1: remove --incognito flag ---"

# ---------------- handle missing file -----------------------------------
if [ ! -f "$TARGET" ]; then
  echo "Target file $TARGET not found; nothing to migrate."
  echo "Migration 1 completed successfully (no changes required)"
  exit 0
fi

# ---------------- do the work ------------------------------------------
if grep -q -- '--incognito' "$TARGET"; then
  echo "Flag found; creating backup"
  cp "$TARGET" "${TARGET}.bak.$(date '+%Y%m%d_%H%M%S')"

  echo "Removing flag..."
  # delete the flag and any following whitespace or backslash
  sed -i -E 's/[[:space:]]--incognito([[:space:]]|\\)?/ /g' "$TARGET"
  echo "Flag removed"
else
  echo "No --incognito flag present; nothing to do"
fi

# ---------------- verification ------------------------------------------
if grep -q -- '--incognito' "$TARGET"; then
  echo "ERROR: flag still present after attempted removal"
  exit 1
fi

echo "Migration 1 completed successfully"
