// Adapter for the Android app's `PortholeNative` object (addWebMessageListener). In a plain browser every
// call resolves to null and the caller uses its web fallback.

import { isObject } from "../lib/json.js";

/** The only method names the page will send; anything else is refused before it leaves the page. */
const ALLOWED = new Set(["machines", "speak", "stopSpeaking", "startRecording", "stopRecording", "pickFile", "openExternal", "openSettings"]);

/** A share can arrive before any screen listens for it (the app opened on the Inbox); this many are kept, the newest. */
const SHARE_QUEUE_MAX = 10;

/**
 * @param {object} win `window`, or `{}` outside a browser
 * @returns {import("../lib/types.js").Bridge}
 */
export function createBridge(win) {
  const native = win ? /** @type {{PortholeNative?: {postMessage(data: string): void, onmessage?: unknown}}} */ (win).PortholeNative : undefined;
  const available = !!native && typeof native.postMessage === "function";
  /** @type {Map<number, {resolve: (v: unknown) => void, reject: (e: Error) => void}>} */
  const pending = new Map();
  /** @type {Map<string, Set<(data: unknown) => void>>} */
  const listeners = new Map();
  /** `share` events nobody was listening for yet, oldest first. @type {unknown[]} */
  const queuedShares = [];
  /** @type {Set<() => void>} */
  const queueWatchers = new Set();
  let nextId = 1;

  if (native && available) {
    native.onmessage = (/** @type {{data: unknown}} */ e) => {
      let raw = e.data;
      if (typeof raw === "string") {
        try { raw = JSON.parse(raw); } catch { return; }
      }
      if (!isObject(raw)) return;
      const msg = raw;
      if (typeof msg.event === "string") {
        const subscribed = listeners.get(msg.event);
        if (msg.event === "share" && (!subscribed || subscribed.size === 0)) {
          queuedShares.push(msg.data);
          if (queuedShares.length > SHARE_QUEUE_MAX) queuedShares.shift();
          for (const fn of [...queueWatchers]) {
            try { fn(); } catch { /* a watcher must not stop the others */ }
          }
          return;
        }
        for (const fn of [...(subscribed ?? [])]) {
          try { fn(msg.data); } catch { /* one listener must not stop the others */ }
        }
        return;
      }
      const id = typeof msg.id === "number" ? msg.id : undefined;
      const p = id !== undefined ? pending.get(id) : undefined;
      if (!p || id === undefined) return;
      pending.delete(id);
      if (msg.ok) p.resolve(msg.result ?? null);
      else p.reject(new Error(typeof msg.error === "string" ? msg.error : "Native call failed"));
    };
  }

  return {
    available,
    async call(method, args = {}) {
      if (!ALLOWED.has(method)) throw new Error(`Bridge method not allowed: ${method}`);
      if (!native || !available) return null;
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          native.postMessage(JSON.stringify({ id, method, args }));
        } catch (e) {
          pending.delete(id);
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    },
    on(event, fn) {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      set.add(fn);
      if (event === "share" && set.size === 1) {
        for (const data of queuedShares.splice(0)) {
          try { fn(data); } catch { /* the first listener's failure must not lose the shares after it */ }
        }
      }
      return () => { set.delete(fn); };
    },
    pendingShares: () => queuedShares.length,
    onShareQueued(fn) {
      queueWatchers.add(fn);
      return () => { queueWatchers.delete(fn); };
    },
  };
}
