// The sidebar content (SPEC 4.2), shown in the drawer on a phone and as the permanent column on a wide screen:
// Machines, Inbox, "Open on this device", Chats, Terminals (a tree), Settings, Config. Built with h() only.
import { h } from "../dom/h.js";
import { copy } from "../lib/copy.js";
import { href } from "../lib/route.js";

/** @typedef {import("../lib/tree.js").OpenEntry} OpenEntry */
/** @typedef {import("../lib/tree.js").Node} Node */
/** @typedef {import("../lib/storage.js").Store} Store */

const OPEN_KEY = "porthole:open";
const OPEN_CAP = 12;
const PULL_PX = 72;

/** @param {unknown} e @returns {e is OpenEntry} */
function isOpenEntry(e) {
  if (!e || typeof e !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (e);
  return typeof o.machine === "string" && typeof o.sessionId === "string" && (o.view === "chat" || o.view === "term");
}

/**
 * The "open on this device" list (`porthole:open`, newest first): the chats and terminals opened here, reopened on launch.
 * @param {Store} store
 */
export function createOpenList(store) {
  /** @type {Set<() => void>} */
  const subs = new Set();
  /** @returns {OpenEntry[]} */
  const get = () => {
    try {
      const raw = store.getItem(OPEN_KEY);
      const v = raw === null ? [] : JSON.parse(raw);
      return Array.isArray(v) ? v.filter(isOpenEntry).map((e) => ({ machine: e.machine, sessionId: e.sessionId, view: e.view })) : [];
    } catch {
      return [];
    }
  };
  /** @param {OpenEntry[]} list */
  const put = (list) => {
    try { store.setItem(OPEN_KEY, JSON.stringify(list.slice(0, OPEN_CAP))); } catch { /* the list is only a convenience */ }
    for (const fn of [...subs]) {
      try { fn(); } catch { /* a bad subscriber must not break the list */ }
    }
  };
  /** @param {OpenEntry} a @param {OpenEntry} b */
  const same = (a, b) => a.machine === b.machine && a.sessionId === b.sessionId && a.view === b.view;
  return {
    get,
    /** Moves (or adds) one entry to the front. @param {OpenEntry} entry */
    touch(entry) {
      const list = get();
      if (list[0] && same(list[0], entry)) return;
      put([entry, ...list.filter((e) => !same(e, entry))]);
    },
    /** @param {OpenEntry} entry */
    remove(entry) {
      put(get().filter((e) => !same(e, entry)));
    },
    /** @param {() => void} fn */
    subscribe(fn) {
      subs.add(fn);
      return () => { subs.delete(fn); };
    },
  };
}

/** @param {string} status */
const statusWord = (status) => /** @type {Record<string, string>} */ (copy.status)[status] ?? copy.status.unknown;

/** A status dot: its shape (ring, filled, check, hollow) and its accessible name carry the meaning, never colour alone. @param {string} status */
function dot(status) {
  return h("span", { class: "dot", "data-status": status, role: "img", "aria-label": statusWord(status) });
}

/** @param {string} state "up" | "connecting" | "down" */
function linkDot(state) {
  const word = state === "up" ? copy.machineUp : state === "down" ? copy.machineDown : copy.machineConnecting;
  return h("span", { class: "dot dot-link", "data-state": state, role: "img", "aria-label": word });
}

const micMark = () => h("span", { class: "mic", role: "img", "aria-label": copy.liveVoiceOn });

/**
 * @param {{
 *   fleet: {sidebar(open: OpenEntry[]): ReturnType<typeof import("../lib/tree.js").buildSidebar>, inbox(): ReturnType<typeof import("../lib/inboxmodel.js").groupInbox>, machines(): {name: string, state(): string, api: {get(path: string): Promise<unknown>}}[], subscribe(fn: () => void): () => void, nudgeAll(): void},
 *   openList: ReturnType<typeof createOpenList>,
 *   onChoose: (hash: string) => void,
 * }} o
 * @returns {{el: HTMLElement, render(force?: boolean): void, refresh(): Promise<void>, destroy(): void}}
 */
export function createSidebar({ fleet, openList, onChoose }) {
  const refreshing = h("div", { class: "pull", role: "status", "data-test": "refreshing", hidden: true }, copy.refreshing);
  const list = h("div", { class: "side-list", "data-test": "drawer-list" });
  const el = h("div", { class: "side" }, refreshing, list);
  /** @type {Set<string>} */
  const collapsed = new Set();
  let signature = "";

  /** @param {string} key */
  function toggle(key) {
    if (!collapsed.delete(key)) collapsed.add(key);
    render(true);
  }

  /** A link that navigates through the shell (so the drawer can close and history stays right). @param {string} to @param {Record<string, string>} attrs @param {(HTMLElement | string | null)[]} kids */
  function link(to, attrs, kids) {
    return h("a", {
      href: to,
      ...attrs,
      on: {
        click: (/** @type {MouseEvent} */ e) => {
          if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          onChoose(to);
        },
      },
    }, ...kids);
  }

  /** @param {string} title */
  const heading = (title) => h("h2", { class: "side-title" }, title);

  /** @param {string} key @param {boolean} open @param {(HTMLElement | string)[]} kids */
  function toggleHead(key, open, kids) {
    return h("button", { type: "button", class: "node-head", "aria-expanded": String(open), "data-fk": key, on: { click: () => toggle(key) } }, h("span", { class: "chev", "aria-hidden": "true" }), ...kids);
  }

  /** @param {Node} n @param {string} machine @returns {HTMLElement} */
  function treeNode(n, machine) {
    if ("id" in n) {
      return link(href({ view: "term", machine, sessionId: n.id }), { class: "row row-pane", "data-kind": "pane", "data-label": n.label, "data-id": n.id, "data-fk": n.key }, [
        dot(n.status),
        h("span", { class: "row-name" }, n.label),
        h("span", { class: "row-state" }, statusWord(n.status)),
      ]);
    }
    const open = !collapsed.has(n.key);
    return h("div", { class: "node", "data-kind": n.kind, "data-label": n.label },
      toggleHead(n.key, open, [dot(n.status), h("span", { class: "row-name" }, n.label)]),
      h("div", { role: "group", class: "tree-group", hidden: !open }, n.children.map((c) => treeNode(c, machine))),
    );
  }

  /** @param {ReturnType<typeof import("../lib/tree.js").buildSidebar>} side @param {number} inboxCount */
  function build(side, inboxCount) {
    /** @type {HTMLElement[]} */
    const out = [];

    // Machines
    out.push(h("section", { class: "side-section", "data-test": "machines" },
      heading(copy.machines),
      side.machines.length === 0 ? h("p", { class: "meta side-empty" }, copy.emptyMachines) : null,
      side.machines.map((m) => h("div", { class: "machine", "data-machine": m.name, "data-state": m.state },
        h("div", { class: "machine-line" },
          linkDot(m.state),
          h("span", { class: "row-name" }, m.name),
          m.needYou > 0 ? h("span", { class: "needs" }, copy.needYou(m.needYou)) : null,
        ),
        h("div", { class: "meta machine-state" }, m.state === "up" ? copy.machineUp : m.state === "down" ? copy.machineDown : copy.machineConnecting),
      )),
    ));

    // Inbox
    out.push(h("section", { class: "side-section" },
      link(href({ view: "inbox" }), { class: "row row-main", "data-fk": "inbox", "data-test": "nav-inbox" }, [
        h("span", { class: "row-name" }, copy.inbox),
        inboxCount > 0 ? h("span", { class: "badge" }, String(inboxCount), h("span", { class: "visually-hidden" }, ` ${copy.needYou(inboxCount)}`)) : null,
      ]),
    ));

    // Open on this device (the switcher)
    out.push(h("section", { class: "side-section", "data-test": "open-list" },
      heading(copy.openOnDevice),
      side.active.length === 0 ? h("p", { class: "meta side-empty" }, copy.emptyOpen) : null,
      side.active.map((r) => h("div", { class: "row-wrap", "data-machine": r.machine, "data-id": r.id },
        link(href({ view: r.view, machine: r.machine, sessionId: r.id }), { class: "row row-open", "data-fk": `open|${r.view}|${r.machine}|${r.id}` }, [
          dot(r.status),
          h("span", { class: "row-name" }, r.name),
          h("span", { class: "row-state" }, `${r.view === "chat" ? copy.linkChat : copy.linkTerminal} · ${r.machine}`),
          r.liveVoice ? micMark() : null,
        ]),
        h("button", {
          type: "button", class: "row-x", "aria-label": copy.closeSession(r.name), "data-fk": `close|${r.view}|${r.machine}|${r.id}`,
          on: { click: () => openList.remove({ machine: r.machine, sessionId: r.id, view: r.view }) },
        }, h("span", { "aria-hidden": "true" }, "✕")),
      )),
    ));

    // Chats
    out.push(h("section", { class: "side-section", "data-test": "chats" },
      heading(copy.chats),
      side.chats.length === 0 ? h("p", { class: "meta side-empty" }, copy.emptyChats) : null,
      side.chats.map((g) => h("div", { class: "chat-group" },
        h("h3", { class: "group-title" }, g.label),
        g.rows.map((r) => link(href({ view: "chat", machine: r.machine, sessionId: r.id }), { class: "row", "data-kind": "chat", "data-label": r.name, "data-fk": `chat|${r.machine}|${r.id}` }, [
          dot(r.status),
          h("span", { class: "row-name" }, r.name),
          h("span", { class: "row-state" }, statusWord(r.status)),
          r.liveVoice ? micMark() : null,
        ])),
      )),
    ));

    // Terminals (a tree per machine)
    out.push(h("section", { class: "side-section" },
      heading(copy.terminals),
      side.terminals.length === 0 ? h("p", { class: "meta side-empty" }, copy.emptyTerminals) : null,
      side.terminals.map((t) => {
        const key = `terminals|${t.machine}`;
        const open = !collapsed.has(key);
        return h("section", { class: "term-machine", "data-test": "terminals", "data-machine": t.machine },
          toggleHead(key, open, [h("span", { class: "row-name" }, t.machine)]),
          h("div", { role: "group", class: "tree-group", hidden: !open },
            t.nodes.length === 0 ? h("p", { class: "meta side-empty" }, copy.emptyTerminals) : null,
            t.nodes.map((n) => treeNode(n, t.machine)),
          ),
        );
      }),
    ));

    // Settings, Usage, Config
    out.push(h("section", { class: "side-section side-foot" },
      link(href({ view: "settings" }), { class: "row row-main", "data-fk": "settings", "data-test": "nav-settings" }, [h("span", { class: "row-name" }, copy.settings)]),
      link(href({ view: "usage" }), { class: "row row-main", "data-fk": "usage", "data-test": "nav-usage" }, [h("span", { class: "row-name" }, copy.usage)]),
      side.machines.map((m) => link(href({ view: "config", machine: m.name }), { class: "row row-main", "data-fk": `config|${m.name}`, "data-machine": m.name }, [h("span", { class: "row-name" }, copy.configFor(m.name))])),
      side.machines.map((m) => link(href({ view: "previews", machine: m.name }), { class: "row row-main", "data-fk": `previews|${m.name}`, "data-test": "nav-previews", "data-machine": m.name }, [h("span", { class: "row-name" }, copy.previewsFor(m.name))])),
    ));
    return out;
  }

  /** @param {boolean} [force] */
  function render(force = false) {
    const open = openList.get();
    const side = fleet.sidebar(open);
    const inboxCount = fleet.inbox().needsYou.reduce((n, g) => n + g.machines.reduce((k, m) => k + m.items.length, 0), 0);
    const sig = JSON.stringify([side, inboxCount, open, [...collapsed]]);
    if (!force && sig === signature) return;
    signature = sig;
    const active = /** @type {HTMLElement | null} */ (el.contains(document.activeElement) ? document.activeElement : null);
    const focusKey = active?.dataset.fk;
    const top = list.scrollTop;
    list.replaceChildren(...build(side, inboxCount));
    list.scrollTop = top;
    if (focusKey) {
      for (const c of list.querySelectorAll("[data-fk]")) {
        if (/** @type {HTMLElement} */ (c).dataset.fk === focusKey) { /** @type {HTMLElement} */ (c).focus(); break; }
      }
    }
  }

  /** Pull-to-refresh (SPEC 4.1): every link is nudged and every machine that is up is asked for its sessions again, which forces a re-scan. */
  async function refresh() {
    refreshing.hidden = false;
    fleet.nudgeAll();
    try {
      await Promise.allSettled(fleet.machines().filter((m) => m.state() === "up").map((m) => m.api.get("/v1/sessions")));
    } finally {
      refreshing.hidden = true;
    }
  }

  /** @type {number | null} */
  let pullFrom = null;
  let pulled = 0;
  list.addEventListener("touchstart", (e) => {
    pullFrom = list.scrollTop <= 0 ? e.touches[0].clientY : null;
    pulled = 0;
  }, { passive: true });
  list.addEventListener("touchmove", (e) => {
    if (pullFrom !== null) pulled = e.touches[0].clientY - pullFrom;
  }, { passive: true });
  list.addEventListener("touchend", () => {
    const go = pullFrom !== null && pulled >= PULL_PX && list.scrollTop <= 0;
    pullFrom = null;
    pulled = 0;
    if (go) void refresh();
  }, { passive: true });

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; render(); });
  };
  const offFleet = fleet.subscribe(schedule);
  const offOpen = openList.subscribe(schedule);
  render(true);

  return {
    el,
    render,
    refresh,
    destroy() { offFleet(); offOpen(); },
  };
}
