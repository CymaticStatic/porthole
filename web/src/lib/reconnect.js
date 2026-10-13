// Reconnect backoff: 1, 2, 4, 8, then 15 seconds forever; a successful open resets it.

const DELAYS = [1, 2, 4, 8, 15];

/**
 * Seconds to wait before retry number `attempt` (0-based).
 * @param {number} attempt
 * @returns {number}
 */
export function delayFor(attempt) {
  return DELAYS[Math.min(attempt, DELAYS.length - 1)];
}

/**
 * @param {{connect: () => void, setTimeout: Function, clearTimeout: Function}} deps
 * @returns {{start(): void, opened(): void, closed(): void, nudge(): void, stop(): void, state(): "connecting"|"up"|"waiting"}}
 */
export function createReconnector({ connect, setTimeout, clearTimeout }) {
  let attempt = 0;
  /** @type {any} */
  let timer = null;
  /** @type {"connecting"|"up"|"waiting"} */
  let mode = "connecting";
  let stopped = true;

  function dial() {
    timer = null;
    mode = "connecting";
    connect();
  }

  return {
    start() {
      stopped = false;
      attempt = 0;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      dial();
    },
    opened() {
      if (stopped) return;
      attempt = 0;
      mode = "up";
    },
    closed() {
      if (stopped || mode === "waiting") return;
      mode = "waiting";
      const ms = delayFor(attempt) * 1000;
      attempt += 1;
      timer = setTimeout(() => { if (!stopped) dial(); }, ms);
    },
    nudge() {
      if (stopped || mode !== "waiting") return;
      clearTimeout(timer);
      dial();
    },
    stop() {
      stopped = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
    },
    state() {
      return mode;
    },
  };
}
