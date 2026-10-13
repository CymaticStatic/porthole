// Previews screen (SPEC 4.10): the web servers running on one machine that Porthole can open. Opening one goes to a
// separate browser page with no bridge (a new tab, or the app's own in-app browser through `openExternal`).
import { h } from "../dom/h.js";
import { copy } from "../lib/copy.js";

/** @typedef {{port: number, pid: number | null, process: string | null, url: string}} Preview */
/** @typedef {{fleet: {machine(name: string): import("../net/machine.js").Machine | undefined}, route: import("../lib/route.js").Route, bridge?: {available: boolean, call(method: string, args?: unknown): Promise<any>}}} Ctx */

const POLL_MS = 10_000;

/** Only web addresses are ever opened. @param {string} url */
function webUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * @param {Element} root
 * @param {Ctx} ctx
 */
export function mount(root, ctx) {
  const route = ctx.route;
  const machine = route.machine ? ctx.fleet.machine(route.machine) : undefined;
  const panel = h("div", { class: "panel previews", "data-test": "previews" });
  root.replaceChildren(panel);

  /** @type {{previews: Preview[], proxyPort: number | null} | null} */
  let data = null;
  let lastKey = "";
  /** @type {string | null} */
  let failure = null;
  let stopped = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;

  /** @param {string} text @param {string} [test] */
  const note = (text, test) => h("p", { class: "panel-note", ...(test ? { "data-test": test } : {}) }, text);

  /** @param {Preview} p */
  function row(p) {
    const url = webUrl(p.url);
    /** @type {HTMLElement | null} */
    let open = null;
    if (url !== null) {
      open = h("a", {
        class: "btn btn-primary",
        href: url,
        target: "_blank",
        rel: "noopener noreferrer",
        "data-test": "preview-open",
        "aria-label": `${copy.previewOpen}: ${copy.previewPort(p.port)}`,
        on: {
          click: (/** @type {Event} */ e) => {
            const bridge = ctx.bridge;
            if (!bridge || !bridge.available) return; // a plain browser follows the link into a new tab
            e.preventDefault();
            bridge.call("openExternal", { url }).catch(() => { window.open(url, "_blank", "noopener,noreferrer"); });
          },
        },
      }, copy.previewOpen);
    }
    return h("li", { class: "preview", "data-test": "preview-row", "data-port": String(p.port) },
      h("div", { class: "preview-text" },
        h("span", { class: "preview-port" }, copy.previewPort(p.port)),
        p.process ? h("span", { class: "preview-process" }, p.process) : null),
      open);
  }

  function render() {
    if (stopped) return;
    if (!machine) { panel.replaceChildren(note(copy.emptyMachines)); return; }
    if (failure !== null) {
      panel.replaceChildren(...[
        note(copy.previewsFailed, "previews-error"),
        failure !== copy.previewsFailed ? h("p", { class: "panel-note panel-detail" }, failure) : null,
        h("button", { type: "button", class: "btn", "data-test": "previews-retry", on: { click: () => { void load(); } } }, copy.tryAgain),
      ].filter((n) => n !== null));
      return;
    }
    if (data === null) { panel.replaceChildren(note(copy.loading, "previews-loading")); return; }
    if (data.previews.length === 0) { panel.replaceChildren(note(copy.previewsEmpty, "previews-empty")); return; }
    panel.replaceChildren(...[
      h("ul", { class: "preview-list" }, data.previews.map(row)),
      data.proxyPort !== null ? h("p", { class: "panel-note", "data-test": "preview-proxy" }, copy.proxyPort(data.proxyPort)) : null,
    ].filter((n) => n !== null));
  }

  async function load() {
    if (stopped) return;
    clearTimeout(timer);
    if (!machine) { render(); return; }
    const r = await machine.api.get("/v1/previews");
    if (stopped) return;
    if (r.ok) {
      failure = null;
      const list = Array.isArray(r.data?.previews) ? /** @type {Preview[]} */ (r.data.previews) : [];
      const proxyPort = typeof r.data?.proxy?.port === "number" ? /** @type {number} */ (r.data.proxy.port) : null;
      const key = JSON.stringify([list, proxyPort]);
      if (key !== lastKey || data === null) {
        lastKey = key;
        data = { previews: list, proxyPort };
        render();
      }
    } else {
      failure = r.error;
      lastKey = "";
      data = null;
      render();
    }
    timer = setTimeout(() => { void load(); }, POLL_MS);
  }

  const onVisible = () => { if (document.visibilityState === "visible") void load(); };
  document.addEventListener("visibilitychange", onVisible);
  render();
  void load();

  return {
    unmount() {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      root.replaceChildren();
    },
  };
}
