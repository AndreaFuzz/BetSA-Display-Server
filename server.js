const express = require('express');
const fs = require('fs');
const { execSync, spawn } = require('child_process');

const PORT = 8080;

// ----------------------------------------------------------------------------
// ── resolution helper (reads xrandr) ─────────────────────────────────────────
let width1 = 0, height1 = 0, width2 = 0, height2 = 0;
try {
  const xr = execSync('xrandr').toString();
  const m1 = xr.match(/HDMI-1 connected.*?(\d+x\d+)/);
  const m2 = xr.match(/HDMI-2 connected.*?(\d+x\d+)/);
  if (m1) [width1, height1] = m1[1].split('x').map(Number);
  if (m2) [width2, height2] = m2[1].split('x').map(Number);
} catch (e) { console.error('xrandr parse failed', e); }
// ----------------------------------------------------------------------------

const app = express();

// 1 Screenshot endpoint ------------------------------------------------------
app.get('/screenshot/:id', (req, res) => {
  const id = req.params.id;
  const file = `/tmp/screen${id}.png`;
  try {
    if (id === '1')
      execSync(`DISPLAY=:0 scrot -a 0,0,${width1},${height1} -o ${file}`);
    else if (id === '2')
      execSync(`DISPLAY=:0 scrot -a ${width1},0,${width2},${height2} -o ${file}`);
    else return res.status(400).send('invalid id');
    res.type('png').send(fs.readFileSync(file));
  } catch (e) {
    console.error(e);
    res.status(500).send('screen grab failed');
  }
});

// 2 Set-URL endpoint ---------------------------------------------------------
app.get('/set-url/:id', (req, res) => {
  const id = req.params.id;
  const url = req.query.url;
  if (!url) return res.status(400).send('missing url');
  const profile = `/home/pi/kiosk/chrome${id}`;
  try { execSync(`pkill -f "--user-data-dir=${profile}" || true`); } catch {}
  const pos  = (id === '2') ? `${width1},0` : '0,0';
  const size = (id === '2') ? `${width2},${height2}` : `${width1},${height1}`;
  const args = [
    '--noerrdialogs','--disable-infobars','--disable-session-crashed-bubble',
    '--disable-gpu','--start-fullscreen',`--app=${url}`,
    `--window-position=${pos}`,`--window-size=${size}`,
    `--user-data-dir=${profile}`
  ];
  spawn('chromium-browser', args,
        { env:{DISPLAY:':0'}, detached:true, stdio:'ignore' }).unref();
  console.log(`Screen ${id} -> ${url}`);
  res.send(`OK`);
});

app.listen(PORT, () => console.log(`kiosk-server listening on ${PORT}`));
