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
 

 
/* ── locate the real Chromium binary ───────────────────────────────
   On Raspberry Pi OS the wrapper at /usr/bin/chromium-browser adds
   unwanted flags.  We therefore look for the underlying binary that
   sits in /usr/lib/chromium/chromium and fall back to the first
   executable “chromium” on $PATH if needed.                          */
function resolveBinary(cmd) {
  try { return execSync(`command -v ${cmd}`, { encoding: 'utf8' }).trim(); }
  catch { return null; }
}

const BROWSER_BIN = (() => {
  if (process.env.KIOSK_CHROME_BIN) return process.env.KIOSK_CHROME_BIN;

  const candidates = [
    '/usr/lib/chromium/chromium',   // Pi OS & Debian bookworm
    '/usr/bin/chromium',            // generic
    resolveBinary('chromium'),
    resolveBinary('chromium-browser')
  ].filter(Boolean);

  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  throw new Error('No Chromium binary found on this system');
})();
 
  

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
const DEVTOOLS_PORT = {               // any unused ports are fine
  '1': 9222,
  '2': 9223
};
 
const CHROME_GPU_ENV = {
  ...process.env,
  DISPLAY: ':0',

  /* safety: on Bookworm/RPiOS the GPU process occasionally fails to
     pick the correct DRI node unless these are cleared.               */
  LIBANGLE_DEFAULT_PLATFORM: undefined,
  ANGLE_DEFAULT_PLATFORM:    undefined
};
function spawnBrowser(id, url) {
  const port     = DEVTOOLS_PORT[id];
  const { w1, h1, w2, h2 } = readRes();
  const profile  = path.join(PROFILE_DIR, `chrome${id}`);

  /* kill any earlier instance that uses the same profile ------------ */
  try { execSync(`pkill -f -- "--user-data-dir=${profile}"`); } catch {}

  const pos  = id === '2' ? `${w1},0` : '0,0';
  const size = id === '2' ? `${w2},${h2}` : `${w1},${h1}`;

  const args = [
    '--kiosk',
    '--use-gl=egl',                 // EGL = native V3D on Pi 5
    '--enable-gpu-rasterization',
    '--ignore-gpu-blocklist',

    '--ozone-platform-hint=x11',    // keep using X11
    '--autoplay-policy=no-user-gesture-required',
    '--noerrdialogs', '--disable-infobars',
    '--disable-session-crashed-bubble',

    `--remote-debugging-port=${port}`,
    `--window-position=${pos}`, `--window-size=${size}`,
    `--app=${url}`,
    `--user-data-dir=${profile}`
  ];

  /* run as the “admin” desktop user so DRM nodes are accessible ----- */
  const child = spawn(
    'sudo',
    ['-Hu', 'admin', BROWSER_BIN, ...args],
    { env: CHROME_GPU_ENV, detached: true, stdio: 'ignore' }
  );

  child.unref();
  child.on('error', err => console.error('spawn failed', err));
  console.log(`Screen ${id} → ${url}  (uid=admin via sudo)`);
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

   

  res.render('diagnostic-ui', {
    d: getDiagnostics(),
     
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
async function devToolsOpen(port, pageUrl) {
  console.log(`[devToolsOpen] port=${port} url=${pageUrl}`);

  // 1. list existing targets
  const listUrl = `http://127.0.0.1:${port}/json/list`;
  console.log(`[devToolsOpen] GET ${listUrl}`);
  const pages = await fetch(listUrl).then(r => r.json());
  console.log(`[devToolsOpen] targets:\n${pages.map(p => `  • ${p.id} (${p.url})`).join('\n')}`);

  const page = pages.find(p => p.type === 'page');
  if (!page) throw new Error('no debuggable page found');

  // 2. connect WebSocket
  console.log(`[devToolsOpen] connecting WS ${page.webSocketDebuggerUrl}`);
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.on('open', () => {
      console.log('[devToolsOpen] WS open');
      let id = 0;
      const send = (method, params = {}) => {
        const msg = { id: ++id, method, params };
        console.log(`[devToolsOpen] → ${method}`, params);
        ws.send(JSON.stringify(msg));
      };

      send('Page.navigate',      { url: pageUrl });
      send('Page.bringToFront');

      setTimeout(() => { ws.close(); resolve(); }, 200);
    });
    ws.on('error', err => { console.error('[devToolsOpen] WS error', err); reject(err); });
  });

  console.log('[devToolsOpen] done');
}


app.get('/get-gpu', async (req, res) => {
  const screen = req.query.screen === '2' ? '2' : '1';
  const port   = DEVTOOLS_PORT[screen];
  console.log(`[get-gpu] request for screen ${screen} (port ${port})`);

  const t0 = Date.now();
  try {
    await devToolsOpen(port, 'chrome://gpu');
    const dt = Date.now() - t0;
    console.log(`[get-gpu] SUCCESS in ${dt} ms`);
    res.send(`chrome://gpu opened on screen ${screen}`);
  } catch (e) {
    const dt = Date.now() - t0;
    console.error(`[get-gpu] FAILED after ${dt} ms:`, e.message);
    res.status(500).send(`DevTools error: ${e.message}`);
  }
});

/* ── GPU trouble-shooting endpoint ──────────────────────────────────────── *
 * GET /gpu-auto-check
 *  ‣ runs a short headless Chromium session as “admin”
 *  ‣ captures chrome_debug.log + basic permission info
 *  ‣ replies with a plain-text bundle you can paste into chat / issues
 * ------------------------------------------------------------------------ */
/* ---- GPU trouble-shooting endpoint ------------------------------------ */
/* ---- GPU trouble-shooting endpoint ------------------------------------ */
app.get('/gpu-auto-check', async (req, res) => {
  const adminHome = '/home/admin';
  const chromeLog = path.join(adminHome, '.config', 'chromium', 'chrome_debug.log');

  try {
    /* stop kiosk instances so the log is ours alone */
    try { execSync('pkill -f -- "--user-data-dir=/home/pi/kiosk"'); } catch {}
    try { fs.unlinkSync(chromeLog); } catch {}

    /* throw-away Chromium (≈8 s) */
    const probe = spawn(
      'sudo',
      [
        '-E', '-Hu', 'admin', BROWSER_BIN, 'about:blank',
        '--use-gl=egl', '--use-angle=gl',
        '--disable-features=Vulkan',
        '--enable-gpu-rasterization',
        '--ignore-gpu-blocklist',
        '--ozone-platform-hint=auto',
        '--enable-logging', '--v=1'
      ],
      { env: CHROME_EGL_ENV }
    );

    await new Promise(r => setTimeout(r, 8000));
    probe.kill('SIGINT');

    /* collect data ------------------------------------------------------ */
    const readFirstErr = () => {
      try {
        const line = fs.readFileSync(chromeLog, 'utf8')
                       .split('\n')
                       .find(l => /ERROR|Failed|denied|DRM|GPU/i.test(l));
        return line || '-- no error line found --';
      } catch {
        return '-- chrome_debug.log not found --';
      }
    };

    const safeExec = cmd => {
      try { return execSync(cmd, { encoding: 'utf8' }).trim(); }
      catch { return '(not present)'; }
    };

    const payload = [
      '=== GPU auto-check =============================================',
      '',
      'First error line:',
      readFirstErr(),
      '',
      'id admin :',          safeExec('id admin'),
      'userns knob :',       safeExec('sysctl -n kernel.unprivileged_userns_clone'),
      'DRI perms  :\n' +     safeExec('ls -l /dev/dri/{card0,renderD128}'),
      '',
      '--- head of chrome_debug.log -----------------------------------',
      (() => {
        try { return fs.readFileSync(chromeLog, 'utf8')
                       .split('\n').slice(0, 200).join('\n'); }
        catch { return '(log missing)'; }
      })(),
      '===============================================================',
    ].join('\n');

    res.type('text/plain').send(payload);

  } catch (e) {
    console.error('[gpu-auto-check] fatal:', e);
    res.status(500).send('gpu-auto-check fatal: ' + e.message);
  }
});
 

/* ──────────────────────────────────────────────────────────────── */
/* GPU-SYSTEM SNAPSHOT                                             */
/*  →   http://<pi>:8080/gpu-sys                                  */
/* ----------------------------------------------------------------
   Runs a few root-side shell probes and a short GL test *as the
   non-privileged “admin” user* so you can see–at a glance–whether
   the VC4/V3D driver, device nodes, groups and Mesa stack are OK. */
app.get('/gpu-sys', (req, res) => {
  const sh = cmd => {
    try { return execSync(cmd, { encoding: 'utf8', maxBuffer: 5e6 }).trim(); }
    catch (e) { return (e.stderr || e.message || '(failed)').toString().trim(); }
  };

  const report = [
    '=== gpu-sys ====================================================',
    `time         : ${new Date().toISOString()}`,
    '',
    '# device nodes -------------------------------------------------',
    sh('ls -l /dev/dri'),
    '',
    '# kernel modules ----------------------------------------------',
    sh('lsmod | grep -E "vc4|v3d" || echo "(vc4/v3d not loaded)"'),
    '',
    '# id admin / group check --------------------------------------',
    sh('id admin'),
    '',
    '# dmesg (last 40 drm lines) -----------------------------------',
    sh('dmesg | grep -i drm | tail -n 40') || '(no drm messages)',
    '',
    '# GL renderer (glxinfo -B) as admin ---------------------------',
    sh('sudo -Hu admin bash -c "glxinfo -B 2>/dev/null | head -n 20"') ||
      '(glxinfo missing – sudo apt install mesa-utils)',
    '===============================================================\n'
  ].join('\n');

  res.type('text/plain').send(report);
});

/* ============================================================= */
/*  CHROME GPU SUMMARY (ROBUST VERSION)                           */
/*    • http://<pi>:8080/chrome-gpu?screen=1|2                    */
/*    • prints renderer, ANGLE backend and feature flags          */
/* ============================================================= */
app.get('/chrome-gpu', async (req, res) => {
  const screen = req.query.screen === '2' ? '2' : '1';
  const port   = DEVTOOLS_PORT[screen] || 9222;

  try {
    // 1) fetch WS endpoint
    const info = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json());
    if (!info.webSocketDebuggerUrl) throw new Error('DevTools WS URL missing');
    const wsUrl = info.webSocketDebuggerUrl;

    // 2) talk WebSocket
    const gpu = await new Promise((ok, fail) => {
      const ws = new WebSocket(wsUrl);
      let id = 0;
      ws.on('open', () =>
        ws.send(JSON.stringify({ id: ++id, method: 'SystemInfo.getInfo' }))
      );
      ws.on('message', m => {
        const msg = JSON.parse(m);
        if (msg.id === id) { ws.close(); ok(msg.result.gpu); }
      });
      ws.on('error', fail);
    });

    if (!gpu) throw new Error('`gpu` field absent in reply');

    /* ---------- pretty-print ---------- */
    const dev     = gpu.devices?.map(d => d.deviceString).join(' | ') || '(n/a)';
    const backend = gpu.auxAttributes?.gl_renderer || '(n/a)';
    const driver  = gpu.auxAttributes?.driver_version || '(n/a)';

    const featObj = gpu.featureStatus || gpu.gpuFeatureStatus || {};
    const featLines = Object.entries(featObj)
      .map(([k,v]) => {
        // v may be string ("enabled") or object {enabled:true}
        const isEnabled =
          typeof v === 'string' ? v :
          typeof v === 'object' ? (v.enabled ?? v.status) : v;
        return `  ${k.padEnd(24)} : ${isEnabled}`;
      })
      .join('\n') || '  (no feature list returned)';

    const out = [
      `=== chrome-gpu (screen ${screen}) ===========================`,
      `Renderer       : ${backend}`,
      `Driver version : ${driver}`,
      `Devices        : ${dev}`,
      '',
      'GPU feature status:',
      featLines,
      '============================================================\n'
    ].join('\n');

    res.type('text/plain').send(out);

  } catch (e) {
    res.status(500).send('chrome-gpu error: ' + e.message);
  }
});

/* ============================================================= */
/*  RAW GPU JSON (debug helper)                                   */
/*    • http://<pi>:8080/chrome-gpu-raw?screen=1|2                */
/* ============================================================= */
app.get('/chrome-gpu-raw', async (req, res) => {
  const screen = req.query.screen === '2' ? '2' : '1';
  const port   = DEVTOOLS_PORT[screen] || 9222;

  try {
    const v  = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json());
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    let id = 0;
    ws.on('open',   () => ws.send(JSON.stringify({ id: ++id, method: 'SystemInfo.getInfo' })));
    ws.on('message',(m)=>{ const msg=JSON.parse(m); if(msg.id===id){ ws.close(); res.json(msg); }});
    ws.on('error',  err => res.status(500).send('WS error: '+err.message));
  } catch (e) {
    res.status(500).send('chrome-gpu-raw error: '+e.message);
  }
});


/* ──────────────────────────────────────────────────────────────── */
/* HEADLESS HARD-WEBGL SELF-TEST                                   */
/*  →   http://<pi>:8080/webgl-selftest                            */
/* ----------------------------------------------------------------
   Spawns a *throw-away* headless Chromium session (as admin) that
   loads a minimal WebGL 1 context and prints whether creation
   succeeded and which renderer ANGLE picked.  Takes ≈ 5 s.        */
app.get('/webgl-selftest', async (req, res) => {
  const tmpProf = '/tmp/chrome-test-profile';
  const jsPath  = '/tmp/webgl-test.js';

  fs.writeFileSync(jsPath, `
    const gl = document.createElement('canvas').getContext('webgl');
    console.log('GL_SUCCESS',
                !!gl,
                gl && gl.getParameter(gl.RENDERER),
                gl && gl.getParameter(gl.VERSION));
  `);

  const child = spawn(
    'sudo',
    [
      '-E', '-Hu', 'admin', BROWSER_BIN,
      '--headless',
      '--disable-gpu-compositing',
      '--use-gl=egl',
      '--use-angle=gl',
      '--disable-features=Vulkan',
      '--enable-gpu-rasterization',
      '--ignore-gpu-blocklist',
      '--window-size=64,64',
      `--user-data-dir=${tmpProf}`,
      `--app=file://${jsPath}`
    ],
    { env: CHROME_EGL_ENV, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let stdout = '', stderr = '';
  child.stdout.on('data', d => stdout += d.toString());
  child.stderr.on('data', d => stderr += d.toString());

  const done = await new Promise(r => child.on('close', r));

  res.type('text/plain').send([
    '=== webgl-selftest ============================================',
    `exitCode      : ${done}`,
    '',
    '--- stdout ----------------------------------------------------',
    stdout || '(none)',
    '--- stderr ----------------------------------------------------',
    stderr || '(none)',
    '===============================================================\n'
  ].join('\n'));
});



/* ── START SERVER ───────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`kiosk-server listening on ${PORT}`);
  const diagBase = `http://localhost:${PORT}/diagnostic-ui`;
  spawnBrowser('1', `${diagBase}?screen=1`);
  spawnBrowser('2', `${diagBase}?screen=2`);
  registerSelf();
});
