// The device's machines: one link each (started at creation), merged read-only views for the drawer and
// inbox, and the links that views (chat, terminal) report for the reconnect strip.
import { asObject } from "../lib/json.js";
import { groupInbox } from "../lib/inboxmodel.js";
import { buildSidebar } from "../lib/tree.js";
import { createApi } from "./api.js";
import { createMachine } from "./machine.js";

/** @typedef {import("./socket.js").LinkState} LinkState */
/** @typedef {import("./machine.js").Machine} Machine */
/** @typedef {{name: string, state: LinkState, retry: () => void}} Link */
/** @typedef {{addEventListener(type: string, fn: () => void): void, removeEventListener(type: string, fn: () => void): void}} Listenable */
/**
 * `deps` goes to every machine (`fetch`, `WebSocket`, `setTimeout`, `clearTimeout`, `outbox`). `window` and `bridge`
 * are optional: when present the fleet nudges every link on `online`, on the page becoming visible, and on the
 * bridge's `network` event.
 * @typedef {import("./machine.js").MachineDeps & {window?: Listenable & {document?: Listenable & {visibilityState?: string}}, bridge?: Pick<import("../lib/types.js").Bridge, "available" | "on">}} FleetDeps
 */

const MACHINES_KEY = "porthole:machines";

/** @param {string} origin */
function hostOf(origin) {
  try { return new URL(origin).hostname.split(".")[0]; } catch { return origin; }
}

/** @param {unknown} v @returns {v is {name: string, origin: string}[]} */
function isMachineList(v) {
  return Array.isArray(v) && v.every((m) => m && typeof m === "object" && typeof m.name === "string" && m.name !== "" && typeof m.origin === "string" && m.origin !== "");
}

/**
 * The machine list. Android app: from the bridge. Browser: `porthole:machines`, else first-run discovery from this
 * page's own origin plus the peers its hostd lists; a discovery that could not reach this origin is not saved.
 * @param {{bridge?: Pick<import("../lib/types.js").Bridge, "available" | "call">, storage: {getItem(k: string): string | null, setItem(k: string, v: string): void}, origin: string, fetch: typeof globalThis.fetch}} o
 * @returns {Promise<{name: string, origin: string}[]>}
 */
export async function loadMachines({ bridge, storage, origin, fetch }) {
  if (bridge?.available) {
    const list = await bridge.call("machines", {}).catch(() => null);
    if (isMachineList(list) && list.length > 0) return list.map((m) => ({ name: m.name, origin: m.origin }));
  }
  try {
    const raw = storage.getItem(MACHINES_KEY);
    const saved = raw === null ? null : JSON.parse(raw);
    if (isMachineList(saved) && saved.length > 0) return saved.map((m) => ({ name: m.name, origin: m.origin }));
  } catch { /* unreadable: discover again */ }

  /** The name a machine reports about itself, else the first part of its address. @param {import("./api.js").ApiResult} r @param {string} at */
  const nameFrom = (r, at) => {
    const name = r.ok ? asObject(r.data).name : undefined;
    return typeof name === "string" && name !== "" ? name : hostOf(at);
  };
  const self = await createApi({ origin, fetch }).get("/v1/machine");
  /** @type {{name: string, origin: string}[]} */
  const list = [{ name: nameFrom(self, origin), origin }];
  const cfg = await createApi({ origin, fetch }).get("/v1/config");
  const configured = cfg.ok ? asObject(cfg.data).peers : undefined;
  const peers = Array.isArray(configured) ? configured.filter((/** @type {unknown} */ p) => typeof p === "string" && p !== origin) : [];
  const found = await Promise.all(/** @type {string[]} */ (peers).map(async (peer) => {
    const r = await createApi({ origin: peer, fetch }).get("/v1/machine");
    return { name: nameFrom(r, peer), origin: peer };
  }));
  for (const f of found) if (!list.some((m) => m.origin === f.origin)) list.push(f);
  if (self.ok) {
    try { storage.setItem(MACHINES_KEY, JSON.stringify(list)); } catch { /* the list is rebuilt on the next launch */ }
  }
  return list;
}

/**
 * @param {{machines: {name: string, origin: string}[], deviceId: string, deps: FleetDeps}} o
 */
export function createFleet({ machines: list, deviceId, deps }) {
  /** @type {Machine[]} */
  const all = list.map((m) => createMachine({ name: m.name, origin: m.origin, deviceId, deps }));
  /** @type {Map<string, {state: LinkState, retry: () => void}>} */
  const viewLinks = new Map();
  /** @type {Set<() => void>} */
  const subscribers = new Set();
  /** @type {(() => void)[]} */
  const cleanups = [];

  const changed = () => {
    for (const fn of [...subscribers]) {
      try { fn(); } catch { /* a bad subscriber must not break the fleet */ }
    }
  };

  /** @returns {Link[]} */
  const links = () => [
    ...all.map((m) => ({ name: m.name, state: m.state(), retry: () => m.nudge() })),
    ...[...viewLinks].map(([name, v]) => ({ name, state: v.state, retry: v.retry })),
  ];

  const nudgeAll = () => {
    for (const m of all) m.nudge();
    for (const v of [...viewLinks.values()]) v.retry();
  };

  for (const m of all) cleanups.push(m.subscribe(changed));
  const win = deps.window;
  if (win) {
    const onOnline = () => nudgeAll();
    const onVisible = () => { if (win.document?.visibilityState === "visible") nudgeAll(); };
    win.addEventListener?.("online", onOnline);
    win.document?.addEventListener?.("visibilitychange", onVisible);
    cleanups.push(() => {
      win.removeEventListener?.("online", onOnline);
      win.document?.removeEventListener?.("visibilitychange", onVisible);
    });
  }
  if (deps.bridge?.available) cleanups.push(deps.bridge.on("network", nudgeAll));

  for (const m of all) m.start();

  return {
    links,
    /** @returns {Machine[]} in list order */
    machines: () => all.slice(),
    /** @param {string} name */
    machine: (name) => all.find((m) => m.name === name),
    /** @param {import("../lib/tree.js").OpenEntry[]} open */
    sidebar: (open) => buildSidebar(all.map((m) => ({ origin: m.origin, state: m.state(), tree: m.tree(), name: m.name })), open),
    inbox: () => groupInbox(Object.fromEntries(all.map((m) => [m.name, m.inbox()]))),
    anyDown: () => links().some((l) => l.state !== "up"),
    subscribe(/** @type {() => void} */ fn) {
      subscribers.add(fn);
      return () => { subscribers.delete(fn); };
    },
    nudgeAll,
    stop() {
      for (const c of cleanups.splice(0)) c();
      for (const m of all) m.stop();
      viewLinks.clear();
      subscribers.clear();
    },
    /**
     * A view's own live connection joins the strip. Call again with the same name to update its state.
     * @param {string} name @param {LinkState} state @param {() => void} [retry] kept from the earlier call when left out
     * @returns {() => void} drop
     */
    reportLink(name, state, retry) {
      const before = viewLinks.get(name);
      const next = { state, retry: retry ?? before?.retry ?? (() => {}) };
      viewLinks.set(name, next);
      if (!before || before.state !== state || before.retry !== next.retry) changed();
      return () => {
        if (!viewLinks.delete(name)) return;
        changed();
      };
    },
  };
}
