// upgrade.js ─ simple on-disk migration runner for .sh scripts (root-safe)
/* eslint-disable no-console */
'use strict';

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/* === CONFIGURATION ==================================================== */
const VERSION_FILE   = path.resolve(__dirname, '.app_version'); // plain text
const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');   // 1.sh, 2.sh …

/* === PUBLIC API ======================================================= */
module.exports = { runMigrations, getVersion };

function runMigrations () {
  const current = readVersion();
  const pending = listScripts().filter(v => v > current).sort((a, b) => a - b);

  if (pending.length === 0) {
    console.log(`[upgrade] already at version ${current} – nothing to do`);
    return;
  }

  console.log(`[upgrade] current version ${current}, pending: ${pending.join(', ')}`);

  for (const v of pending) {
    const script = path.join(MIGRATIONS_DIR, `${v}.sh`);
    console.log(`[upgrade] running ${script}`);

    try { ensureExecutable(script); }
    catch (e) { console.error(`[upgrade] chmod +x failed: ${e.message}`); break; }

    const res = spawnSync(script, { stdio: 'inherit', shell: false });

    if (res.status === 0) {
      writeVersion(v);
      console.log(`[upgrade] -> success, version set to ${v}`);
    } else {
      console.error(`[upgrade] -> FAILED with exit code ${res.status}`);
      break;
    }
  }
}

/* --------------- NEW tiny helper exported above ---------------------- */
function getVersion () {
  return readVersion();           // just read the file and return the number
}

/* === INTERNAL HELPERS (unchanged) ===================================== */
function readVersion () {
  try { return parseInt(fs.readFileSync(VERSION_FILE, 'utf8'), 10) || 0; }
  catch { return 0; }
}

function writeVersion (num) { fs.writeFileSync(VERSION_FILE, String(num), 'utf8'); }

function listScripts () {
  try {
    return fs.readdirSync(MIGRATIONS_DIR)
             .filter(f => /^[0-9]+\.sh$/.test(f))
             .map(f => parseInt(f, 10));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

function ensureExecutable (file) {
  const mode = fs.statSync(file).mode & 0o777;
  if ((mode & 0o111) !== 0o111) {
    fs.chmodSync(file, mode | 0o755);
    console.log(`[upgrade] chmod +x ${file}`);
  }
}
