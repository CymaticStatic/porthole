// The app shell: top bar, drawer (phone) or permanent column (≥ 840 px), reconnect strip and the #view the router fills.
// A screen is lazy-loaded from ./<name>.js and mounted with `ctx`; when it unmounts, every link it reported is dropped.
import { h } from "../dom/h.js";
import { copy } from "../lib/copy.js";
import { href, parse, VIEWS } from "../lib/route.js";
import { createOpenList, createSidebar } from "./sidebar.js";
import { createStrip } from "./strip.js";

/** @typedef {import("../lib/route.js").Route} Route */
/** @typedef {ReturnType<typeof import("../net/fleet.js").createFleet>} Fleet */

const WIDE_QUERY = "(min-width: 840px)";
const EDGE_PX = 24;
const SWIPE_PX = 56;
const NOTICE_MS = 4000;
const FOCUSABLE = "a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex='-1'])";

/**
 * @param {{
 *   app: HTMLElement,
 *   base: {fleet: Fleet, settings: import("../lib/types.js").SettingsStore, bridge: import("../lib/types.js").Bridge, copy: typeof copy, events: import("../lib/types.js").Events},
 *   openStore: import("../lib/storage.js").Store,
 *   win?: Window,
 *   setTimeout?: typeof setTimeout,
 *   clearTimeout?: typeof clearTimeout,
 * }} o
 * @returns {{start(): void, navigate(target: string | Route): void, destroy(): void}}
 */
export function createShell({ app, base, openStore, win = window, setTimeout: setT = (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: clearT = (id) => globalThis.clearTimeout(id) }) {
  const { fleet } = base;
  const doc = win.document;
  const openList = createOpenList(openStore);
  const mql = win.matchMedia(WIDE_QUERY);

  // ---- DOM ----
  const sidebar = createSidebar({ fleet, openList, onChoose: (hash) => choose(hash) });
  const closeBtn = h("button", { type: "button", class: "icon-btn drawer-close", "data-test": "drawer-close", "aria-label": copy.closeMenu, on: { click: () => close() } }, h("span", { "aria-hidden": "true" }, "✕"));
  const drawer = h("aside", { id: "drawer", class: "drawer", "data-test": "drawer", "aria-label": copy.menu, "aria-hidden": "true" },
    h("div", { class: "drawer-head" }, h("span", { class: "drawer-title" }, copy.appName), closeBtn),
    sidebar.el,
  );
  const scrim = h("div", { class: "scrim", "data-test": "scrim", "aria-hidden": "true", on: { click: () => close() } });

  const menuBtn = h("button", { type: "button", class: "icon-btn menu-btn", "data-test": "menu", "aria-label": copy.menu, "aria-controls": "drawer", "aria-expanded": "false", on: { click: () => open() } },
    h("span", { class: "bars", "aria-hidden": "true" }));
  const title = h("h1", { class: "title", "data-test": "title" });
  const machineBadge = h("span", { class: "machine-badge", "data-test": "machine-badge", hidden: true });
  const changesLink = h("a", { class: "top-link", "data-test": "changes-link", hidden: true }, copy.changes);
  const topbar = h("header", { class: "topbar" }, menuBtn, title, machineBadge, changesLink);
  const notice = h("div", { class: "notice", role: "status", "data-test": "notice", hidden: true });
  const strip = createStrip({ fleet, setTimeout: setT, clearTimeout: clearT });
  const view = h("div", { class: "view", id: "view", "data-test": "view" });
  const page = h("div", { class: "page" }, topbar, notice, strip.el, view);
  const shell = h("div", { class: "shell" }, drawer, scrim, page);

  // ---- drawer ----
  let isOpen = false;
  let hasEntry = false; // a history entry was pushed for the open drawer (so "back" closes it)
  let expectBack = 0;

  const wide = () => mql.matches;

  function applyDrawer() {
    const onPhone = !wide();
    const modal = onPhone && isOpen;
    drawer.setAttribute("aria-hidden", onPhone ? String(!isOpen) : "false");
    drawer.inert = onPhone && !isOpen;
    if (modal) { drawer.setAttribute("role", "dialog"); drawer.setAttribute("aria-modal", "true"); }
    else { drawer.removeAttribute("role"); drawer.removeAttribute("aria-modal"); }
    page.inert = modal;
    menuBtn.setAttribute("aria-expanded", String(modal));
    shell.classList.toggle("drawer-open", modal);
  }

  function open() {
    if (isOpen || wide()) return;
    isOpen = true;
    win.history.pushState({ portholeDrawer: true }, "");
    hasEntry = true;
    sidebar.render();
    applyDrawer();
    closeBtn.focus();
  }

  /** Closes the drawer and puts focus back on the menu button. @param {{keepEntry?: boolean}} [o] */
  function close({ keepEntry = false } = {}) {
    if (!isOpen) return;
    isOpen = false;
    applyDrawer();
    menuBtn.focus();
    if (hasEntry && !keepEntry) {
      hasEntry = false;
      expectBack++;
      win.history.back();
    }
  }

  /** A row was chosen in the sidebar. @param {string} hash */
  function choose(hash) {
    if (isOpen) {
      // The drawer's own history entry becomes the destination, so "back" returns to where the user was.
      win.history.replaceState(null, "", hash);
      hasEntry = false;
      close({ keepEntry: true });
      sync();
      return;
    }
    go(hash);
  }

  /** @param {string} hash */
  function go(hash) {
    if (win.location.hash === hash) { sync(); return; }
    win.location.hash = hash;
  }

  /** @param {string | Route} target */
  function navigate(target) {
    const hash = typeof target === "string" ? target : href(target);
    if (isOpen) choose(hash);
    else go(hash);
  }

  const onPop = () => {
    if (expectBack > 0) { expectBack--; return; }
    if (isOpen) { hasEntry = false; close({ keepEntry: true }); }
  };
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (!isOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Tab") {
      const items = /** @type {HTMLElement[]} */ ([...drawer.querySelectorAll(FOCUSABLE)]).filter((n) => !n.hidden && n.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const at = doc.activeElement;
      if (e.shiftKey && (at === first || !drawer.contains(at))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (at === last || !drawer.contains(at))) { e.preventDefault(); first.focus(); }
    }
  };
  const onWideChange = () => {
    if (wide() && isOpen) close();
    applyDrawer();
  };

  // A swipe from the left edge opens the drawer.
  /** @type {{x: number, y: number} | null} */
  let edge = null;
  /** @param {TouchEvent} e */
  const onTouchStart = (e) => {
    const t = e.touches[0];
    edge = !isOpen && !wide() && e.touches.length === 1 && t.clientX <= EDGE_PX ? { x: t.clientX, y: t.clientY } : null;
  };
  /** @param {TouchEvent} e */
  const onTouchMove = (e) => {
    if (!edge) return;
    const t = e.touches[0];
    const dx = t.clientX - edge.x;
    const dy = Math.abs(t.clientY - edge.y);
    if (dx >= SWIPE_PX && dx > dy * 2) { edge = null; open(); }
    else if (dy > SWIPE_PX) edge = null;
  };
  const onTouchEnd = () => { edge = null; };

  // ---- title ----
  /** @type {Route} */
  let route = { view: "inbox" };

  /** @param {Route} r */
  function titleFor(r) {
    switch (r.view) {
      case "inbox": return copy.inbox;
      case "settings": return copy.settings;
      case "usage": return copy.usage;
      case "previews": return copy.previews;
      case "config": return copy.configTitle(r.machine ?? "");
      case "changes": return copy.changes;
      default: {
        const s = r.machine ? fleet.machine(r.machine)?.tree()?.sessions.find((/** @type {{id: string, name: string}} */ x) => x.id === r.sessionId) : undefined;
        const name = s ? s.name : r.sessionId ?? "";
        return r.view === "term" ? `${name} · ${copy.linkTerminal}` : name;
      }
    }
  }

  function updateTitle() {
    const text = titleFor(route);
    title.textContent = text;
    title.title = text;
    machineBadge.textContent = route.machine ?? "";
    const onSession = (route.view === "chat" || route.view === "term") && !!route.machine && !!route.sessionId;
    changesLink.hidden = !onSession;
    if (onSession) changesLink.setAttribute("href", href({ view: "changes", machine: route.machine, sessionId: route.sessionId }));
    machineBadge.hidden = !route.machine;
    doc.title = text ? `${text} · ${copy.appName}` : copy.appName;
  }

  // ---- router ----
  /** @typedef {{handle: {unmount?: () => unknown} | null, drops: Map<string, () => void>, dead: boolean}} Mounted */
  /** @type {Mounted | null} */
  let current = null;
  let currentHref = "";
  let token = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let noticeTimer = null;

  /** @param {Mounted} m */
  async function unmountOne(m) {
    m.dead = true;
    try { await m.handle?.unmount?.(); } catch { /* a view that fails to unmount must not block the next one */ }
    for (const drop of [...m.drops.values()]) drop();
    m.drops.clear();
  }

  /** @param {Route} r @param {string} hrefStr */
  async function show(r, hrefStr) {
    const mine = ++token;
    currentHref = hrefStr;
    route = r;
    updateTitle();
    if ((r.view === "chat" || r.view === "term") && r.machine && r.sessionId) openList.touch({ machine: r.machine, sessionId: r.sessionId, view: r.view });
    const previous = current;
    current = null;
    if (previous) await unmountOne(previous);
    if (mine !== token) return;

    const root = h("div", { class: "view-root", "data-view": r.view }, h("p", { class: "meta view-loading" }, copy.loading));
    view.replaceChildren(root);
    /** @type {Mounted} */
    const mounted = { handle: null, drops: new Map(), dead: false };
    current = mounted;
    /** @type {(name: string, state: "connecting" | "up" | "down", retry?: () => void) => () => void} */
    const reportLink = (name, state, retry) => {
      const drop = fleet.reportLink(name, state, retry);
      const wrapped = () => { mounted.drops.delete(name); drop(); };
      if (!mounted.dead) mounted.drops.set(name, wrapped);
      else drop();
      return wrapped;
    };
    const ctx = { ...base, route: r, navigate, reportLink };
    try {
      const mod = /** @type {{mount(root: HTMLElement, ctx: import("../lib/types.js").Ctx): unknown}} */ (await import(`./${/** @type {Record<string, string>} */ (VIEWS)[r.view]}.js`));
      if (mine !== token) return;
      root.replaceChildren();
      mounted.handle = (await mod.mount(root, ctx)) ?? null;
      if (mine !== token) { await unmountOne(mounted); return; }
    } catch {
      if (mine !== token) { await unmountOne(mounted); return; }
      for (const drop of [...mounted.drops.values()]) drop();
      mounted.drops.clear();
      root.replaceChildren(h("div", { class: "view-failed", role: "alert", "data-test": "view-failed" },
        h("p", {}, copy.viewFailed),
        h("button", { type: "button", class: "btn", on: { click: () => win.location.reload() } }, copy.reload),
      ));
    }
  }

  /** @param {string} text */
  function flash(text) {
    notice.textContent = text;
    notice.hidden = false;
    if (noticeTimer !== null) clearT(noticeTimer);
    noticeTimer = setT(() => { notice.hidden = true; noticeTimer = null; }, NOTICE_MS);
  }

  /** Reads the address and shows its screen (once per distinct route). */
  function sync() {
    if (isOpen) close({ keepEntry: true });
    const raw = win.location.hash;
    const path = raw.replace(/^#/, "").replace(/^\/+/, "").replace(/\/+$/, "");
    const r = parse(raw);
    const unknown = path !== "" && path !== "inbox" && r.view === "inbox";
    if (path === "" ) {
      // First launch: reopen what was last open on this device.
      const last = openList.get()[0];
      if (last && !currentHref) {
        const to = href({ view: last.view, machine: last.machine, sessionId: last.sessionId });
        win.history.replaceState(null, "", to);
        void show(parse(to), to);
        return;
      }
    }
    if (unknown) flash(copy.pageUnknown);
    const to = href(r);
    if (win.location.hash !== to && (unknown || path === "")) win.history.replaceState(null, "", to);
    if (to === currentHref) return;
    void show(r, to);
  }

  const onHash = () => sync();

  // The terminal fills what is left under the chrome; keep --term-offset equal to the chrome's real height.
  const chrome = [topbar, notice, strip.el];
  const syncOffset = () => {
    const px = chrome.reduce((sum, el) => sum + (el.hidden ? 0 : el.offsetHeight), 0);
    shell.style.setProperty("--term-offset", `${px}px`);
  };
  /** @type {ResizeObserver | null} */
  let chromeObserver = null;

  return {
    start() {
      app.removeAttribute("aria-live");
      app.replaceChildren(shell);
      applyDrawer();
      syncOffset();
      if (typeof globalThis.ResizeObserver === "function") {
        const obs = new globalThis.ResizeObserver(syncOffset);
        for (const el of chrome) obs.observe(el);
        chromeObserver = obs;
      }
      mql.addEventListener("change", onWideChange);
      win.addEventListener("hashchange", onHash);
      win.addEventListener("popstate", onPop);
      doc.addEventListener("keydown", onKey, true);
      doc.addEventListener("touchstart", onTouchStart, { passive: true });
      doc.addEventListener("touchmove", onTouchMove, { passive: true });
      doc.addEventListener("touchend", onTouchEnd, { passive: true });
      fleet.subscribe(updateTitle);
      sync();
    },
    navigate,
    destroy() {
      mql.removeEventListener("change", onWideChange);
      win.removeEventListener("hashchange", onHash);
      win.removeEventListener("popstate", onPop);
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("touchstart", onTouchStart);
      doc.removeEventListener("touchmove", onTouchMove);
      doc.removeEventListener("touchend", onTouchEnd);
      strip.destroy();
      chromeObserver?.disconnect();
      sidebar.destroy();
      if (current) void unmountOne(current);
      current = null;
    },
  };
}
