// server.js ─ BETSA kiosk helper with EJS diagnostics UI & redirect countdown
const express      = require('express');
const fs           = require('fs');
const { execSync, spawn } = require('child_process');
const os           = require('os');
const path         = require('path');

const PORT        = 8080;
const STATE_FILE  = '/home/pi/kiosk/urls.json';      // persistent store
const PROFILE_DIR = '/home/pi/kiosk';                // per-screen chrome data

// ── locate chromium binary ───────────────────────────────────────────────────
const BROWSER_BIN = (() => {
  for (const cmd of ['chromium-browser', 'chromium']) {
    try { execSync(`command -v ${cmd}`); return cmd; } catch {}
  }
  throw new Error('No chromium binary found – install "chromium"');
})();

// ── helpers ──────────────────────────────────────────────────────────────────
function readRes() {
  try {
    const xr = execSync('xrandr --current', { env:{ DISPLAY:':0' } }).toString();
    const m1 = xr.match(/HDMI-1 connected.*? (\d+)x(\d+)/);
    const m2 = xr.match(/HDMI-2 connected.*? (\d+)x(\d+)/);
    return {
      w1: m1 ? +m1[1] : 0, h1: m1 ? +m1[2] : 0,
      w2: m2 ? +m2[1] : 0, h2: m2 ? +m2[2] : 0,
    };
  } catch {
    return { w1:0, h1:0, w2:0, h2:0 };
  }
}

function spawnBrowser(id, url) {
  const { w1, h1, w2, h2 } = readRes();
  const profile = path.join(PROFILE_DIR, `chrome${id}`);
  try { execSync(`pkill -f -- "--user-data-dir=${profile}"`); } catch {}

  const pos  = id === '2' ? `${w1},0` : '0,0';
  const size = id === '2' ? `${w2},${h2}` : `${w1},${h1}`;
  const args = [
    '--kiosk', '--no-sandbox', '--test-type',
    '--noerrdialogs', '--disable-infobars',
    '--disable-session-crashed-bubble', '--start-fullscreen',
    `--app=${url}`,
    `--window-position=${pos}`, `--window-size=${size}`,
    `--user-data-dir=${profile}`
  ];

  const child = spawn(BROWSER_BIN, args, {
    env: { DISPLAY:':0' },
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
  } catch (e) {
    console.error('Could not write state file:', e);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function getDiagnostics() {
  // -------- device / platform model detection ------------------------------
  function detectDeviceModel() {
    // 1. Raspberry Pi (and most other ARM SBCs) expose a simple text file
    //    that already works in your current codebase.
    try {
      const piModel = fs.readFileSync('/proc/device-tree/model', 'utf8').trim();
      if (piModel.length) return piModel;
    } catch { /* not a Pi or file missing */ }

    // 2. Standard x86_64 / amd64 machines usually have DMI data.
    //    We look at product name + (optionally) version + vendor.
    const dmiBase = '/sys/devices/virtual/dmi/id';
    try {
      const product  = fs.readFileSync(path.join(dmiBase, 'product_name'  ), 'utf8').trim();
      const version  = fs.readFileSync(path.join(dmiBase, 'product_version'), 'utf8').trim();
      const vendor   = fs.readFileSync(path.join(dmiBase, 'sys_vendor'     ), 'utf8').trim();
      const parts = [vendor, product, version].filter(Boolean);
      if (parts.length) return parts.join(' ');
    } catch { /* DMI not available (rare in VMs / locked-down systems) */ }

    // 3. Fallback: ask `hostnamectl`, available on most modern Linux distros.
    try {
      const out = execSync('hostnamectl', { encoding: 'utf8' });
      const m = out.match(/Hardware Model:\s+(.+)/);
      if (m) return m[1].trim();
    } catch { /* command missing or no permission */ }

    // 4. Last resort – at least expose the CPU model so we never return "unknown".
    try {
      const cpuModel = (os.cpus()?.[0]?.model || '').trim();
      if (cpuModel.length) return cpuModel;
    } catch { /* extremely unlikely */ }

    return 'unknown';
  }

  // --------------------------------------------------------------------------
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
    arch: os.arch(),                 // e.g. armv7l, aarch64, x64
    deviceModel: detectDeviceModel(),// now never "unknown" on a properly configured box
    network: ifaces
  };
}


// ── express + views ─────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

/* 1 ─ screenshot endpoint (quality & max width) ───────────────────────────── */
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

/* 2 ─ raw JSON diagnostics ────────────────────────────────────────────────── */
app.get('/diagnostic', (req, res) => {
  res.json(getDiagnostics());
});

 
/* 3 ─ diagnostics UI with optional redirect target & saved URLs ──────────── */
app.get('/diagnostic-ui', (req, res) => {
  const state  = loadState();                  // { hdmi1, hdmi2 }
  const screen = req.query.screen;             // "1" | "2" | undefined
  let target   = null;

  if (screen === '1')      target = state.hdmi1;
  else if (screen === '2') target = state.hdmi2;

  res.render('diagnostic-ui', {
    d:   getDiagnostics(),
    urls: state,          // pass both HDMI URLs to EJS
    target,
    screen
  });
});


/* 4 ─ reboot endpoint ─────────────────────────────────────────────────────── */
app.post('/reboot', (req, res) => {
  res.send('Rebooting…');
  setTimeout(() => {
    spawn('sudo', ['reboot'], { stdio: 'ignore', detached: true }).unref();
  }, 100);
});

/* 5 ─ set-URL & persistence ───────────────────────────────────────────────── */
app.get('/set-url/:id', (req, res) => {
  const id  = req.params.id;
  const url = req.query.url;
  if (!url) return res.status(400).send('missing url');
  if (id !== '1' && id !== '2') return res.status(400).send('invalid id');

  spawnBrowser(id, url);

  const state = loadState();
  if (id === '1') state.hdmi1 = url; else state.hdmi2 = url;
  saveState(state);

  res.send('OK');
});
/* ── saved-urls: GET returns state, POST updates AND refreshes chromes ───── */
app.get('/saved-urls', (req, res) => {
  res.json(loadState());                       // { hdmi1, hdmi2 }
});

app.post('/saved-urls', (req, res) => {
  /* expected JSON: { "hdmi1": "<url-or-null>", "hdmi2": "<url-or-null>" } */
  const { hdmi1, hdmi2 } = req.body || {};

  // quick type guards
  const okType = v => typeof v === 'string' || v === null || typeof v === 'undefined';
  if (!okType(hdmi1) || !okType(hdmi2))
    return res.status(400).send('hdmi1/hdmi2 must be string, null, or omitted');

  const state = loadState();

  /* ── HDMI-1 ────────────────────────────────────────────────────────────── */
  if (typeof hdmi1 !== 'undefined') {
    state.hdmi1 = hdmi1;
    if (typeof hdmi1 === 'string' && hdmi1.length) {
      spawnBrowser('1', hdmi1);                // refresh screen 1
    }
    // if hdmi1 === null we leave screen 1 on whatever it was
    // (add a pkill here if you want to blank it)
  }

  /* ── HDMI-2 ────────────────────────────────────────────────────────────── */
  if (typeof hdmi2 !== 'undefined') {
    state.hdmi2 = hdmi2;
    if (typeof hdmi2 === 'string' && hdmi2.length) {
      spawnBrowser('2', hdmi2);                // refresh screen 2
    }
  }

  saveState(state);
  res.json(state);                             // echo back new state
});

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
    
    const ip = ipv4Of('eth0');          // returns null if eth0 missing / no IPv4
    if (!ip) {
      console.error('[register] eth0 not found or no IPv4 - skipping registration');
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
// ── GPU diagnostics ─────────────────────────────────────────────────────────
const PROFILE_BASE = PROFILE_DIR;                    // already /home/pi/kiosk

function getGpuInfo() {
  /**
   * Chromium writes hardware details into   <profile>/Local State
   * under the key "gpu_info_cache".  We read both screen profiles
   * (chrome1 and chrome2).  If one is missing we skip it.
   */
  function readOne(profile) {
    try {
      const raw = fs.readFileSync(
        path.join(PROFILE_BASE, profile, 'Local State'),
        'utf8'
      );
      const json = JSON.parse(raw).gpu_info_cache || {};
      // tiny helper to make the dashboard easier to read
      const summary = (() => {
        const basic = json.basic_info || {};
        return {
          gl_renderer    : basic.gl_renderer        || 'n/a',
          gl_vendor      : basic.gl_vendor          || 'n/a',
          gl_version     : basic.gl_version         || 'n/a',
          is_gpu_access  : basic.initialization_time_ms !== undefined,
          video_decode   : (json.feature_status || {}).video_decode || 'n/a',
          rasterization  : (json.feature_status || {}).rasterization || 'n/a',
        };
      })();
      return { full: json, summary };
    } catch (e) {
      return { error: e.message || String(e) };
    }
  }

  return {
    chrome1: readOne('chrome1'),   // HDMI-1 profile
    chrome2: readOne('chrome2'),   // HDMI-2 profile
  };
}

// ── /gpu-info endpoint ──────────────────────────────────────────────────────
app.get('/gpu-info', (req, res) => {
  res.json(getGpuInfo());
});

/* ── start server & always open diagnostics first ─────────────────────────── */
app.listen(PORT, () => {
  console.log(`kiosk-server listening on ${PORT}`);

  const diagBase = `http://localhost:${PORT}/diagnostic-ui`;

  // Always load diagnostics page first; it decides whether to redirect
  spawnBrowser('1', `${diagBase}?screen=1`);
  spawnBrowser('2', `${diagBase}?screen=2`);
  registerSelf();
});
