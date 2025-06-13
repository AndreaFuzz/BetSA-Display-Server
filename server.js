// server.js ─ BETSA kiosk helper
const express  = require('express');
const fs       = require('fs');
const { execSync, spawn } = require('child_process');

const PORT = 8080;
const BROWSER_BIN = (() => {
  for (const cmd of ['chromium-browser', 'chromium']) {
    try { execSync(`command -v ${cmd}`); return cmd; } catch {}
  }
  throw new Error('No chromium binary found – install "chromium"');
})();

// ── resolution helper ────────────────────────────────────────────────────────
function readRes() {
  try {
    const xr = execSync('xrandr --current', {env:{DISPLAY:':0'}}).toString();
    const m1 = xr.match(/HDMI-1 connected.*? (\d+)x(\d+)/);
    const m2 = xr.match(/HDMI-2 connected.*? (\d+)x(\d+)/);
    return {
      w1: m1 ? +m1[1] : 0, h1: m1 ? +m1[2] : 0,
      w2: m2 ? +m2[1] : 0, h2: m2 ? +m2[2] : 0,
    };
  } catch (e) { return {w1:0,h1:0,w2:0,h2:0}; }
}
let {w1,h1,w2,h2} = readRes();

const app = express();

// 1 ─ screenshot endpoint ────────────────────────────────────────────────────
app.get('/screenshot/:id', (req,res)=>{
  ({w1,h1,w2,h2} = readRes());                     // refresh each time
  const id   = req.params.id;
  const file = `/tmp/screen${id}.png`;
  try {
    if (id==='1')
      execSync(`DISPLAY=:0 scrot -a 0,0,${w1},${h1} -o ${file}`);
    else if(id==='2')
      execSync(`DISPLAY=:0 scrot -a ${w1},0,${w2},${h2} -o ${file}`);
    else return res.status(400).send('invalid id');
    res.type('png').send(fs.readFileSync(file));
  } catch(e){
    console.error(e); res.status(500).send('screen grab failed');
  }
});

// 2 ─ set-URL endpoint ───────────────────────────────────────────────────────
app.get('/set-url/:id', (req,res)=>{
  ({w1,h1,w2,h2} = readRes());
  const id  = req.params.id;
  const url = req.query.url;
  if(!url) return res.status(400).send('missing url');

  const profile = `/home/pi/kiosk/chrome${id}`;
  // kill any existing window for that profile
  try{ execSync(`pkill -f -- "--user-data-dir=${profile}"`); }catch{}

  const pos  = (id==='2') ? `${w1},0`          : '0,0';
  const size = (id==='2') ? `${w2},${h2}`      : `${w1},${h1}`;
  const args = [
    '--no-sandbox', '--disable-gpu', '--noerrdialogs', '--disable-infobars',
    '--disable-session-crashed-bubble', '--start-fullscreen',
    `--app=${url}`, `--window-position=${pos}`, `--window-size=${size}`,
    `--user-data-dir=${profile}`
  ];

  const child = spawn(BROWSER_BIN, args,
      {env:{DISPLAY:':0'}, detached:true, stdio:'ignore'});
  child.unref();
  child.on('error', err => console.error('spawn failed', err));

  console.log(`Screen ${id} -> ${url}`);
  res.send('OK');
});

app.listen(PORT, ()=> console.log(`kiosk-server listening on ${PORT}`));
