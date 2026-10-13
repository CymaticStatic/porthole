// Terminal view (SPEC 4.4): xterm on the PTY socket, the key toolbar (Ctrl latch, text size, shortcuts), touch gestures.
// Mounted by main.js with `mount(root, ctx)`; returns `{unmount()}`. Every word comes from copy.js; DOM is built with h().
import { FitAddon } from "../../vendor/addon-fit/lib/addon-fit.mjs";
import { Terminal } from "../../vendor/xterm/lib/xterm.mjs";
import { h } from "../dom/h.js";
import { copy } from "../lib/copy.js";
import { createCtrlLatch, createRecognizer, gestureAction, mergeGestureMap, navPlan, nextFontSize, wheelBytes } from "../lib/gestures.js";
import { asObject } from "../lib/json.js";
import { href } from "../lib/route.js";
import { parseSteps, stepBytes, stepLabel } from "../lib/steps.js";
import { neighbour } from "../lib/tree.js";
import { openSocket } from "../net/socket.js";

/**
 * @typedef {object} TerminalCtx
 * @property {ReturnType<typeof import("../net/fleet.js").createFleet>} fleet
 * @property {import("../lib/route.js").Route} route
 * @property {{get(): Record<string, unknown>, set(patch: Record<string, unknown>): void, subscribe(fn: (settings: Record<string, unknown>) => void): () => void}} settings
 * @property {(name: string, state: import("../net/socket.js").LinkState, retry?: () => void) => () => void} reportLink
 */

const DEFAULT_FONT_PX = 14;
const FLASH_MS = 4000;
const NO_SESSION = "no such session";
const SS3 = "\x1bO";

/** @param {unknown} v @returns {number} */
function fontPx(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FONT_PX;
}

/** A design token as `#rrggbb`: the canvas turns any CSS colour (OKLCH included) into pixels xterm can read. @param {string} name */
function tokenColor(name) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (raw === "") return undefined;
  const g = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!g) return undefined;
  g.fillStyle = "#000000";
  g.fillStyle = raw;
  g.clearRect(0, 0, 1, 1);
  g.fillRect(0, 0, 1, 1);
  const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
  return "#" + [r, gr, b].map((c) => c.toString(16).padStart(2, "0")).join("");
}

function terminalTheme() {
  return {
    background: tokenColor("--surface"),
    foreground: tokenColor("--text"),
    cursor: tokenColor("--accent"),
    cursorAccent: tokenColor("--surface"),
    selectionBackground: tokenColor("--mine"),
  };
}

/** @param {TerminalCtx} ctx @param {HTMLElement} root */
export function mount(root, ctx) {
  const { machine: machineName, sessionId } = ctx.route;
  const machine = machineName ? ctx.fleet.machine(machineName) : undefined;
  const view = h("section", { class: "term-view", "data-test": "terminal-view" });
  root.append(view);

  if (!machine || !machineName || !sessionId) {
    view.append(h("p", { class: "term-note", role: "status", "data-test": "terminal-note" }, copy.terminalFailed));
    return { unmount() { view.remove(); } };
  }

  // ---- state -------------------------------------------------------------------------------------------------
  let ended = false;
  let readonly = false;
  /** True once hostd sent a text snapshot (a herdr pane): that session has no keyboard and no tmux windows. */
  let screenMode = false;
  let currentPx = fontPx(ctx.settings.get().termFontPx);
  let scrollAcc = 0;
  let lastTouch = { x: 0, y: 0 };
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let flashTimer;
  /** @type {number} */
  let fitFrame = 0;
  let panelToken = 0;
  /** @type {HTMLElement | null} */
  let panel = null;
  /** @type {HTMLElement | null} */
  let scrim = null;
  const decoder = new TextDecoder();
  const ctrl = createCtrlLatch();

  // ---- elements ----------------------------------------------------------------------------------------------
  const note = h("div", { class: "term-note", role: "status", "data-test": "terminal-note", hidden: true });
  const flash = h("div", { class: "term-flash", role: "status", "data-test": "terminal-flash", hidden: true });
  const host = h("div", { class: "term-screen", "data-test": "terminal", "data-state": "connecting", "data-font-px": String(currentPx) });

  /** @type {HTMLButtonElement[]} buttons that type into the session: off while the terminal is view-only */
  const inputButtons = [];

  /**
   * A toolbar button. mousedown is cancelled so a tap never takes the focus (and the on-screen keyboard) away from the terminal.
   * @param {string} key @param {string} label @param {string | null} aria @param {() => void} onPress @param {boolean} needsInput
   */
  function button(key, label, aria, onPress, needsInput = true) {
    const b = /** @type {HTMLButtonElement} */ (h("button", {
      type: "button",
      class: "term-key",
      "data-key": key,
      "aria-label": aria,
      on: { mousedown: (/** @type {Event} */ e) => e.preventDefault(), click: onPress },
    }, label));
    if (needsInput) inputButtons.push(b);
    return b;
  }

  const ctrlButton = button("Ctrl", copy.ctrl, null, () => {
    ctrl.tap(Date.now());
    syncCtrl();
  });
  ctrlButton.dataset.latch = "off";
  ctrlButton.setAttribute("aria-pressed", "false");
  const keyboardButton = button("Keyboard", copy.keyboard, null, toggleKeyboard, false);
  keyboardButton.setAttribute("aria-pressed", "false");
  const shortcutsButton = button("Shortcuts", copy.shortcuts, null, openPanel);

  /** @param {"Esc" | "Tab" | "Left" | "Down" | "Up" | "Right"} key */
  const namedKey = (key) => button(key, copy.keys[key], copy.keyNames[key], () => pressStep(key));

  const toolbar = h("div", { class: "term-toolbar", role: "toolbar", "aria-label": copy.terminalKeys, "data-test": "toolbar" },
    h("div", { class: "term-row" },
      namedKey("Esc"),
      namedKey("Tab"),
      ctrlButton,
      namedKey("Left"),
      namedKey("Down"),
      namedKey("Up"),
      namedKey("Right"),
    ),
    h("div", { class: "term-row" },
      button("Paste", copy.paste, null, () => { void pasteFromClipboard(); }),
      keyboardButton,
      button("Smaller", copy.smallerTextLabel, copy.smallerText, () => stepFont(-1), false),
      button("Bigger", copy.biggerTextLabel, copy.biggerText, () => stepFont(1), false),
      shortcutsButton,
    ),
  );

  view.append(note, host, flash, toolbar);

  // ---- terminal ----------------------------------------------------------------------------------------------
  const term = new Terminal({
    cursorBlink: false,
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace",
    fontSize: currentPx,
    macOptionIsMeta: true,
    minimumContrastRatio: 4.5,
    scrollback: 5000,
    theme: terminalTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  const refit = () => {
    try { fit.fit(); } catch { /* the view is not laid out yet; the observer fits it when it is */ }
  };
  refit();

  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(refit);
  });
  observer.observe(host);

  const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
  const onScheme = () => { term.options.theme = terminalTheme(); };
  colorScheme.addEventListener("change", onScheme);

  // ---- helpers -----------------------------------------------------------------------------------------------
  function syncCtrl() {
    const s = ctrl.state();
    ctrlButton.dataset.latch = s;
    ctrlButton.setAttribute("aria-pressed", String(s !== "off"));
    ctrlButton.textContent = s === "locked" ? copy.ctrlLocked : copy.ctrl;
  }

  function syncKeyboard() {
    keyboardButton.setAttribute("aria-pressed", String(document.activeElement === term.textarea));
  }

  /** @param {boolean} on */
  function setReadonly(on) {
    readonly = on;
    for (const b of inputButtons) b.disabled = on;
    toolbar.dataset.readonly = String(on);
  }

  /** The banner under the top bar: a plain headline, then hostd's own sentence when there is one. @param {string} headline @param {string} [detail] */
  function showNote(headline, detail) {
    note.replaceChildren(h("strong", {}, headline), ...(detail ? [h("span", {}, detail)] : []));
    note.hidden = false;
  }

  function clearNote() {
    note.hidden = true;
    note.replaceChildren();
  }

  /** A short message that goes away by itself (a failed paste). @param {string} message */
  function say(message) {
    flash.textContent = message;
    flash.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flash.hidden = true;
      flash.textContent = "";
      flashTimer = undefined;
    }, FLASH_MS);
  }

  /** The tmux prefix key as a step name (Settings → Gestures), C-b when none or unusable. */
  function prefixKey() {
    const p = ctx.settings.get().tmuxPrefix;
    return typeof p === "string" && p !== "" ? p : "C-b";
  }

  /** @param {string} step @returns {Uint8Array<ArrayBuffer> | null} */
  function bytesFor(step) {
    for (const prefix of [prefixKey(), "C-b"]) {
      try { return stepBytes(step, prefix); } catch { /* try the default prefix, then give up on this step */ }
    }
    return null;
  }

  /** @param {Uint8Array<ArrayBuffer>} bytes */
  function sendBytes(bytes) {
    if (readonly || ended) return;
    socket.send(bytes);
  }

  /** Steps from a gesture or a saved shortcut: one frame each, in order, never through the Ctrl latch. @param {string[]} steps */
  function sendSteps(steps) {
    for (const step of steps) {
      const b = bytesFor(step);
      if (b) sendBytes(b);
    }
  }

  /** A toolbar key: goes through the Ctrl latch like typed text, and arrows follow the program's cursor-key mode. @param {string} step */
  function pressStep(step) {
    const b = bytesFor(step);
    if (!b) return;
    let text = decoder.decode(b);
    if (term.modes.applicationCursorKeysMode && /^\x1b\[[A-D]$/.test(text)) text = SS3 + text[2];
    sendBytes(ctrl.apply(text));
    syncCtrl();
  }

  /** @param {1 | -1} dir */
  function stepFont(dir) {
    const next = nextFontSize(currentPx, dir);
    ctx.settings.set({ termFontPx: next });
    applyFont(next);
  }

  /** @param {number} px */
  function applyFont(px) {
    if (ended || px === currentPx) return;
    currentPx = px;
    term.options.fontSize = px;
    host.dataset.fontPx = String(px);
    refit();
  }

  async function pasteFromClipboard() {
    if (readonly || ended) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text !== "" && !readonly && !ended) term.paste(text);
    } catch {
      say(copy.pasteFailed);
    }
  }

  function toggleKeyboard() {
    if (document.activeElement === term.textarea) term.blur();
    else term.focus();
    syncKeyboard();
  }

  /** "tmux" or "herdr": from the machine's latest session list, or from the snapshot hostd sent. @returns {"tmux" | "herdr"} */
  function sessionKind() {
    if (screenMode) return "herdr";
    const sessions = machine?.tree()?.sessions;
    const found = Array.isArray(sessions) ? sessions.find((s) => s.id === sessionId) : undefined;
    const kind = found?.where.kind;
    if (kind === "tmux" || kind === "herdr") return kind;
    return sessionId?.startsWith("herdr") ? "herdr" : "tmux";
  }

  // ---- the socket --------------------------------------------------------------------------------------------
  const wsBase = (() => {
    const u = new URL(/** @type {string} */ (machine.origin));
    return `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}/v1/sessions/${encodeURIComponent(sessionId)}/pty`;
  })();
  /** @type {() => void} */
  let dropLink = () => {};

  /** @param {string} text */
  function renderScreen(text) {
    screenMode = true;
    setReadonly(true);
    const buf = term.buffer.active;
    const scrolledUp = buf.viewportY < buf.baseY;
    const y = buf.viewportY;
    // A full reset inside the write stream, so the old picture never shows blank between two snapshots.
    term.write("\x1bc\x1b[?25l" + text.replace(/\r?\n/g, "\r\n"), () => {
      if (scrolledUp) term.scrollToLine(y);
      else term.scrollToBottom();
    });
  }

  /** @param {string} raw */
  function onControl(raw) {
    /** @type {{type?: unknown, reason?: unknown, text?: unknown, error?: unknown}} */
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "readonly") {
      setReadonly(true);
      showNote(copy.terminalReadOnly, typeof msg.reason === "string" ? copy.reasonLine(msg.reason) || undefined : undefined);
    } else if (msg.type === "screen" && typeof msg.text === "string") {
      renderScreen(msg.text);
    } else if (msg.type === "error") {
      showNote(msg.error === NO_SESSION ? copy.terminalClosed : copy.terminalFailed);
    }
  }

  const socket = openSocket({
    url: () => `${wsBase}?cols=${term.cols}&rows=${term.rows}`,
    WebSocket: globalThis.WebSocket,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    binaryType: "arraybuffer",
    onState(state) {
      if (ended) return;
      host.dataset.state = state;
      dropLink = ctx.reportLink(copy.linkTerminal, state, () => socket.nudge());
    },
    onOpen() {
      // A new attach paints the whole screen again: start from an empty one, and let hostd say again whether it is view-only.
      screenMode = false;
      term.reset();
      setReadonly(false);
      clearNote();
      socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    },
    onMessage(data) {
      if (typeof data === "string") onControl(data);
      else if (data instanceof ArrayBuffer) term.write(new Uint8Array(data));
    },
  });

  term.onResize(({ cols, rows }) => { if (!ended) socket.send(JSON.stringify({ type: "resize", cols, rows })); });
  term.onData((data) => {
    if (readonly) return;
    sendBytes(ctrl.apply(data));
    syncCtrl();
  });
  term.onBinary((data) => {
    if (readonly) return;
    sendBytes(Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff));
  });
  const onFocus = () => syncKeyboard();
  host.addEventListener("focusin", onFocus);
  host.addEventListener("focusout", onFocus);

  // ---- settings (text size changes made in Settings apply at once) -----------------------------------------------
  const offSettings = ctx.settings.subscribe((s) => applyFont(fontPx(s.termFontPx)));

  // ---- gestures ----------------------------------------------------------------------------------------------
  const recognizer = createRecognizer();

  /** Where the finger is, as a 1-based terminal column and row, for mouse-wheel reports. */
  function cell() {
    const screen = host.querySelector(".xterm-screen");
    const r = screen ? screen.getBoundingClientRect() : null;
    const w = r && r.width > 0 ? r.width / term.cols : 8;
    const hgt = r && r.height > 0 ? r.height / term.rows : 16;
    const left = r ? r.left : 0;
    const top = r ? r.top : 0;
    return {
      h: hgt,
      col: Math.min(term.cols, Math.max(1, Math.floor((lastTouch.x - left) / w) + 1)),
      row: Math.min(term.rows, Math.max(1, Math.floor((lastTouch.y - top) / hgt) + 1)),
    };
  }

  /** @param {number} dy finger movement in px; down = look further back */
  function dragScroll(dy) {
    const c = cell();
    scrollAcc += dy / c.h;
    const n = Math.trunc(scrollAcc);
    if (n === 0) return;
    scrollAcc -= n;
    // tmux only understands wheel reports while it has asked for the mouse (set -g mouse on); otherwise scroll xterm's own history.
    if (sessionKind() === "tmux" && !readonly && term.modes.mouseTrackingMode !== "none") sendBytes(wheelBytes(-n, c.col, c.row));
    else term.scrollLines(-n);
  }

  /** @param {{level: "window" | "pane" | "session", dir: 1 | -1}} nav */
  function go(nav) {
    const target = neighbour(ctx.fleet.sidebar([]).terminals, sessionId ?? "", nav.level, nav.dir);
    if (target && target !== sessionId) location.hash = href({ view: "term", machine: machineName, sessionId: target });
  }

  /** @param {string} action */
  function runAction(action) {
    const plan = navPlan(action, sessionKind());
    if (!plan) return;
    if ("steps" in plan) sendSteps(plan.steps);
    else if ("navigate" in plan) go(plan.navigate);
    else if (plan.local === "text-bigger") stepFont(1);
    else if (plan.local === "text-smaller") stepFont(-1);
    else if (plan.local === "paste") void pasteFromClipboard();
  }

  /** @param {{gesture: string, dy?: number}[]} events */
  function onGestures(events) {
    const map = mergeGestureMap(ctx.settings.get().gestures);
    for (const ev of events) {
      const action = gestureAction(ev.gesture, map);
      if (ev.gesture === "drag") {
        if (action === "scroll") dragScroll(ev.dy ?? 0);
      } else if (action !== "scroll") runAction(action);
    }
  }

  /** @param {TouchEvent} e */
  const points = (e) => [...e.touches].map((t) => ({ id: t.identifier, x: t.clientX, y: t.clientY }));
  /** @param {TouchEvent} e */
  const track = (e) => {
    const t = e.touches[0];
    if (t) lastTouch = { x: t.clientX, y: t.clientY };
  };
  host.addEventListener("touchstart", (e) => { track(e); scrollAcc = 0; onGestures(recognizer.down(e.timeStamp, points(e))); }, { passive: true });
  host.addEventListener("touchmove", (e) => { track(e); onGestures(recognizer.move(e.timeStamp, points(e))); }, { passive: true });
  host.addEventListener("touchend", (e) => onGestures(recognizer.up(e.timeStamp, points(e))), { passive: true });
  host.addEventListener("touchcancel", (e) => { recognizer.up(e.timeStamp, []); }, { passive: true });

  // ---- the shortcut panel ------------------------------------------------------------------------------------
  /** @param {KeyboardEvent} e */
  function onPanelKey(e) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    closePanel();
  }

  function closePanel() {
    if (!panel) return;
    panelToken++;
    document.removeEventListener("keydown", onPanelKey, true);
    panel.remove();
    scrim?.remove();
    panel = null;
    scrim = null;
    if (!ended) shortcutsButton.focus();
  }

  /** @param {HTMLElement} list @param {unknown} shortcuts */
  function fillShortcuts(list, shortcuts) {
    const items = Array.isArray(shortcuts) ? shortcuts : [];
    if (items.length === 0) {
      list.replaceChildren(h("p", { class: "term-panel-note" }, copy.shortcutsEmpty));
      return;
    }
    list.replaceChildren(...items.map((/** @type {{label?: unknown, steps?: unknown}} */ s) => {
      const label = typeof s.label === "string" ? s.label : "";
      const parsed = parseSteps(typeof s.steps === "string" ? s.steps : "", { allowPrefix: true });
      const detail = parsed.ok ? parsed.steps.map(stepLabel).join(", ") : copy.reasonLine(parsed.reason);
      return h("button", {
        type: "button",
        class: "term-shortcut",
        "data-shortcut": label,
        disabled: !parsed.ok || readonly,
        on: {
          click: () => {
            if (!parsed.ok) return;
            sendSteps(parsed.steps);
            closePanel();
          },
        },
      }, h("span", { class: "term-shortcut-label" }, label), h("span", { class: "term-shortcut-steps" }, detail));
    }));
  }

  function openPanel() {
    if (panel || ended) return;
    const token = ++panelToken;
    const list = h("div", { class: "term-panel-list", role: "group", "aria-label": copy.shortcuts }, h("p", { class: "term-panel-note" }, copy.loading));
    const closeButton = h("button", { type: "button", class: "term-key term-panel-close", "data-test": "shortcut-close", on: { click: closePanel } }, copy.close);
    panel = h("div", { class: "term-panel", role: "dialog", "aria-modal": "true", "aria-label": copy.shortcuts, "data-test": "shortcut-panel" },
      h("div", { class: "term-panel-head" }, h("h2", { class: "term-panel-title" }, copy.shortcuts), closeButton),
      list,
    );
    scrim = h("div", { class: "term-scrim", on: { click: closePanel } });
    view.append(scrim, panel);
    document.addEventListener("keydown", onPanelKey, true);
    closeButton.focus();
    void machine?.api.get("/v1/shortcuts").then((r) => {
      if (token !== panelToken || ended) return;
      if (r.ok) fillShortcuts(list, asObject(r.data).shortcuts);
      else list.replaceChildren(h("p", { class: "term-panel-note" }, copy.shortcutsFailed), ...(r.error ? [h("p", { class: "term-panel-note" }, copy.reasonLine(r.error))] : []));
    });
  }

  syncCtrl();

  return {
    unmount() {
      if (ended) return;
      ended = true;
      closePanel();
      offSettings();
      colorScheme.removeEventListener("change", onScheme);
      observer.disconnect();
      cancelAnimationFrame(fitFrame);
      clearTimeout(flashTimer);
      socket.close();
      dropLink();
      term.dispose();
      view.remove();
    },
  };
}
