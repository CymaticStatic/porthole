// One link per machine: its API client, its events socket, its latest session tree and inbox, and the
// only code that sends held outbox entries (see "Send flow" in the plan).
import { asObject, isObject, parseJson } from "../lib/json.js";
import { nextAction } from "../lib/outbox.js";
import { createApi } from "./api.js";
import { openSocket } from "./socket.js";

/**
 * hostd's events socket says nothing while nothing changes, so the page asks: `{"type":"ping"}` every 10 s. A hostd that answers
 * with `{"type":"pong"}` is then held to it (25 s of silence means the link is redialled); one that does not is left alone.
 * @type {import("./socket.js").Heartbeat}
 */
const HEARTBEAT = {
  ping: JSON.stringify({ type: "ping" }),
  isPong(data) {
    if (typeof data !== "string") return false;
    const msg = parseJson(data);
    return isObject(msg) && msg.type === "pong";
  },
  pingMs: 10_000,
  silentMs: 25_000,
};

/** @typedef {import("./socket.js").LinkState} LinkState */
/** @typedef {import("../lib/outbox.js").NextAction} NextAction */
/** @typedef {{clientMsgId: string, sessionId: string, action: NextAction}} SendResult */
/**
 * @typedef {object} MachineDeps
 * @property {typeof fetch} fetch
 * @property {typeof WebSocket} WebSocket
 * @property {typeof setTimeout} setTimeout
 * @property {typeof clearTimeout} clearTimeout
 * @property {ReturnType<typeof import("../lib/outbox.js").createOutbox>} outbox
 */
/**
 * @typedef {object} Machine
 * @property {string} name
 * @property {string} origin
 * @property {() => LinkState} state
 * @property {() => import("../lib/tree.js").TreeLike | null} tree the latest `sessions` push from hostd, or null before the first one
 * @property {() => import("../lib/inboxmodel.js").InboxItemLike[]} inbox
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
  /** @type {import("../lib/tree.js").TreeLike | null} */
  let tree = null;
  /** @type {import("../lib/inboxmodel.js").InboxItemLike[]} */
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
    const msg = parseJson(raw);
    if (!isObject(msg)) return;
    if (msg.type === "sessions" && isObject(msg.tree)) {
      tree = /** @type {import("../lib/tree.js").TreeLike} */ (msg.tree);
      changed();
    } else if (msg.type === "inbox" && Array.isArray(msg.items)) {
      inbox = /** @type {import("../lib/inboxmodel.js").InboxItemLike[]} */ (msg.items);
      changed();
    } else if (msg.type === "notify" && typeof msg.id === "number" && Number.isInteger(msg.id)) {
      // The page never shows notifications (the phone app's service does); it only acknowledges them so hostd stops replaying.
      lastNotifyId = Math.max(lastNotifyId, msg.id);
      socket?.send(JSON.stringify({ type: "ack", id: msg.id }));
    }
  }

  async function refreshInbox() {
    const r = await api.get("/v1/inbox");
    const data = r.ok ? asObject(r.data) : null;
    if (data && Array.isArray(data.items)) {
      inbox = /** @type {import("../lib/inboxmodel.js").InboxItemLike[]} */ (data.items);
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
        heartbeat: HEARTBEAT,
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
