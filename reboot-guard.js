// reboot-guard.js - safe reboot utilities and endpoint handler (blocking with detailed reasons)
"use strict";

const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");

const APP_DIR = "/opt/betsa-display-screens";
const LOG_EVERY_MS = 10_000; // throttle identical "blocked" logs

let lastLogAt = 0;
let lastLogKey = "";

/* ------------------------------ helpers ------------------------------ */

function fileExists(p) {
  try { fs.accessSync(p, fs.constants.F_OK); return true; } catch { return false; }
}

function listExistingGitLocks() {
  const gitDir = path.join(APP_DIR, ".git");
  const lockNames = [
    "index.lock",
    "shallow.lock",
    "packed-refs.lock",
    "config.lock",
    "HEAD.lock",
    "FETCH_HEAD.lock",
    "ORIG_HEAD.lock"
  ];
  return lockNames
    .map(name => path.join(gitDir, name))
    .filter(fileExists)
    .map(p => path.basename(p));
}

// Return array of { pid, cmd } for processes matching pattern, excluding our own probe.
function pgrepDetails(pattern) {
  try {
    const out = execSync(`pgrep -fa -- "${pattern}"`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (!out) return [];
    return out
      .split("\n")
      .map(line => {
        const firstSpace = line.indexOf(" ");
        if (firstSpace === -1) return { pid: line.trim(), cmd: "" };
        const pid = line.slice(0, firstSpace).trim();
        const cmd = line.slice(firstSpace + 1).trim();
        return { pid, cmd };
      })
      // Drop our own pgrep shell wrapper, just in case
      .filter(p => p.cmd && !/pgrep\b/.test(p.cmd) && !/sh\s+-c\s+pgrep/.test(p.cmd));
  } catch {
    return [];
  }
}

// Systemd check (authoritative for your updater unit)
function isServiceActive(name) {
  try {
    const out = execSync(`systemctl is-active ${name}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    return out === "active" || out === "activating";
  } catch {
    return false;
  }
}

/**
 * Build a detailed busy-state snapshot.
 * Returns:
 *   {
 *     reasons: [string],
 *     details: { updater: [{pid, cmd}], git: [{pid, cmd}], npm: [{pid, cmd}] },
 *     locks: [string],
 *     explicitLock: string|null
 *   }
 */
function detectBusyDetailed() {
  const locks = listExistingGitLocks();

  // 1) systemd state first (no false positives)
  const updaterServiceActive = isServiceActive("betsa-update.service");

  // 2) processes (immune to self-match via regex trick and filter)
  // The [b] trick makes our probe's command line not match itself.
  const updater = pgrepDetails("/usr/local/bin/[b]etsa-update.sh");

  const escapedAppDir = APP_DIR.replace(/\//g, "\\/");
  const gitProcs = pgrepDetails(`git .*${escapedAppDir}`);

  const npmProcs = pgrepDetails(`npm .* (ci|install)`);

  const explicitLockPath = "/run/betsa-update.lock";
  const explicitLock = fileExists(explicitLockPath) ? explicitLockPath : null;

  const reasons = [];
  if (locks.length) reasons.push(`git locks: ${locks.join(", ")}`);
  if (updaterServiceActive) reasons.push(`updater service active (systemd)`);
  if (updater.length) reasons.push(`updater running (${updater.length} proc)`);
  if (gitProcs.length) reasons.push(`git activity in repo (${gitProcs.length} proc)`);
  if (npmProcs.length) reasons.push(`npm install/ci in progress (${npmProcs.length} proc)`);
  if (explicitLock) reasons.push(`explicit lock present (${explicitLock})`);

  return {
    reasons,
    details: { updater, git: gitProcs, npm: npmProcs },
    locks,
    explicitLock
  };
}

/** Back-compat boolean check (true = busy) */
function isUpdaterBusy() {
  return detectBusyDetailed().reasons.length > 0;
}

function scheduleRebootNow() {
  setTimeout(() => spawn("sudo", ["reboot"], { stdio: "ignore", detached: true }).unref(), 100);
}

/* ------------------------------ logging ------------------------------ */

function logBlockedIfNeeded(snapshot) {
  const { reasons, details, locks, explicitLock } = snapshot;
  const now = Date.now();

  // Key captures both summary and the list of PIDs to reduce duplicate spam.
  const pidKey = [
    ...details.updater.map(p => p.pid),
    ...details.git.map(p => p.pid),
    ...details.npm.map(p => p.pid)
  ].join(",");
  const key = `${reasons.slice().sort().join(" | ")} || ${pidKey}`;

  if (key === lastLogKey && now - lastLogAt < LOG_EVERY_MS) return;
  lastLogKey = key;
  lastLogAt = now;

  // One-line summary
  console.log(`[reboot-guard] blocked: ${reasons.join(" | ") || "unknown reason"}`);

  // Detailed lines
  if (locks.length) {
    console.log(`[reboot-guard] git locks: ${locks.join(", ")}`);
  }
  if (explicitLock) {
    console.log(`[reboot-guard] explicit lock: ${explicitLock}`);
  }
  if (details.updater.length) {
    console.log(`[reboot-guard] updater processes (${details.updater.length}):`);
    details.updater.forEach(p => console.log(`  pid=${p.pid} cmd=${p.cmd}`));
  }
  if (details.git.length) {
    console.log(`[reboot-guard] git processes (${details.git.length}):`);
    details.git.forEach(p => console.log(`  pid=${p.pid} cmd=${p.cmd}`));
  }
  if (details.npm.length) {
    console.log(`[reboot-guard] npm processes (${details.npm.length}):`);
    details.npm.forEach(p => console.log(`  pid=${p.pid} cmd=${p.cmd}`));
  }
}

/* ------------------------------ waiter and route ------------------------------ */

// Waits until ready; logs throttled details while waiting.
function waitUntilReady(intervalMs = 4000) {
  return new Promise(resolve => {
    const tick = () => {
      try {
        const snap = detectBusyDetailed();
        if (snap.reasons.length === 0) return resolve();
        logBlockedIfNeeded(snap);
      } catch (e) {
        // Do not abort; keep waiting. Optionally log once if needed.
        console.log(`[reboot-guard] error while checking busy state: ${e && e.message ? e.message : e}`);
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

// One way to call it: POST /reboot. It waits until safe, then replies 200 and reboots.
async function handleRebootBlocking(_req, res) {
  await waitUntilReady();
  res.send("Rebooting...");
  scheduleRebootNow();
}

module.exports = {
  handleRebootBlocking,
  isUpdaterBusy
};
