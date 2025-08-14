/* screenshot.js - screenshot helper (1/2 size, JPEG preferred with safe fallbacks) */
"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// scale divisor to match current behavior (your old code effectively used 1/2)
const SCALE_DIVISOR = 2;

/* ---------- helpers transplanted from server.js ---------- */

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

  try {
    execSync("ffmpeg -hide_banner -devices | grep -q kmsgrab");
    return "kms";
  } catch {/* fall through */ }

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

function safeUnlink(p) { try { fs.unlinkSync(p); } catch {} }

/* ---------- public API ---------- */

/**
 * Capture HDMI-1 or HDMI-2, down-scale to 1/2 width, return JPEG buffer if possible.
 * Falls back to PNG if needed.
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

  const tmpPng = `/tmp/screen${id}-${Date.now()}.png`;
  let cmd;
  const stack = detectStack();

  // 1 - Wayland via grim
  if (stack === "wayland") {
    cmd = `grim -g "${wlGeom(geom)}" ${tmpPng}`;
    try {
      execSync(cmd, { stdio: "inherit" });
      return await compress(tmpPng, quality);
    } catch (e) {
      console.warn("[capture] grim failed:", e.message);
    }
  }

  // 2 - DRM kmsgrab
  const drm = findDrmCard();
  if (drm) {
    cmd = `ffmpeg -hide_banner -loglevel error -f kmsgrab -device ${drm} `
        + `-i - -frames:v 1 `
        + `-vf "crop=${geom.w}:${geom.h}:${geom.x}:${geom.y}" -y ${tmpPng}`;
    try {
      execSync(cmd, { stdio: "inherit" });
      return await compress(tmpPng, quality);
    } catch (e) {
      console.warn("[capture] kmsgrab failed:", e.message);
    }
  }

  // 3 - X11 x11grab
  cmd = `ffmpeg -hide_banner -loglevel error -f x11grab `
      + `-video_size ${geom.w}x${geom.h} -i :0.0+${geom.x},${geom.y} `
      + `-frames:v 1 -y ${tmpPng}`;
  execSync(cmd, { stdio: "inherit" });
  return await compress(tmpPng, quality);
}

/* ---------- internal: resize & encode ---------- */

// Lazy-load sharp exactly when needed, never at module top-level
let _sharpTried = false;
let _sharp = null;
function tryLoadSharp() {
  if (_sharpTried) return _sharp;
  _sharpTried = true;
  try {
    _sharp = require("sharp");
  } catch (e) {
    console.warn("[compress] sharp not available; will use ffmpeg fallback:", e.message);
    _sharp = null;
  }
  return _sharp;
}

function mapJpegQualityToFfmpegQ(quality) {
  // sharp uses 1..100 (higher = better). ffmpeg -q:v uses 2..31 (lower = better).
  const q = Math.round(31 - Math.max(1, Math.min(100, quality)) * (29 / 100));
  return Math.max(2, Math.min(31, q));
}

function ffmpegScaleJpeg(pngPath, quality) {
  const q = mapJpegQualityToFfmpegQ(quality);
  const jpgPath = pngPath.replace(/\.png$/i, ".jpg");
  const cmd = `ffmpeg -hide_banner -loglevel error -y -i ${pngPath} `
            + `-vf "scale=iw/${SCALE_DIVISOR}:-1" -q:v ${q} ${jpgPath}`;
  execSync(cmd, { stdio: "inherit" });
  const buf = fs.readFileSync(jpgPath);
  safeUnlink(jpgPath);
  return buf;
}

async function compress (pngPath, quality) {
  // Preferred: sharp (if available)
  const sharp = tryLoadSharp();
  if (sharp) {
    try {
      const img  = sharp(pngPath);
      const meta = await img.metadata();
      const targetW = Math.max(1, Math.round((meta.width || 1) / SCALE_DIVISOR));
      const buf  = await img
        .resize({ width: targetW })
        .jpeg({ quality })
        .toBuffer();
      safeUnlink(pngPath);
      return { mime: "image/jpeg", buffer: buf };
    } catch (e) {
      console.warn("[compress] sharp failed; will try ffmpeg:", e.message);
    }
  }

  // Fallback 1: ffmpeg for resize + JPEG encode
  try {
    const buf = ffmpegScaleJpeg(pngPath, quality);
    safeUnlink(pngPath);
    return { mime: "image/jpeg", buffer: buf };
  } catch (e) {
    console.warn("[compress] ffmpeg fallback failed; returning raw PNG:", e.message);
  }

  // Fallback 2: raw PNG (no resize)
  const buf = fs.readFileSync(pngPath);
  safeUnlink(pngPath);
  return { mime: "image/png", buffer: buf };
}

module.exports = { captureScreenshot };
