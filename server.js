// server.js ─ BETSA kiosk helper with EJS diagnostics UI & redirect countdown
/* eslint-disable no-console */

const express      = require('express');
const fs           = require('fs');
const { execSync, spawn } = require('child_process');
const os           = require('os');
const path         = require('path');
const http         = require('http');
const WebSocket    = require('ws');             // DevTools WS
const fetch        = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const PORT        = 8080;                       // HTTP API / UI port
const STATE_FILE  = '/home/pi/kiosk/urls.json'; // persistent store for HDMI URLs
const PROFILE_DIR = '/home/pi/kiosk';           // (unused here but kept)

/* ──────────────────────────── DevTools helpers ─────────────────────────── */
/* HDMI-1 → port 9222  |  HDMI-2 → port 9223 */
const SCREEN_PORT = { '1': 9222, '2': 9223 };

/* GET /json from Chrome remote-debugging port */
function fetchJson(port) {
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

/* Send Page.navigate over WebSocket to the first "page" target             */
async function navigate(port, url) {
  const list = await fetchJson(port);
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error(`no page target on port ${port}`);

  return new Promise((res, rej) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        id:     1,
        method: 'Page.navigate',
        params: { url }
      }));
      setTimeout(() => { ws.close(); res(); }, 200); // allow load to start
    });
    ws.on('error', rej);
  });
}

/* Redirect a given screen to a URL                                         */
async function redirectBrowser(screenId, url) {
  const port = SCREEN_PORT[screenId];
  if (!port) {
    console.error(`[redirect] invalid screen "${screenId}"`);
    return;
  }
  try {
    await navigate(port, url);
    console.log(`[redirect] screen ${screenId} (${port}) → ${url}`);
  } catch (e) {
    console.error(`[redirect] screen ${screenId} failed: ${e.message}`);
  }
}

/* ─────────────────────────── State helpers ─────────────────────────────── */
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { hdmi1: null, hdmi2: null }; }
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('Could not write state file:', e);
  }
}

/* ─────────────────────── Screen-resolution helper ────────────────────────
   Needed by /screenshot route. Parses `xrandr` output and returns the width
   and height for each HDMI output. Defaults to 1920x1080 if parsing fails. */
function readRes() {
  try {
    const out = execSync('xrandr', { encoding: 'utf8' });
    const rx  = /^(HDMI-\d)\s+connected.*?(\d+)x(\d+)/gm;
    let m, map = {};
    while ((m = rx.exec(out)) !== null) {
      map[m[1]] = { w: parseInt(m[2], 10), h: parseInt(m[3], 10) };
    }
    const h1 = map['HDMI-1'] || { w: 1920, h: 1080 };
    const h2 = map['HDMI-2'] || { w: 1920, h: 1080 };
    return { w1: h1.w, h1: h1.h, w2: h2.w, h2: h2.h };
  } catch (e) {
    console.error('readRes failed, defaulting to 1920x1080 per screen');
    return { w1: 1920, h1: 1080, w2: 1920, h2: 1080 };
  }
}

/* ───────────────────── diagnostics (unchanged logic) ───────────────────── */
function getDiagnostics() {
  /* -------- device / platform model detection --------------------------- */
  function detectDeviceModel() {
    try {
      const piModel = fs.readFileSync('/proc/device-tree/model', 'utf8').trim();
      if (piModel.length) return piModel;
    } catch { /* not a Pi */ }

    const dmiBase = '/sys/devices/virtual/dmi/id';
    try {
      const product  = fs.readFileSync(path.join(dmiBase, 'product_name'  ), 'utf8').trim();
      const version  = fs.readFileSync(path.join(dmiBase, 'product_version'), 'utf8').trim();
      const vendor   = fs.readFileSync(path.join(dmiBase, 'sys_vendor'     ), 'utf8').trim();
      const parts = [vendor, product, version].filter(Boolean);
      if (parts.length) return parts.join(' ');
    } catch { /* no DMI */ }

    try {
      const out = execSync('hostnamectl', { encoding: 'utf8' });
      const m = out.match(/Hardware Model:\s+(.+)/);
      if (m) return m[1].trim();
    } catch { /* cmd missing */ }

    try {
      const cpuModel = (os.cpus()?.[0]?.model || '').trim();
      if (cpuModel.length) return cpuModel;
    } catch {}

    return 'unknown';
  }

  /* -------- network interfaces ------------------------------------------ */
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
  const tmpPng  = `/tmp/screen${id}.png`;      // raw capture
  const outFile = `/tmp/screen${id}.jpg`;      // final file we may send
  const wantW   = parseInt(req.query.maxw, 10);   // NaN if missing
  const wantQ   = parseInt(req.query.quality, 10); // NaN if missing

  try {
    if (id === '1')
      execSync(`DISPLAY=:0 scrot -a 0,0,${w1},${h1} -o ${tmpPng}`);
    else if (id === '2')
      execSync(`DISPLAY=:0 scrot -a ${w1},0,${w2},${h2} -o ${tmpPng}`);
    else
      return res.status(400).send('invalid id');
  } catch (e) {
    console.error(e);
    return res.status(500).send('screen grab failed');
  }

  const needResize  = !Number.isNaN(wantW);
  const needQuality = !Number.isNaN(wantQ);
  if (needResize || needQuality) {
    try {
      const resizeOpt  = needResize  ? ` -resize ${wantW}` : '';
      const qualityOpt = needQuality ? ` -quality ${wantQ}` : ' -quality 90';
      execSync(`convert ${tmpPng}${resizeOpt}${qualityOpt} ${outFile}`);
      res.type('jpeg').send(fs.readFileSync(outFile));
    } catch (e) {
      console.error('imagemagick convert failed', e);
      return res.status(500).send('image conversion failed');
    }
  } else {
    res.type('png').send(fs.readFileSync(tmpPng));
  }
});

/* 2 ─ raw JSON diagnostics ------------------------------------------------- */
app.get('/diagnostic', (req, res) => {
  res.json(getDiagnostics());
});

/* 3 ─ diagnostics UI ------------------------------------------------------- */
app.get('/diagnostic-ui', (req, res) => {
  const state  = loadState();                  // { hdmi1, hdmi2 }
  const screen = req.query.screen;             // "1" | "2" | undefined
  let target   = null;

  if (screen === '1')      target = state.hdmi1;
  else if (screen === '2') target = state.hdmi2;

  res.render('diagnostic-ui', {
    d:     getDiagnostics(),
    urls:  state,          // pass both HDMI URLs to EJS
    target,
    screen
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
app.get('/saved-urls', (req, res) => {
  res.json(loadState());
});

app.post('/saved-urls', (req, res) => {
  const { hdmi1, hdmi2 } = req.body || {};

  const okType = v => typeof v === 'string' || v === null || typeof v === 'undefined';
  if (!okType(hdmi1) || !okType(hdmi2))
    return res.status(400).send('hdmi1/hdmi2 must be string, null, or omitted');

  const state = loadState();

  if (typeof hdmi1 !== 'undefined') {
    state.hdmi1 = hdmi1;
    if (typeof hdmi1 === 'string' && hdmi1.length) redirectBrowser('1', hdmi1);
  }

  if (typeof hdmi2 !== 'undefined') {
    state.hdmi2 = hdmi2;
    if (typeof hdmi2 === 'string' && hdmi2.length) redirectBrowser('2', hdmi2);
  }

  saveState(state);
  res.json(state);
});

/* ───────────────────── optional registration helper ────────────────────── */
function ipv4Of(ifaceName = 'eth0') {
  const nicArr = os.networkInterfaces()[ifaceName];
  if (!nicArr) return null;
  for (const n of nicArr) {
    if (n.family === 'IPv4' && !n.internal) return n.address;
  }
  return null;
}

async function registerSelf() {
  try {
    const ip = ipv4Of('eth0');
    if (!ip) {
      console.error('[register] eth0 not found or no IPv4 - skipping');
      return;
    }

    const res = await fetch('http://10.1.220.203:7070/data', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ ip_eth0: ip })
    });

    if (!res.ok) {
      const txt = await res.text();
      console.error(`[register] server replied ${res.status}: ${txt}`);
    } else {
      console.log(`[register] announced ${ip} to File-SD`);
    }
  } catch (err) {
    console.error('[register] failed:', err.message || err);
  }
}

/* ──────────────────────────── start server ─────────────────────────────── */
app.listen(PORT, () => {
  console.log(`kiosk-server listening on ${PORT}`);

  const diagBase = `http://localhost:${PORT}/diagnostic-ui`;

  redirectBrowser('1', `${diagBase}?screen=1`);
  redirectBrowser('2', `${diagBase}?screen=2`);
  registerSelf();
});
