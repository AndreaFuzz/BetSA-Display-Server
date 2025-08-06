/* server.js ─ BETSA kiosk helper with EJS diagnostics UI & auto-reconnecting DevTools */
/* eslint-disable no-console */
'use strict';
const upgrade = require('./upgrade');
upgrade.runMigrations();                 // already there
const APP_VERSION = upgrade.getVersion(); // new – read the number

const ANNOUNCE_INTERVAL = 10 * 60 * 1000;   // 10 minutes
const express = require('express');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
const { captureScreenshot } = require("./screenshot");
/* ───────────────────────────── constants ──────────────────────────────── */
const PORT = 8080;                          // HTTP API / UI port
const STATE_FILE = '/home/admin/kiosk/urls.json'; // persistent store for HDMI URLs
const POINTER_FILE = '/home/admin/kiosk/pointer.json';

const SCREEN_PORT = { '1': 9222, '2': 9223 };      // HDMI-1 / HDMI-2 debug ports
const HUB = 'http://10.1.220.219:7070';    // central server

/* ───────────────────────── hub helpers / 7070 ─────────────────────────── */
function getMacAddress() {
  for (const nics of Object.values(os.networkInterfaces())) {
    for (const nic of nics) {
      if (nic.family === 'IPv4' && !nic.internal && nic.mac &&
        nic.mac !== '00:00:00:00:00:00')
        return nic.mac;
    }
  }
  return 'unknown';
}
const DEVICE_MAC = getMacAddress();

function postToHub(path, payload, delay = 2000) {
  fetch(`${HUB}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(res => {
      if (!res.ok) throw new Error(`hub responded ${res.status}`);
      console.log(`[hub] POST ${path} ok`);
    })
    .catch(err => {
      console.error(`[hub] POST ${path} failed: ${err.message}`);
      setTimeout(() => postToHub(path, payload, Math.min(delay * 2, 60000)), delay);
    });
}
function announceMouse (hidden) {
  postToHub('/device/mouse', { mac: DEVICE_MAC, mouse: { hidden } });
}
function announceSelf() {
  postToHub('/device', {
    mac: DEVICE_MAC,
    urls: loadState(),
    mouse: loadPointerState(),
    diag: getDiagnostics()
  });
}
function announceUrls(urls) { postToHub('/device/urls', { mac: DEVICE_MAC, urls }); }

/* ───────────────── DevTools auto-reconnect controller ─────────────────── */
function fetchJson(port) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: '/json' }, r => {
      let data = '';
      r.on('data', c => (data += c));
      r.on('end', () => { try { res(JSON.parse(data)); } catch (e) { rej(e); } });
    }).on('error', rej);
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
      const page = list.find(t => t.type === 'page');
      if (!page) throw new Error('no "page" target');
      this.ws = new WebSocket(page.webSocketDebuggerUrl);
      this.ws.on('open', () => {
        console.log(`[ws] screen ${this.screenId} connected`);
        this.error = false; this.backoff = 2000;
        if (this.desired) this.send(this.desired);
      });
      this.ws.on('close', () => {
        if (!this.error) console.warn(`[ws] screen ${this.screenId} closed`);
        this.error = true; this.ws = null; this.schedule();
      });
      this.ws.on('error', e => {
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
    this.ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url } }));
    console.log(`[redirect] screen ${this.screenId} (${this.port}) → ${url}`);
  }
  ensure() { if (!this.ws && !this.timer) this.schedule(0); }
  schedule(d = this.backoff) {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, d);
    this.backoff = Math.min(this.backoff * 2, 60000);
  }
}
const controllers = {}; for (const [id, port] of Object.entries(SCREEN_PORT)) controllers[id] = new DevToolsController(id, port);
function redirectBrowser(id, url) { const c = controllers[id]; if (c) c.navigate(url); }

/* ─────────────────────────── state helpers ────────────────────────────── */
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { hdmi1: null, hdmi2: null }; } }
function saveState(s) { try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) { console.error('Could not write state:', e); } }

/* ───────────────── diagnostics helper ─────────────────────────────────── */
function getDiagnostics() {
  function detectModel() {
    try { const m = fs.readFileSync('/proc/device-tree/model', 'utf8').trim(); if (m) return m; } catch { }
    const dmi = '/sys/devices/virtual/dmi/id';
    try {
      const prod = fs.readFileSync(path.join(dmi, 'product_name'), 'utf8').trim();
      const ver = fs.readFileSync(path.join(dmi, 'product_version'), 'utf8').trim();
      const ven = fs.readFileSync(path.join(dmi, 'sys_vendor'), 'utf8').trim();
      const parts = [ven, prod, ver].filter(Boolean); if (parts.length) return parts.join(' ');
    } catch { }
    return 'unknown';
  }
  const nets = os.networkInterfaces(), ifaces = [];
  for (const [n, arr] of Object.entries(nets)) for (const nic of arr)
    if (nic.family === 'IPv4' && !nic.internal) ifaces.push({ iface: n, ip: nic.address, mac: nic.mac });
  return {
    time: new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' }),
    hostname: os.hostname(), arch: os.arch(), deviceModel: detectModel(), network: ifaces
  };
}

/* ───────────────── mouse-cursor helpers ──────────────────────────────── */
 
const INIT_FILE    = '/home/admin/kiosk/pointer.init';   // written after 1st POST

function loadPointerState () {
  /*  BEFORE any manual setting, report "hidden": true               */
  if (!fs.existsSync(INIT_FILE)) return { hidden: true };

  try {                        // after first POST we can trust pointer.json
    return JSON.parse(fs.readFileSync(POINTER_FILE, 'utf8'));
  } catch {
    return { hidden: false };  // corrupted JSON? fall back to visible
  }
}

function savePointerState (s) {
  try {
    fs.mkdirSync(path.dirname(POINTER_FILE), { recursive: true });
    fs.writeFileSync(POINTER_FILE, JSON.stringify(s));
    if (!fs.existsSync(INIT_FILE)) fs.writeFileSync(INIT_FILE, 'done');
  } catch (e) {
    console.error('[mouse] persist failed:', e);
  }
}
function isCursorHidden () {
  try { execSync('pgrep -u admin unclutter', { stdio: 'ignore' }); return true; }
  catch { return false; }
}
function hideCursor () {
  try {
    execSync('sudo -u admin DISPLAY=:0 XAUTHORITY=/home/admin/.Xauthority pkill unclutter || true', { stdio: 'ignore' });
    spawn(
      'sudo',
      ['-u','admin','DISPLAY=:0','XAUTHORITY=/home/admin/.Xauthority',
       'unclutter','-idle','0','-root'],
      { detached: true, stdio: 'ignore' }
    ).unref();
  } catch (e) { console.error('[mouse] hide failed:', e); }
}
function showCursor () {
  try { execSync('sudo -u admin DISPLAY=:0 XAUTHORITY=/home/admin/.Xauthority pkill unclutter || true', { stdio: 'ignore' }); }
  catch (e) { console.error('[mouse] show failed:', e); }
}

/* initialisation -------------------------------------------------------- */
(() => {
  const firstBoot = !fs.existsSync(INIT_FILE);           // new sentinel check
  const state     = firstBoot ? { hidden: true } : loadPointerState();
  const actuallyHidden = isCursorHidden();

  if (state.hidden && !actuallyHidden) hideCursor();
  if (!state.hidden && actuallyHidden) showCursor();
})();
 

 
/* ───────────────────────── express setup ──────────────────────────────── */
const app = express();
app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

 

/* replace the whole /screenshot/:id handler */
app.get("/screenshot/:id", async (req, res) => {
  try {
    const { mime, buffer } = await captureScreenshot(req.params.id, 70); // 70 % JPEG
    res.type(mime).send(buffer);
  } catch (err) {
    res.status(500).send(err.message);
  }
});
 
/* ─────────────── diagnostics & UI ─────────────────────────────────────── */
app.get('/diagnostic', (_, res) => res.json(getDiagnostics()));
app.get('/diagnostic-ui', (req, res) => {
  const state  = loadState();
  const screen = req.query.screen;
  const target = screen === '1' ? state.hdmi1
               : screen === '2' ? state.hdmi2
               : null;

  res.render('diagnostic-ui', {
    d: getDiagnostics(),
    urls: state,
    target,
    screen,
    version: APP_VERSION
  });
});


/* ─────────────── reboot endpoint ─────────────────────────────────────── */
app.post('/reboot', (_req, res) => {
  res.send('Rebooting…');
  setTimeout(() => spawn('sudo', ['reboot'], { stdio: 'ignore', detached: true }).unref(), 100);
});

/* ───────────── saved-urls endpoints ───────────────────────────────────── */
app.get('/saved-urls', (_, res) => res.json(loadState()));
app.post('/saved-urls', (req, res) => {
  const { hdmi1, hdmi2 } = req.body || {};
  const ok = v => typeof v === 'string' || v === null || typeof v === 'undefined';
  if (!ok(hdmi1) || !ok(hdmi2)) return res.status(400).send('hdmi1/hdmi2 bad type');

  const state = loadState();
  if (typeof hdmi1 !== 'undefined') { state.hdmi1 = hdmi1; if (typeof hdmi1 === 'string' && hdmi1) redirectBrowser('1', hdmi1); }
  if (typeof hdmi2 !== 'undefined') { state.hdmi2 = hdmi2; if (typeof hdmi2 === 'string' && hdmi2) redirectBrowser('2', hdmi2); }
  saveState(state);
  announceUrls(state);          // push to hub
  res.json(state);
});

/* ───────────── mouse endpoints ────────────────────────────────────────── */
app.get('/mouse', (_, res) => res.json(loadPointerState()));
app.post('/mouse', (req, res) => {
  const { hidden } = req.body || {};
  if (typeof hidden !== 'boolean')
    return res.status(400).send('Expecting JSON body { "hidden": true|false }');

  const wasHidden = isCursorHidden();
  if (hidden && !wasHidden) hideCursor();
  if (!hidden && wasHidden) showCursor();

  savePointerState({ hidden });
  announceMouse(hidden);            // ← tell the hub
  res.json({ hidden });
});

/* ───────────────────────── clear-cookies endpoint ────────────────────── */

/**
 *  Connect to Chrome’s DevTools WebSocket on the given port and run the
 *  Network-domain “clear” commands.  Resolves when the commands have been
 *  sent and the socket closed.  Throws on any failure along the way.
 */
/* ─── Clear everything and refresh ───────────────────────────────────── */
function clearCookiesCacheAndRefresh (port) {
  return new Promise(async (resolve, reject) => {
    try {
      const list = await fetchJson(port);
      const page = list.find(t => t.type === 'page');
      if (!page) return reject(new Error('no "page" target found'));

      const ws = new WebSocket(page.webSocketDebuggerUrl);
      let id = 0;
      const send = (method, params = {}) =>
        ws.send(JSON.stringify({ id: ++id, method, params }));

      ws.once('open', () => {
        send('Network.clearBrowserCookies');   // delete all cookies
        send('Network.clearBrowserCache');     // empty HTTP cache
        send('Page.reload', { ignoreCache: true }); // hard-refresh tab
        setTimeout(() => { ws.close(); resolve(); }, 500);
      });

      ws.once('error', err => { ws.close(); reject(err); });
    } catch (err) { reject(err); }
  });
}


/* POST /clear-cookies/1   or   POST /clear-cookies/2
   -------------------------------------------------- */
app.post('/clear-cookies/:id', async (req, res) => {
  const port = SCREEN_PORT[req.params.id];
  if (!port) return res.status(400).send('invalid HDMI id');

  try {
    await clearCookiesCacheAndRefresh(port);
    res.send(`Cookies, cache cleared **and page reloaded** for HDMI-${req.params.id}`);
  } catch (e) {
    console.error(`[cookies] HDMI-${req.params.id} failed:`, e.message);
    res.status(500).send(`failed: ${e.message}`);
  }
});

/* ──────────────── live console logs over SSE ─────────────────────────── */
/*
   GET /console[/<id>]

   – If <id> is 1 or 2, streams that HDMI head only.
   – With no <id>, it multiplexes both heads.
   – Each SSE message is a JSON object, e.g.
       {"screen":1,"kind":"console","type":"log","text":"hello","ts":1721830123456}
       {"screen":2,"kind":"browser","level":"error","text":"404","ts":...}

   Clients:  curl -N http://localhost:8080/console
             curl -N http://localhost:8080/console/1
*/
app.get('/console/:id?', (req, res) => {
  /* pick which ports we’ll tap */
  const want = (() => {
    const id = req.params.id;
    if (id === '1' || id === '2') return [[id, SCREEN_PORT[id]]];
    return Object.entries(SCREEN_PORT);          // both
  })();

  /* standard SSE headers */
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection:      'keep-alive',
  });
  res.flushHeaders();
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  /* helper to establish a WebSocket to the page target on one port */
  function wire(screen, port) {
    /* discover the page target */
    fetchJson(port)
      .then(list => {
        const page = list.find(t => t.type === 'page');
        if (!page) throw new Error('no “page” target');
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        let msgId = 0;
        const sendCmd = (method, params = {}) =>
          ws.send(JSON.stringify({ id: ++msgId, method, params }));

        ws.on('open', () => {
          sendCmd('Runtime.enable');   // console.* events
          sendCmd('Log.enable');       // browser log events
        });

        ws.on('message', data => {
          try { data = JSON.parse(data); } catch { return; }

          /* console.* */
          if (data.method === 'Runtime.consoleAPICalled') {
            const { type, args } = data.params;
            send({
              screen, kind: 'console', type,
              text: args.map(a => a.value ?? a.description).join(' '),
              ts: Date.now()
            });
          }

          /* network / browser */
          if (data.method === 'Log.entryAdded') {
            const { entry } = data.params;
            send({
              screen, kind: 'browser',
              level: entry.level, source: entry.source, text: entry.text,
              ts: entry.timestamp
            });
          }
        });

        ws.on('close',  () => send({ screen, kind: 'status', text: 'closed' }));
        ws.on('error',  e => send({ screen, kind: 'error',  text: e.message }));
        req.on('close', () => ws.close());
      })
      .catch(err => {
        send({ screen, kind: 'error', text: `connect failed: ${err.message}` });
      });
  }

  /* connect to every requested screen */
  want.forEach(([scr, port]) => wire(Number(scr), port));

  /* keep‑alive ping every 30 s so proxies don’t cut the pipe */
  const ping = setInterval(() => res.write(': ping\n\n'), 30000);
  req.on('close', () => clearInterval(ping));
});


/* ───────────── registration (/data) + hub snapshot ────────────────────── */
function detectPrimaryIPv4() {
  for (const [name, nics] of Object.entries(os.networkInterfaces()))
    for (const nic of nics) if (nic.family === 'IPv4' && !nic.internal) return { name, ip: nic.address };
  return null;
}
function registerSelf() {
  const primary = detectPrimaryIPv4();
  if (!primary) { console.error('[register] no usable IPv4 interface'); return setTimeout(registerSelf, 2000); }

  /* original /data body – unchanged */
  fetch(`${HUB}/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip_eth0: primary.ip })
  })
    .then(res => {
      if (!res.ok) throw new Error('server responded ' + res.status);
      console.log(`[register] announced ${primary.name} - ${primary.ip}`);
    })
    .catch(err => { console.error('[register] failed:', err.message); setTimeout(registerSelf, 2000); });

  /* new full snapshot */
  announceSelf();
}

/* ──────────────────────── start server ───────────────────────────────── */
app.listen(PORT, () => {
  console.log(`kiosk-server listening on ${PORT}`);
  const diag = `http://localhost:${PORT}/diagnostic-ui`;
  redirectBrowser('1', `${diag}?screen=1`);
  redirectBrowser('2', `${diag}?screen=2`);
  registerSelf();
  setInterval(announceSelf, ANNOUNCE_INTERVAL);
});
