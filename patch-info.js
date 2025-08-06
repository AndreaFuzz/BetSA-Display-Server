// patch-info.js
// Reads the newest line in /var/local/patch_history and returns a
// consistent object.  The object ALWAYS has `hasPatch` (boolean).

const fs = require("fs");
const DEFAULT_PATH = "/var/local/patch_history";

/**
 * Synchronous because diagnostics are already synchronous.
 * On success:  { hasPatch: true, id, timestamp, notes, extra }
 * On none  :   { hasPatch: false }
 */
function getLatestPatch(filePath = DEFAULT_PATH) {
  try {
    const txt = fs.readFileSync(filePath, "utf8");
    const lines = txt
      .split("\n")
      .filter(line => line.trim().length);       // ignore blank lines

    if (lines.length === 0) return { hasPatch: false };

    const [id, ts, notes, extra] = lines[lines.length - 1].split("|");
    return {
      
      patch: Number(id),
      timestamp: ts,    // ISO-8601 UTC, written by the Bash script
      notes,
      extra            // e.g. "chromium 125.0.6422.1"
    };
  } catch {
    // File missing, unreadable, or another error → treat as "no patches"
    return { hasPatch: false };
  }
}

module.exports = { getLatestPatch };
