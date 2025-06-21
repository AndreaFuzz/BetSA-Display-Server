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
const STATE_FILE  = '/home/admin/kiosk/urls.json'; // persistent store for HDMI URLs

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
/* One resilient connection per screen ------------------------------------- */
class DevToolsController {
  constructor (screenId, port) {
    this.screenId   = screenId;
    this.port       = port;
    this.ws         = null;          // active WebSocket (or null)
    this.timer      = null;          // reconnect timer handle
    this.desiredUrl = null;          // last URL we were asked to show

    /* ── log-throttling helpers ── */
    this.errorShown = false;         // true after first “connect failed” or WS error
    this.backoff    = 2000;          // start at 2 s, doubles to reduce noise

    this.connect();                  // start immediately
  }

  /* Public - navigate (or queue) ----------------------------------------- */
  navigate (url) {
    this.desiredUrl = url;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendNavigate(url);
    } else {
      this.ensureConnection();
    }
  }

  /* Internal - open WS (gets new target each time!) ---------------------- */
  async connect () {
    try {
      const list = await fetchJson(this.port);
      const page = list.find(t => t.type === 'page');
      if (!page) throw new Error('no "page" target');

      this.ws = new WebSocket(page.webSocketDebuggerUrl);

      this.ws.on('open', () => {
        console.log(`[ws] screen ${this.screenId} connected`);
        this.errorShown = false;     // reset throttle after success
        this.backoff    = 2000;      // reset back-off
        if (this.desiredUrl) this.sendNavigate(this.desiredUrl);
      });

      this.ws.on('close', () => {
        if (!this.errorShown) console.warn(`[ws] screen ${this.screenId} closed`);
        this.errorShown = true;
        this.ws = null;
        this.scheduleReconnect();
      });

      this.ws.on('error', err => {
        if (!this.errorShown) console.warn(
          `[ws] screen ${this.screenId} error: ${err.message}`
        );
        this.errorShown = true;
        this.ws.close();             // triggers 'close' for unified handling
      });
    } catch (e) {
      if (!this.errorShown) console.warn(
        `[ws] screen ${this.screenId} connect failed: ${e.message}`
      );
      this.errorShown = true;
      this.scheduleReconnect();
    }
  }

  /* Helper - actually send Page.navigate --------------------------------- */
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

  /* Schedule reconnect with exponential back-off ------------------------- */
  scheduleReconnect (delay = this.backoff) {
    if (this.timer) return;          // already waiting
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);

    // next attempt waits twice as long, max 60 s
    this.backoff = Math.min(this.backoff * 2, 60000);
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
/* ---------- find a running Wayland socket even when we are root ---------- */
function detectStack () {
  // 1. Normal case: variables already present (started with sudo -E, etc.)
  if (process.env.WAYLAND_DISPLAY && process.env.XDG_RUNTIME_DIR)
    return 'wayland';

  // 2. We are root.  Look under /run/user/*/wayland-* and grab the first hit.
  //    This works because root can read every user's runtime dir.
  try {
    const base = '/run/user';
    for (const uid of fs.readdirSync(base)) {
      const dir = path.join(base, uid);
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith('wayland-')) {
          process.env.XDG_RUNTIME_DIR = dir;
          process.env.WAYLAND_DISPLAY = name;
          console.log(`[autoenv] using ${dir}/${name}`);
          return 'wayland';
        }
      }
    }
  } catch { /* fall through */ }

  // 3. As a last resort fall back to kmsgrab (root has CAP_SYS_ADMIN)
  try { execSync('ffmpeg -hide_banner -devices | grep -q kmsgrab'); return 'kms'; }
  catch {}

  return 'unknown';
}
 /* ───────────────────────── Screen-resolution helper ────────────────────── */
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

/* ─────────────── Wayland geometry helper (grim wants “x,y widthxheight”) ─ */
function wlGeom ({ x, y, w, h }) {
  return `${x},${y} ${w}x${h}`;
}

/* ───────────────────── Find a usable /dev/dri/cardX for kmsgrab ────────── */
function findDrmCard () {
  try {
    const dri = '/dev/dri';
    for (const name of fs.readdirSync(dri)) {
      if (name.startsWith('card')) {
        const p = path.join(dri, name);
        try { fs.accessSync(p, fs.constants.R_OK); return p; } catch {}
      }
    }
  } catch {}
  return null;          // none found or not readable
}

/* ────────────────────── Screenshot endpoint with fallbacks ─────────────── */
app.get('/screenshot/:id', (req, res) => {
  const id = req.params.id;
  const { w1, h1, w2, h2 } = readRes();

  const geom = id === '1'
    ? { x: 0,  y: 0,  w: w1, h: h1 }
    : id === '2'
    ? { x: w1, y: 0,  w: w2, h: h2 }
    : null;

  if (!geom) return res.status(400).send('invalid id');

  const tmp   = `/tmp/screen${id}-${Date.now()}.png`;
  const stack = detectStack();     // your existing helper
  let cmd;

/* -------- attempt 1: Wayland / grim ------------------------------------- */
  if (stack === 'wayland') {
    cmd = `grim -g "${wlGeom(geom)}" ${tmp}`;
    try { execSync(cmd, { stdio: 'inherit' }); return sendImage(); }
    catch (e) { console.warn('[capture] grim failed:', e.message); }
  }

/* -------- attempt 2: DRM / kmsgrab -------------------------------------- */
  const drm = findDrmCard();
  if (drm) {
    cmd = `ffmpeg -hide_banner -loglevel error -f kmsgrab -device ${drm} `
        + `-i - -frames:v 1 `
        + `-vf "crop=${geom.w}:${geom.h}:${geom.x}:${geom.y}" -y ${tmp}`;
    try { execSync(cmd, { stdio: 'inherit' }); return sendImage(); }
    catch (e) { console.warn('[capture] kmsgrab failed:', e.message); }
  } else {
    console.warn('[capture] no /dev/dri/cardX found, skipping kmsgrab');
  }

/* -------- attempt 3: X11 / x11grab -------------------------------------- */
  cmd = `ffmpeg -hide_banner -loglevel error -f x11grab `
      + `-video_size ${geom.w}x${geom.h} -i :0.0+${geom.x},${geom.y} `
      + `-frames:v 1 -y ${tmp}`;
  try { execSync(cmd, { stdio: 'inherit' }); return sendImage(); }
  catch (e) { console.error('[capture] x11grab failed:', e.message); }

  return res.status(500).send('capture failed');

/* ------------------------- helper: stream result ------------------------- */
 /* ------------------------- helper: stream result ------------------------- */
function sendImage () {
  const wantW = +req.query.maxw   || NaN;
  const wantQ = +req.query.quality || 90;

  let file   = tmp;        // what we’ll actually send
  let type   = 'png';      // MIME type
  let extra  = null;       // second file to delete (jpg)

  try {
    if (!Number.isNaN(wantW) || wantQ !== 90) {
      const jpg = tmp.replace(/\.png$/, '.jpg');
      execSync(
        `convert ${tmp}` +
        (!Number.isNaN(wantW) ? ` -resize ${wantW}` : '') +
        ` -quality ${wantQ} ${jpg}`
      );
      file  = jpg;
      extra = jpg;         // remember to delete it later
      type  = 'jpeg';
    }
  } catch (e) {
    console.warn('[capture] convert failed, falling back to PNG:', e.message);
  }

  // Stream the image to the client
  res.type(type);
  const stream = fs.createReadStream(file);
  stream.pipe(res);

  // When the response is done (or aborted) – delete temp files
  const cleanup = () => {
    fs.unlink(tmp,  () => {});      // original PNG
    if (extra) fs.unlink(extra, () => {});
  };
  res.once('finish', cleanup);
  res.once('close',  cleanup);
}

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

/** Return the first active, non-internal IPv4 interface (name + address). */
function detectPrimaryIPv4 () {
  for (const [name, nics] of Object.entries(os.networkInterfaces())) {
    for (const nic of nics) {
      if (nic.family === 'IPv4' && !nic.internal) {
        return { name, ip: nic.address };
      }
    }
  }
  return null;            // nothing suitable found
}

async function registerSelf () {
  const primary = detectPrimaryIPv4();
  if (!primary) {
    console.error('[register] no usable IPv4 interface - skipping');
    return;
  }

   
  try {
    const res = await fetch('http://10.1.220.203:7070/data', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ ip_eth0: primary.ip })
    });

    if (!res.ok) console.error(`[register] server responded ${res.status}`);
    else         console.log(`[register] announced ${primary.name} - ${primary.ip}`);
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
