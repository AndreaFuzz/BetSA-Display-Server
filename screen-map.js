// screen-map.js
"use strict";

const { execSync } = require("child_process");

function makeRunner(env, log) {
  const XENV = {
    DISPLAY: env.DISPLAY || ":0",
    XAUTHORITY: env.XAUTHORITY || "/home/admin/.Xauthority",
  };
  return function run(cmd) {
    try {
      return execSync(cmd, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...XENV },
      }).toString();
    } catch (e) {
      const msg = (e.stderr || e.stdout || e.message || "").toString().split("\n")[0];
      log && log.warn && log.warn(`[screen-map] run failed: ${cmd} -> ${msg}`);
      return "";
    }
  };
}

/* -------- low-level helpers -------- */

function pidForPort(run, port) {
  const viaSs = run(`ss -ltnp 'sport = :${port}' | awk -F'pid=' 'NR>1{split($2,a,","); print a[1]; exit}'`).trim();
  if (viaSs) return viaSs;
  const viaLsof = run(`lsof -iTCP:${port} -sTCP:LISTEN -t | head -n1`).trim();
  return viaLsof || "";
}
function widForPid(run, pid) {
  if (!pid) return "";
  return run(`wmctrl -lp | awk '$3==${pid} {print $1; exit}'`).trim();
}
function xOfWid(run, wid) {
  if (!wid) return NaN;
  const x = run(`wmctrl -lG | awk '$1=="${wid}" {print $3; exit}'`).trim();
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

function detectLeftRightPorts(run, log) {
  const ports = [9222, 9223];
  const items = ports.map(port => {
    const pid = pidForPort(run, port);
    const wid = widForPid(run, pid);
    const x   = xOfWid(run, wid);
    return { port, pid, wid, x };
  }).filter(i => Number.isFinite(i.x));

  if (!items.length) return { detected: false };

  items.sort((a, b) => a.x - b.x);
  const left  = items[0].port;
  const right = (items[1] && items[1].port) || left;
  return { detected: true, left, right, details: items };
}

/* -------- public API -------- */

function initScreenControllers(opts) {
  const {
    DevToolsController,
    loadState,                 // function returning { hdmi1, hdmi2 }
    env = {},
    log = console,
    // timings
    probeIntervalMs = 500,
    bootDetectTimeoutMs = 10000,  // how long to wait for a reliable map before we give up waiting
    remapIntervalMs = 5000,       // steady-state recheck
  } = opts;

  const run = makeRunner(env, log);

  // controllers keyed by screen id "1" (left) and "2" (right)
  let controllers = { "1": null, "2": null };

  // latest desired URLs per logical screen (left/right)
  // redirectBrowser() updates these and either queues or applies them.
  let desired = { "1": null, "2": null };

  // current port map
  let map = { detected: false, left: null, right: null };
  let ready = false;   // true once we have a detected left/right map at least once

  function buildControllers(newMap) {
    const prev = map;
    map = newMap;

    // Rebuild both controllers to the new ports
    controllers["1"] = new DevToolsController("1", map.left);  controllers["1"].port = map.left;
    controllers["2"] = new DevToolsController("2", map.right); controllers["2"].port = map.right;

    log.info(`[screen-map] map left->${map.left} right->${map.right} detected=${map.detected}`);

    // Apply desired URLs immediately if we have them
    if (desired["1"]) controllers["1"].navigate(desired["1"]);
    if (desired["2"]) controllers["2"].navigate(desired["2"]);
  }

  function applyIfReady(id, url) {
    if (!url) return;
    if (ready && controllers[id]) {
      controllers[id].navigate(url);
      log.info(`[screen-map] applied screen ${id} url -> ${url}`);
    } else {
      log.info(`[screen-map] queued screen ${id} url (mapping not ready yet) -> ${url}`);
    }
  }

  // External API: record desired URL and apply now if ready
  function redirectBrowser(id, url) {
    if (id !== "1" && id !== "2") return;
    desired[id] = url || null;
    applyIfReady(id, desired[id]);
  }

  function getCurrentPorts() {
    return { "1": controllers["1"]?.port, "2": controllers["2"]?.port };
  }

  // Bootstrap: wait for a reliable mapping before applying any URLs
  (function bootstrap() {
    // seed desired with whatever is already saved
    try {
      const state = (typeof loadState === "function") ? loadState() : { hdmi1: null, hdmi2: null };
      if (state.hdmi1) desired["1"] = state.hdmi1;
      if (state.hdmi2) desired["2"] = state.hdmi2;
    } catch {}

    const start = Date.now();

    const tick = () => {
      const found = detectLeftRightPorts(run, log);
      if (found.detected) {
        ready = true;
        buildControllers(found);
        return startRemapLoop(); // switch to steady-state loop
      }

      if (Date.now() - start >= bootDetectTimeoutMs) {
        // Still not detected; keep queuing but do not apply to avoid swapping.
        log.warn("[screen-map] mapping not detected yet; will keep queuing URLs until windows appear");
        return startRemapLoop(); // go to steady-state loop anyway
      }

      setTimeout(tick, probeIntervalMs);
    };

    tick();
  })();

  function startRemapLoop() {
    setInterval(() => {
      const found = detectLeftRightPorts(run, log);
      if (found.detected) {
        if (!ready || found.left !== map.left || found.right !== map.right) {
          ready = true;
          buildControllers(found);
        }
      }
    }, remapIntervalMs);
  }

  return { redirectBrowser, getCurrentPorts };
}

module.exports = { initScreenControllers };
