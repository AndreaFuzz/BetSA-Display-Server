/* server.js ─ BETSA kiosk helper with EJS diagnostics UI & auto-reconnecting DevTools */
/* eslint-disable no-console */
'use strict';

const express = require('express');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

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
//change
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

/* ───────────────── mouse-cursor helpers ───────────────────────────────── */
function loadPointerState() { try { return JSON.parse(fs.readFileSync(POINTER_FILE, 'utf8')); } catch { return { hidden: false }; } }
function savePointerState(s) { try { fs.mkdirSync(path.dirname(POINTER_FILE), { recursive: true }); fs.writeFileSync(POINTER_FILE, JSON.stringify(s)); } catch (e) { console.error('[mouse] persist failed:', e); } }
function isCursorHidden() { try { execSync('pgrep -u admin unclutter', { stdio: 'ignore' }); return true; } catch { return false; } }
function hideCursor() {
  try {
    execSync('sudo -u admin DISPLAY=:0 XAUTHORITY=/home/admin/.Xauthority pkill unclutter || true', { stdio: 'ignore' });
    spawn('sudo', ['-u', 'admin', 'DISPLAY=:0', 'XAUTHORITY=/home/admin/.Xauthority', 'unclutter', '-idle', '0', '-root'], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) { console.error('[mouse] hide failed:', e.message); }
}
function showCursor() { try { execSync('sudo -u admin DISPLAY=:0 XAUTHORITY=/home/admin/.Xauthority pkill unclutter || true', { stdio: 'ignore' }); } catch (e) { console.error('[mouse] show failed:', e.message); } }
(() => { const s = loadPointerState(), r = isCursorHidden(); if (s.hidden && !r) hideCursor(); if (!s.hidden && r) showCursor(); })();

/* ───────────────────────── screenshot helper ──────────────────────────── */
function readRes() {
  try {
    const out = execSync('xrandr', { encoding: 'utf8' });
    const rx = /^(HDMI-\d)\s+connected.*?(\d+)x(\d+)/gm;
    let m, map = {};
    while ((m = rx.exec(out)) !== null) map[m[1]] = { w: +m[2], h: +m[3] };
    const h1 = map['HDMI-1'] || { w: 1920, h: 1080 };
    const h2 = map['HDMI-2'] || { w: 1920, h: 1080 };
    return { w1: h1.w, h1: h1.h, w2: h2.w, h2: h2.h };
  } catch {
    console.error('readRes failed, defaulting 1920×1080 per screen');
    return { w1: 1920, h1: 1080, w2: 1920, h2: 1080 };
  }
}

/* ───────────────────────── express setup ──────────────────────────────── */
const app = express();
app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

/* ─────────────── screenshot endpoint (X11-only) ───────────────────────── */
/* ───────── screenshot endpoint (X11-only but with resize/quality) ─────── */
app.get('/screenshot/:id', (req, res) => {
  const id = req.params.id, { w1, h1, w2, h2 } = readRes();
  const geom = id === '1' ? { x: 0,  y: 0,  w: w1, h: h1 }
             : id === '2' ? { x: w1, y: 0,  w: w2, h: h2 }
             : null;
  if (!geom) return res.status(400).send('invalid id');

  const tmp = `/tmp/screen${id}-${Date.now()}.png`;
  const cmd = `ffmpeg -hide_banner -loglevel error -f x11grab -video_size ${geom.w}x${geom.h} ` +
              `-i :0.0+${geom.x},${geom.y} -frames:v 1 -y ${tmp}`;
  try { execSync(cmd, { stdio: 'inherit' }); }
  catch (e) { console.error('[capture] x11grab failed:', e.message); return res.status(500).send('capture failed'); }

  /* optional convert to JPEG / resize (same flags as original) */
  const wantW = +req.query.maxw || NaN;
  const wantQ = +req.query.quality || 90;
  let outFile = tmp, mime = 'png';

  try {
    if (!Number.isNaN(wantW) || wantQ !== 90) {
      const jpg = tmp.replace(/\.png$/, '.jpg');
      execSync(
        `convert ${tmp}` +
        (!Number.isNaN(wantW) ? ` -resize ${wantW}` : '') +
        ` -quality ${wantQ} ${jpg}`
      );
      outFile = jpg; mime = 'jpeg';
    }
  } catch (e) { console.warn('[capture] convert failed, sending raw PNG:', e.message); }

  res.type(mime);
  const stream = fs.createReadStream(outFile);
  stream.pipe(res);

  const clean = () => { fs.unlink(tmp, () => {}); if (outFile !== tmp) fs.unlink(outFile, () => {}); };
  res.once('finish', clean); res.once('close', clean);
});


/* ─────────────── diagnostics & UI ─────────────────────────────────────── */
app.get('/diagnostic', (_, res) => res.json(getDiagnostics()));
app.get('/diagnostic-ui', (req, res) => {
  const state = loadState(), screen = req.query.screen;
  const target = screen === '1' ? state.hdmi1 : screen === '2' ? state.hdmi2 : null;
  res.render('diagnostic-ui', { d: getDiagnostics(), urls: state, target, screen });
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
});
