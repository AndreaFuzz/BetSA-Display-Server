// screenshot.js — port-true screenshots: HDMI-1 -> screen 1, HDMI-2 -> screen 2
"use strict";

const fs = require("fs");
const http = require("http");
const WebSocket = require("ws");
const { execSync } = require("child_process");

const DEFAULT_DISPLAY = ":0";
const DEFAULT_XAUTH   = "/home/admin/.Xauthority";
const STATE_FILE      = "/home/admin/kiosk/urls.json";
const SCALE_DIVISOR   = 2;

// fixed port mapping by physical output
const PORT_FOR = { "1": 9222, "2": 9223 };
const OUT_FOR  = { "1": "HDMI-1", "2": "HDMI-2" };

/* -------- exec helpers -------- */
function run(cmd, opts = {}) {
  const env = { ...process.env, DISPLAY: process.env.DISPLAY || DEFAULT_DISPLAY, XAUTHORITY: process.env.XAUTHORITY || DEFAULT_XAUTH };
  try { return execSync(cmd, { encoding: "utf8", stdio: ["ignore","pipe","pipe"], env, ...opts }).toString(); }
  catch (e) { const msg = (e.stderr || e.stdout || e.message || "").toString().split("\n")[0]; console.warn(`[capture] run failed: ${cmd} -> ${msg}`); return ""; }
}
function have(cmd){ return !!run(`command -v ${cmd} || true`).trim(); }
function safeUnlink(p){ try{ fs.unlinkSync(p); } catch{} }

/* -------- layout / connection helpers -------- */
function getOutputs() {
  const out = run("xrandr --query");
  const con = {};
  // quick status for HDMI-1/HDMI-2
  for (const id of ["1","2"]) {
    const name = OUT_FOR[id];
    const re = new RegExp(`^${name}\\s+(connected|disconnected)`, "m");
    const m = out.match(re);
    con[id] = !!(m && m[1] === "connected");
  }
  // geometry map per *name*
  const rx = /^(HDMI-\d)\s+connected.*?(\d+)x(\d+)\+(\d+)\+(\d+)/gm;
  let m; const headsByName = {};
  while ((m = rx.exec(out)) !== null) {
    headsByName[m[1]] = { name:m[1], w:+m[2], h:+m[3], x:+m[4], y:+m[5] };
  }
  // total size (best-effort)
  const scr = out.match(/current\s+(\d+)\s+x\s+(\d+)/);
  const total = { W: scr ? +scr[1] : NaN, H: scr ? +scr[2] : NaN };
  if (!Number.isFinite(total.W) || !Number.isFinite(total.H)) {
    const heads = Object.values(headsByName);
    if (heads.length) {
      const minX = Math.min(...heads.map(h=>h.x));
      const maxX = Math.max(...heads.map(h=>h.x+h.w));
      const minY = Math.min(...heads.map(h=>h.y));
      const maxY = Math.max(...heads.map(h=>h.y+h.h));
      total.W = maxX-minX; total.H = maxY-minY;
    } else {
      total.W = 1920; total.H = 1080;
    }
  }
  return { connected: con, headsByName, total };
}
function geomForId(id, headsByName) {
  const name = OUT_FOR[id];
  return headsByName[name] || null; // null if that physical output isn’t active
}

/* -------- expected URL helpers (unchanged) -------- */
function loadState(){ try { return JSON.parse(fs.readFileSync(STATE_FILE,"utf8")); } catch { return { hdmi1:null, hdmi2:null }; } }
function expectedFor(id){ const s=loadState(); return id==="1"? s.hdmi1 : id==="2" ? s.hdmi2 : null; }
function normalizeUrl(u){ if(!u) return ""; try { return new URL(u).href; } catch { return String(u); } }

/* -------- DevTools helpers -------- */
function fetchJson(port){
  return new Promise((res,rej)=>{
    http.get({host:"127.0.0.1", port, path:"/json"}, r=>{
      let d=""; r.on("data",c=>d+=c); r.on("end",()=>{ try{ res(JSON.parse(d)); }catch(e){ rej(e);} });
    }).on("error",rej);
  });
}

/* -------- DevTools capture bound to fixed port -------- */
async function captureViaDevtoolsTruth(screenId, quality){
  const { connected } = getOutputs();
  if (screenId === "1" && !connected["1"]) throw new Error("screen 1 not connected");
  if (screenId === "2" && !connected["2"]) throw new Error("screen 2 not connected");

  const port = PORT_FOR[screenId];
  const list = await fetchJson(port);
  const page = list.find(t=>t.type==="page");
  if (!page) throw new Error("no page target");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id=0; const pending=new Map();
  function send(method, params){
    return new Promise((resolve,reject)=>{
      const i=++id; pending.set(i,{resolve,reject});
      ws.send(JSON.stringify({id:i,method,params}));
    });
  }
  await new Promise((resolve,reject)=>{
    const t=setTimeout(()=>reject(new Error("ws open timeout")),3000);
    ws.once("open",()=>{ clearTimeout(t); resolve(); });
    ws.once("error",reject);
  });
  ws.on("message",(raw)=>{
    try{
      const msg=JSON.parse(raw);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg.result); pending.delete(msg.id); }
    }catch{}
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDefaultBackgroundColorOverride",{ color:{r:255,g:255,b:255,a:255} });

  const urlR = await send("Runtime.evaluate",{ expression:"location.href", returnByValue:true });
  const cur  = normalizeUrl(urlR?.result?.value || "");
  const exp  = normalizeUrl(expectedFor(screenId) || "");

  if (exp && cur !== exp) { ws.close(); throw new Error(`url mismatch: expected ${exp} but at ${cur}`); }
  if (!cur || cur==="about:blank" || cur.startsWith("chrome-error://")) { ws.close(); throw new Error(`bad url: ${cur || "empty"}`); }

  const cap = await send("Page.captureScreenshot", {
    format:"jpeg", quality: Math.max(1, Math.min(100, quality)), fromSurface:true, captureBeyondViewport:true
  });
  ws.close();
  const buf = Buffer.from(cap.data, "base64");
  console.info(`[capture] method=devtools_truth port=${port} url=${cur}`);
  return await scaleMemoryToJpeg(buf, quality);
}

/* -------- X11 full-desktop + crop by output name -------- */
async function captureViaX11FullCrop(screenId, quality){
  if (!have("ffmpeg")) throw new Error("ffmpeg not available");
  const { total, headsByName, connected } = getOutputs();
  if (screenId === "1" && !connected["1"]) throw new Error("screen 1 not connected");
  if (screenId === "2" && !connected["2"]) throw new Error("screen 2 not connected");

  const g = geomForId(screenId, headsByName);
  if (!g) throw new Error(`screen ${screenId} not connected`);

  const W = total.W, H = total.H;
  const display = (process.env.DISPLAY || DEFAULT_DISPLAY).includes(".")
    ? (process.env.DISPLAY || DEFAULT_DISPLAY)
    : (process.env.DISPLAY || DEFAULT_DISPLAY) + ".0";

  const tmpPng = `/tmp/screen${screenId}-${Date.now()}.png`;
  const vf = `crop=${g.w}:${g.h}:${g.x}:${g.y}`;
  const cmd = `ffmpeg -hide_banner -loglevel error -nostdin -f x11grab -draw_mouse 0 `
            + `-video_size ${W}x${H} -i ${display}+0,0 -frames:v 1 -vf "${vf}" -y ${tmpPng}`;
  console.info(`[capture] method=x11_full+crop display=${display} total=${W}x${H} region=${g.w}x${g.h}+${g.x}+${g.y}`);
  run(cmd);
  if (!fs.existsSync(tmpPng)) throw new Error("x11grab failed");
  return await compressFile(tmpPng, quality);
}

/* -------- public API -------- */
async function captureScreenshot(id, quality = 70){
  try { return await captureViaDevtoolsTruth(id, quality); }
  catch (e) { console.warn(`[capture] devtools path failed: ${e.message || e}`); }
  try { return await captureViaX11FullCrop(id, quality); }
  catch (e) { console.warn(`[capture] x11 fallback failed: ${e.message || e}`); }
  throw new Error("screenshot failed: all methods exhausted");
}

/* -------- scaling/compression (unchanged) -------- */
let _sharpTried=false, _sharp=null;
function tryLoadSharp(){ if(_sharpTried) return _sharp; _sharpTried=true; try{ _sharp=require("sharp"); }catch(e){ console.warn("[compress] sharp not available:", e.message); _sharp=null; } return _sharp; }
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
  return { mime: isJpgInput? "image/jpeg" : "image/png", buffer: out };
}

module.exports = { captureScreenshot };
