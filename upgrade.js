// upgrade.js ─ platform-aware migration runner
/* eslint-disable no-console */
'use strict';

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/* === PLATFORM DETECTION ============================================== */
function isRaspberryPi () {
  try {
    const model = fs.readFileSync('/proc/device-tree/model', 'utf8').toLowerCase();
    return model.includes('raspberry pi');
  } catch {
    return false;                       // file absent on non-Pi hardware
  }
}
const PLATFORM       = isRaspberryPi() ? 'pi' : 'intel';
const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations', PLATFORM);
const VERSION_FILE   = path.resolve(__dirname, '.app_version');

/* === PUBLIC API ======================================================= */
module.exports = { runMigrations, getVersion };

/**
 * Run any *.sh scripts in the platform-specific migrations directory
 * whose numeric name is higher than the recorded version.
 */
function runMigrations () {
  console.log(`[upgrade] platform detected: ${PLATFORM}`);
  console.log(`[upgrade] migration path:    ${MIGRATIONS_DIR}`);

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

/* expose current version */
function getVersion () { return readVersion(); }

/* === INTERNAL HELPERS ================================================= */
function readVersion () {
  try { return parseInt(fs.readFileSync(VERSION_FILE, 'utf8'), 10) || 0; }
  catch { return 0; }
}

function writeVersion (num) {
  const data = String(num);

  try {
    fs.writeFileSync(VERSION_FILE, data, 'utf8');
    return;
  } catch (e) {
    if (e.code !== 'EACCES') throw e;
    console.warn(`[upgrade] no permission to write ${VERSION_FILE}; retrying with sudo`);
  }

  const cmd = `echo '${data.replace(/'/g, "'\\''")}' | sudo tee '${VERSION_FILE}' >/dev/null`;
  const res = spawnSync('bash', ['-c', cmd], { stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`sudo tee failed (exit ${res.status})`);
}

function listScripts () {
  try {
    return fs.readdirSync(MIGRATIONS_DIR)
             .filter(f => /^[0-9]+\.sh$/.test(f))
             .map(f => parseInt(f, 10));
  } catch (e) {
    if (e.code === 'ENOENT') return [];          // no dir yet → no scripts
    throw e;
  }
}
