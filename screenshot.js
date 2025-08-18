// screenshot.js - truth-only screenshots for Raspberry Pi X11 kiosks
"use strict";

const fs = require("fs");
const http = require("http");
const WebSocket = require("ws");
const { execSync } = require("child_process");

const DEFAULT_DISPLAY = ":0";
const DEFAULT_XAUTH   = "/home/admin/.Xauthority";
const STATE_FILE      = "/home/admin/kiosk/urls.json"; // expected urls per screen
const SCALE_DIVISOR   = 2;

/* ---------------- small exec helpers ---------------- */

function run(cmd, opts = {}) {
  const env = {
    ...process.env,
    DISPLAY: process.env.DISPLAY || DEFAULT_DISPLAY,
    XAUTHORITY: process.env.XAUTHORITY || DEFAULT_XAUTH,
  };
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore","pipe","pipe"], env, ...opts }).toString();
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message || "").toString().split("\n")[0];
    console.warn(`[capture] run failed: ${cmd} -> ${msg}`);
    return "";
  }
}
function have(cmd) { return !!run(`command -v ${cmd} || true`).trim(); }
function safeUnlink(p){ try{ fs.unlinkSync(p); } catch{} }
function isRaspberryPi(){ try{ return /Raspberry Pi/i.test(fs.readFileSync("/proc/device-tree/model","utf8")); }catch{ return false; } }

/* ---------------- layout helpers ---------------- */

function parseHeads() {
  const out = run("xrandr --query");
  const scr = out.match(/current\s+(\d+)\s+x\s+(\d+)/);
  const total = { W: scr ? +scr[1] : NaN, H: scr ? +scr[2] : NaN };

  const rx = /^(HDMI-\d)\s+connected.*?(\d+)x(\d+)\+(\d+)\+(\d+)/gm;
  let m; const heads = [];
  while ((m = rx.exec(out)) !== null) {
    heads.push({ name:m[1], w:+m[2], h:+m[3], x:+m[4], y:+m[5] });
  }
  if (!heads.length) {
    console.warn("[capture] xrandr parse failed; assuming two 1920x1080 heads at X=0 and X=1920");
    return { total:{W:3840,H:1080}, heads:[
      { name:"HDMI-1", w:1920, h:1080, x:0,    y:0 },
      { name:"HDMI-2", w:1920, h:1080, x:1920, y:0 },
    ]};
  }
  heads.sort((a,b)=>a.x-b.x);
  if (!Number.isFinite(total.W) || !Number.isFinite(total.H)) {
    const minX = Math.min(...heads.map(h=>h.x));
    const maxX = Math.max(...heads.map(h=>h.x+h.w));
    const minY = Math.min(...heads.map(h=>h.y));
    const maxY = Math.max(...heads.map(h=>h.y+h.h));
    total.W = maxX - minX; total.H = maxY - minY;
  }
  return { total, heads };
}
function geomForId(id, heads){ return id==="1" ? heads[0] : (id==="2" ? (heads[1]||heads[0]) : null); }
function baseDisplay(){ return (process.env.DISPLAY || DEFAULT_DISPLAY).replace(/\.\d+$/,""); }

/* ---------------- expected URL ---------------- */

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE,"utf8")); }
  catch { return { hdmi1:null, hdmi2:null }; }
}
function expectedFor(id) {
  const s = loadState();
  return id==="1" ? s.hdmi1 : id==="2" ? s.hdmi2 : null;
}
function normalizeUrl(u){
  if(!u) return "";
  try { return new URL(u).href; } catch { return String(u); }
}

/* ---------------- DevTools helpers (no navigation) ---------------- */

function pidForPort(port) {
  const viaSs  = run(`ss -ltnp 'sport = :${port}' | awk -F'pid=' 'NR>1{split($2,a,","); print a[1]; exit}'`).trim();
  if (viaSs) return viaSs;
  const viaLsof = run(`lsof -iTCP:${port} -sTCP:LISTEN -t | head -n1`).trim();
  return viaLsof || "";
}
function widForPid(pid){ return pid ? run(`wmctrl -lp | awk '$3==${pid} {print $1; exit}'`).trim() : ""; }
function xOfWid(wid){ if(!wid) return NaN; const x=run(`wmctrl -lG | awk '$1=="${wid}" {print $3; exit}'`).trim(); const n=Number(x); return Number.isFinite(n)?n:NaN; }

function detectLeftRightPorts() {
  const ports=[9222,9223];
  const items = ports.map(port=>{
    const pid=pidForPort(port); const wid=widForPid(pid); const x=xOfWid(wid);
    return { port,pid,wid,x };
  }).filter(i=>Number.isFinite(i.x));
  if (!items.length) { console.warn("[capture] devtools map unavailable"); return null; }
  items.sort((a,b)=>a.x-b.x);
  const left  = items[0].port;
  const right = (items[1] && items[1].port) || left;
  console.info(`[capture] devtools map left->${left} right->${right} details=${JSON.stringify(items)}`);
  return { left, right };
}

function fetchJson(port){
  return new Promise((res,rej)=>{
    http.get({host:"127.0.0.1", port, path:"/json"}, r=>{
      let d=""; r.on("data",c=>d+=c); r.on("end",()=>{ try{ res(JSON.parse(d)); }catch(e){ rej(e); }});
    }).on("error",rej);
  });
}

async function captureViaDevtoolsTruth(screenId, quality) {
  const map = detectLeftRightPorts();
  if (!map) throw new Error("devtools map unavailable");
  const port = screenId==="1" ? map.left : map.right;

  const list = await fetchJson(port);
  const page = list.find(t=>t.type==="page");
  if (!page) throw new Error("no page target");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let nextId=0; const pending=new Map();
  function send(method, params){
    return new Promise((resolve,reject)=>{
      const id=++nextId;
      pending.set(id,{resolve,reject});
      ws.send(JSON.stringify({id,method,params}));
    });
  }
  await new Promise((resolve,reject)=>{
    const t=setTimeout(()=>reject(new Error("ws open timeout")), 3000);
    ws.once("open", ()=>{ clearTimeout(t); resolve(); });
    ws.once("error", e=>reject(e));
  });
  ws.on("message",(raw)=>{
    try{
      const msg=JSON.parse(raw);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id).resolve(msg.result); pending.delete(msg.id);
      }
    }catch{}
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDefaultBackgroundColorOverride",{ color:{r:255,g:255,b:255,a:255} });

  // Truth check: what is actually loaded right now?
  const urlResult = await send("Runtime.evaluate",{ expression:"location.href", returnByValue:true });
  const stateRes  = await send("Runtime.evaluate",{ expression:"document.readyState", returnByValue:true });
  const current   = normalizeUrl(urlResult?.result?.value || "");
  const ready     = String(stateRes?.result?.value || "");
  const expected  = normalizeUrl(expectedFor(screenId) || "");

  // If we expected a specific URL and it does not match, fail (do not capture)
  if (expected && current !== expected) {
    ws.close();
    console.error(`[capture] devtools truth check failed: expected=${expected} current=${current} readyState=${ready}`);
    throw new Error(`url mismatch: expected ${expected} but at ${current}`);
  }
  // If it looks like a net error/blank, fail (do not capture)
  if (current === "" || current === "about:blank" || current.startsWith("chrome-error://")) {
    ws.close();
    console.error(`[capture] devtools truth check failed: bad url "${current}" readyState=${ready}`);
    throw new Error(`bad url: ${current || "empty"}`);
  }

  // Capture exactly what is on the compositor surface, no reloads
  const cap = await send("Page.captureScreenshot", {
    format:"jpeg",
    quality: Math.max(1, Math.min(100, quality)),
    fromSurface:true,
    captureBeyondViewport:true
  });
  ws.close();
  console.info(`[capture] method=devtools_truth port=${port} url=${current} readyState=${ready}`);
  const buf = Buffer.from(cap.data, "base64");
  return await scaleMemoryToJpeg(buf, quality);
}

/* ---------------- X11 full-desktop + crop (truth) ---------------- */

async function captureViaX11FullCrop(screenId, quality) {
  if (!have("ffmpeg")) throw new Error("ffmpeg not available");
  const { total, heads } = parseHeads();
  const g = geomForId(screenId, heads);
  if (!g) throw new Error("invalid id");

  const W = total.W || (heads[0].w + (heads[1]?.w || 0));
  const H = total.H || Math.max(heads[0].h, heads[1]?.h || 0);
  const display = (process.env.DISPLAY || DEFAULT_DISPLAY).includes(".")
    ? (process.env.DISPLAY || DEFAULT_DISPLAY)
    : (process.env.DISPLAY || DEFAULT_DISPLAY) + ".0";

  const tmpPng = `/tmp/screen${screenId}-${Date.now()}.png`;
  const vf = `crop=${g.w}:${g.h}:${g.x}:${g.y}`;
  const cmd = `ffmpeg -hide_banner -loglevel error -nostdin -f x11grab -draw_mouse 0 `
            + `-video_size ${W}x${H} -i ${display}+0,0 -frames:v 1 `
            + `-vf "${vf}" -y ${tmpPng}`;
  console.info(`[capture] method=x11_full+crop display=${display} total=${W}x${H} region=${g.w}x${g.h}+${g.x}+${g.y}`);
  run(cmd);
  if (!fs.existsSync(tmpPng)) throw new Error("x11grab failed");
  return await compressFile(tmpPng, quality);
}

/* ---------------- public API ---------------- */

async function captureScreenshot(id, quality = 70) {
  // 1) Try DevTools without altering the page. If URL does not match expected, FAIL.
  try {
    return await captureViaDevtoolsTruth(id, quality);
  } catch (e) {
    console.warn(`[capture] devtools path failed: ${e.message || e}`);
  }

  // 2) Fallback to X11 full+crop (always truth of pixels on screen)
  try {
    return await captureViaX11FullCrop(id, quality);
  } catch (e) {
    console.warn(`[capture] x11 fallback failed: ${e.message || e}`);
  }

  throw new Error("screenshot failed: all methods exhausted");
}

/* ---------------- scaling/compression ---------------- */

let _sharpTried=false, _sharp=null;
function tryLoadSharp(){ if(_sharpTried) return _sharp; _sharpTried=true; try{ _sharp=require("sharp"); }catch(e){ console.warn("[compress] sharp not available:", e.message); _sharp=null;} return _sharp; }
function mapJpegQualityToFfmpegQ(q){ const v=Math.round(31 - Math.max(1,Math.min(100,q))*(29/100)); return Math.max(2,Math.min(31,v)); }

async function scaleMemoryToJpeg(buf, quality){
  const tmp = `/tmp/devtools-${Date.now()}.jpg`;
  fs.writeFileSync(tmp, buf);
  try { return await compressFile(tmp, quality, true); }
  finally { safeUnlink(tmp); }
}

async function compressFile(inputPath, quality, isJpgInput=false){
  const sharp = tryLoadSharp();
  if (sharp) {
    try {
      const img=sharp(inputPath);
      const meta=await img.metadata();
      const targetW=Math.max(1, Math.round((meta.width||1)/SCALE_DIVISOR));
      const out=await img.resize({width:targetW}).jpeg({quality}).toBuffer();
      safeUnlink(inputPath);
      return { mime:"image/jpeg", buffer: out };
    } catch(e){ console.warn("[compress] sharp failed; using ffmpeg:", e.message); }
  }
  if (have("ffmpeg")) {
    const q=mapJpegQualityToFfmpegQ(quality);
    const jpgPath=isJpgInput? inputPath : inputPath.replace(/\.\w+$/i,".jpg");
    const vf=`scale=iw/${SCALE_DIVISOR}:-1`;
    run(`ffmpeg -hide_banner -loglevel error -nostdin -y -i ${inputPath} -vf "${vf}" -q:v ${q} ${jpgPath}`);
    const out=fs.readFileSync(jpgPath);
    safeUnlink(jpgPath); safeUnlink(inputPath);
    return { mime:"image/jpeg", buffer: out };
  }
  const out=fs.readFileSync(inputPath);
  safeUnlink(inputPath);
  return { mime: isJpgInput? "image/jpeg":"image/png", buffer: out };
}

module.exports = { captureScreenshot };
