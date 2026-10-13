// The reconnect strip (SPEC 4.13): sits under the top bar on every screen. While any link (a machine's events link or a
// link a view reported with ctx.reportLink) has been down for more than a second it says "Reconnecting…" with the
// names and a "Try now" button; when everything is up again it says "Connected again." for 2 s, then goes away.
import { copy } from "../lib/copy.js";
import { h } from "../dom/h.js";

const DOWN_AFTER_MS = 1000;
const SHOWN_AFTER_MS = 2000;

/**
 * @param {{fleet: {links(): {name: string, state: string, retry: () => void}[], subscribe(fn: () => void): () => void},
 *   setTimeout?: (fn: () => void, ms: number) => any, clearTimeout?: (id: any) => void, now?: () => number}} o
 * @returns {{el: HTMLElement, destroy(): void}}
 */
export function createStrip({ fleet, setTimeout: setT = (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: clearT = (id) => globalThis.clearTimeout(id), now = Date.now }) {
  const text = h("span", { class: "strip-text" });
  const button = h("button", { type: "button", class: "strip-button", "data-test": "strip-retry" }, copy.tryNow);
  const el = h("div", { class: "strip", role: "status", "data-test": "strip", "data-state": "hidden" }, text, button);

  /** @type {Map<string, number>} when each link that is not up first went down */
  const downSince = new Map();
  /** @type {{name: string, retry: () => void}[]} */
  let failing = [];
  /** @type {"hidden" | "down" | "up"} */
  let mode = "hidden";
  let timer = /** @type {any} */ (null);

  const stopTimer = () => {
    if (timer !== null) { clearT(timer); timer = null; }
  };
  /** @param {number} ms */
  const later = (ms) => {
    stopTimer();
    timer = setT(() => { timer = null; evaluate(); }, ms);
  };

  /** @param {"hidden" | "down" | "up"} next */
  function show(next) {
    mode = next;
    el.dataset.state = next;
    if (next === "down") {
      text.textContent = `${copy.reconnecting} ${failing.map((f) => f.name).join(", ")}`;
    } else if (next === "up") {
      text.textContent = copy.reconnected;
    }
  }

  function evaluate() {
    const t = now();
    const links = fleet.links();
    const names = new Set(links.map((l) => l.name));
    for (const name of [...downSince.keys()]) if (!names.has(name)) downSince.delete(name);
    /** @type {number | null} */
    let soonest = null;
    failing = [];
    for (const l of links) {
      if (l.state === "up") { downSince.delete(l.name); continue; }
      // A link that was never down (first connect) is "connecting", not failing; one that is retrying stays down.
      if (l.state === "down" && !downSince.has(l.name)) downSince.set(l.name, t);
      const since = downSince.get(l.name);
      if (since === undefined) continue;
      const wait = since + DOWN_AFTER_MS - t;
      if (wait <= 0) failing.push({ name: l.name, retry: l.retry });
      else soonest = soonest === null ? wait : Math.min(soonest, wait);
    }
    if (failing.length > 0) {
      stopTimer();
      show("down");
      return;
    }
    if (mode === "down") {
      show("up");
      later(SHOWN_AFTER_MS);
      return;
    }
    if (mode === "up") {
      if (timer === null) show("hidden");
      return;
    }
    if (soonest !== null) later(soonest);
  }

  button.addEventListener("click", () => {
    for (const f of failing) f.retry();
  });
  const off = fleet.subscribe(evaluate);
  evaluate();

  return {
    el,
    destroy() {
      stopTimer();
      off();
    },
  };
}
