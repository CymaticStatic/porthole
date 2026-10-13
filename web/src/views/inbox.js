// Inbox screen (SPEC 4.6): Needs you / Working / Done, each grouped by project folder and then by machine.
// Every card can be stopped, archived (button, or a swipe to the left) and opened; a needs-you card with one
// single-choice question also has its option buttons and a typed answer, and one multi-select question has tick boxes
// and a Submit button. Several questions at once are answered in the terminal (hostd refuses them, see inboxmodel.answerMode).
//
// Rendering never throws away what Ben is doing: cards are kept between updates and only the ones whose data
// changed are replaced, typed answers live outside the DOM, and focus is put back after a replacement.
import { h } from "../dom/h.js";
import { copy } from "../lib/copy.js";
import { ago, basename } from "../lib/format.js";
import { answerMode, contextRing } from "../lib/inboxmodel.js";
import { asObject } from "../lib/json.js";
import { href } from "../lib/route.js";

/** @typedef {import("../lib/inboxmodel.js").Item & {sessionId: string, kind: string, title: string, body: string}} Card */
/** @typedef {import("../net/api.js").ApiResult} ApiResult */
/** @typedef {{fleet: ReturnType<typeof import("../net/fleet.js").createFleet>}} Ctx */
/** What the screen remembers about one card between updates. @typedef {{expanded: boolean, busy: boolean, answered: string, notice: string, detail: string}} Ui */

const SWIPE_PX = 80; // how far left a swipe must go to archive
const SWIPE_START_PX = 10; // movement before we decide whether it is a swipe or a scroll
const SWIPE_RATIO = 2; // "mostly horizontal": at least twice as far across as up or down
const AGE_TICK_MS = 30_000;
const MAX_ANSWER = 2000; // hostd's limit for a typed answer
const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * @param {string} tag @param {Record<string, string | number>} attrs @param {...Element} kids
 * @returns {SVGElement}
 */
function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...kids);
  return el;
}

/** Colour is never the only signal: a ring with its percent as words, plus a triangle when low. @param {{percent: number, warn: boolean}} ring */
function ringNode(ring) {
  const pct = Math.max(0, Math.min(100, ring.percent));
  const dial = svg("svg", { viewBox: "0 0 24 24", class: "inbox-ring", "aria-hidden": "true", focusable: "false" },
    svg("circle", { class: "inbox-ring-track", cx: 12, cy: 12, r: 9, fill: "none", "stroke-width": 3 }),
    svg("circle", { class: "inbox-ring-arc", cx: 12, cy: 12, r: 9, fill: "none", "stroke-width": 3, pathLength: 100, "stroke-dasharray": `${pct} ${100 - pct}`, transform: "rotate(-90 12 12)" }));
  const kids = [dial];
  if (ring.warn) {
    kids.push(svg("svg", { viewBox: "0 0 24 24", class: "inbox-warn-shape", "aria-hidden": "true", focusable: "false" },
      svg("polygon", { points: "12,3 22,21 2,21", fill: "none", "stroke-width": 2, "stroke-linejoin": "round" }),
      svg("line", { x1: 12, y1: 9.5, x2: 12, y2: 14.5, "stroke-width": 2, "stroke-linecap": "round" }),
      svg("circle", { cx: 12, cy: 17.6, r: 1.2, stroke: "none" })));
  }
  return h("span", { class: "inbox-context" + (ring.warn ? " is-warn" : ""), "data-test": "context-ring", "data-warn": String(ring.warn), "data-percent": String(ring.percent) },
    ...kids, h("span", { class: "inbox-context-text" }, ring.warn ? copy.contextLeftWarn(ring.percent) : copy.contextLeft(ring.percent)));
}

/** @param {number} ms @param {number} now */
function ageOf(ms, now) {
  return Number.isFinite(ms) ? ago(new Date(ms).toISOString(), now) : "";
}

/** The sentence under a failure headline: hostd's own reason, nothing for "couldn't reach it" (the headline already says so). @param {ApiResult | null} r */
function detailOf(r) {
  if (r === null || r.ok || r.status === 0) return "";
  if (r.status === 404) return copy.apiNotFound;
  return copy.reasonLine(r.error);
}

/**
 * @param {HTMLElement} root
 * @param {Ctx} ctx
 * @returns {{unmount(): void}}
 */
export function mount(root, ctx) {
  const fleet = ctx.fleet;
  /** @type {Map<string, Ui>} */
  const ui = new Map();
  /** Typed answers, by card: kept here so a redraw never eats a word. @type {Map<string, string>} */
  const typed = new Map();
  /** Ticked options of multi-select cards, by card: kept here for the same reason. @type {Map<string, Set<number>>} */
  const ticked = new Map();
  /** Cards archived on this device that hostd's next push has not caught up with yet. @type {Set<string>} */
  const hidden = new Set();
  /** @type {Map<string, {sig: string, el: HTMLElement}>} */
  const cache = new Map();
  let structure = "";
  let showArchived = false;
  let fieldCount = 0;

  const notes = h("div", { class: "inbox-notes" });
  const columns = h("div", { class: "inbox-columns" });
  const archivedButton = h("button", { type: "button", class: "inbox-button", "data-action": "archived", "aria-expanded": "false", on: { click: () => void toggleArchived() } }, copy.archived);
  const archivePanel = h("div", { class: "inbox-archive", "data-test": "archive", hidden: true });
  const page = h("section", { class: "inbox", "data-test": "inbox", "aria-label": copy.inbox },
    notes, columns,
    h("div", { class: "inbox-footer" }, h("p", { class: "inbox-hint" }, copy.swipeToArchive), archivedButton),
    archivePanel);

  /** @param {{machine: string, id: string}} item */
  const keyOf = (item) => `${item.machine}:${item.id}`;
  /** @param {string} key @returns {Ui} */
  const uiOf = (key) => ui.get(key) ?? { expanded: false, busy: false, answered: "", notice: "", detail: "" };
  /** @param {string} key @param {Partial<Ui>} p */
  function patch(key, p) {
    ui.set(key, { ...uiOf(key), ...p });
    render();
  }
  /** @param {Card} item */
  const sigOf = (item) => JSON.stringify([item.machine, item.column, item.title, item.body, item.sessionId, item.kind, item.contextLeft, item.question, item.updatedAt, uiOf(keyOf(item))]);

  // ---- Actions ----

  /** @param {Card} item @param {{optionIndexes: number[]} | {text: string}} body @param {string} label */
  async function answer(item, body, label) {
    const key = keyOf(item);
    patch(key, { busy: true, notice: "", detail: "" });
    const m = fleet.machine(item.machine);
    const r = m ? await m.api.post(`/v1/inbox/${encodeURIComponent(item.id)}/answer`, body) : null;
    if (r !== null && r.ok && asObject(r.data).status === "sent") {
      typed.delete(key);
      ticked.delete(key);
      patch(key, { busy: false, answered: label });
    } else {
      patch(key, { busy: false, notice: copy.answerFailed, detail: detailOf(r) });
    }
  }

  /** @param {Card} item */
  async function stop(item) {
    const key = keyOf(item);
    patch(key, { busy: true, notice: "", detail: "" });
    const m = fleet.machine(item.machine);
    const r = m ? await m.api.post(`/v1/sessions/${encodeURIComponent(item.sessionId)}/keys`, { keys: ["Esc"] }) : null;
    if (r !== null && r.ok && asObject(r.data).status === "sent") patch(key, { busy: false });
    else patch(key, { busy: false, notice: copy.stopFailed, detail: detailOf(r) });
  }

  /** @param {Card} item @returns {Promise<boolean>} true when the card is gone */
  async function archive(item) {
    const key = keyOf(item);
    const m = fleet.machine(item.machine);
    const r = m ? await m.api.post(`/v1/inbox/${encodeURIComponent(item.id)}/archive`) : null;
    // 404: hostd no longer has it live (archived somewhere else); the card should go either way.
    if (r !== null && ((r.ok && asObject(r.data).archived === true) || (!r.ok && r.status === 404))) {
      hidden.add(key);
      render();
      return true;
    }
    patch(key, { busy: false, notice: copy.archiveFailed, detail: detailOf(r) });
    return false;
  }

  // ---- Swipe left to archive ----

  /** @param {HTMLElement} card @param {HTMLElement} face @param {Card} item */
  function attachSwipe(card, face, item) {
    /** @type {{id: number, x: number, y: number, dx: number, locked: boolean} | null} */
    let drag = null;
    let committing = false;
    const settle = () => {
      card.classList.remove("is-dragging", "is-swiping");
      face.style.transform = "";
    };
    card.addEventListener("pointerdown", (e) => {
      if (committing || e.pointerType === "mouse" || !e.isPrimary) return; // mouse users have the Archive button
      if (e.target instanceof Element && e.target.closest("input, textarea, select")) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, locked: false };
    });
    card.addEventListener("pointermove", (e) => {
      if (drag === null || e.pointerId !== drag.id || committing) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.locked) {
        if (Math.abs(dx) < SWIPE_START_PX && Math.abs(dy) < SWIPE_START_PX) return;
        if (dx >= 0 || Math.abs(dx) < SWIPE_RATIO * Math.abs(dy)) { drag = null; return; } // a scroll, or the wrong way
        drag.locked = true;
        card.classList.add("is-dragging", "is-swiping");
        try { card.setPointerCapture(e.pointerId); } catch { /* touch pointers are captured already */ }
      }
      drag.dx = Math.min(0, dx);
      face.style.transform = `translateX(${drag.dx}px)`;
    });
    /** @param {PointerEvent} e */
    const release = (e) => {
      if (drag === null || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      if (!d.locked) return;
      card.classList.remove("is-dragging");
      const dy = e.clientY - d.y;
      if (e.type === "pointerup" && d.dx <= -SWIPE_PX && Math.abs(d.dx) >= SWIPE_RATIO * Math.abs(dy)) {
        committing = true;
        face.style.transform = "translateX(-110%)";
        void archive(item).then((gone) => {
          if (!gone) { committing = false; settle(); }
        });
      } else {
        settle();
      }
    };
    card.addEventListener("pointerup", release);
    card.addEventListener("pointercancel", release);
  }

  // ---- One card ----

  /** @param {Card} item @returns {HTMLElement} */
  function buildCard(item) {
    const key = keyOf(item);
    const st = uiOf(key);
    const q = item.question;
    const mode = answerMode(item);
    const askOpen = item.column === "needs-you" && q !== null && q.open && st.answered === "";
    const column = /** @type {"needs-you" | "working" | "done"} */ (item.column);

    const head = h("div", { class: "inbox-head" },
      h("span", { class: `inbox-dot is-${item.column}`, role: "img", "aria-label": copy.status[column] }),
      h("h5", { class: "inbox-title" }, item.title),
      h("span", { class: "meta inbox-age", "data-updated": String(item.updatedAt) }, ageOf(item.updatedAt, Date.now())));

    const text = askOpen && q !== null && q.text !== "" ? q.text : item.body;
    const body = h("p", { class: "inbox-body" + (askOpen ? " is-question" : "") + (st.expanded ? " is-open" : "") }, text);
    const more = h("button", {
      type: "button", class: "inbox-more", hidden: true, "data-action": "more", "data-focus": "more", "aria-expanded": String(st.expanded),
      on: { click: () => patch(key, { expanded: !st.expanded }) },
    }, st.expanded ? copy.less : copy.more);

    /** @type {HTMLElement[]} */
    const ask = [];
    if (st.answered !== "") {
      ask.push(h("p", { class: "inbox-answered", role: "status" }, copy.answered(st.answered)));
    } else if (askOpen && q !== null) {
      if (mode === "terminal") {
        ask.push(h("p", { class: "inbox-note", "data-test": "terminal-note" }, copy.answerInTerminal));
      } else if (mode === "ticks") {
        /** @type {Set<number>} */
        const set = ticked.get(key) ?? new Set();
        ticked.set(key, set);
        const submit = /** @type {HTMLButtonElement} */ (h("button", {
          type: "button", class: "inbox-button is-primary", "data-action": "submit-ticks", "data-focus": "submit", disabled: st.busy || set.size === 0,
          on: {
            click: () => {
              const picked = [...set].sort((a, b) => a - b);
              if (picked.length > 0) void answer(item, { optionIndexes: picked }, picked.map((i) => q.options[i]).join(", "));
            },
          },
        }, copy.submitAnswer));
        ask.push(h("p", { class: "inbox-label" }, copy.tickHint));
        ask.push(h("div", { class: "inbox-ticks", role: "group", "aria-label": q.text }, q.options.map((option, i) => {
          const box = /** @type {HTMLInputElement} */ (h("input", {
            type: "checkbox", class: "inbox-tickbox", "data-tick": i, "data-focus": `tick-${i}`, checked: set.has(i), disabled: st.busy,
            on: {
              change: () => {
                if (box.checked) set.add(i);
                else set.delete(i);
                submit.disabled = st.busy || set.size === 0;
              },
            },
          }));
          return h("label", { class: "inbox-tick" }, box, h("span", {}, option));
        })));
        ask.push(submit);
      } else {
        if (q.options.length > 0) {
          ask.push(h("div", { class: "inbox-options" }, q.options.map((option, i) => h("button", {
            type: "button", class: "inbox-option", "data-option": i, "data-focus": `opt-${i}`, disabled: st.busy,
            on: { click: () => void answer(item, { optionIndexes: [i] }, option) },
          }, option))));
        }
        const fieldId = `inbox-answer-${++fieldCount}`;
        const input = /** @type {HTMLInputElement} */ (h("input", {
          type: "text", id: fieldId, class: "inbox-input", name: "answer", maxlength: MAX_ANSWER, autocomplete: "off", enterkeyhint: "send",
          placeholder: copy.answerPlaceholder, "data-focus": "text", "data-test": "answer-input", disabled: st.busy,
          on: { input: () => typed.set(key, input.value) },
        }));
        input.value = typed.get(key) ?? "";
        ask.push(h("form", {
          class: "inbox-other",
          on: {
            submit: (/** @type {Event} */ e) => {
              e.preventDefault();
              const t = input.value.trim();
              if (t !== "") void answer(item, { text: t }, t);
            },
          },
        },
        h("label", { class: "inbox-label", for: fieldId }, copy.otherAnswer),
        h("div", { class: "inbox-other-row" }, input,
          h("button", { type: "submit", class: "inbox-button is-primary", "data-action": "send-answer", "data-focus": "send", disabled: st.busy }, copy.sendAnswer))));
      }
    }

    const ring = contextRing(item);
    const context = ring === null ? null : ringNode(ring);

    const notice = st.notice === "" ? null : h("div", { class: "inbox-notice", role: "alert" },
      h("p", { class: "inbox-notice-title" }, st.notice),
      st.detail === "" ? null : h("p", { class: "inbox-notice-detail" }, st.detail));

    const terminal = item.kind === "herdr" || (askOpen && mode === "terminal");
    const open = h("a", {
      class: "inbox-button", "data-action": "open", "data-focus": "open",
      href: href({ view: terminal ? "term" : "chat", machine: item.machine, sessionId: item.sessionId }),
    }, terminal ? copy.openTerminal : copy.openChat);
    const actions = h("div", { class: "inbox-actions" },
      open,
      h("span", { class: "inbox-spacer" }),
      h("button", { type: "button", class: "inbox-button is-danger", "data-action": "stop", "data-focus": "stop", disabled: st.busy, on: { click: () => void stop(item) } }, copy.stop),
      h("button", {
        type: "button", class: "inbox-button", "data-action": "archive", "data-focus": "archive", disabled: st.busy,
        on: { click: () => { patch(key, { busy: true, notice: "", detail: "" }); void archive(item); } },
      }, copy.archive));

    const face = h("div", { class: "inbox-face" }, head, body, more, ask, context, notice, actions);
    const card = h("article", {
      class: "inbox-card", "data-test": "inbox-card", "data-column": item.column, "data-machine": item.machine, "data-item": item.id, "data-key": key,
    }, h("div", { class: "inbox-reveal", "aria-hidden": "true" }, copy.archive), face);
    attachSwipe(card, face, item);
    return card;
  }

  /** @param {Card} item */
  function cardFor(item) {
    const key = keyOf(item);
    const sig = sigOf(item);
    const hit = cache.get(key);
    if (hit !== undefined && hit.sig === sig) return hit.el;
    const el = buildCard(item);
    cache.set(key, { sig, el });
    return el;
  }

  /** Show "More" only when the three-line cut hides something (or the text is open, to close it again). @param {HTMLElement} card */
  function measure(card) {
    const body = card.querySelector(".inbox-body");
    const more = card.querySelector(".inbox-more");
    if (!(body instanceof HTMLElement) || !(more instanceof HTMLElement)) return;
    more.hidden = body.classList.contains("is-question") ? true : !(body.classList.contains("is-open") || body.scrollHeight > body.clientHeight + 1);
  }

  // ---- The whole screen ----

  /** @param {import("../lib/inboxmodel.js").Group[]} groups */
  function visible(groups) {
    return groups
      .map((g) => ({ project: g.project, machines: g.machines.map((m) => ({ machine: m.machine, items: /** @type {Card[]} */ (m.items).filter((i) => !hidden.has(keyOf(i))) })).filter((m) => m.items.length > 0) }))
      .filter((g) => g.machines.length > 0);
  }

  function activeField() {
    const a = document.activeElement;
    if (!(a instanceof HTMLElement) || !page.contains(a) || !a.dataset.focus) return null;
    const card = a.closest("[data-test=inbox-card]");
    if (!(card instanceof HTMLElement)) return null;
    const isInput = a instanceof HTMLInputElement;
    return { key: card.dataset.key ?? "", focus: a.dataset.focus, start: isInput ? a.selectionStart : null, end: isInput ? a.selectionEnd : null };
  }

  /** @param {{key: string, focus: string, start: number | null, end: number | null} | null} f */
  function restoreField(f) {
    if (f === null) return;
    const el = cache.get(f.key)?.el.querySelector(`[data-focus="${f.focus}"]`);
    if (!(el instanceof HTMLElement) || ("disabled" in el && el.disabled === true) || el === document.activeElement) return;
    el.focus({ preventScroll: true });
    if (el instanceof HTMLInputElement && f.start !== null && f.end !== null) el.setSelectionRange(f.start, f.end);
  }

  function render() {
    const grouped = fleet.inbox();
    const groups = { needsYou: visible(grouped.needsYou), working: visible(grouped.working), done: visible(grouped.done) };
    const all = [...groups.needsYou, ...groups.working, ...groups.done].flatMap((g) => g.machines.flatMap((m) => m.items));
    const live = new Set(all.map(keyOf));
    // Forget what belongs to cards that no longer exist (hidden ones count as existing until hostd stops listing them).
    const listed = new Set([...grouped.needsYou, ...grouped.working, ...grouped.done].flatMap((g) => g.machines.flatMap((m) => m.items.map(keyOf))));
    for (const k of [...ui.keys()]) if (!listed.has(k)) ui.delete(k);
    for (const k of [...typed.keys()]) if (!listed.has(k)) typed.delete(k);
    for (const k of [...ticked.keys()]) if (!listed.has(k)) ticked.delete(k);
    for (const k of [...hidden]) if (!listed.has(k)) hidden.delete(k);
    for (const k of [...cache.keys()]) if (!live.has(k)) cache.delete(k);

    const machines = fleet.machines();
    notes.replaceChildren(...machines.filter((m) => m.state() === "down").map((m) => h("p", { class: "inbox-note", role: "status" }, copy.cannotReach(m.name))));

    const emptyText = all.length === 0 && machines.some((m) => m.state() === "connecting") ? copy.loading : copy.inboxEmpty;
    const sections = /** @type {const} */ ([["needs-you", copy.sectionNeedsYou, groups.needsYou], ["working", copy.sectionWorking, groups.working], ["done", copy.sectionDone, groups.done]]);
    const shape = JSON.stringify([emptyText, sections.map(([col, , gs]) => [col, gs.map((g) => [g.project, g.machines.map((m) => [m.machine, m.items.map((i) => i.id)])])])]);

    const focus = activeField();
    if (shape === structure) {
      for (const item of all) {
        const key = keyOf(item);
        const hit = cache.get(key);
        const sig = sigOf(item);
        if (hit === undefined || hit.sig === sig) continue;
        const el = buildCard(item);
        hit.el.replaceWith(el);
        cache.set(key, { sig, el });
        measure(el);
      }
    } else {
      structure = shape;
      columns.replaceChildren(...sections.flatMap(([col, label, gs]) => {
        if (gs.length === 0 && col !== "needs-you") return [];
        const count = gs.reduce((n, g) => n + g.machines.reduce((k, m) => k + m.items.length, 0), 0);
        const headingId = `inbox-heading-${col}`;
        return [h("section", { class: `inbox-section is-${col}`, "data-test": `section-${col}`, "data-column": col, "aria-labelledby": headingId },
          h("h2", { class: "inbox-heading", id: headingId }, label, " ", h("span", { class: "inbox-count" }, String(count))),
          gs.length === 0
            ? h("p", { class: "inbox-empty", "data-test": "inbox-empty" }, emptyText)
            : gs.map((g) => h("div", { class: "inbox-group", "data-test": "inbox-group", "data-project": g.project },
              h("h3", { class: "inbox-project" }, g.project === "" ? "/" : g.project),
              g.machines.map((m) => h("div", { class: "inbox-machine", "data-test": "inbox-machine", "data-machine": m.machine },
                h("h4", { class: "inbox-machine-name" }, m.machine),
                m.items.map(cardFor))))))];
      }));
      for (const card of columns.querySelectorAll("[data-test=inbox-card]")) if (card instanceof HTMLElement) measure(card);
    }
    restoreField(focus);
  }

  // ---- Archived list ----

  async function loadArchived() {
    archivePanel.replaceChildren(h("p", { class: "inbox-note" }, copy.loading));
    const found = await Promise.all(fleet.machines().map(async (m) => ({ name: m.name, r: await m.api.get("/v1/inbox/archive") })));
    if (!showArchived) return;
    const now = Date.now();
    /** @type {{machine: string, title: string, project: string, at: number}[]} */
    const rows = [];
    let failed = false;
    for (const { name, r } of found) {
      const items = r.ok ? asObject(r.data).items : undefined;
      if (!Array.isArray(items)) { failed = true; continue; }
      for (const raw of items) {
        const it = asObject(raw);
        rows.push({ machine: name, title: String(it.title ?? ""), project: basename(String(it.project ?? "")), at: Number(it.archivedAt ?? it.updatedAt) });
      }
    }
    rows.sort((a, b) => b.at - a.at);
    archivePanel.replaceChildren(
      ...(failed ? [h("p", { class: "inbox-note", role: "status" }, copy.inboxFailed)] : []),
      rows.length === 0 && !failed
        ? h("p", { class: "inbox-empty" }, copy.archivedEmpty)
        : h("ul", { class: "inbox-archived-list" }, rows.map((r) => h("li", { class: "inbox-archived-item", "data-machine": r.machine },
          h("span", { class: "inbox-archived-title" }, r.title),
          h("span", { class: "meta" }, [r.project, r.machine, ageOf(r.at, now)].filter((s) => s !== "").join(" · "))))));
  }

  async function toggleArchived() {
    showArchived = !showArchived;
    archivedButton.setAttribute("aria-expanded", String(showArchived));
    archivePanel.hidden = !showArchived;
    if (showArchived) await loadArchived();
    else archivePanel.replaceChildren();
  }

  // ---- Start ----

  const tick = () => {
    const now = Date.now();
    for (const el of page.querySelectorAll("[data-updated]")) el.textContent = ageOf(Number(el.getAttribute("data-updated")), now);
  };
  const remeasure = () => {
    for (const card of columns.querySelectorAll("[data-test=inbox-card]")) if (card instanceof HTMLElement) measure(card);
  };
  const timer = setInterval(tick, AGE_TICK_MS);
  window.addEventListener("resize", remeasure);
  root.append(page);
  render();
  const off = fleet.subscribe(render);

  return {
    unmount() {
      off();
      clearInterval(timer);
      window.removeEventListener("resize", remeasure);
      page.remove();
    },
  };
}
