// screen-map.js — left/right mapping via DevTools, with single-screen support
"use strict";

const { execSync } = require("child_process");
const http = require("http");
const WebSocket = require("ws");

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

/* -------------- DevTools helpers -------------- */

function fetchJson(port) {
  return new Promise((res, rej) => {
    http.get({ host: "127.0.0.1", port, path: "/json" }, r => {
      let d = "";
      r.on("data", c => (d += c));
      r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on("error", rej);
  });
}

async function cdpWindowRectForPort(port) {
  const list = await fetchJson(port);
  const page = list.find(t => t.type === "page");
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws open timeout")), 3000);
    ws.once("open", () => { clearTimeout(t); resolve(); });
    ws.once("error", reject);
  });

  const rect = await new Promise((resolve, reject) => {
    ws.once("message", raw => {
      try {
        const msg = JSON.parse(raw);
        if (msg.id === 1 && msg.result && msg.result.result && msg.result.result.value) {
          resolve(msg.result.result.value);
        }
      } catch (e) { reject(e); }
    });
    ws.send(JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: {
        expression: "({x:window.screenX,y:window.screenY,w:window.outerWidth,h:window.outerHeight})",
        returnByValue: true
      }
    }));
  }).finally(() => ws.close());

  if (!rect || typeof rect.x !== "number") throw new Error("no rect from page");
  return { x: Number(rect.x) || 0, y: Number(rect.y) || 0, w: Number(rect.w) || 0, h: Number(rect.h) || 0 };
}

async function detectLeftRightPortsCDP(log) {
  const ports = [9222, 9223];
  const out = [];
  for (const port of ports) {
    try {
      const r = await cdpWindowRectForPort(port);
      out.push({ port, x: r.x, rect: r });
    } catch {
      // ignore
    }
  }
  if (!out.length) return { detected: false };

  out.sort((a, b) => a.x - b.x);
  const left = out[0].port;
  const right = out[1] ? out[1].port : null; // IMPORTANT: null when single-screen
  log.info(`[screen-map] CDP map left->${left} right->${right} details=${JSON.stringify(out)}`);
  return { detected: true, left, right, method: "cdp" };
}

/* -------------- Optional wmctrl fallback -------------- */

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
function detectLeftRightPortsWM(run, log) {
  const ports = [9222, 9223];
  const items = ports.map(port => {
    const pid = pidForPort(run, port);
    const wid = widForPid(run, pid);
    const x   = xOfWid(run, wid);
    return { port, pid, wid, x };
  }).filter(i => Number.isFinite(i.x));

  if (!items.length) return { detected: false };

  items.sort((a, b) => a.x - b.x);
  const left = items[0].port;
  const right = items[1] ? items[1].port : null; // IMPORTANT: null when single-screen
  log.info(`[screen-map] WMCTRL map left->${left} right->${right} details=${JSON.stringify(items)}`);
  return { detected: true, left, right, method: "wmctrl" };
}

/* -------------- Public API -------------- */

function initScreenControllers(opts) {
  const {
    DevToolsController,
    loadState,
    env = {},
    log = console,
    probeIntervalMs = 500,
    bootDetectTimeoutMs = 10000,
    remapIntervalMs = 5000,
  } = opts;

  const run = makeRunner(env, log);

  let controllers = { "1": null, "2": null };
  let desired = { "1": null, "2": null };
  let map = { detected: false, left: null, right: null };
  let ready = false;

  function buildControllers(newMap) {
    map = newMap;

    // Always create left controller
    controllers["1"] = new DevToolsController("1", map.left);
    controllers["1"].port = map.left;

    // Create right only if distinct, non-null port exists
    if (map.right && map.right !== map.left) {
      controllers["2"] = new DevToolsController("2", map.right);
      controllers["2"].port = map.right;
      log.info(`[screen-map] map applied left->${map.left} right->${map.right} via ${map.method}`);
    } else {
      controllers["2"] = null;
      log.info(`[screen-map] map applied left->${map.left} right->(none) via ${map.method}`);
    }

    // Apply desired URLs if we can
    if (desired["1"]) controllers["1"].navigate(desired["1"]);
    if (desired["2"] && controllers["2"]) controllers["2"].navigate(desired["2"]);
  }

  function applyIfReady(id, url) {
    if (!url) return;
    if (ready && controllers[id]) {
      controllers[id].navigate(url);
      log.info(`[screen-map] applied screen ${id} url -> ${url}`);
    } else if (id === "2" && !controllers["2"]) {
      log.info(`[screen-map] screen 2 unavailable; queued url -> ${url}`);
    } else {
      log.info(`[screen-map] queued screen ${id} url (mapping not ready) -> ${url}`);
    }
  }

  function redirectBrowser(id, url) {
    if (id !== "1" && id !== "2") return;
    desired[id] = url || null;
    applyIfReady(id, desired[id]);
  }

  function getCurrentPorts() {
    return { "1": controllers["1"]?.port || null, "2": controllers["2"]?.port || null };
  }

  (async function bootstrap() {
    try {
      const state = typeof loadState === "function" ? loadState() : { hdmi1: null, hdmi2: null };
      if (state.hdmi1) desired["1"] = state.hdmi1;
      if (state.hdmi2) desired["2"] = state.hdmi2;
    } catch {}

    const start = Date.now();
    while (true) {
      let found = await detectLeftRightPortsCDP(log);
      if (!found.detected) found = detectLeftRightPortsWM(run, log);
      if (found.detected) {
        ready = true;
        buildControllers(found);
        break;
      }
      if (Date.now() - start >= bootDetectTimeoutMs) {
        log.warn("[screen-map] mapping not detected yet; will keep queuing URLs until windows appear");
        break;
      }
      await new Promise(r => setTimeout(r, probeIntervalMs));
    }

    setInterval(async () => {
      let found = await detectLeftRightPortsCDP(log);
      if (!found.detected) found = detectLeftRightPortsWM(run, log);
      if (found.detected && (found.left !== map.left || found.right !== map.right || !ready)) {
        ready = true;
        buildControllers(found);
      }
    }, remapIntervalMs);
  })();

  return { redirectBrowser, getCurrentPorts };
}

module.exports = { initScreenControllers };
