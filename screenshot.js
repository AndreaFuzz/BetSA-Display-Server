/* screenshot.js ─ screenshot helper (1⁄3 size, JPEG only) */
"use strict";

const fs          = require("fs");
const path        = require("path");
const { execSync } = require("child_process");
const sharp       = require("sharp");            // npm i sharp

/* ────────── helpers transplanted from server.js ────────── */

function readRes () {
  try {
    const out = execSync("xrandr", { encoding: "utf8" });
    const rx  = /^(HDMI-\d)\s+connected.*?(\d+)x(\d+)/gm;
    let m, map = {};
    while ((m = rx.exec(out)) !== null) map[m[1]] = { w: +m[2], h: +m[3] };
    const h1 = map["HDMI-1"] || { w: 1920, h: 1080 };
    const h2 = map["HDMI-2"] || { w: 1920, h: 1080 };
    return { w1: h1.w, h1: h1.h, w2: h2.w, h2: h2.h };
  } catch {
    console.error("readRes failed, defaulting 1920x1080 per screen");
    return { w1: 1920, h1: 1080, w2: 1920, h2: 1080 };
  }
}

function detectStack () {
  if (process.env.WAYLAND_DISPLAY && process.env.XDG_RUNTIME_DIR) return "wayland";

  try {
    const base = "/run/user";
    for (const uid of fs.readdirSync(base)) {
      const dir = path.join(base, uid);
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith("wayland-")) {
          process.env.XDG_RUNTIME_DIR = dir;
          process.env.WAYLAND_DISPLAY = name;
          console.log(`[autoenv] using ${dir}/${name}`);
          return "wayland";
        }
      }
    }
  } catch {/* fall through */ }

  try { execSync("ffmpeg -hide_banner -devices | grep -q kmsgrab"); return "kms"; }
  catch {/* fall through */ }

  return "unknown";
}

function wlGeom ({ x, y, w, h }) {
  return `${x},${y} ${w}x${h}`;
}

function findDrmCard () {
  try {
    for (const name of fs.readdirSync("/dev/dri")) {
      if (name.startsWith("card")) {
        const p = "/dev/dri/" + name;
        try { fs.accessSync(p, fs.constants.R_OK); return p; } catch {}
      }
    }
  } catch {}
  return null;
}

/* ────────── public API ────────── */

/**
 * Capture HDMI-1 or HDMI-2, down-scale to 1⁄3 width, return JPEG buffer.
 * @param  {"1"|"2"} id
 * @param  {number}  quality  JPEG quality 1-100 (default 70)
 * @return {Promise<{mime:string,buffer:Buffer}>}
 */
async function captureScreenshot (id, quality = 70) {
  const { w1, h1, w2, h2 } = readRes();
  const geom = id === "1" ? { x: 0,  y: 0,  w: w1, h: h1 }
             : id === "2" ? { x: w1, y: 0,  w: w2, h: h2 }
             : null;
  if (!geom) throw new Error("invalid id");

  const tmp   = `/tmp/screen${id}-${Date.now()}.png`;
  const stack = detectStack();
  let   cmd;

  /* 1 ─ Wayland via grim */
  if (stack === "wayland") {
    cmd = `grim -g "${wlGeom(geom)}" ${tmp}`;
    try { execSync(cmd, { stdio: "inherit" }); return await compress(tmp, quality); }
    catch (e) { console.warn("[capture] grim failed:", e.message); }
  }

  /* 2 ─ DRM kmsgrab */
  const drm = findDrmCard();
  if (drm) {
    cmd = `ffmpeg -hide_banner -loglevel error -f kmsgrab -device ${drm} `
        + `-i - -frames:v 1 `
        + `-vf "crop=${geom.w}:${geom.h}:${geom.x}:${geom.y}" -y ${tmp}`;
    try { execSync(cmd, { stdio: "inherit" }); return await compress(tmp, quality); }
    catch (e) { console.warn("[capture] kmsgrab failed:", e.message); }
  }

  /* 3 ─ X11 x11grab */
  cmd = `ffmpeg -hide_banner -loglevel error -f x11grab `
      + `-video_size ${geom.w}x${geom.h} -i :0.0+${geom.x},${geom.y} `
      + `-frames:v 1 -y ${tmp}`;
  execSync(cmd, { stdio: "inherit" });
  return await compress(tmp, quality);
}

/* ────────── internal: resize & encode ────────── */

async function compress (pngPath, quality) {
  try {
    const img  = sharp(pngPath);
    const meta = await img.metadata();
    const buf  = await img
      // two-thirds of the original width
      .resize({ width: Math.round(meta.width / 2) })
      .jpeg({ quality })
      .toBuffer();
    fs.unlink(pngPath, () => {});
    return { mime: "image/jpeg", buffer: buf };
  } catch (e) {
    console.warn("[compress] sharp failed, sending raw PNG:", e.message);
    const buf = fs.readFileSync(pngPath);
    fs.unlink(pngPath, () => {});
    return { mime: "image/png", buffer: buf };
  }
}

module.exports = { captureScreenshot };
