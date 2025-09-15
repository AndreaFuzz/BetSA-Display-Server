// screen-map.js — PORT-BASED binding: HDMI-1 -> 9222, HDMI-2 -> 9223
"use strict";

function initScreenControllers(opts) {
  const {
    DevToolsController,
    loadState,
    log = console,
  } = opts;

  const PORTS = { "1": 9222, "2": 9223 };

  let controllers = { "1": null, "2": null };
  let desired = { "1": null, "2": null };

  // Load saved URLs (hdmi1/hdmi2) and apply as soon as possible
  try {
    const state = typeof loadState === "function" ? loadState() : { hdmi1: null, hdmi2: null };
    if (state && typeof state === "object") {
      desired["1"] = state.hdmi1 || null;
      desired["2"] = state.hdmi2 || null;
    }
  } catch (e) {
    log.warn(`[screen-map] loadState failed: ${e.message || e}`);
  }

  function ensureController(id) {
    if (controllers[id]) return controllers[id];
    const port = PORTS[id];
    const c = new DevToolsController(id, port);
    c.port = port;
    controllers[id] = c;
    if (desired[id]) c.navigate(desired[id]);
    log.info(`[screen-map] controller ${id} -> port ${port} (port-based)`);
    return c;
  }

  // Build both controllers up front; they auto-reconnect if the browser is not up yet
  ensureController("1");
  ensureController("2");

  function redirectBrowser(id, url) {
    if (id !== "1" && id !== "2") return;
    desired[id] = url || null;
    const c = controllers[id] || ensureController(id);
    if (url) c.navigate(url);
    log.info(`[screen-map] desired[${id}] = ${url || "null"}`);
  }

  function getCurrentPorts() {
    return { "1": PORTS["1"], "2": PORTS["2"] };
  }

  return { redirectBrowser, getCurrentPorts };
}

module.exports = { initScreenControllers };
