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
 

echo "Migration intel/1.sh completed successfully"
 