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
    '--disable-gpu', '--noerrdialogs', '--disable-infobars',
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

function getDiagnostics() {
  const nets = os.networkInterfaces();
  const ifaces = [];
  for (const [name, arr] of Object.entries(nets)) {
    for (const nic of arr) {
      if (nic.family === 'IPv4' && !nic.internal) {
        ifaces.push({ iface: name, ip: nic.address, mac: nic.mac });
      }
    }
  }
  let model = 'unknown';
  try { model = fs.readFileSync('/proc/device-tree/model', 'utf8').trim(); } catch {}
  return {
    time: new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' }),
    hostname: os.hostname(),
    arch: os.arch(),
    deviceModel: model,
    network: ifaces
  };
}

// ── express + views ─────────────────────────────────────────────────────────
const app = express();
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
app.get('/saved-urls', (req, res) => {
  res.json(loadState());   // loadState() already returns {hdmi1, hdmi2}
});
/* ── start server & always open diagnostics first ─────────────────────────── */
app.listen(PORT, () => {
  console.log(`kiosk-server listening on ${PORT}`);

  const diagBase = `http://localhost:${PORT}/diagnostic-ui`;

  // Always load diagnostics page first; it decides whether to redirect
  spawnBrowser('1', `${diagBase}?screen=1`);
  spawnBrowser('2', `${diagBase}?screen=2`);
});
