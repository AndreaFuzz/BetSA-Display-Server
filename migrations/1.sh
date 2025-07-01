#!/usr/bin/env bash
set -euo pipefail

# -------- configuration -------------------------------------------------
TARGET="/usr/local/bin/betsa-launch-chrome.sh"
LOG="/var/log/betsa-migration-1.log"

# -------- logging setup -------------------------------------------------
mkdir -p "$(dirname "$LOG")"
touch "$LOG"
exec > >(tee -a "$LOG") 2>&1

echo "[$(date '+%F %T')] --- Migration 1: remove --incognito flag ---"

# -------- sanity checks -------------------------------------------------
if [ ! -f "$TARGET" ]; then
  echo "ERROR: target file $TARGET not found"
  exit 1
fi

# -------- do the work ---------------------------------------------------
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

# -------- verification --------------------------------------------------
if grep -q -- '--incognito' "$TARGET"; then
  echo "ERROR: flag still present after attempted removal"
  exit 1
fi

echo "Migration 1 completed successfully"
