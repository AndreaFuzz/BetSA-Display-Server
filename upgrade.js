// upgrade.js ─ migration runner for .sh scripts (filesystem-agnostic)
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

/**
 * Run any .sh scripts in the migrations directory that have a higher
 * numeric name than the recorded version. Each script is invoked with bash;
 * after a successful exit the version file is bumped.
 */
function runMigrations () {
  const current = readVersion();
  const pending = listScripts()
                   .filter(v => v > current)
                   .sort((a, b) => a - b);

  if (pending.length === 0) {
    console.log(`[upgrade] already at version ${current} – nothing to do`);
    return;
  }

  console.log(`[upgrade] current version ${current}, pending: ${pending.join(', ')}`);

  for (const v of pending) {
    const script = path.join(MIGRATIONS_DIR, `${v}.sh`);
    console.log(`[upgrade] running ${script}`);

 
    const res = spawnSync('sudo', ['bash', script], { stdio: 'inherit' });

    if (res.status === 0) {
      writeVersion(v);
      console.log(`[upgrade] -> success, version set to ${v}`);
    } else {
      console.error(`[upgrade] -> FAILED with exit code ${res.status}`);
      console.error('[upgrade] aborting further migrations');
      break;
    }
  }
}

/* expose current version to other modules */
function getVersion () {
  return readVersion();
}

/* === INTERNAL HELPERS ================================================= */
function readVersion () {
  try { return parseInt(fs.readFileSync(VERSION_FILE, 'utf8'), 10) || 0; }
  catch { return 0; }                 // file missing or unreadable
}

function writeVersion (num) {
  const data = String(num);

  try {
    /* fast path: write with current privileges */
    fs.writeFileSync(VERSION_FILE, data, 'utf8');
    return;
  } catch (e) {
    if (e.code !== 'EACCES') throw e;          // real error → re-throw
    console.warn(`[upgrade] no permission to write ${VERSION_FILE}; retrying with sudo`);
  }

  /* fallback: echo … | sudo tee FILE  */
  const cmd = `echo '${data.replace(/'/g, "'\\''")}' | sudo tee '${VERSION_FILE}' >/dev/null`;
  const res = spawnSync('bash', ['-c', cmd], { stdio: 'inherit' });

  if (res.status !== 0) {
    throw new Error(`sudo tee failed (exit ${res.status})`);
  }
}

function listScripts () {
  try {
    return fs.readdirSync(MIGRATIONS_DIR)
             .filter(f => /^[0-9]+\.sh$/.test(f))
             .map(f => parseInt(f, 10));           // parseInt stops at first non-digit
  } catch (e) {
    if (e.code === 'ENOENT') return [];            // no migrations dir yet
    throw e;
  }
}
