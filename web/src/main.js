// Boot: settings → bridge → device id → machine list → fleet → app events and the send-result listener → shell and router.
import { h } from "./dom/h.js";
import { copy } from "./lib/copy.js";
import { createDrafts } from "./lib/drafts.js";
import { createOutbox } from "./lib/outbox.js";
import { defaultStorage } from "./lib/storage.js";
import { createBridge } from "./net/bridge.js";
import { createFleet, loadMachines } from "./net/fleet.js";
import { createShell } from "./views/shell.js";

const SETTINGS_KEY = "porthole:settings";
const DEVICE_KEY = "porthole:device";

/** @typedef {import("./lib/storage.js").Store} Store */
/** @typedef {Record<string, any>} Settings */

/**
 * `ctx.settings`: the one JSON object under `porthole:settings`. Only this function touches that key. `get()` returns the whole
 * object (keys never saved are absent), `set(patch)` merges and notifies, `subscribe(fn)` also hears changes made in another tab.
 * @param {Store} store @param {Window} win
 */
function createSettings(store, win) {
  /** @type {Set<(s: Settings) => void>} */
  const subs = new Set();
  /** @type {Settings} what this page last knew; used when the store cannot be read or written (private mode, full) */
  let known = {};

  /** @returns {Settings} */
  function get() {
    try {
      const raw = store.getItem(SETTINGS_KEY);
      const v = raw === null ? {} : JSON.parse(raw);
      known = v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch { /* unreadable: keep what we knew */ }
    return { ...known };
  }
  const notify = () => {
    const s = get();
    for (const fn of [...subs]) {
      try { fn(s); } catch { /* one bad subscriber must not stop the others */ }
    }
  };

  win.addEventListener("storage", (e) => {
    if (e.key === SETTINGS_KEY || e.key === null) notify();
  });

  return {
    get,
    /** @param {Settings} patch */
    set(patch) {
      known = { ...get(), ...patch };
      try { store.setItem(SETTINGS_KEY, JSON.stringify(known)); } catch { /* kept in memory for this page */ }
      notify();
    },
    /** @param {(s: Settings) => void} fn @returns {() => void} */
    subscribe(fn) {
      subs.add(fn);
      return () => { subs.delete(fn); };
    },
  };
}

/** The app event bus (`ctx.events`). */
function createEvents() {
  /** @type {Map<string, Set<(data: any) => void>>} */
  const listeners = new Map();
  return {
    /** @param {string} name @param {(data: any) => void} fn @returns {() => void} */
    on(name, fn) {
      const set = listeners.get(name) ?? new Set();
      listeners.set(name, set);
      set.add(fn);
      return () => { set.delete(fn); };
    },
    /** @param {string} name @param {unknown} data */
    emit(name, data) {
      for (const fn of [...(listeners.get(name) ?? [])]) {
        try { fn(data); } catch { /* a listener that throws must not stop the others */ }
      }
    },
  };
}

/** @param {Store} store @returns {string} `"web-" + 12 random [a-z0-9]`, kept in `porthole:device` */
function deviceId(store) {
  try {
    const have = store.getItem(DEVICE_KEY);
    if (have && /^web-[a-z0-9]{12}$/.test(have)) return have;
  } catch { /* fall through to a fresh id */ }
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const id = "web-" + [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  try { store.setItem(DEVICE_KEY, id); } catch { /* a new id next launch is harmless */ }
  return id;
}

/**
 * Every machine's send results, heard once each, whichever chat is open (plan: "Send results").
 * @param {{fleet: ReturnType<typeof createFleet>, outbox: ReturnType<typeof createOutbox>, drafts: ReturnType<typeof createDrafts>, events: ReturnType<typeof createEvents>}} o
 */
function listenForSendResults({ fleet, outbox, drafts, events }) {
  /** @type {Set<unknown>} */
  const heard = new Set();
  const attach = () => {
    for (const m of fleet.machines()) {
      if (heard.has(m)) continue;
      heard.add(m);
      m.onSendResult(({ clientMsgId, sessionId, action }) => {
        const entry = outbox.get(clientMsgId);
        if (!entry) return; // the outbox no longer holds it: nothing to apply
        if (action.draft === "clear") {
          drafts.clear(entry.origin, sessionId);
          drafts.addSent(entry.origin, sessionId, { clientMsgId, text: entry.text, at: entry.at, status: "delivered", reason: null });
        }
        if (action.outbox === "remove") outbox.remove(clientMsgId);
        events.emit("send-result", { clientMsgId, sessionId, action });
      });
    }
  };
  fleet.subscribe(attach);
  attach();
}

async function boot() {
  const app = document.getElementById("app");
  if (!app) return;
  const store = defaultStorage();
  const settings = createSettings(store, window);
  const bridge = createBridge(window);
  const id = deviceId(store);
  const fetchFn = window.fetch.bind(window);
  const machines = await loadMachines({ bridge, storage: store, origin: window.location.origin, fetch: fetchFn });
  const outbox = createOutbox(store);
  const fleet = createFleet({
    machines,
    deviceId: id,
    deps: {
      fetch: fetchFn,
      WebSocket: window.WebSocket,
      setTimeout: window.setTimeout.bind(window),
      clearTimeout: window.clearTimeout.bind(window),
      outbox,
      window,
      bridge,
    },
  });
  const events = createEvents();
  listenForSendResults({ fleet, outbox, drafts: createDrafts(store), events });
  createShell({ app, base: { fleet, settings, bridge, copy, events }, openStore: store }).start();
}

void boot().catch(() => {
  document.getElementById("app")?.replaceChildren(h("div", { class: "view-failed", role: "alert", "data-test": "view-failed" },
    h("p", {}, copy.viewFailed),
    h("button", { type: "button", class: "btn", on: { click: () => window.location.reload() } }, copy.reload),
  ));
});
