// The chat view (SPEC 4.2): one session's conversation, the key row, and the composer.
// The transcript arrives over `wss://host/v1/sessions/:id/chat`: a `backlog` (newest page) on every (re)connect, then `append`s.
// Older pages come from `GET /v1/sessions/:id/chat?before=<page.start>`. Items are merged by lib/chatmodel.js.
import { h } from "../dom/h.js";
import { mdom } from "../dom/mdom.js";
import { createChat, toolSummary } from "../lib/chatmodel.js";
import { ago } from "../lib/format.js";
import { toTree } from "../lib/markdown.js";
import { openSocket } from "../net/socket.js";
import { createComposer } from "./composer.js";
import { createKeyRow } from "./keyrow.js";
import { attachReadAloud } from "./talk.js";

const PAGE = 50;
const STICK_PX = 80; // closer to the bottom than this counts as "at the bottom"
const LOAD_OLDER_PX = 40;
const SVG_NS = "http://www.w3.org/2000/svg";

/** The small microphone that marks what was said at the desk. @returns {SVGElement} */
function micMark() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM5 11a7 7 0 0014 0M12 18v3");
  svg.append(path);
  return svg;
}

/** A tiny event bus for read-aloud (it listens for newly arrived items). */
function createBus() {
  /** @type {Map<string, Set<(data: any) => void>>} */
  const map = new Map();
  return {
    /** @param {string} name @param {(data: any) => void} fn */
    on(name, fn) {
      const set = map.get(name) ?? new Set();
      set.add(fn);
      map.set(name, set);
      return () => { set.delete(fn); };
    },
    /** @param {string} name @param {any} data */
    emit(name, data) {
      for (const fn of [...(map.get(name) ?? [])]) fn(data);
    },
  };
}

/**
 * @param {HTMLElement} root @param {any} ctx
 * @returns {{unmount(): void}}
 */
export function mount(root, ctx) {
  const { copy, route } = ctx;
  const sessionId = String(route.sessionId);
  const machine = ctx.fleet.machine(route.machine);
  if (!machine) {
    root.replaceChildren(h("p", { class: "chat-problem" }, copy.chatFailed));
    return { unmount() { root.replaceChildren(); } };
  }

  const sessionPath = `/v1/sessions/${encodeURIComponent(sessionId)}`;
  const chat = createChat();
  const bus = createBus();
  let alive = true;
  let gotBacklog = false;
  let hasOlder = false;
  let start = 0;
  let loadingOlder = false;
  let stick = true;
  /** @type {() => void} */
  let dropLink = () => {};
  /** @type {Map<string, HTMLElement>} */
  const nodes = new Map();

  // ---- the DOM ------------------------------------------------------------------------------------------------------------------
  const earlier = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "chat-earlier", "data-test": "show-earlier", on: { click: () => void loadOlder() } }, copy.showEarlier));
  earlier.hidden = true;
  const note = h("p", { class: "chat-note", "data-test": "chat-note", role: "status" }, copy.loading);
  const list = h("div", { class: "chat-list" });
  const scroller = h("div", { class: "chat-scroll", "data-test": "chat", role: "log", "aria-label": copy.linkChat, tabindex: "0" }, earlier, note, list);
  const pill = h("button", { type: "button", class: "chat-pill", "data-test": "new-messages", on: { click: () => { toBottom(); } } }, copy.newMessages);
  pill.hidden = true;

  const readAloud = attachReadAloud(ctx, bus);
  const readBtn = readAloud.button(() => chat.newestAssistant()?.text ?? "");
  const bar = h("div", { class: "chat-bar" }, readBtn);
  bar.hidden = true;

  const keyRow = createKeyRow({ ctx, machine, sessionId });
  const composer = createComposer({ ctx, machine, sessionId, talkRoot: root });
  const dock = h("div", { class: "chat-dock" }, keyRow.el, composer.el);
  const view = h("div", { class: "chat-view" }, bar, h("div", { class: "chat-body" }, scroller, pill), dock);
  root.replaceChildren(view);

  // ---- items --------------------------------------------------------------------------------------------------------------------
  /** @param {any} item @returns {HTMLElement} */
  function buildItem(item) {
    const when = h("span", { class: "meta" }, ago(item.at, Date.now()));
    if (item.kind === "tools") {
      return h(
        "details",
        { class: "chat-tools", "data-id": item.id },
        h("summary", {}, toolSummary(item)),
        h("ul", { class: "chat-tool-list" }, ...item.tools.map((/** @type {string} */ t) => h("li", {}, t))),
      );
    }
    const mine = item.kind === "user";
    const head = h("p", { class: "bubble-head" }, h("span", { class: "bubble-who" }, mine ? copy.you : copy.agent), " ", when);
    /** @type {Record<string, any>} */
    const attrs = { class: `bubble ${mine ? "bubble-mine" : "bubble-agent"}`, "data-test": "bubble", "data-kind": item.kind, "data-id": item.id };
    if (item.via) attrs["data-via"] = item.via;
    const body = mine ? h("p", { class: "bubble-text" }, item.text) : h("div", { class: "bubble-md" }, mdom(toTree(item.text)));
    const via = item.via === "live-voice" ? h("p", { class: "bubble-via" }, micMark(), h("span", {}, copy.saidAtDesk)) : null;
    return h("div", attrs, head, via, body);
  }

  function renderList() {
    const items = chat.items();
    list.replaceChildren(
      ...items.map((item) => {
        let n = nodes.get(item.id);
        if (!n) {
          n = buildItem(item);
          nodes.set(item.id, n);
        }
        return n;
      }),
    );
    bar.hidden = chat.newestAssistant() === null;
    earlier.hidden = !hasOlder;
    if (!gotBacklog) return;
    note.hidden = items.length > 0;
    if (items.length === 0) note.textContent = copy.chatEmpty;
  }

  /** @param {string} text */
  function setNote(text) {
    note.textContent = text;
    note.hidden = text === "";
  }

  const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_PX;

  function toBottom() {
    scroller.scrollTop = scroller.scrollHeight;
    pill.hidden = true;
  }

  /** @param {number} fresh how many items just arrived live */
  function afterLive(fresh) {
    if (fresh === 0) return;
    if (stick) {
      toBottom();
    } else {
      pill.hidden = false;
    }
  }

  // (stick: was the list at the bottom just before the newest items arrived)

  // ---- loading ------------------------------------------------------------------------------------------------------------------
  async function loadOlder() {
    if (loadingOlder || !hasOlder || !alive) return;
    loadingOlder = true;
    earlier.disabled = true;
    const r = await machine.api.get(`${sessionPath}/chat?before=${encodeURIComponent(String(start))}&limit=${PAGE}`);
    loadingOlder = false;
    if (!alive) return;
    earlier.disabled = false;
    if (!r.ok) {
      setNote(r.status === 0 || !r.error ? copy.chatFailed : `${copy.chatFailed} ${copy.reasonLine(r.error)}`);
      return;
    }
    const page = r.data;
    const before = scroller.scrollHeight - scroller.scrollTop;
    chat.older(page);
    start = page.start;
    hasOlder = Boolean(page.hasOlder);
    setNote("");
    renderList();
    scroller.scrollTop = scroller.scrollHeight - before; // the message that was at the top stays where it was
  }

  /** @param {string} raw */
  function onMessage(raw) {
    /** @type {any} */
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "backlog" && msg.page) {
      const first = !gotBacklog;
      stick = first || atBottom();
      chat.backlog(msg.page);
      if (first) {
        gotBacklog = true;
        start = msg.page.start;
        hasOlder = Boolean(msg.page.hasOlder);
      }
      setNote("");
      renderList();
      if (typeof msg.page.note === "string" && msg.page.note !== "" && chat.items().length === 0) setNote(copy.reasonLine(msg.page.note));
      if (first || stick) toBottom();
    } else if (msg.type === "append" && Array.isArray(msg.items)) {
      stick = atBottom();
      const fresh = chat.append(msg.items, msg.end);
      renderList();
      afterLive(fresh.length);
      if (fresh.length > 0) bus.emit("items", fresh);
    } else if (msg.type === "error") {
      setNote(typeof msg.error === "string" && msg.error !== "" ? `${copy.chatFailed} ${copy.reasonLine(msg.error)}` : copy.chatFailed);
    }
  }

  const wsUrl = (() => {
    const u = new URL(String(machine.origin));
    return `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}${sessionPath}/chat`;
  })();
  const socket = openSocket({
    url: wsUrl,
    WebSocket: globalThis.WebSocket,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    onState(state) {
      if (!alive) return;
      dropLink = ctx.reportLink(copy.linkChat, state, () => socket.nudge());
    },
    onMessage,
  });

  scroller.addEventListener("scroll", () => {
    if (atBottom()) {
      pill.hidden = true;
    }
    if (scroller.scrollTop < LOAD_OLDER_PX) void loadOlder();
  });

  // times in the bubbles stay roughly right while the page is open
  const clock = globalThis.setInterval(() => {
    for (const item of chat.items()) {
      const n = nodes.get(item.id);
      const meta = n?.querySelector(".bubble-head .meta");
      if (meta) meta.textContent = ago(item.at, Date.now());
    }
  }, 60_000);

  return {
    unmount() {
      alive = false;
      clearInterval(clock);
      socket.close();
      dropLink();
      readAloud.detach();
      composer.destroy();
      keyRow.destroy();
      root.replaceChildren();
    },
  };
}
