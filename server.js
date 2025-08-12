/* server.js - BETSA kiosk helper with EJS diagnostics UI & auto-reconnecting DevTools */
/* eslint-disable no-console */
"use strict";
const upgrade = require("./upgrade");
upgrade.runMigrations();
const APP_VERSION = upgrade.getVersion();

const ANNOUNCE_INTERVAL = 10 * 60 * 1000;   // 10 minutes drift-based
const express = require("express");
const fs = require("fs");
const { execSync, spawn } = require("child_process");
const os = require("os");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));
const { captureScreenshot } = require("./screenshot");
const { getLatestPatch } = require("./patch-info");
const autopatch = require("./auto-patch");

const PORT = 8080;
const STATE_FILE = "/home/admin/kiosk/urls.json";
const POINTER_FILE = "/home/admin/kiosk/pointer.json";
const SCREEN_PORT = { "1": 9222, "2": 9223 };
const HUB = "http://10.1.220.219:7070";

/* ---------------------------------------------------------------------- */
/* fetch helper with timeout and jitter */
function fetchWithTimeout(url, opts = {}, timeoutMs = 10000) {
  const AC = global.AbortController || (() => { throw new Error("AbortController missing"); });
  let controller;
  try { controller = new AC(); } catch { controller = new (require("abort-controller"))(); }
  const id = setTimeout(() => controller.abort(), timeoutMs);
  const merged = { ...opts, signal: controller.signal };
  return fetch(url, merged).finally(() => clearTimeout(id));
}

/* choose live primary NIC + MAC each announce */
function detectPrimaryIPv4() {
  for (const [name, nics] of Object.entries(os.networkInterfaces())) {
    for (const nic of nics) {
      if (nic && nic.family === "IPv4" && !nic.internal) {
        return { name, ip: nic.address, mac: nic.mac };
      }
    }
  }
  return null;
}
function currentMac() {
  const p = detectPrimaryIPv4();
  if (p && p.mac && p.mac !== "00:00:00:00:00:00") return p.mac;
  return "unknown";
}

/* ---------------------------------------------------------------------- */
/* announce helpers */
function postToHub(path, payload, delay = 2000) {
  const jitter = Math.floor(Math.random() * 400); // spread load
  fetchWithTimeout(`${HUB}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }, 10000 + jitter)
    .then(res => {
      if (!res.ok) throw new Error(`hub responded ${res.status}`);
      console.log(`[hub] POST ${path} ok`);
    })
    .catch(err => {
      console.error(`[hub] POST ${path} failed: ${err.message}`);
      setTimeout(() => postToHub(path, payload, Math.min(delay * 2, 60000)), delay + jitter);
    });
}

function announceMouse(hidden) {
  const mac = currentMac();
  postToHub("/device/mouse", { mac, mouse: { hidden } });
}

function announceSelf() {
  const mac = currentMac();
  postToHub("/device", {
    mac,
    urls: loadState(),
    mouse: loadPointerState(),
    diag: getDiagnostics()
  });
}

function announceUrls(urls) {
  const mac = currentMac();
  postToHub("/device/urls", { mac, urls });
}

/* ---------------------------------------------------------------------- */
/* DevTools auto-reconnect */
function fetchJson(port) {
  return new Promise((res, rej) => {
    http.get({ host: "127.0.0.1", port, path: "/json" }, r => {
      let data = "";
      r.on("data", c => (data += c));
      r.on("end", () => { try { res(JSON.parse(data)); } catch (e) { rej(e); } });
    }).on("error", rej);
  });
}

class DevToolsController {
  constructor(screenId, port) {
    this.screenId = screenId;
    this.port = port;
    this.ws = null;
    this.timer = null;
    this.desired = null;
    this.error = false;
    this.backoff = 2000;
    this.connect();
  }
  navigate(url) {
    this.desired = url;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.send(url);
    else this.ensure();
  }
  async connect() {
    try {
      const list = await fetchJson(this.port);
      const page = list.find(t => t.type === "page");
      if (!page) throw new Error('no "page" target');
      this.ws = new WebSocket(page.webSocketDebuggerUrl);
      this.ws.on("open", () => {
        console.log(`[ws] screen ${this.screenId} connected`);
        this.error = false; this.backoff = 2000;
        if (this.desired) this.send(this.desired);
      });
      this.ws.on("close", () => {
        if (!this.error) console.warn(`[ws] screen ${this.screenId} closed`);
        this.error = true; this.ws = null; this.schedule();
      });
      this.ws.on("error", e => {
        if (!this.error) console.warn(`[ws] screen ${this.screenId} error: ${e.message}`);
        this.error = true; this.ws.close();
      });
    } catch (e) {
      if (!this.error) console.warn(`[ws] screen ${this.screenId} connect failed: ${e.message}`);
      this.error = true; this.schedule();
    }
  }
  send(url) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ id: 1, method: "Page.navigate", params: { url } }));
    console.log(`[redirect] screen ${this.screenId} (${this.port}) -> ${url}`);
  }
  ensure() { if (!this.ws && !this.timer) this.schedule(0); }
  schedule(d = this.backoff) {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, d);
    this.backoff = Math.min(this.backoff * 2, 60000);
  }
}
const controllers = {};
for (const [id, port] of Object.entries(SCREEN_PORT)) controllers[id] = new DevToolsController(id, port);
function redirectBrowser(id, url) { const c = controllers[id]; if (c) c.navigate(url); }

/* ---------------------------------------------------------------------- */
/* state helpers */
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { hdmi1: null, hdmi2: null }; }
}
function saveState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) { console.error("Could not write state:", e); }
}

/* diagnostics helper */
function getDiagnostics() {
  function detectModel() {
    try {
      const m = fs.readFileSync("/proc/device-tree/model", "utf8").trim();
      if (m) return m;
    } catch {}
    const dmi = "/sys/devices/virtual/dmi/id";
    try {
      const prod = fs.readFileSync(path.join(dmi, "product_name"), "utf8").trim();
      const ver  = fs.readFileSync(path.join(dmi, "product_version"), "utf8").trim();
      const ven  = fs.readFileSync(path.join(dmi, "sys_vendor"), "utf8").trim();
      const parts = [ven, prod, ver].filter(Boolean);
      if (parts.length) return parts.join(" ");
    } catch {}
    return "unknown";
  }

  const nets = os.networkInterfaces();
  const ifaces = [];
  for (const [n, arr] of Object.entries(nets)) {
    for (const nic of arr) {
      if (nic.family === "IPv4" && !nic.internal) {
        ifaces.push({ iface: n, ip: nic.address, mac: nic.mac });
      }
    }
  }

  return {
    time: new Date().toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" }),
    hostname: os.hostname(),
    arch: os.arch(),
    deviceModel: detectModel(),
    network: ifaces,
    patch: getLatestPatch()
  };
}

/* ---------------------------------------------------------------------- */
/* mouse helpers */
const INIT_FILE = "/home/admin/kiosk/pointer.init";
function loadPointerState() {
  if (!fs.existsSync(INIT_FILE)) return { hidden: true };
  try { return JSON.parse(fs.readFileSync(POINTER_FILE, "utf8")); }
  catch { return { hidden: false }; }
}
function savePointerState(s) {
  try {
    fs.mkdirSync(path.dirname(POINTER_FILE), { recursive: true });
    fs.writeFileSync(POINTER_FILE, JSON.stringify(s));
    if (!fs.existsSync(INIT_FILE)) fs.writeFileSync(INIT_FILE, "done");
  } catch (e) { console.error("[mouse] persist failed:", e); }
}
function isCursorHidden() {
  try { execSync("pgrep -u admin unclutter", { stdio: "ignore" }); return true; }
  catch { return false; }
}
function hideCursor() {
  try {
    execSync("sudo -u admin DISPLAY=:0 XAUTHORITY=/home/admin/.Xauthority pkill unclutter || true", { stdio: "ignore" });
    spawn(
      "sudo",
      ["-u","admin","DISPLAY=:0","XAUTHORITY=/home/admin/.Xauthority","unclutter","-idle","0","-root"],
      { detached: true, stdio: "ignore" }
    ).unref();
  } catch (e) { console.error("[mouse] hide failed:", e); }
}
function showCursor() {
  try { execSync("sudo -u admin DISPLAY=:0 XAUTHORITY=/home/admin/.Xauthority pkill unclutter || true", { stdio: "ignore" }); }
  catch (e) { console.error("[mouse] show failed:", e); }
}

/* initialisation */
(() => {
  const firstBoot = !fs.existsSync(INIT_FILE);
  const state = firstBoot ? { hidden: true } : loadPointerState();
  const actuallyHidden = isCursorHidden();
  if (state.hidden && !actuallyHidden) hideCursor();
  if (!state.hidden && actuallyHidden) showCursor();
})();

/* ---------------------------------------------------------------------- */
/* express app + routes */
const app = express();
app.use(express.json());
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.get("/screenshot/:id", async (req, res) => {
  try {
    const { mime, buffer } = await captureScreenshot(req.params.id, 30);
    res.type(mime).send(buffer);
  } catch (err) { res.status(500).send(err.message); }
});

app.get("/diagnostic", (_, res) => res.json(getDiagnostics()));
app.get("/diagnostic-ui", (req, res) => {
  const state  = loadState();
  const screen = req.query.screen;
  const target = screen === "1" ? state.hdmi1
               : screen === "2" ? state.hdmi2
               : null;
  res.render("diagnostic-ui", {
    d: getDiagnostics(),
    urls: state,
    target,
    screen,
    version: APP_VERSION
  });
});

app.post("/reboot", (_req, res) => {
  res.send("Rebooting...");
  setTimeout(() => spawn("sudo", ["reboot"], { stdio: "ignore", detached: true }).unref(), 100);
});

app.get("/saved-urls", (_, res) => res.json(loadState()));
app.post("/saved-urls", (req, res) => {
  const { hdmi1, hdmi2 } = req.body || {};
  const ok = v => typeof v === "string" || v === null || typeof v === "undefined";
  if (!ok(hdmi1) || !ok(hdmi2)) return res.status(400).send("hdmi1/hdmi2 bad type");
  const state = loadState();
  if (typeof hdmi1 !== "undefined") { state.hdmi1 = hdmi1; if (typeof hdmi1 === "string" && hdmi1) redirectBrowser("1", hdmi1); }
  if (typeof hdmi2 !== "undefined") { state.hdmi2 = hdmi2; if (typeof hdmi2 === "string" && hdmi2) redirectBrowser("2", hdmi2); }
  saveState(state);
  announceUrls(state);
  res.json(state);
});

app.get("/mouse", (_, res) => res.json(loadPointerState()));
app.post("/mouse", (req, res) => {
  const { hidden } = req.body || {};
  if (typeof hidden !== "boolean") return res.status(400).send('Expecting JSON body { "hidden": true|false }');
  const wasHidden = isCursorHidden();
  if (hidden && !wasHidden) hideCursor();
  if (!hidden && wasHidden) showCursor();
  savePointerState({ hidden });
  announceMouse(hidden);
  res.json({ hidden });
});

/* clear cookies/cache/reload */
function clearCookiesCacheAndRefresh(port) {
  return new Promise(async (resolve, reject) => {
    try {
      const list = await fetchJson(port);
      const page = list.find(t => t.type === "page");
      if (!page) return reject(new Error('no "page" target found'));
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      let id = 0;
      const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
      ws.once("open", () => {
        send("Network.clearBrowserCookies");
        send("Network.clearBrowserCache");
        send("Page.reload", { ignoreCache: true });
        setTimeout(() => { ws.close(); resolve(); }, 500);
      });
      ws.once("error", err => { ws.close(); reject(err); });
    } catch (err) { reject(err); }
  });
}
app.post("/clear-cookies/:id", async (req, res) => {
  const port = SCREEN_PORT[req.params.id];
  if (!port) return res.status(400).send("invalid HDMI id");
  try {
    await clearCookiesCacheAndRefresh(port);
    res.send(`Cookies, cache cleared and page reloaded for HDMI-${req.params.id}`);
  } catch (e) {
    console.error(`[cookies] HDMI-${req.params.id} failed:`, e.message);
    res.status(500).send(`failed: ${e.message}`);
  }
});
// Manual trigger: GET /autopatch/check
app.get("/autopatch/check", (req, res) => {
  if (autopatch.isBusy()) {
    res.status(202).send("autopatch already running");
    return;
  }
  const vt = req.query.vt ? Number(req.query.vt) : undefined; // e.g. /autopatch/check?vt=3

  // fire-and-forget
  autopatch.checkAndApply({ vt })
    .then(r => console.log(`[autopatch] completed: ${JSON.stringify(r)}`))
    .catch(err => console.error("[autopatch] failed:", err));

  res.status(202).send("autopatch started in background");
});

/* live console logs over SSE (unchanged) */
app.get("/console/:id?", (req, res) => {
  const want = (() => {
    const id = req.params.id;
    if (id === "1" || id === "2") return [[id, SCREEN_PORT[id]]];
    return Object.entries(SCREEN_PORT);
  })();
  res.writeHead(200, {
    "Content-Type":  "text/event-stream",
    "Cache-Control": "no-cache",
    Connection:      "keep-alive"
  });
  res.flushHeaders();
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  function wire(screen, port) {
    fetchJson(port)
      .then(list => {
        const page = list.find(t => t.type === "page");
        if (!page) throw new Error('no "page" target');
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        let msgId = 0;
        const sendCmd = (method, params = {}) => ws.send(JSON.stringify({ id: ++msgId, method, params }));
        ws.on("open", () => {
          sendCmd("Runtime.enable");
          sendCmd("Log.enable");
        });
        ws.on("message", data => {
          try { data = JSON.parse(data); } catch { return; }
          if (data.method === "Runtime.consoleAPICalled") {
            const { type, args } = data.params;
            send({
              screen, kind: "console", type,
              text: args.map(a => a.value ?? a.description).join(" "),
              ts: Date.now()
            });
          }
          if (data.method === "Log.entryAdded") {
            const { entry } = data.params;
            send({
              screen, kind: "browser",
              level: entry.level, source: entry.source, text: entry.text,
              ts: entry.timestamp
            });
          }
        });
        ws.on("close",  () => send({ screen, kind: "status", text: "closed" }));
        ws.on("error",  e => send({ screen, kind: "error",  text: e.message }));
        req.on("close", () => ws.close());
      })
      .catch(err => { send({ screen, kind: "error", text: `connect failed: ${err.message}` }); });
  }
  want.forEach(([scr, port]) => wire(Number(scr), port));
  const ping = setInterval(() => res.write(": ping\n\n"), 30000);
  req.on("close", () => clearInterval(ping));
});

/* ---------------------------------------------------------------------- */
/* start server */
app.listen(PORT, () => {
  console.log(`kiosk-server listening on ${PORT}`);
  
  const diag = `http://localhost:${PORT}/diagnostic-ui`;
  redirectBrowser("1", `${diag}?screen=1`);
  redirectBrowser("2", `${diag}?screen=2`);
 
  const primary = detectPrimaryIPv4();
  const ip = primary && primary.ip;
  const minute = autopatch.startNightlyStagger(ip, { hour: 20, tz: "Africa/Johannesburg" });
  console.log(`[autopatch] stagger minute for ${ip || "unknown"}: ${minute}`);
  
  announceSelf(); // announce immediately
  setInterval(announceSelf, ANNOUNCE_INTERVAL); // keep drift
});
