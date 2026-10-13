// One link per machine: its API client, its events socket, its latest session tree and inbox, and the
// only code that sends held outbox entries (see "Send flow" in the plan).
import { nextAction } from "../lib/outbox.js";
import { createApi } from "./api.js";
import { openSocket } from "./socket.js";

/** @typedef {import("./socket.js").LinkState} LinkState */
/** @typedef {import("../lib/outbox.js").NextAction} NextAction */
/** @typedef {{clientMsgId: string, sessionId: string, action: NextAction}} SendResult */
/**
 * @typedef {object} MachineDeps
 * @property {typeof fetch} fetch
 * @property {any} WebSocket
 * @property {Function} setTimeout
 * @property {Function} clearTimeout
 * @property {ReturnType<typeof import("../lib/outbox.js").createOutbox>} outbox
 */
/**
 * @typedef {object} Machine
 * @property {string} name
 * @property {string} origin
 * @property {() => LinkState} state
 * @property {() => any} tree the latest `sessions` push from hostd, or null before the first one
 * @property {() => any[]} inbox
 * @property {import("./api.js").Api} api
 * @property {(fn: () => void) => () => void} subscribe
 * @property {(fn: (r: SendResult) => void) => () => void} onSendResult
 * @property {() => void} start
 * @property {() => void} stop
 * @property {() => void} nudge
 */

/** `https://host` → `wss://host/v1/events?device=…&since=…`. @param {string} origin @param {string} deviceId @param {number} since */
function eventsUrl(origin, deviceId, since) {
  const u = new URL(origin);
  const proto = u.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${u.host}/v1/events?device=${encodeURIComponent(deviceId)}&since=${since}`;
}

/**
 * @param {{name: string, origin: string, deviceId: string, deps: MachineDeps}} o
 * @returns {Machine}
 */
export function createMachine({ name, origin, deviceId, deps }) {
  const api = createApi({ origin, fetch: deps.fetch });
  /** @type {LinkState} */
  let state = "connecting";
  /** @type {any} */
  let tree = null;
  /** @type {any[]} */
  let inbox = [];
  let lastNotifyId = 0;
  /** @type {ReturnType<typeof openSocket> | null} */
  let socket = null;
  /** @type {Set<() => void>} */
  const subscribers = new Set();
  /** @type {Set<(r: SendResult) => void>} */
  const resultListeners = new Set();

  const changed = () => {
    for (const fn of [...subscribers]) {
      try { fn(); } catch { /* a bad subscriber must not break the link */ }
    }
  };

  /** @param {unknown} raw */
  function onMessage(raw) {
    if (typeof raw !== "string") return;
    /** @type {any} */
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "sessions" && msg.tree && typeof msg.tree === "object") {
      tree = msg.tree;
      changed();
    } else if (msg.type === "inbox" && Array.isArray(msg.items)) {
      inbox = msg.items;
      changed();
    } else if (msg.type === "notify" && Number.isInteger(msg.id)) {
      // The page never shows notifications (the phone app's service does); it only acknowledges them so hostd stops replaying.
      lastNotifyId = Math.max(lastNotifyId, msg.id);
      socket?.send(JSON.stringify({ type: "ack", id: msg.id }));
    }
  }

  async function refreshInbox() {
    const r = await api.get("/v1/inbox");
    if (r.ok && r.data && Array.isArray(r.data.items)) {
      inbox = r.data.items;
      changed();
    }
  }

  let flushing = false;
  let again = false;
  /** Re-posts this machine's held outbox entries, one at a time in order. Never edits the outbox: listeners apply the action. */
  async function flushHeld() {
    if (flushing) { again = true; return; }
    flushing = true;
    try {
      do {
        again = false;
        for (const queued of deps.outbox.held(origin)) {
          if (state !== "up") break;
          const entry = deps.outbox.get(queued.clientMsgId);
          if (!entry || entry.status !== "held" || entry.origin !== origin) continue; // answered meanwhile
          const answer = await api.post(`/v1/sessions/${encodeURIComponent(entry.sessionId)}/send`, { text: entry.text, clientMsgId: entry.clientMsgId });
          const result = { clientMsgId: entry.clientMsgId, sessionId: entry.sessionId, action: nextAction(entry, answer) };
          for (const fn of [...resultListeners]) {
            try { fn(result); } catch { /* one listener must not stop the others */ }
          }
          // Still unreachable: the rest stay held and go out at the next "up".
          if (!answer.ok && answer.status === 0) break;
        }
      } while (again);
    } finally {
      flushing = false;
    }
  }

  return {
    name,
    origin,
    api,
    state: () => state,
    tree: () => tree,
    inbox: () => inbox,
    subscribe(fn) {
      subscribers.add(fn);
      return () => { subscribers.delete(fn); };
    },
    onSendResult(fn) {
      resultListeners.add(fn);
      return () => { resultListeners.delete(fn); };
    },
    start() {
      if (socket) return;
      socket = openSocket({
        url: () => eventsUrl(origin, deviceId, lastNotifyId),
        WebSocket: deps.WebSocket,
        setTimeout: deps.setTimeout,
        clearTimeout: deps.clearTimeout,
        onState(s) {
          if (s === state) return;
          state = s;
          changed();
        },
        onOpen() {
          void refreshInbox();
          void flushHeld();
        },
        onMessage,
      });
    },
    stop() {
      socket?.close();
      socket = null;
      if (state !== "down") { state = "down"; changed(); }
    },
    nudge() {
      socket?.nudge();
    },
  };
}
