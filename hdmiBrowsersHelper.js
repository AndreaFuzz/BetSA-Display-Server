#!/usr/bin/env node
// hdmiBrowsersHelper.js (hotplug + non-blocking stop for betsa-browsers.service)
// - No extensions, no incognito
// - Background-friendly supervisor (don’t await start())
// - Reacts to HDMI plug/unplug via udevadm monitor
// - Includes stopBrowsersServiceNow() to stop betsa-browsers.service without blocking

"use strict";
const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");

// ---------------- tiny utils ----------------
function which(cmd) { try { return execSync(`command -v ${cmd}`).toString().trim(); } catch { return null; } }
function sh(cmd, opts = {}) { return execSync(cmd, { stdio: "inherit", ...opts }); }
function shOut(cmd) { try { return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString(); } catch { return ""; } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return `[${new Date().toISOString()}]`; }

function xIsReady(display) {
  // Returns true once xrandr can list at least one connected output
  try {
    const out = execSync(`DISPLAY=${display} xrandr --query`, { stdio: ["ignore", "pipe", "ignore"] }).toString();
    return / connected/.test(out);
  } catch {
    return false;
  }
}

// fire-and-forget stop of betsa-browsers.service (system + user scopes)
function stopBrowsersServiceNow(unit = "betsa-browsers.service") {
  try {
    // system scope
    const s1 = spawn("systemctl", ["stop", unit, "--no-block", "--no-ask-password"], {
      stdio: "ignore",
      detached: true
    });
    s1.unref();
  } catch { }
  try {
    // user scope (in case it was launched as a user service)
    const s2 = spawn("systemctl", ["--user", "stop", unit, "--no-block", "--no-ask-password"], {
      stdio: "ignore",
      detached: true
    });
    s2.unref();
  } catch { }

  // optional: nudge Chromium to exit faster, also detached
  try {
    const k = spawn("bash", ["-lc", "pkill -f ungoogled-chromium || pkill -f chromium || true"], {
      stdio: "ignore",
      detached: true
    });
    k.unref();
  } catch { }

  // log and return immediately
  console.log("[svc] sent non-blocking stop to", unit);
}

// ---------------- supervisor ----------------
class HdmiBrowserSupervisor {
  // Replace the entire constructor in class HdmiBrowserSupervisor
  constructor(opts = {}) {
    const desktopUser = opts.desktopUser || "admin";
    const display = opts.display || ":0";
    const home = opts.home || `/home/${desktopUser}`;
    const xauth = opts.xauthority || `${home}/.Xauthority`;
    const uidStr = shOut(`id -u ${desktopUser}`).trim();
    const uid = Number(uidStr || process.getuid());
    const xdg = opts.xdgRuntimeDir || `/run/user/${uid}`;
    const isRoot = process.getuid && process.getuid() === 0;

    const browser =
      opts.browserPath ||
      which("ungoogled-chromium") ||
      which("chromium") ||
      which("chromium-browser") ||
      "/usr/bin/chromium";

    const prof1 = opts.profile1 || `${home}/.config/single-profile-1`;
    const prof2 = opts.profile2 || `${home}/.config/single-profile-2`;

    const hdmi1Name = opts.hdmi1Name || "HDMI-1";
    const hdmi2Name = opts.hdmi2Name || "HDMI-2";

    const logDir = opts.logDir || `${home}/.local/share/hdmi-launcher`;
    fs.mkdirSync(logDir, { recursive: true });

    this.cfg = { desktopUser, display, home, xauth, uid, xdg, isRoot, browser, prof1, prof2, hdmi1Name, hdmi2Name, logDir };

    process.env.DISPLAY = display;
    process.env.XAUTHORITY = xauth;
    process.env.XDG_RUNTIME_DIR = xdg;

    this.children = [];
    this._running = false;
    this._stopping = false;
    this._hotplug = null;
    this._debounce = null;

    // Helpful boot log so we can see which binary got picked
    console.log(ts(), `[supervisor] using browser: ${browser}`);
  }


  ensureDbusSession() {
    if (!process.env.DBUS_SESSION_BUS_ADDRESS) {
      const addr = `unix:path=${this.cfg.xdg}/bus`;
      try { execSync("busctl --user status", { stdio: "ignore" }); }
      catch { spawn("dbus-daemon", ["--session", `--address=${addr}`, "--fork", "--nopidfile"], { stdio: "ignore" }); }
      process.env.DBUS_SESSION_BUS_ADDRESS = addr;
    }
  }

  applyXmodmap() {
    const map = "keycode 70 = NoSymbol\nkeycode 23 = NoSymbol\nkeycode 28 = NoSymbol\n";
    try {
      const child = spawn("/usr/bin/xmodmap", ["-"], { env: process.env, stdio: ["pipe", "ignore", "ignore"] });
      child.stdin.write(map); child.stdin.end();
    } catch { }
  }

  xrandrQuery() {
    const text = shOut(`DISPLAY=${this.cfg.display} xrandr --query`);
    const outputs = {};
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Za-z0-9-]+)\s+(connected|disconnected)\b(.*)$/);
      if (!m) continue;
      const name = m[1], status = m[2], rest = m[3] || "";
      let w, h, x, y;
      const g = rest.match(/(\d{2,5})x(\d{2,5})\+(\d{1,5})\+(\d{1,5})/);
      if (g) { w = +g[1]; h = +g[2]; x = +g[3]; y = +g[4]; }
      outputs[name] = { name, status, width: w, height: h, x, y };
    }
    return outputs;
  }

  layoutByPort() {
    const H1 = this.cfg.hdmi1Name;
    const H2 = this.cfg.hdmi2Name;

    try { sh(`DISPLAY=${this.cfg.display} xrandr --output ${H1} --auto --primary --pos 0x0`); } catch { }
    const q1 = this.xrandrQuery();
    const h1Up = q1[H1] && q1[H1].status === "connected" && Number.isFinite(q1[H1].width);

    try { sh(`DISPLAY=${this.cfg.display} xrandr --output ${H2} --auto ${h1Up ? `--right-of ${H1}` : ""}`); } catch { }

    const q2 = this.xrandrQuery();
    const mkWin = (o) => o && o.status === "connected" && [o.width, o.height, o.x, o.y].every(Number.isFinite)
      ? { pos: `${o.x},${o.y}`, size: `${o.width},${o.height}` } : null;

    return { win1: mkWin(q2[H1]), win2: mkWin(q2[H2]), debugQ: q2 };
  }

  killChromium() { try { sh(`pkill -f ${this.cfg.browser}`); } catch { } }

  cleanSingletonLocks(profileDir) {
    try {
      fs.mkdirSync(profileDir, { recursive: true });
      for (const p of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
        const f = path.join(profileDir, p);
        if (fs.existsSync(f)) fs.rmSync(f, { force: true });
      }
    } catch { }
  }

  // Replace launchChromium entirely
  launchChromium({ profileDir, debugPort, pos, size, tag }) {
    this.cleanSingletonLocks(profileDir);

    // Pi-friendly flags: EGL GL; consider disabling GPU only if EGL fails
    const args = [
      "--kiosk", "--start-fullscreen",
      "--disable-crashpad", "--no-first-run", "--no-default-browser-check",
      "--password-store=basic",
      "--use-gl=egl",
      // "--disable-gpu",                // uncomment only if EGL still fails on your image
      `--window-position=${pos}`, `--window-size=${size}`,
      `--user-data-dir=${profileDir}`, `--remote-debugging-port=${debugPort}`,
      "--enable-logging=stderr", "--v=1",
      "about:blank"
    ];

    if (this.cfg.isRoot && !args.includes("--no-sandbox")) args.unshift("--no-sandbox");

    const errLog = fs.createWriteStream(path.join(this.cfg.logDir, `chromium-${tag}.stderr.log`), { flags: "a" });
    const child = spawn(this.cfg.browser, args, { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", b => errLog.write(b));
    child.on("spawn", () => console.log(ts(), `Launched ${path.basename(this.cfg.browser)} on ${pos} size ${size} profile ${profileDir}`));
    child.on("exit", (code, sig) => {
      errLog.end(`\n---- EXIT ${new Date().toISOString()} code=${code} sig=${sig} ----\n`);
      console.log(ts(), `Chromium exited code=${code} sig=${sig} profile=${path.basename(profileDir)}`);
    });
    return child;
  }


  _startHotplugWatcher() {
    try {
      this._hotplug = spawn("udevadm", ["monitor", "--udev", "--subsystem-match=drm"], { stdio: ["ignore", "pipe", "pipe"] });
      const onBump = () => {
        if (this._debounce) return;
        this._debounce = setTimeout(() => {
          this._debounce = null;
          console.log(ts(), "[hotplug] DRM change detected -> re-layout & restart browsers");
          for (const k of this.children) { try { k.kill("SIGTERM"); } catch { } }
        }, 300);
      };
      this._hotplug.stdout.on("data", onBump);
      this._hotplug.stderr.on("data", onBump);
    } catch (e) {
      console.warn(ts(), "udevadm monitor not available; hotplug watcher disabled:", e.message);
    }
  }

  _stopHotplugWatcher() {
    if (this._hotplug) { try { this._hotplug.kill("SIGTERM"); } catch { } this._hotplug = null; }
    if (this._debounce) { clearTimeout(this._debounce); this._debounce = null; }
  }

 
async start() {
  if (this._running) return;
  this._running = true; this._stopping = false;

  if (!fs.existsSync(this.cfg.browser)) {
    console.error("Chromium not found. Set browserPath in options.");
    this._running = false;
    throw new Error("browser not found");
  }

  this.ensureDbusSession();
  this.applyXmodmap();

  // Wait until X is actually usable (prevents “failed to open display” fast-exit)
  for (let i = 0; i < 30; i++) {
    if (xIsReady(this.cfg.display)) break;
    console.log(ts(), "[supervisor] waiting for X to be ready…");
    await sleep(1000);
  }

  this._startHotplugWatcher();

  while (!this._stopping) {
    this.killChromium();
    await sleep(800);

    let win1=null, win2=null, lastQ={};
    for (let i=0;i<4;i++){
      const { win1:w1, win2:w2, debugQ } = this.layoutByPort();
      win1=w1; win2=w2; lastQ=debugQ;
      if (win1 || win2) break;
      await sleep(200);
    }
    if (!win1 && !win2) {
      console.log(ts(), "No usable geometry yet. xrandr dump:", JSON.stringify(lastQ, null, 2));
      await sleep(1500);
      continue;
    }

    this.children = [];
    if (win1) this.children.push(this.launchChromium({ profileDir: this.cfg.prof1, debugPort: 9222, pos: win1.pos, size: win1.size, tag: "hdmi1" }));
    else     console.log(ts(), "HDMI-1 not connected. Skipping browser 1.");
    if (win2) this.children.push(this.launchChromium({ profileDir: this.cfg.prof2, debugPort: 9223, pos: win2.pos, size: win2.size, tag: "hdmi2" }));
    else     console.log(ts(), "HDMI-2 not connected. Skipping browser 2.");

    if (this.children.length === 0) { await sleep(2500); continue; }

    await new Promise((resolve) => {
      let done=false;
      for (const c of this.children) c.once("exit", () => { if (!done){ done=true; resolve(); } });
    });

    if (this._stopping) break;
    fs.appendFileSync(path.join(this.cfg.home, "chromium-autostart.log"), `[ ${new Date().toString()} ] Chromium quit - restarting\n`);
    await sleep(800);
  }

  for (const k of this.children) { try { k.kill("SIGTERM"); } catch {} }
  this._stopHotplugWatcher();
  this.children = [];
  this._running = false;
}


  async stop() {
    this._stopping = true;
    this._stopHotplugWatcher();
    for (const k of this.children) { try { k.kill("SIGTERM"); } catch { } }
  }
}

// ------------- exports -------------
module.exports = {
  HdmiBrowserSupervisor,
  stopBrowsersServiceNow
};
