// auto-patch.js
"use strict";

const os = require("os");
const fs = require("fs");
const { spawn, execFileSync } = require("child_process");
const { getLatestPatch } = require("./patch-info");

// ----------------------------------------------------------------------------
// Config (can be overridden with env vars)
// ----------------------------------------------------------------------------
const PATCHES_URL =
  process.env.PATCHES_URL ||
  "http://qa-assets.betsainfo.co.za/betsa/display/patches.json";

const LOG_FILE = process.env.AUTOPATCH_LOG_FILE || "/var/log/betsa-patch.log";

// Default timeout per patch (ms). Pi installs can be slow; 60 min default.
const DEFAULT_PATCH_TIMEOUT_MS = Number(
  process.env.AUTOPATCH_PATCH_TIMEOUT_MS || 60 * 60 * 1000
);

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function hasCmd(cmd) {
  try {
    execFileSync("bash", ["-lc", `command -v ${cmd}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isRoot() {
  try {
    return process.getuid && process.getuid() === 0;
  } catch {
    return false;
  }
}

function canSudoNonInteractive() {
  if (!hasCmd("sudo")) return false;
  try {
    execFileSync("sudo", ["-n", "true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// node-fetch v3 dynamic import
const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));

function fetchWithTimeout(url, opts = {}, timeoutMs = 10000) {
  const AC = global.AbortController || require("abort-controller");
  const controller = new AC();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  const merged = { ...opts, signal: controller.signal };
  return fetch(url, merged).finally(() => clearTimeout(id));
}

function isRaspberryPi() {
  try {
    const model = fs.readFileSync("/proc/device-tree/model", "utf8");
    if (/raspberry\s*pi/i.test(model)) return true;
  } catch {}
  return os.arch().startsWith("arm");
}

function pickUrlForDevice(patchObj) {
  return isRaspberryPi() ? patchObj.raspberry_pi_url : patchObj.intel_url;
}

async function getServerPatches() {
  const res = await fetchWithTimeout(PATCHES_URL, {}, 10000);
  if (!res.ok) throw new Error("patches.json fetch failed: " + res.status);
  const data = await res.json();
  const patches = Array.isArray(data.patches) ? data.patches : [];
  patches.sort((a, b) => Number(a.number) - Number(b.number));
  return patches;
}

// Poll a systemd unit until it finishes or times out
function waitForUnit(unit, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      let out = "";
      try {
        out = execFileSync(
          "bash",
          [
            "-lc",
            `systemctl show -p ActiveState -p SubState -p Result -p ExecMainStatus ${unit}`,
          ],
          { encoding: "utf8" }
        );
      } catch {
        // Unit vanished (e.g. reboot in the middle) -> treat as finished
        return resolve({ state: "unknown", sub: "unknown", result: "unknown", exitCode: null });
      }
      const map = {};
      out.split("\n").forEach((l) => {
        const i = l.indexOf("=");
        if (i > 0) map[l.slice(0, i)] = l.slice(i + 1);
      });
      const state = (map.ActiveState || "").trim();
      const sub = (map.SubState || "").trim();
      const result = (map.Result || "").trim();
      const exitCode =
        map.ExecMainStatus != null ? parseInt(map.ExecMainStatus, 10) : null;

      if (state === "inactive" || state === "failed" || sub === "dead") {
        return resolve({ state, sub, result, exitCode });
      }
      if (Date.now() > deadline) {
        return reject(new Error(`timeout waiting for ${unit}`));
      }
      setTimeout(poll, 2000);
    };
    setTimeout(poll, 2000);
  });
}

// ----------------------------------------------------------------------------
// Patch execution strategies
// ----------------------------------------------------------------------------

// Detached run in a transient systemd unit.
// opts may include { vt: number } to mirror logs to a text VT.
async function runPatchSystemd(url, patchNumber, opts = {}) {
  const unit = `betsa-patch-${patchNumber}-${Date.now()}`;
  const vtFromEnv = process.env.AUTOPATCH_VT ? Number(process.env.AUTOPATCH_VT) : null;
  const vt = opts && typeof opts.vt === "number" ? opts.vt : vtFromEnv;

  const openvtAvailable = vt && hasCmd("openvt");

  // Build the command line that runs inside the transient unit.
  // We pass URL and LOG as envs so quoting is robust, and we use double quotes so $URL/$LOG expand.
  const execLine = openvtAvailable
    ? `openvt -c ${vt} -sw -- bash -lc "curl -fsSL \\"$URL\\" | bash -x 2>&1 | tee -a \\"$LOG\\""`
    : `bash -lc "curl -fsSL \\"$URL\\" | bash -x 2>&1 | tee -a \\"$LOG\\""`;

  const args = [
    "--unit",
    unit,
    "--collect",
    "--property=After=network-online.target",
    "--property=StandardOutput=journal",
    "--property=StandardError=journal",
    `--setenv=URL=${url}`,
    `--setenv=LOG=${LOG_FILE}`,
    "/bin/bash",
    "-lc",
    execLine,
  ];

  // Pick runner: systemd-run as root, or sudo -n systemd-run if allowed
  const runner = isRoot()
    ? ["systemd-run", ...args]
    : canSudoNonInteractive()
    ? ["sudo", "-n", "systemd-run", ...args]
    : null;

  if (!runner) {
    throw new Error("no privilege to use systemd-run");
  }

  console.log(`[autopatch] launching detached unit ${unit}`);
  await new Promise((res, rej) => {
    const p = spawn(runner[0], runner.slice(1), { stdio: "inherit" });
    p.on("exit", (c) =>
      c === 0 ? res() : rej(new Error(`systemd-run failed (${c})`))
    );
    p.on("error", rej);
  });

  const result = await waitForUnit(unit, DEFAULT_PATCH_TIMEOUT_MS);
  if (result.exitCode === 0 || result.result === "success") return;
  throw new Error(
    `patch unit ${unit} ended state=${result.state} result=${result.result} code=${result.exitCode}`
  );
}

// Inline run in the current service cgroup.
// Safe on your Pi script (it only restarts x11-kiosk.service).
// We still escalate with sudo -n to get root; if not allowed, we error quickly.
function runPatchInline(url) {
  return new Promise((resolve, reject) => {
    const inner = `set -o pipefail; curl -fsSL "${url}" | bash -x 2>&1 | tee -a "${LOG_FILE}"`;

    let cmd, args;
    if (isRoot()) {
      cmd = "bash";
      args = ["-lc", inner];
    } else if (canSudoNonInteractive()) {
      cmd = "sudo";
      args = ["-n", "bash", "-lc", inner];
    } else {
      return reject(new Error("no privilege to run patch inline (need root or passwordless sudo)"));
    }

    console.warn("[autopatch] running patch inline (no systemd-run).");
    const child = spawn(cmd, args, { stdio: "inherit" });

    const killTimer = setTimeout(() => {
      console.error("[autopatch] timeout reached, stopping inline patch");
      try {
        child.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 5000);
    }, DEFAULT_PATCH_TIMEOUT_MS);

    child.on("exit", (code) => {
      clearTimeout(killTimer);
      code === 0
        ? resolve()
        : reject(new Error(`patch failed with exit code ${code}`));
    });
    child.on("error", (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
  });
}

// Try systemd-run; if privilege missing or it is blocked by polkit, fall back inline.
async function runOnePatch(url, patchNumber, opts = {}) {
  try {
    return await runPatchSystemd(url, patchNumber, opts);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (
      /no privilege to use systemd-run/i.test(msg) ||
      /Interactive authentication required/i.test(msg) ||
      /systemd-run failed/i.test(msg)
    ) {
      console.warn("[autopatch] falling back to inline patch run.");
      return runPatchInline(url);
    }
    throw e;
  }
}

// ----------------------------------------------------------------------------
// Main flow
// ----------------------------------------------------------------------------
let activeRun = null; // in-process concurrency guard

async function _doCheckAndApply(opts = {}) {
  const local = getLatestPatch();
  const current = typeof local.patch === "number" ? local.patch : 0;
  console.log(`[autopatch] current patch: ${current}`);

  const patches = await getServerPatches();
  const latest = patches.reduce(
    (m, p) => Math.max(m, Number(p.number) || 0),
    0
  );
  console.log(`[autopatch] server latest: ${latest}`);

  const toApply = patches.filter((p) => Number(p.number) > current);
  if (toApply.length === 0) {
    console.log("[autopatch] up to date");
    return { current, latest, applied: [] };
  }

  const applied = [];
  for (const p of toApply) {
    const url = pickUrlForDevice(p);
    if (!url) {
      console.warn(
        `[autopatch] patch ${p.number} has no URL for this device; skipping`
      );
      continue;
    }
    console.log(`[autopatch] applying patch ${p.number} from ${url}`);
    await runOnePatch(url, Number(p.number), opts);
    console.log(`[autopatch] patch ${p.number} complete`);
    applied.push(p.number);
    // Your patch .sh should append to /var/local/patch_history so getLatestPatch() sees the new version.
    // If a patch reboots the system, control will not reach here; on boot, the next check will see it applied.
  }

  return { current, latest, applied };
}

async function checkAndApply(opts = {}) {
  if (activeRun) return activeRun; // already running
  activeRun = (async () => {
    try {
      return await _doCheckAndApply(opts);
    } finally {
      activeRun = null;
    }
  })();
  return activeRun;
}

function isBusy() {
  return !!activeRun;
}



/* -------------------------------------------------------------------------- */
/* Nightly staggered scheduler (minute derived from IPv4 last octet)          */
/* -------------------------------------------------------------------------- */

function computeStaggerMinuteFromIP(ip) {
  // Expecting IPv4 like "a.b.c.d"; normalize last octet 0..255 -> minute 0..59
  if (typeof ip === "string") {
    const parts = ip.trim().split(".");
    if (parts.length === 4) {
      const last = parseInt(parts[3], 10);
      if (!Number.isNaN(last) && last >= 0 && last <= 255) {
        return Math.floor((last * 60) / 256);
      }
    }
  }
  // Deterministic fallback from hostname (FNV-1a) so devices remain stable
  const h = os.hostname();
  let hash = 2166136261;
  for (let i = 0; i < h.length; i++) {
    hash ^= h.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash % 60;
}

/**
 * Start nightly autopatch checks staggered by IP-derived minute.
 * If started after 20:00, it will try this hour at :minute (e.g. 21:mm).
 * After the first run, it always schedules 20:mm nightly.
 *
 * @param {string} ip IPv4 address for minute derivation
 * @param {object} opts optional { hour: number (default 20), tz: string, vt: number }
 *                      opts.vt is forwarded to checkAndApply({ vt })
 * @returns {number} the chosen minute [0..59]
 */
function startNightlyStagger(ip, opts = {}) {
  const hour = Number.isFinite(opts.hour) ? Number(opts.hour) : 20;
  const tz = opts.tz || "Africa/Johannesburg";
  const minute = computeStaggerMinuteFromIP(ip);

  function nextAtHourMinute(base, h, m) {
    const t = new Date(base);
    t.setHours(h, m, 0, 0);
    if (t <= base) t.setDate(t.getDate() + 1);
    return t;
  }

  function computeInitial(now) {
    if (now.getHours() >= hour) {
      // Try this hour at :minute; if already passed, bump one hour.
      const first = new Date(now);
      first.setSeconds(0, 0);
      first.setMinutes(minute);
      if (first <= now) first.setHours(now.getHours() + 1, minute, 0, 0);

      // If we rolled past midnight and are now before the target hour,
      // defer to the next 20:mm to keep the "nightly after 20:00" policy.
      if (first.getDate() !== now.getDate() && first.getHours() < hour) {
        return nextAtHourMinute(now, hour, minute);
      }
      return first;
    }
    // Before target hour: schedule today at hour:mm
    return nextAtHourMinute(now, hour, minute);
  }

  function scheduleFor(when) {
    const delay = Math.max(0, when.getTime() - Date.now());
    console.log(
      `[autopatch] next scheduled check: ${when.toLocaleString("en-ZA", { timeZone: tz })} (minute ${minute}) ip=${ip || "unknown"}`
    );
    setTimeout(async () => {
      try {
        if (!isBusy()) {
          console.log("[autopatch] starting scheduled check...");
          await checkAndApply({ vt: opts.vt });
        } else {
          console.log("[autopatch] skipped: already running");
        }
      } catch (e) {
        console.error("[autopatch] scheduled run failed:", e && e.message ? e.message : e);
      } finally {
        // From now on, pin to nightly 20:mm
        const next = nextAtHourMinute(new Date(), hour, minute);
        scheduleFor(next);
      }
    }, delay);
  }

  scheduleFor(computeInitial(new Date()));
  return minute;
}


module.exports = { checkAndApply, isBusy, startNightlyStagger, computeStaggerMinuteFromIP };
