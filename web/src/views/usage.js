// Usage screen (SPEC 4.11): how much of the Claude 5-hour and 7-day limits is used, when each resets, and when
// hostd last read the numbers. One block per machine, because each machine reads its own.
import { h } from "../dom/h.js";
import { copy } from "../lib/copy.js";
import { ago, resetsIn } from "../lib/format.js";

/** @typedef {{id: string, usedPercent: number, resetsAt: string | null, status?: string}} UsageWindow */
/** @typedef {{kind: "loading"} | {kind: "failed"} | {kind: "ok", windows: UsageWindow[], readAt: string}} MachineUsage */
/** @typedef {{fleet: {machines(): import("../net/machine.js").Machine[]}}} Ctx */

const REFRESH_MS = 60_000;
const RETRY_MS = 30_000;
const TICK_MS = 30_000;
/** The retry wait shown in the sentence for a failed read; matches RETRY_MS. */
const RETRY_TEXT = "30 seconds";
const ORDER = ["5h", "7d"];

/** @param {string} s */
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** @param {string} id */
function windowLabel(id) {
  return id === "5h" ? copy.usageFiveHours : copy.usageSevenDays;
}

/** @param {unknown} v @returns {v is UsageWindow} */
function isWindow(v) {
  if (!v || typeof v !== "object") return false;
  const w = /** @type {Record<string, unknown>} */ (v);
  return ORDER.includes(/** @type {string} */ (w.id)) && typeof w.usedPercent === "number" && Number.isFinite(w.usedPercent);
}

/**
 * @param {Element} root
 * @param {Ctx} ctx
 */
export function mount(root, ctx) {
  const machines = ctx.fleet.machines();
  const panel = h("div", { class: "panel usage", "data-test": "usage" });
  root.replaceChildren(panel);

  /** @type {Map<string, MachineUsage>} */
  const states = new Map(machines.map((m) => [m.name, { kind: /** @type {const} */ ("loading") }]));
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const timers = new Map();
  let stopped = false;

  /** @param {UsageWindow} w @param {number} now */
  function windowEl(w, now) {
    const pct = Math.max(0, Math.min(100, Math.round(w.usedPercent)));
    const label = windowLabel(w.id);
    const fill = h("div", { class: "meter-fill" });
    fill.style.setProperty("--pct", String(pct));
    const reset = w.resetsAt ? resetsIn(w.resetsAt, now) : "";
    return h("div", { class: "usage-window", "data-test": "usage-window", "data-window": w.id },
      h("div", { class: "usage-head" },
        h("span", { class: "usage-label" }, label),
        h("span", { class: "usage-percent" }, copy.usagePercent(pct))),
      h("div", { class: "meter", role: "progressbar", "aria-label": label, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct) }, fill),
      reset !== "" ? h("p", { class: "usage-reset" }, capital(reset)) : null);
  }

  /** @param {string} name @param {MachineUsage} s @param {number} now */
  function machineEl(name, s, now) {
    /** @type {(HTMLElement | null)[]} */
    let body;
    if (s.kind === "loading") {
      body = [h("p", { class: "panel-note" }, copy.loading)];
    } else if (s.kind === "failed") {
      body = [h("p", { class: "panel-note", "data-test": "usage-unavailable" }, copy.usageUnavailable(RETRY_TEXT))];
    } else if (s.windows.length === 0) {
      body = [h("p", { class: "panel-note", "data-test": "usage-empty" }, copy.usageNotRead)];
    } else {
      const read = ago(s.readAt, now);
      body = [
        ...ORDER.flatMap((id) => s.windows.filter((w) => w.id === id)).map((w) => windowEl(w, now)),
        read !== "" ? h("p", { class: "usage-read", "data-test": "usage-read" }, copy.lastRead(read)) : null,
      ];
    }
    return h("section", { class: "usage-machine", "data-test": "usage-machine", "data-machine": name },
      machines.length > 1 ? h("h2", { class: "section-title" }, name) : null,
      ...body);
  }

  function render() {
    if (stopped) return;
    if (machines.length === 0) { panel.replaceChildren(h("p", { class: "panel-note" }, copy.emptyMachines)); return; }
    const now = Date.now();
    panel.replaceChildren(...machines.map((m) => machineEl(m.name, states.get(m.name) ?? { kind: "loading" }, now)));
  }

  /** @param {import("../net/machine.js").Machine} m */
  async function load(m) {
    if (stopped) return;
    clearTimeout(timers.get(m.name));
    const r = await m.api.get("/v1/usage");
    if (stopped) return;
    let next = RETRY_MS;
    if (r.ok && r.data && typeof r.data === "object") {
      const windows = Array.isArray(r.data.windows) ? r.data.windows.filter(isWindow) : [];
      const readAt = typeof r.data.readAt === "string" ? r.data.readAt : "";
      states.set(m.name, { kind: "ok", windows, readAt });
      next = REFRESH_MS;
    } else {
      states.set(m.name, { kind: "failed" });
    }
    render();
    timers.set(m.name, setTimeout(() => { void load(m); }, next));
  }

  const tick = setInterval(render, TICK_MS);
  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    render();
    for (const m of machines) void load(m);
  };
  document.addEventListener("visibilitychange", onVisible);
  render();
  for (const m of machines) void load(m);

  return {
    unmount() {
      stopped = true;
      clearInterval(tick);
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      document.removeEventListener("visibilitychange", onVisible);
      root.replaceChildren();
    },
  };
}
