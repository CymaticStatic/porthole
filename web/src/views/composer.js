// The chat composer (SPEC 4.5, 4.8, 4.12): a draft that survives anything, attachments that become full paths in the text,
// the send flow with its statuses, and the sent history. The send flow rules are in the plan ("Send flow"):
//  - the composer posts only while the machine link is up; if the link is down, or its own POST gets no answer, the outbox entry
//    stays `held`, the status says so, and the composer never re-sends it by itself: net/machine.js is the only sender of held entries;
//  - the answer to the composer's own POST is applied here (draft, sent history, outbox, status line);
//  - results of machine.js re-posts are applied by the app's fleet-level listener, which then emits the app event `send-result`;
//    the composer only refreshes what is on screen for its own session and writes nothing to drafts, sent history or outbox for them.
import { h } from "../dom/h.js";
import { createDrafts } from "../lib/drafts.js";
import { ago, basename } from "../lib/format.js";
import { createOutbox, nextAction } from "../lib/outbox.js";
import { defaultStorage } from "../lib/storage.js";
import { mount as mountTalk } from "./talk.js";

const POLL_MS = 3000;
const COPIED_MS = 1500;
const WIDE = "(min-width: 900px)";
const SVG_NS = "http://www.w3.org/2000/svg";

/** @param {string} d path data of a 24x24 icon @returns {SVGElement} */
function icon(d) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

/** A message id hostd accepts (letters, digits, dots, dashes, underscores). */
function newClientMsgId() {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === "function") return "web-" + c.randomUUID();
  return "web-" + [...c.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {{ctx: any, machine: any, sessionId: string, talkRoot: HTMLElement}} o
 * @returns {{el: HTMLElement, destroy(): void, focus(): void}}
 */
export function createComposer({ ctx, machine, sessionId, talkRoot }) {
  const { copy } = ctx;
  const origin = String(machine.origin);
  const store = defaultStorage();
  const drafts = createDrafts(store);
  const outbox = createOutbox(store);
  const sessionPath = `/v1/sessions/${encodeURIComponent(sessionId)}`;

  let alive = true;
  let busy = false;
  let uploading = 0;
  /** @type {string[]} */
  let files = [];
  /** @type {{id: string, text: string} | null} the message this composer last sent (for "Try again" and the send-result event) */
  let lastSent = null;
  /** @type {string | null} */
  let pollId = null;
  /** @type {any} */
  let pollTimer = null;
  let sheetOpen = false;
  /** @type {{unmount(): void} | null} */
  let talk = null;
  /** @type {any[]} */
  const timers = [];

  // ---- the DOM ------------------------------------------------------------------------------------------------------------------
  const box = /** @type {HTMLTextAreaElement} */ (
    h("textarea", { class: "composer-box", rows: 1, "aria-label": copy.messageLabel, placeholder: copy.messagePlaceholder, autocomplete: "off", enterkeyhint: "enter" })
  );
  const draftNote = h("p", { class: "composer-note", "data-test": "draft-note", role: "alert" });
  draftNote.hidden = true;
  const chips = h("ul", { class: "chips", "aria-label": copy.attach });
  chips.hidden = true;
  const attachStatus = h("p", { class: "composer-note", "data-test": "attach-status", role: "status" });
  attachStatus.hidden = true;
  const statusEl = h("div", { class: "send-status", "data-test": "send-status", role: "status" });
  statusEl.hidden = true;

  const camera = /** @type {HTMLInputElement} */ (
    h("input", { type: "file", class: "visually-hidden", accept: "image/*", capture: "environment", tabindex: "-1", "aria-label": copy.takePhoto, "data-test": "attach-camera" })
  );
  const photo = /** @type {HTMLInputElement} */ (
    h("input", { type: "file", class: "visually-hidden", accept: "image/*", tabindex: "-1", "aria-label": copy.choosePhoto, "data-test": "attach-photo" })
  );
  const anyFile = /** @type {HTMLInputElement} */ (
    h("input", { type: "file", class: "visually-hidden", tabindex: "-1", "aria-label": copy.chooseFile, "data-test": "attach-file" })
  );

  const canPasteButton = typeof globalThis.navigator?.clipboard?.read === "function";
  /** @param {string} label @param {() => void} fn @param {string} test */
  const menuItem = (label, fn, test) =>
    h("button", { type: "button", class: "menu-item", role: "menuitem", "data-test": test, on: { click: () => { closeMenu(); fn(); } } }, label);
  const menu = h(
    "div",
    { class: "attach-menu", role: "menu", "data-test": "attach-menu" },
    menuItem(copy.takePhoto, () => (ctx.bridge?.available ? void pick("camera") : camera.click()), "attach-take"),
    menuItem(copy.choosePhoto, () => (ctx.bridge?.available ? void pick("photo") : photo.click()), "attach-choose-photo"),
    menuItem(copy.chooseFile, () => (ctx.bridge?.available ? void pick("file") : anyFile.click()), "attach-choose-file"),
    canPasteButton ? menuItem(copy.pasteImage, () => void pasteFromClipboard(), "attach-paste") : null,
  );
  menu.hidden = true;

  const attachBtn = h(
    "button",
    { type: "button", class: "composer-button", "data-test": "attach", "aria-haspopup": "menu", "aria-expanded": "false", on: { click: () => (menu.hidden ? openMenu() : closeMenu()) } },
    icon("M21 12.5l-8.5 8.5a5.5 5.5 0 01-7.8-7.8L13.5 4.5a3.7 3.7 0 015.2 5.2l-8.6 8.6a1.8 1.8 0 01-2.6-2.6l7.9-7.9"),
    copy.attach,
  );
  const talkBtn = h(
    "button",
    { type: "button", class: "composer-button", "data-test": "talk", on: { click: () => openTalk() } },
    icon("M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM5 11a7 7 0 0014 0M12 18v3"),
    copy.talk,
  );
  const sentOpen = h(
    "button",
    { type: "button", class: "composer-button composer-quiet", "data-test": "sent-open", "aria-expanded": "false", on: { click: () => toggleSheet() } },
    copy.sentMessages,
  );
  const sendBtn = /** @type {HTMLButtonElement} */ (
    h("button", { type: "button", class: "composer-send", "data-test": "send", on: { click: () => void send() } }, icon("M4 12l16-8-6 16-3-7z"), copy.send)
  );

  const sentList = h("ul", { class: "sent-list" });
  const sheet = h(
    "section",
    { class: "sent-sheet", "data-test": "sent", "aria-label": copy.sentMessages },
    h("div", { class: "sent-head" }, h("h3", { class: "sent-title" }, copy.sentMessages), h("button", { type: "button", class: "composer-button", on: { click: () => toggleSheet(false) } }, copy.close)),
    sentList,
  );
  sheet.hidden = true;

  const el = h(
    "div",
    { class: "composer", "data-test": "composer" },
    sheet,
    chips,
    attachStatus,
    draftNote,
    box,
    h("div", { class: "composer-actions" }, sentOpen, attachBtn, talkBtn, sendBtn),
    menu,
    statusEl,
    camera,
    photo,
    anyFile,
  );

  // ---- the draft ----------------------------------------------------------------------------------------------------------------
  function autosize() {
    box.style.height = "auto";
    box.style.height = box.scrollHeight + "px";
  }

  function updateControls() {
    sendBtn.disabled = busy || box.value.trim() === "";
  }

  function renderChips() {
    chips.hidden = files.length === 0;
    chips.replaceChildren(
      ...files.map((path) => {
        const name = basename(path) || path;
        return h(
          "li",
          { class: "chip", "data-test": "attach-chip" },
          h("span", { class: "chip-name", title: path }, name),
          h("button", { type: "button", class: "chip-remove", "aria-label": copy.removeFile(name), on: { click: () => removeFile(path) } }, icon("M6 6l12 12M18 6L6 18")),
        );
      }),
    );
  }

  /** Saves the draft exactly as typed; a file stays listed only while its path is still in the text. */
  function saveDraft() {
    files = files.filter((f) => box.value.includes(f));
    const r = drafts.put(origin, sessionId, box.value, files);
    draftNote.hidden = r.ok;
    draftNote.textContent = r.ok ? "" : copy.draftSaveFailed;
    renderChips();
    updateControls();
    autosize();
  }

  /** @param {string} path */
  function removeFile(path) {
    const lines = box.value.split("\n");
    const i = lines.findIndex((l) => l.trim() === path);
    if (i >= 0) lines.splice(i, 1);
    box.value = lines.join("\n");
    files = files.filter((f) => f !== path);
    saveDraft();
  }

  /** @param {string} text */
  function setText(text) {
    box.value = text;
    saveDraft();
  }

  /** Puts a full path on its own line at the cursor. @param {string} path */
  function insertPath(path) {
    const v = box.value;
    const start = box.selectionStart ?? v.length;
    const end = box.selectionEnd ?? start;
    const before = v.slice(0, start);
    const insert = (before === "" || before.endsWith("\n") ? "" : "\n") + path + "\n";
    box.value = before + insert + v.slice(end);
    const caret = before.length + insert.length;
    box.setSelectionRange(caret, caret);
    if (!files.includes(path)) files.push(path);
    saveDraft();
  }

  /** Text from the talk overlay, added like typing. @param {string} text */
  function insertSpoken(text) {
    const v = box.value;
    const lead = v === "" || /\s$/.test(v) ? "" : " ";
    box.value = v + lead + text;
    const end = box.value.length;
    box.setSelectionRange(end, end);
    saveDraft();
  }

  // ---- status line and polling --------------------------------------------------------------------------------------------------
  /** @param {string | null} key a copy key from nextAction (`sendHeld`, `pendingTitle`, `sendFailedTitle`) @param {string} [reason] hostd's own words */
  function showStatus(key, reason) {
    statusEl.replaceChildren();
    statusEl.hidden = key === null;
    if (key === null) return;
    statusEl.dataset.kind = key;
    statusEl.append(h("p", { class: "send-title" }, String(copy[key] ?? "")));
    if (reason) statusEl.append(h("p", { class: "send-reason", "data-test": "send-reason" }, copy.reasonLine(reason)));
    if (key === "sendFailedTitle") statusEl.append(h("button", { type: "button", class: "composer-button", "data-test": "send-retry", on: { click: () => void send() } }, copy.tryAgain));
  }

  function stopPoll() {
    clearTimeout(pollTimer);
    pollId = null;
  }

  /** Asks hostd every 3 s until a message it had not yet delivered changes. @param {string} id */
  function startPoll(id) {
    stopPoll();
    pollId = id;
    const tick = async () => {
      const r = await machine.api.get(`/v1/sends/${encodeURIComponent(id)}`);
      if (!alive || pollId !== id) return;
      const pending = r.ok ? r.data?.status === "pending" : r.status === 0;
      if (pending) {
        pollTimer = setTimeout(tick, POLL_MS);
        return;
      }
      pollId = null;
      const entry = outbox.get(id) ?? { clientMsgId: id, origin, sessionId, text: lastSent?.id === id ? lastSent.text : "", status: "pending", at: Date.now() };
      settle(entry, r);
    };
    pollTimer = setTimeout(tick, POLL_MS);
  }

  // ---- the send flow ------------------------------------------------------------------------------------------------------------
  /**
   * Applies hostd's answer (or its absence) for a message this composer sent: storage first, then the screen.
   * @param {import("../lib/outbox.js").OutboxEntry} entry @param {any} answer
   */
  function settle(entry, answer) {
    const action = nextAction(entry, answer);
    const id = entry.clientMsgId;
    const status = answer.ok ? answer.data?.status : null;
    if (action.outbox === "remove") outbox.remove(id);
    else if (action.poll) outbox.update(id, { status: "pending" });
    if (action.draft === "clear") {
      drafts.clear(origin, sessionId);
      drafts.addSent(origin, sessionId, { clientMsgId: id, text: entry.text, at: Date.now(), status: "delivered", reason: null });
    }
    /** @type {string | undefined} */
    const reason = answer.ok ? (status === "refused" || status === "failed" ? answer.data?.reason : undefined) : answer.status === 0 ? undefined : answer.error;
    if (action.show === "sendFailedTitle") lastSent = { id, text: entry.text };
    if (!alive) return;
    if (action.draft === "clear" && box.value === entry.text) {
      box.value = "";
      files = [];
      saveDraft();
    } else if (action.draft === "clear") {
      saveDraft(); // typed on while it was going out: keep the new words
    }
    showStatus(action.show, reason);
    if (action.poll) startPoll(id);
    if (sheetOpen) renderSent();
  }

  async function send() {
    if (busy) return;
    const text = box.value;
    if (text.trim() === "") return;
    const held = outbox.all().find((e) => e.origin === origin && e.sessionId === sessionId);
    // The same words again (after a failure or a hold) are the same message: hostd answers a repeat id from its log, never twice.
    const sameWords = held?.text === text ? held.clientMsgId : lastSent?.text === text ? lastSent.id : null;
    if (held && held.clientMsgId !== sameWords) outbox.remove(held.clientMsgId);
    const id = sameWords ?? newClientMsgId();
    /** @type {import("../lib/outbox.js").OutboxEntry} */
    const entry = held && held.clientMsgId === id ? held : { clientMsgId: id, origin, sessionId, text, status: "held", at: Date.now() };
    outbox.put(entry);
    lastSent = { id, text };
    stopPoll();
    busy = true;
    updateControls();
    /** @type {any} */
    const answer =
      machine.state() === "up"
        ? await machine.api.post(`${sessionPath}/send`, { text, clientMsgId: id })
        : { ok: false, status: 0, error: "" };
    busy = false;
    if (alive) updateControls();
    settle(entry, answer);
  }

  // ---- hostd re-posted a held message while this chat was open (the app applied it; this only refreshes the screen) ---------------
  const offResult = ctx.events.on("send-result", (/** @type {any} */ ev) => {
    if (!alive || !ev || ev.sessionId !== sessionId || !ev.action) return;
    const action = ev.action;
    if (action.draft === "clear") {
      if (lastSent && lastSent.id === ev.clientMsgId && box.value !== lastSent.text) {
        saveDraft(); // typed on while it was held: keep the new words
      } else {
        const d = drafts.get(origin, sessionId);
        box.value = d ? d.text : "";
        files = d ? d.files : [];
        renderChips();
        updateControls();
        autosize();
      }
    }
    showStatus(action.show);
    if (action.poll) startPoll(String(ev.clientMsgId));
    else if (pollId === ev.clientMsgId) stopPoll();
    if (sheetOpen) renderSent();
  });

  // ---- attachments --------------------------------------------------------------------------------------------------------------
  /** @param {string} text */
  function attachProblem(text) {
    attachStatus.textContent = text;
    attachStatus.hidden = text === "";
  }

  /** @param {Blob} file @param {string} name */
  async function upload(file, name) {
    uploading++;
    attachProblem(copy.uploading);
    const r = await machine.api.upload(file, name);
    uploading--;
    if (!alive) return;
    if (r.ok && typeof r.data?.path === "string") {
      insertPath(r.data.path);
      if (uploading === 0) attachProblem("");
    } else {
      attachProblem(r.status === 0 || !r.error ? copy.uploadFailed : `${copy.uploadFailed} ${copy.reasonLine(r.error)}`);
    }
  }

  /** @param {FileList | File[] | null} list */
  function uploadAll(list) {
    for (const f of list ? [...list] : []) void upload(f, f.name || `file-${Date.now()}`);
  }

  /** The Android app picks (and uploads) the file itself and answers with where it put it. @param {"camera" | "photo" | "file"} source */
  async function pick(source) {
    try {
      const r = await ctx.bridge.call("pickFile", { source });
      if (r && typeof r.path === "string") insertPath(r.path);
    } catch {
      // the person closed the picker: nothing to add
    }
  }

  async function pasteFromClipboard() {
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (!type) continue;
        const blob = await item.getType(type);
        void upload(blob, `pasted-${Date.now()}.${type.slice(6).replace(/[^a-z0-9]/gi, "") || "png"}`);
        return;
      }
    } catch {
      attachProblem(copy.uploadFailed);
    }
  }

  for (const input of [camera, photo, anyFile]) {
    input.addEventListener("change", () => {
      uploadAll(input.files);
      input.value = "";
    });
  }

  box.addEventListener("paste", (e) => {
    const images = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return; // plain text pastes are left alone
    e.preventDefault();
    for (const f of images) void upload(f, f.name || `pasted-${Date.now()}.${f.type.slice(6) || "png"}`);
  });

  const offShare = ctx.bridge?.available
    ? ctx.bridge.on("share", (/** @type {any} */ d) => {
        if (d && typeof d.path === "string") insertPath(d.path);
      })
    : () => {};

  // ---- menu, sheet, talk --------------------------------------------------------------------------------------------------------
  function openMenu() {
    menu.hidden = false;
    attachBtn.setAttribute("aria-expanded", "true");
  }
  function closeMenu() {
    menu.hidden = true;
    attachBtn.setAttribute("aria-expanded", "false");
  }

  function renderSent() {
    const items = drafts.sent(origin, sessionId).slice().reverse();
    const now = Date.now();
    sentList.replaceChildren(
      ...(items.length === 0
        ? [h("li", { class: "sent-empty" }, copy.sentEmpty)]
        : items.map((item) => {
            const word = copy.sentStatus[/** @type {keyof typeof copy.sentStatus} */ (item.status)] ?? item.status;
            const copyBtn = h("button", { type: "button", class: "composer-button", "data-test": "sent-copy" }, copy.copyText);
            copyBtn.addEventListener("click", () => {
              void navigator.clipboard.writeText(item.text).then(() => {
                copyBtn.textContent = copy.copied;
                timers.push(setTimeout(() => { copyBtn.textContent = copy.copyText; }, COPIED_MS));
              });
            });
            return h(
              "li",
              { class: "sent-item", "data-test": "sent-item" },
              h("p", { class: "sent-line" }, h("span", { class: "sent-status" }, word), " ", h("span", { class: "meta" }, ago(new Date(item.at).toISOString(), now))),
              h("p", { class: "sent-text" }, item.text),
              h(
                "div",
                { class: "sent-actions" },
                copyBtn,
                h("button", { type: "button", class: "composer-button", "data-test": "sent-putback", on: { click: () => { setText(item.text); toggleSheet(false); box.focus(); } } }, copy.putBack),
              ),
            );
          })),
    );
  }

  /** @param {boolean} [open] */
  function toggleSheet(open = !sheetOpen) {
    sheetOpen = open;
    sheet.hidden = !open;
    sentOpen.setAttribute("aria-expanded", String(open));
    if (open) renderSent();
  }

  function openTalk() {
    if (talk) return;
    talk = mountTalk(talkRoot, ctx, {
      api: machine.api,
      onText: (text, { send: pressSend }) => {
        insertSpoken(text);
        if (pressSend) void send();
      },
      onClose: () => { talk = null; },
    });
  }

  // ---- wiring -------------------------------------------------------------------------------------------------------------------
  box.addEventListener("input", saveDraft);
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && matchMedia(WIDE).matches) {
      e.preventDefault();
      void send();
    }
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) { closeMenu(); attachBtn.focus(); }
  });

  // restore: the draft, then any message that was still waiting for an answer before the page was reloaded
  const saved = drafts.get(origin, sessionId);
  if (saved) {
    box.value = saved.text;
    files = saved.files.filter((f) => saved.text.includes(f));
  }
  renderChips();
  updateControls();
  const waiting = outbox.all().find((e) => e.origin === origin && e.sessionId === sessionId);
  if (waiting) {
    lastSent = { id: waiting.clientMsgId, text: waiting.text };
    if (waiting.status === "pending") {
      showStatus("pendingTitle");
      startPoll(waiting.clientMsgId);
    } else {
      showStatus("sendHeld");
    }
  }
  timers.push(setTimeout(autosize, 0));

  return {
    el,
    focus: () => box.focus(),
    destroy() {
      alive = false;
      offResult();
      offShare();
      stopPoll();
      for (const t of timers) clearTimeout(t);
      talk?.unmount();
      talk = null;
    },
  };
}
