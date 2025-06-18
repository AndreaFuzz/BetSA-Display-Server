// server.js ─ BETSA kiosk helper with EJS diagnostics UI & auto-reconnecting DevTools
/* eslint-disable no-console */

const express      = require('express');
const fs           = require('fs');
const { execSync, spawn } = require('child_process');
const os           = require('os');
const path         = require('path');
const http         = require('http');
const WebSocket    = require('ws');
const fetch        = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

const PORT        = 8080;                       // HTTP API / UI port
const STATE_FILE  = '/home/pi/kiosk/urls.json'; // persistent store for HDMI URLs

/* ─────────────────── DevTools auto-reconnect controller ────────────────── */

const SCREEN_PORT = { '1': 9222, '2': 9223 };   // HDMI-1 / HDMI-2 debug ports

/* Fetch /json array from Chrome’s remote-debug port ----------------------- */
function fetchJson (port) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: '/json' }, r => {
      let data = '';
      r.on('data', c => (data += c));
      r.on('end', () => {
        try { res(JSON.parse(data)); }
        catch (e) { rej(e); }
      });
    }).on('error', rej);
  });
}

/* One resilient connection per screen ------------------------------------- */
class DevToolsController {
  constructor (screenId, port) {
    this.screenId   = screenId;
    this.port       = port;
    this.ws         = null;          // active WebSocket (or null)
    this.timer      = null;          // reconnect timer handle
    this.desiredUrl = null;          // last URL we were asked to show
    this.connect();                  // start immediately
  }

  /* Public – navigate (or queue) ----------------------------------------- */
  navigate (url) {
    this.desiredUrl = url;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendNavigate(url);
    } else {
      this.ensureConnection();
    }
  }

  /* Internal – open WS (gets new target each time!) ---------------------- */
  async connect () {
    try {
      const list = await fetchJson(this.port);
      const page = list.find(t => t.type === 'page');
      if (!page) throw new Error('no "page" target');

      this.ws = new WebSocket(page.webSocketDebuggerUrl);

      this.ws.on('open', () => {
        console.log(`[ws] screen ${this.screenId} connected`);
        if (this.desiredUrl) this.sendNavigate(this.desiredUrl);
      });

      this.ws.on('close', () => {
        console.warn(`[ws] screen ${this.screenId} closed`);
        this.ws = null;
        this.scheduleReconnect();
      });

      this.ws.on('error', err => {
        console.warn(`[ws] screen ${this.screenId} error: ${err.message}`);
        this.ws.close();             // triggers 'close' for unified handling
      });
    } catch (e) {
      console.warn(`[ws] screen ${this.screenId} connect failed: ${e.message}`);
      this.scheduleReconnect();
    }
  }

  /* Helper – actually send Page.navigate --------------------------------- */
  sendNavigate (url) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      id: 1,
      method: 'Page.navigate',
      params: { url }
    }));
    console.log(`[redirect] screen ${this.screenId} (${this.port}) → ${url}`);
  }

  /* Ensure we’re (re-)connecting ----------------------------------------- */
  ensureConnection () {
    if (!this.ws && !this.timer) this.scheduleReconnect(0);
  }

  /* Schedule reconnect in n ms (default 2000) ---------------------------- */
  scheduleReconnect (delay = 2000) {
    if (this.timer) return;          // already waiting
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }
}

/* Instantiate controllers for both screens ------------------------------- */
const controllers = {};
for (const [id, port] of Object.entries(SCREEN_PORT)) {
  controllers[id] = new DevToolsController(id, port);
}

/* Thin wrapper so the rest of the code doesn’t change -------------------- */
function redirectBrowser (screenId, url) {
  const c = controllers[screenId];
  if (!c) return console.error(`[redirect] invalid screen "${screenId}"`);
  c.navigate(url);
}

/* ─────────────────────────── State helpers ─────────────────────────────── */
function loadState () {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { hdmi1: null, hdmi2: null }; }
}

function saveState (state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('Could not write state file:', e);
  }
}

/* ─────────────────────── Screen-resolution helper ─────────────────────── */
function readRes () {
  try {
    const out = execSync('xrandr', { encoding: 'utf8' });
    const rx  = /^(HDMI-\d)\s+connected.*?(\d+)x(\d+)/gm;
    let m, map = {};
    while ((m = rx.exec(out)) !== null) {
      map[m[1]] = { w: +m[2], h: +m[3] };
    }
    const h1 = map['HDMI-1'] || { w: 1920, h: 1080 };
    const h2 = map['HDMI-2'] || { w: 1920, h: 1080 };
    return { w1: h1.w, h1: h1.h, w2: h2.w, h2: h2.h };
  } catch {
    console.error('readRes failed, defaulting 1920×1080 per screen');
    return { w1: 1920, h1: 1080, w2: 1920, h2: 1080 };
  }
}

/* ───────────────── diagnostics (unchanged logic) ───────────────────────── */
function getDiagnostics () {
  /* … same implementation as before … */
  function detectDeviceModel () {
    try {
      const piModel = fs.readFileSync('/proc/device-tree/model', 'utf8').trim();
      if (piModel.length) return piModel;
    } catch {}
    const dmi = '/sys/devices/virtual/dmi/id';
    try {
      const product = fs.readFileSync(path.join(dmi, 'product_name'), 'utf8').trim();
      const version = fs.readFileSync(path.join(dmi, 'product_version'), 'utf8').trim();
      const vendor  = fs.readFileSync(path.join(dmi, 'sys_vendor'), 'utf8').trim();
      const parts = [vendor, product, version].filter(Boolean);
      if (parts.length) return parts.join(' ');
    } catch {}
    try {
      const out = execSync('hostnamectl', { encoding: 'utf8' });
      const m = out.match(/Hardware Model:\s+(.+)/);
      if (m) return m[1].trim();
    } catch {}
    try {
      const cpu = os.cpus()?.[0]?.model?.trim();
      if (cpu) return cpu;
    } catch {}
    return 'unknown';
  }

  const nets = os.networkInterfaces();
  const ifaces = [];
  for (const [name, arr] of Object.entries(nets)) {
    for (const nic of arr) {
      if (nic.family === 'IPv4' && !nic.internal) {
        ifaces.push({ iface: name, ip: nic.address, mac: nic.mac });
      }
    }
  }

  return {
    time: new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' }),
    hostname: os.hostname(),
    arch: os.arch(),
    deviceModel: detectDeviceModel(),
    network: ifaces
  };
}

/* ─────────────────────────── express setup ─────────────────────────────── */
const app = express();
app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

/* 1 ─ screenshot endpoint -------------------------------------------------- */
app.get('/screenshot/:id', (req, res) => {
  const { w1, h1, w2, h2 } = readRes();
  const id      = req.params.id;
  const tmpPng  = `/tmp/screen${id}.png`;
  const outJpg  = `/tmp/screen${id}.jpg`;
  const wantW   = +req.query.maxw || NaN;
  const wantQ   = +req.query.quality || NaN;

  try {
    if (id === '1')      execSync(`DISPLAY=:0 scrot -a 0,0,${w1},${h1} -o ${tmpPng}`);
    else if (id === '2') execSync(`DISPLAY=:0 scrot -a ${w1},0,${w2},${h2} -o ${tmpPng}`);
    else return res.status(400).send('invalid id');
  } catch {
    return res.status(500).send('screen grab failed');
  }

  const resize  = !Number.isNaN(wantW) ? ` -resize ${wantW}` : '';
  const quality = !Number.isNaN(wantQ) ? ` -quality ${wantQ}` : ' -quality 90';
  if (resize || quality !== ' -quality 90') {
    try {
      execSync(`convert ${tmpPng}${resize}${quality} ${outJpg}`);
      return res.type('jpeg').send(fs.readFileSync(outJpg));
    } catch {
      return res.status(500).send('image conversion failed');
    }
  }
  res.type('png').send(fs.readFileSync(tmpPng));
});

/* 2 ─ raw JSON diagnostics ------------------------------------------------- */
app.get('/diagnostic', (_, res) => res.json(getDiagnostics()));

/* 3 ─ diagnostics UI ------------------------------------------------------- */
app.get('/diagnostic-ui', (req, res) => {
  const state  = loadState();
  const screen = req.query.screen;
  const target = screen === '1' ? state.hdmi1
               : screen === '2' ? state.hdmi2
               : null;

  res.render('diagnostic-ui', {
    d: getDiagnostics(),
    urls: state,
    target, screen
  });
});

/* 4 ─ reboot endpoint ------------------------------------------------------ */
app.post('/reboot', (req, res) => {
  res.send('Rebooting…');
  setTimeout(() => {
    spawn('sudo', ['reboot'], { stdio: 'ignore', detached: true }).unref();
  }, 100);
});

/* saved-urls: GET returns state, POST updates AND refreshes screens -------- */
app.get('/saved-urls', (_, res) => res.json(loadState()));

app.post('/saved-urls', (req, res) => {
  const { hdmi1, hdmi2 } = req.body || {};
  const ok = v => typeof v === 'string' || v === null || typeof v === 'undefined';
  if (!ok(hdmi1) || !ok(hdmi2)) return res.status(400).send('hdmi1/hdmi2 bad type');

  const state = loadState();

  if (typeof hdmi1 !== 'undefined') {
    state.hdmi1 = hdmi1;
    if (typeof hdmi1 === 'string' && hdmi1) redirectBrowser('1', hdmi1);
  }
  if (typeof hdmi2 !== 'undefined') {
    state.hdmi2 = hdmi2;
    if (typeof hdmi2 === 'string' && hdmi2) redirectBrowser('2', hdmi2);
  }

  saveState(state);
  res.json(state);
});

/* ───────────────────── optional registration helper ────────────────────── */
function ipv4Of (iface = 'eth0') {
  const nicArr = os.networkInterfaces()[iface];
  return nicArr?.find(n => n.family === 'IPv4' && !n.internal)?.address || null;
}
 
async function registerSelf () {
  try {
    const ip = ipv4Of('eth0');
    if (!ip) return console.error('[register] no eth0 IPv4 – skipping');

    const res = await fetch('http://10.1.220.203:7070/data', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ ip_eth0: ip })
    });

    if (!res.ok) console.error(`[register] server ${res.status}`);
    else         console.log(`[register] announced ${ip}`);
  } catch (e) {
    console.error('[register] failed:', e.message);
  }
}

/* ──────────────────────────── start server ─────────────────────────────── */
app.listen(PORT, () => {
  console.log(`kiosk-server listening on ${PORT}`);

  const diag = `http://localhost:${PORT}/diagnostic-ui`;
  redirectBrowser('1', `${diag}?screen=1`);
  redirectBrowser('2', `${diag}?screen=2`);
  registerSelf();
});
