// A WebSocket that reconnects by itself (backoff in lib/reconnect.js). Every dependency is injected.
import { createReconnector } from "../lib/reconnect.js";

/** @typedef {"connecting" | "up" | "down"} LinkState */
/**
 * @typedef {object} SocketOptions
 * @property {string | (() => string)} url a function is called on every (re)connect, so a query such as `since=` stays current
 * @property {any} WebSocket the constructor to use
 * @property {Function} setTimeout
 * @property {Function} clearTimeout
 * @property {(ws: any) => void} [onOpen]
 * @property {(data: any, event: any) => void} [onMessage]
 * @property {(state: LinkState) => void} [onState]
 * @property {"blob" | "arraybuffer"} [binaryType]
 */

/**
 * Opens the socket at once and keeps it open until `close()`.
 * @param {SocketOptions} o
 * @returns {{send(data: string | ArrayBufferLike | ArrayBufferView): boolean, nudge(): void, close(): void}}
 */
export function openSocket({ url, WebSocket, setTimeout, clearTimeout, onOpen, onMessage, onState, binaryType }) {
  /** @type {any} */
  let ws = null;
  let ended = false;
  /** @type {LinkState | null} */
  let last = null;
  /** @param {LinkState} s */
  const report = (s) => {
    if (s === last) return;
    last = s;
    onState?.(s);
  };

  /** @type {ReturnType<typeof createReconnector>} */
  const reconnector = createReconnector({
    connect() {
      report("connecting");
      /** @type {any} */
      let mine;
      try {
        mine = new WebSocket(typeof url === "function" ? url() : url);
      } catch {
        ws = null;
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
        onOpen?.(mine);
      };
      mine.onmessage = (/** @type {any} */ e) => {
        if (ws !== mine) return;
        onMessage?.(e.data, e);
      };
      mine.onerror = () => { /* a close follows; that is where the retry is scheduled */ };
      mine.onclose = () => {
        if (ws !== mine) return;
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
      const w = ws;
      ws = null;
      if (w) {
        w.onopen = w.onmessage = w.onerror = w.onclose = null;
        try { w.close(); } catch { /* already closed */ }
      }
      report("down");
    },
  };
}
