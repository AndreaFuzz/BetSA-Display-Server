// server.js — BETSA kiosk helper with EJS diagnostics UI & redirect countdown
// ----------------------------------------------------------------------------
const express = require('express');
const fs = require('fs');
const { execSync, spawn, spawnSync } = require('child_process');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
// lightweight fetch in CommonJS
const fetch = (...a) => import('node-fetch').then(m => m.default(...a));

const PORT = 8080;
const STATE_FILE = '/home/pi/kiosk/urls.json';
const PROFILE_DIR = '/home/pi/kiosk';
const DEVTOOLS_TIMEOUT = 8000;

 
function resolveBinary(cmd) {
  try {
    // command -v prints the full path; trim() removes the newline
    return execSync(`command -v ${cmd}`, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const BROWSER_BIN = (() => {
  // honour manual override
  if (process.env.KIOSK_CHROME_BIN) return process.env.KIOSK_CHROME_BIN;

  //  common absolute paths first (no PATH lookup needed later)
  const fixed = [
    '/usr/lib/chromium-browser/chromium-browser', // Pi OS, old Ubuntu
    '/usr/lib/chromium/chromium',                 // Debian/Ubuntu
    '/usr/bin/chromium-browser',                  // newer Ubuntu
    '/usr/bin/chromium',
    '/snap/bin/chromium'                          // Snap package
  ];
  for (const p of fixed) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }

  // fall back to whatever “command -v” can find
  return (
    resolveBinary('chromium-browser') ||
    resolveBinary('chromium')         ||
    resolveBinary('google-chrome')    ||   // if you ever swap to Chrome
    (() => { throw new Error('No chromium binary found'); })()
  );
})();

/* ─────────────────────────  GPU-PROBE HELPERS  ─────────────────────────── */
async function devToolsProbe() {
  const probeDir = require('fs').mkdtempSync('/tmp/chrome-gpu-');

  const chromeArgs = [
  // DevTools on a random port
  '--remote-debugging-port=0',

  // allow root without sandbox *and* keep GPU enabled
  '--no-sandbox',
  '--test-type',

  // suppress first-run noise
  '--no-first-run',
  '--noerrdialogs',

  // throw-away profile
  '--user-data-dir=' + probeDir,

  // make ANGLE talk to V3D
  '--enable-gpu-rasterization',
  '--use-angle=gles',
  '--use-gl=egl',
  '--disable-software-rasterizer',

  // minimal UI window (not headless)
  '--app=about:blank'
];

const chrome = spawn(
  BROWSER_BIN,
  chromeArgs,
  { stdio: ['ignore', 'pipe', 'pipe'], env: { DISPLAY: ':0' } }
);



  try {
    // 2 . catch “DevTools listening on ws://…”
    const wsUrl = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Chrome timeout')), DEVTOOLS_TIMEOUT);
      const scan = chunk => {
        const m = chunk.toString().match(/DevTools listening on (ws:\/\/.*)/);
        if (m) { clearTimeout(t); resolve(m[1].trim()); }
      };
      chrome.stdout.on('data', scan);
      chrome.stderr.on('data', scan);
    });

    // 3 . ask SystemInfo.getInfo over the socket
    const raw = await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const t  = setTimeout(() => { ws.close(); reject(new Error('DevTools timeout')); },
                            DEVTOOLS_TIMEOUT);

      ws.on('open', () =>
        ws.send(JSON.stringify({ id: 1, method: 'SystemInfo.getInfo' }))
      );

      ws.on('message', data => {
        const msg = JSON.parse(data);
        if (msg.id === 1) { clearTimeout(t); ws.close(); resolve(msg.result); }
      });

      ws.on('error', err => { clearTimeout(t); reject(err); });
    });

    return raw; // full DevTools payload (same data chrome://gpu shows)
  } finally {
    // 4 . clean up regardless of success/failure
    try { chrome.kill('SIGTERM'); } catch {}
    try { require('fs').rmSync(probeDir, { recursive: true, force: true }); } catch {}
  }
}


function summariseGpu(info) {
  const f = (info.gpu && info.gpu.featureStatus) || {};
  return {
    videoDecode: f.videoDecode || 'unknown',
    rasterization: f.rasterization || 'unknown',
    gpuEnabled: /hardware|enabled/i.test(f.videoDecode) ||
                /hardware|enabled/i.test(f.rasterization)
  };
}
/* ───────────────────────────────────────────────────────────────────────── */

/* ── UTILITY HELPERS  (unchanged from your original) ─────────────────────── */
function readRes() {
  try {
    const xr = execSync('xrandr --current', { env: { DISPLAY: ':0' } }).toString();
    const m1 = xr.match(/HDMI-1 connected.*? (\d+)x(\d+)/);
    const m2 = xr.match(/HDMI-2 connected.*? (\d+)x(\d+)/);
    return {
      w1: m1 ? +m1[1] : 0, h1: m1 ? +m1[2] : 0,
      w2: m2 ? +m2[1] : 0, h2: m2 ? +m2[2] : 0
    };
  } catch { return { w1: 0, h1: 0, w2: 0, h2: 0 }; }
}

function spawnBrowser(id, url) {
  const { w1, h1, w2, h2 } = readRes();
  const profile = path.join(PROFILE_DIR, `chrome${id}`);
  try { execSync(`pkill -f -- "--user-data-dir=${profile}"`); } catch { }

  const pos  = id === '2' ? `${w1},0` : '0,0';
  const size = id === '2' ? `${w2},${h2}` : `${w1},${h1}`;
  const args = [
    '--kiosk',
    '--use-gl=egl',
    '--enable-gpu-rasterization',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox','--test-type',
    '--noerrdialogs', '--disable-infobars',
    '--disable-session-crashed-bubble',
    `--app=${url}`,
    `--window-position=${pos}`, `--window-size=${size}`,
    `--user-data-dir=${profile}`
  ];
   

  const child = spawn(BROWSER_BIN, args, {
    env: { DISPLAY: ':0' },
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  child.on('error', err => console.error('spawn failed', err));
  console.log(`Screen ${id} -> ${url}`);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { hdmi1: null, hdmi2: null }; }
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) { console.error('Could not write state file:', e); }
}

function getDiagnostics() {
  function detectDeviceModel() {
    try {
      const piModel = fs.readFileSync('/proc/device-tree/model', 'utf8').trim();
      if (piModel.length) return piModel;
    } catch { }
    const dmi = '/sys/devices/virtual/dmi/id';
    try {
      const prod = fs.readFileSync(path.join(dmi, 'product_name'), 'utf8').trim();
      const ver = fs.readFileSync(path.join(dmi, 'product_version'), 'utf8').trim();
      const ven = fs.readFileSync(path.join(dmi, 'sys_vendor'), 'utf8').trim();
      const parts = [ven, prod, ver].filter(Boolean);
      if (parts.length) return parts.join(' ');
    } catch { }
    try {
      const out = execSync('hostnamectl', { encoding: 'utf8' });
      const m = out.match(/Hardware Model:\s+(.+)/);
      if (m) return m[1].trim();
    } catch { }
    try {
      const cpu = (os.cpus()?.[0]?.model || '').trim();
      if (cpu.length) return cpu;
    } catch { }
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

function ipv4Of(iface = 'eth0') {
  const nicArr = os.networkInterfaces()[iface];
  if (!nicArr) return null;
  for (const n of nicArr) if (n.family === 'IPv4' && !n.internal) return n.address;
  return null;
}

async function registerSelf() {
  try {
    const ip = ipv4Of('eth0');
    if (!ip) return console.error('[register] eth0 missing/no IPv4');
    await fetch('http://10.1.220.203:7070/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip_eth0: ip })
    });
    console.log(`[register] announced ${ip} to File-SD`);
  } catch (e) {
    console.error('[register] failed:', e.message);
  }
}

/* ── EXPRESS SETUP & ROUTES ─────────────────────────────────────────────── */
const app = express();
app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

/* 1 screenshot endpoint --------------------------------------------------- */
app.get('/screenshot/:id', (req, res) => {
  const { w1, h1, w2, h2 } = readRes();
  const id = req.params.id;
  const tmp = `/tmp/screen${id}.png`;
  const out = `/tmp/screen${id}.jpg`;
  const wantW = parseInt(req.query.maxw, 10);
  const wantQ = parseInt(req.query.quality, 10);

  try {
    if (id === '1') execSync(`DISPLAY=:0 scrot -a 0,0,${w1},${h1} -o ${tmp}`);
    else if (id === '2') execSync(`DISPLAY=:0 scrot -a ${w1},0,${w2},${h2} -o ${tmp}`);
    else return res.status(400).send('invalid id');
  } catch (e) {
    console.error(e); return res.status(500).send('screen grab failed');
  }

  const needResize = !Number.isNaN(wantW);
  const needQuality = !Number.isNaN(wantQ);
  if (needResize || needQuality) {
    try {
      const resizeOpt = needResize ? ` -resize ${wantW}` : '';
      const qualityOpt = needQuality ? ` -quality ${wantQ}` : ' -quality 90';
      execSync(`convert ${tmp}${resizeOpt}${qualityOpt} ${out}`);
      res.type('jpeg').send(fs.readFileSync(out));
    } catch (e) {
      console.error('convert failed', e);
      return res.status(500).send('image conversion failed');
    }
  } else {
    res.type('png').send(fs.readFileSync(tmp));
  }
});

/* 2 simple diagnostics ---------------------------------------------------- */
app.get('/diagnostic', (req, res) => {
   res.json(getDiagnostics());
});

/* 3 diagnostics UI (adds GPU summary) ------------------------------------- */
app.get('/diagnostic-ui', async (req, res) => {
  const state = loadState();
  const screen = req.query.screen;
  const target = screen === '1' ? state.hdmi1
    : screen === '2' ? state.hdmi2 : null;

  let gpu = null;
  try { gpu = summariseGpu(await devToolsProbe()); }
  catch (e) { console.error('[gpu probe] failed:', e.message); }

  res.render('diagnostic-ui', {
    d: getDiagnostics(),
    gpu: gpu,
    urls: state,
    target, screen
  });
});

/* 4 reboot --------------------------------------------------------------- */
app.post('/reboot', (req, res) => {
  res.send('Rebooting…');
  setTimeout(() => {
    spawn('sudo', ['reboot'], { stdio: 'ignore', detached: true }).unref();
  }, 100);
});

/* 5 URL management -------------------------------------------------------- */
app.get('/set-url/:id', (req, res) => {
  const id = req.params.id; const url = req.query.url;
  if (!url) return res.status(400).send('missing url');
  if (id !== '1' && id !== '2') return res.status(400).send('invalid id');

  spawnBrowser(id, url);
  const state = loadState(); if (id === '1') state.hdmi1 = url; else state.hdmi2 = url;
  saveState(state); res.send('OK');
});
app.get('/saved-urls', (req, res) => { res.json(loadState()); });
app.post('/saved-urls', (req, res) => {
  const { hdmi1, hdmi2 } = req.body || {};
  const ok = v => typeof v === 'string' || v === null || typeof v === 'undefined';
  if (!ok(hdmi1) || !ok(hdmi2)) return res.status(400).send('hdmi1/hdmi2 bad');

  const state = loadState();
  if (typeof hdmi1 !== 'undefined') {
    state.hdmi1 = hdmi1;
    if (typeof hdmi1 === 'string' && hdmi1.length) {
      spawnBrowser('1', hdmi1);                // refresh screen 1
    }
  }
  if (typeof hdmi2 !== 'undefined') {
    state.hdmi2 = hdmi2;
    if (typeof hdmi2 === 'string' && hdmi2.length) {
      spawnBrowser('2', hdmi2);                // refresh screen 2
    }
  }
  saveState(state); 
  res.json(state);
});

/* 6 GPU info API ---------------------------------------------------------- */
app.get('/gpu-info', async (req, res) => {
  try {
    const raw = await devToolsProbe();
    res.json({ summary: summariseGpu(raw), raw });
  } catch (err) {
    console.error('[gpu-info] probe failed:', err.message);
    try { spawnSync('pkill', ['-f', 'chrome-gpu-probe']); } catch { }
    res.status(500).json({ error: err.message });
  }
});

/* ── START SERVER ───────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`kiosk-server listening on ${PORT}`);
  const diagBase = `http://localhost:${PORT}/diagnostic-ui`;
  spawnBrowser('1', `${diagBase}?screen=1`);
  spawnBrowser('2', `${diagBase}?screen=2`);
  registerSelf();
});
