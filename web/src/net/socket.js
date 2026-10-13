// A WebSocket that reconnects by itself (backoff in lib/reconnect.js). Every dependency is injected.
import { createReconnector } from "../lib/reconnect.js";

/** @typedef {"connecting" | "up" | "down"} LinkState */
/** @typedef {string | ArrayBuffer | Blob} SocketData what a socket message carries (`binaryType` picks Blob or ArrayBuffer for binary frames) */
/**
 * A heartbeat for a socket whose server stays silent when nothing changes. The page sends `ping` every `pingMs`. Once the server
 * has answered one ping (`isPong`), the link counts as dead after `silentMs` without any message and is dialled again. Until the
 * first answer the silence is not judged, so a server that does not answer pings is never redialled for being quiet.
 * @typedef {object} Heartbeat
 * @property {string} ping the text frame to send
 * @property {(data: SocketData) => boolean} isPong true for the server's answer to `ping`
 * @property {number} pingMs
 * @property {number} silentMs
 */
/**
 * @typedef {object} SocketOptions
 * @property {string | (() => string)} url a function is called on every (re)connect, so a query such as `since=` stays current
 * @property {typeof WebSocket} WebSocket the constructor to use
 * @property {typeof globalThis.setTimeout} setTimeout
 * @property {typeof globalThis.clearTimeout} clearTimeout
 * @property {(ws: WebSocket) => void} [onOpen]
 * @property {(data: SocketData, event: MessageEvent) => void} [onMessage]
 * @property {(state: LinkState) => void} [onState]
 * @property {"blob" | "arraybuffer"} [binaryType]
 * @property {Heartbeat} [heartbeat]
 */

/**
 * Opens the socket at once and keeps it open until `close()`.
 * `nudge()` drops the current socket, whatever state it is in, and dials a new one now (a network change can leave a half-open socket
 * that still looks up).
 * @param {SocketOptions} o
 * @returns {{send(data: string | ArrayBuffer | Blob | ArrayBufferView<ArrayBuffer>): boolean, nudge(): void, close(): void}}
 */
export function openSocket({ url, WebSocket, setTimeout, clearTimeout, onOpen, onMessage, onState, binaryType, heartbeat }) {
  /** @type {WebSocket | null} */
  let ws = null;
  let ended = false;
  /** @type {LinkState | null} */
  let last = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let pingTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let silenceTimer;
  let ponged = false;
  /** @param {LinkState} s */
  const report = (s) => {
    if (s === last) return;
    last = s;
    onState?.(s);
  };

  function stopHeartbeat() {
    clearTimeout(pingTimer);
    clearTimeout(silenceTimer);
    pingTimer = silenceTimer = undefined;
    ponged = false;
  }

  /** @param {WebSocket} mine @param {Heartbeat} hb */
  function startHeartbeat(mine, hb) {
    stopHeartbeat();
    const tick = () => {
      if (ws !== mine) return;
      try { mine.send(hb.ping); } catch { /* a dead socket closes; the retry follows */ }
      pingTimer = setTimeout(tick, hb.pingMs);
    };
    pingTimer = setTimeout(tick, hb.pingMs);
  }

  /** @param {WebSocket} mine @param {Heartbeat} hb @param {SocketData} data */
  function heard(mine, hb, data) {
    if (!ponged && !hb.isPong(data)) return;
    ponged = true;
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => { if (ws === mine) reconnector.nudge(); }, hb.silentMs);
  }

  /** Drops the current socket without reporting it: its replacement is dialled by the caller. */
  function detach() {
    stopHeartbeat();
    const old = ws;
    ws = null;
    if (old) {
      old.onopen = old.onmessage = old.onerror = old.onclose = null;
      try { old.close(); } catch { /* already closed */ }
    }
  }

  /** @type {ReturnType<typeof createReconnector>} */
  const reconnector = createReconnector({
    connect() {
      detach();
      report("connecting");
      /** @type {WebSocket} */
      let mine;
      try {
        mine = new WebSocket(typeof url === "function" ? url() : url);
      } catch {
        reconnector.closed();
        report("down");
        return;
      }
      ws = mine;
      if (binaryType) mine.binaryType = binaryType;
      mine.onopen = () => {
        if (ws !== mine) return;
        reconnector.opened();
        report("up");
        if (heartbeat) startHeartbeat(mine, heartbeat);
        onOpen?.(mine);
      };
      mine.onmessage = (e) => {
        if (ws !== mine) return;
        if (heartbeat) heard(mine, heartbeat, e.data);
        onMessage?.(e.data, e);
      };
      mine.onerror = () => { /* a close follows; that is where the retry is scheduled */ };
      mine.onclose = () => {
        if (ws !== mine) return;
        stopHeartbeat();
        ws = null;
        reconnector.closed();
        report("down");
      };
    },
    setTimeout,
    clearTimeout,
  });

  reconnector.start();

  return {
    /** @returns {boolean} false when there is no open socket to write to */
    send(data) {
      if (ws === null) return false;
      try {
        ws.send(data);
        return true;
      } catch {
        return false;
      }
    },
    nudge() {
      reconnector.nudge();
    },
    close() {
      if (ended) return;
      ended = true;
      reconnector.stop();
      detach();
      report("down");
    },
  };
}
