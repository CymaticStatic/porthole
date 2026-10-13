// Settings (this device, SPEC 4.2 item 5): machines, text size, talk mode, read-aloud, gestures, tmux prefix and
// notifications. Every control reads and writes through `ctx.settings` (get / set / subscribe); this file never
// touches the `porthole:settings` key. The machine list is the one thing that is not a setting: it lives in
// `porthole:machines` (the fleet reads it at start-up), so a change there reloads the page.
import { h } from "../dom/h.js";
import { copy } from "../lib/copy.js";
import { ACTIONS, DEFAULT_GESTURES, FONT_STEPS, mergeGestureMap, nextFontSize } from "../lib/gestures.js";
import { asObject } from "../lib/json.js";
import { parseSteps } from "../lib/steps.js";
import { phoneSettingsLinks } from "../lib/phonesettings.js";

/** @typedef {Pick<import("../lib/types.js").Ctx, "fleet" | "settings" | "bridge"> & {route: {view: string, machine?: string}}} Ctx */

/** The five text sizes (87.5 %, 100 %, 112.5 %, 125 %, 150 %): multiplied into the page's base size as `--fs-scale`. */
export const TEXT_SCALES = Object.freeze([0.875, 1, 1.125, 1.25, 1.5]);
export const DEFAULT_TERM_FONT_PX = 14;
export const DEFAULT_PREFIX = "C-b";
const MACHINES_KEY = "porthole:machines";

/** @param {string} title @param {...(Node | string | null | false)} kids */
export function section(title, ...kids) {
  return h("section", { class: "set-section" }, h("h2", { class: "set-heading" }, title), ...kids);
}

/**
 * A row with a label on the left and an on/off switch on the right. The whole row is the tap target.
 * @param {{label: string, test: string, checked: boolean, onChange: (on: boolean) => void}} o
 * @returns {{el: HTMLElement, input: HTMLInputElement}}
 */
export function toggleRow({ label, test, checked, onChange }) {
  const input = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", class: "switch", "data-test": test }));
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  return { el: h("label", { class: "set-row" }, h("span", { class: "set-row-text" }, label), input), input };
}

/** Applies the text size to the whole page (D1 applies it again at start-up). @param {number} scale */
function applyScale(scale) {
  document.documentElement.style.setProperty("--fs-scale", String(scale));
}

/** The saved text size, snapped to the nearest of the five steps. @param {unknown} v */
function scaleIndex(v) {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 1;
  let best = 1;
  for (let i = 0; i < TEXT_SCALES.length; i++) {
    if (Math.abs(TEXT_SCALES[i] - n) < Math.abs(TEXT_SCALES[best] - n)) best = i;
  }
  return best;
}

/** The saved terminal text size, snapped to FONT_STEPS. @param {unknown} v */
function termPx(v) {
  const n = typeof v === "number" && Number.isFinite(v) ? v : DEFAULT_TERM_FONT_PX;
  return FONT_STEPS.reduce((best, px) => (Math.abs(px - n) < Math.abs(best - n) ? px : best), FONT_STEPS[0]);
}

/** Only the gestures that differ from the defaults are saved. @param {Record<string, string>} map */
function gestureDiff(map) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [g, action] of Object.entries(map)) if (action !== DEFAULT_GESTURES[g]) out[g] = action;
  return out;
}

/** A prefix is one key step: C-b, C-a, a named key, or one character. @param {string} text */
export function checkPrefix(text) {
  const r = parseSteps(text.trim());
  if (!r.ok) return { ok: false, reason: r.reason };
  if (r.steps.length !== 1 || r.steps[0].startsWith("text:")) return { ok: false, reason: copy.prefixInvalid };
  return { ok: true, key: r.steps[0] };
}

/** @param {string} origin */
function hostOf(origin) {
  try { return new URL(origin).host; } catch { return origin; }
}

/**
 * @param {HTMLElement} root
 * @param {Ctx} ctx
 * @returns {{unmount(): void}}
 */
export function mount(root, ctx) {
  const store = ctx.settings;
  /** @type {(() => void)[]} */
  const syncs = [];

  // ---- Machines ----
  const machinesBox = h("div", { class: "set-stack" });
  let alive = true;
  const readOnly = ctx.bridge?.available === true;
  const machineList = ctx.fleet.machines().map((m) => ({ name: m.name, origin: m.origin }));

  /** @param {{name: string, origin: string}[]} list @returns {boolean} */
  const saveMachines = (list) => {
    try {
      localStorage.setItem(MACHINES_KEY, JSON.stringify(list));
      return true;
    } catch {
      return false;
    }
  };

  const machineError = h("p", { class: "set-error", role: "alert", hidden: true, "data-test": "machine-error" });
  /** @param {string} text */
  const showMachineError = (text) => {
    machineError.textContent = text;
    machineError.hidden = text === "";
  };

  for (const m of machineList) {
    const kept = h("span", { class: "set-sub", "data-test": "voice-kept" });
    const row = h("div", { class: "set-row", "data-test": "machine-row", "data-machine": m.name },
      h("span", { class: "set-row-text" }, h("strong", {}, m.name), h("span", { class: "set-sub" }, hostOf(m.origin)), kept));
    ctx.fleet.machine(m.name)?.api.get("/v1/voice/kept").then((r) => {
      const files = r.ok ? asObject(r.data).files : undefined;
      if (alive && Array.isArray(files)) kept.textContent = copy.voiceKeptCount(files.length);
    }).catch(() => {});
    if (!readOnly && machineList.length > 1) {
      row.append(h("button", {
        type: "button",
        class: "btn",
        "aria-label": copy.removeMachine(m.name),
        "data-test": "machine-remove",
        on: {
          click: () => {
            const next = machineList.filter((x) => x.origin !== m.origin);
            if (!saveMachines(next)) return showMachineError(copy.machineSaveFailed);
            location.reload();
          },
        },
      }, copy.remove));
    }
    machinesBox.append(row);
  }
  if (machineList.length === 0) machinesBox.append(h("p", { class: "set-note" }, copy.emptyMachines));

  /** @type {Node[]} */
  const machineParts = [machinesBox];
  if (readOnly) {
    machineParts.push(h("p", { class: "set-note", "data-test": "machines-readonly" }, copy.machinesReadOnly));
  } else {
    const nameInput = /** @type {HTMLInputElement} */ (h("input", {
      type: "text",
      class: "field",
      autocapitalize: "none",
      autocomplete: "off",
      spellcheck: "false",
      "data-test": "machine-name",
    }));
    const form = h("form", {
      class: "set-form",
      on: {
        submit: (/** @type {Event} */ e) => {
          e.preventDefault();
          const name = nameInput.value.trim().toLowerCase();
          if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) return showMachineError(copy.machineNameInvalid);
          const labels = location.hostname.split(".");
          const tail = labels.length > 1 ? "." + labels.slice(1).join(".") : "";
          const port = location.port ? ":" + location.port : "";
          const origin = `${location.protocol}//${name}${tail}${port}`;
          if (machineList.some((m) => m.name === name || m.origin === origin)) return showMachineError(copy.machineExists);
          if (!saveMachines([...machineList, { name, origin }])) return showMachineError(copy.machineSaveFailed);
          location.reload();
        },
      },
    },
    h("label", { class: "set-field" }, h("span", {}, copy.machineName), nameInput),
    h("button", { type: "submit", class: "btn btn-primary", "data-test": "machine-add" }, copy.add));
    machineParts.push(h("p", { class: "set-note" }, copy.addMachine), form, machineError);
  }

  // ---- Text size ----
  const termValue = h("span", { class: "stepper-value", "data-test": "term-font-value" });
  const scaleValue = h("span", { class: "stepper-value", "data-test": "text-scale-value" });
  const termPreview = h("p", { class: "set-preview mono", "data-test": "term-preview" }, copy.textSizePreview);
  const termSmaller = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn", "data-test": "term-smaller", "aria-label": `${copy.terminalTextSize}: ${copy.smallerText}` }, copy.smallerText));
  const termBigger = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn", "data-test": "term-bigger", "aria-label": `${copy.terminalTextSize}: ${copy.biggerText}` }, copy.biggerText));
  const scaleSmaller = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn", "data-test": "scale-smaller", "aria-label": `${copy.chatTextSize}: ${copy.smallerText}` }, copy.smallerText));
  const scaleBigger = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn", "data-test": "scale-bigger", "aria-label": `${copy.chatTextSize}: ${copy.biggerText}` }, copy.biggerText));

  termSmaller.addEventListener("click", () => store.set({ termFontPx: nextFontSize(termPx(store.get().termFontPx), -1) }));
  termBigger.addEventListener("click", () => store.set({ termFontPx: nextFontSize(termPx(store.get().termFontPx), 1) }));
  scaleSmaller.addEventListener("click", () => store.set({ textScale: TEXT_SCALES[Math.max(0, scaleIndex(store.get().textScale) - 1)] }));
  scaleBigger.addEventListener("click", () => store.set({ textScale: TEXT_SCALES[Math.min(TEXT_SCALES.length - 1, scaleIndex(store.get().textScale) + 1)] }));

  syncs.push(() => {
    const px = termPx(store.get().termFontPx);
    termValue.textContent = String(px);
    termPreview.style.setProperty("font-size", px + "px");
    termSmaller.disabled = nextFontSize(px, -1) === px;
    termBigger.disabled = nextFontSize(px, 1) === px;
    const i = scaleIndex(store.get().textScale);
    scaleValue.textContent = copy.scaleValue(TEXT_SCALES[i]);
    scaleSmaller.disabled = i === 0;
    scaleBigger.disabled = i === TEXT_SCALES.length - 1;
    applyScale(TEXT_SCALES[i]);
  });

  const textSizeSection = section(copy.textSize,
    h("div", { class: "set-row set-row-stack" },
      h("span", { class: "set-row-text" }, copy.chatTextSize),
      h("div", { class: "stepper" }, scaleSmaller, scaleValue, scaleBigger)),
    h("p", { class: "set-preview", "data-test": "chat-preview" }, copy.textSizePreview),
    h("div", { class: "set-row set-row-stack" },
      h("span", { class: "set-row-text" }, copy.terminalTextSize),
      h("div", { class: "stepper" }, termSmaller, termValue, termBigger)),
    termPreview);

  // ---- Talk mode and read-aloud ----
  /** @param {string} label @param {string} test @param {string} key @param {boolean} fallback */
  const settingToggle = (label, test, key, fallback) => {
    const row = toggleRow({
      label,
      test,
      checked: Boolean(store.get()[key] ?? fallback),
      onChange: (on) => store.set({ [key]: on }),
    });
    syncs.push(() => { row.input.checked = Boolean(store.get()[key] ?? fallback); });
    return row.el;
  };
  const talkSection = section(copy.talkMode,
    settingToggle(copy.talkAutoSend, "talk-auto-send", "talkAutoSend", true),
    settingToggle(copy.talkAutoStop, "talk-auto-stop", "talkAutoStop", true),
    settingToggle(copy.readAloud, "read-aloud", "readAloud", false));

  // ---- Gestures and the tmux prefix ----
  const gestureBox = h("div", { class: "set-stack" });
  for (const gesture of Object.keys(DEFAULT_GESTURES)) {
    const names = /** @type {Record<string, string>} */ (copy.gestureNames);
    const actions = /** @type {Record<string, string>} */ (copy.gestureActions);
    const select = /** @type {HTMLSelectElement} */ (h("select", { class: "field", "data-test": "gesture-select", "data-gesture": gesture },
      ACTIONS.map((a) => h("option", { value: a }, actions[a] ?? a))));
    select.addEventListener("change", () => {
      const map = mergeGestureMap(store.get().gestures);
      map[gesture] = select.value;
      store.set({ gestures: gestureDiff(map) });
    });
    const note = h("span", { class: "set-sub", "data-test": "gesture-note" }, copy.windowSwipeNote);
    syncs.push(() => {
      const action = mergeGestureMap(store.get().gestures)[gesture];
      select.value = action;
      note.hidden = !action.startsWith("window-");
    });
    gestureBox.append(h("label", { class: "set-field", "data-test": "gesture-row" }, h("span", {}, names[gesture] ?? gesture), select, note));
  }

  const prefixError = h("p", { class: "set-error", role: "alert", hidden: true, "data-test": "prefix-error" });
  const prefixInput = /** @type {HTMLInputElement} */ (h("input", {
    type: "text",
    class: "field",
    autocapitalize: "none",
    autocomplete: "off",
    spellcheck: "false",
    "data-test": "tmux-prefix",
  }));
  prefixInput.addEventListener("input", () => {
    const r = checkPrefix(prefixInput.value);
    prefixInput.setAttribute("aria-invalid", String(!r.ok));
    prefixError.hidden = r.ok;
    if (r.ok) store.set({ tmuxPrefix: r.key });
    else prefixError.textContent = copy.reasonLine(r.reason ?? "");
  });
  syncs.push(() => {
    // Leave the box alone while Ben is typing in it; it already holds what he typed.
    if (document.activeElement === prefixInput) return;
    const saved = store.get().tmuxPrefix;
    prefixInput.value = typeof saved === "string" ? saved : DEFAULT_PREFIX;
    prefixInput.removeAttribute("aria-invalid");
    prefixError.hidden = true;
  });

  const resetButton = h("button", { type: "button", class: "btn", "data-test": "gesture-reset", on: { click: () => store.set({ gestures: {} }) } }, copy.resetGestures);
  const gesturesSection = section(copy.gestures,
    h("p", { class: "set-note" }, copy.gesturesIntro),
    gestureBox,
    resetButton,
    h("label", { class: "set-field" }, h("span", {}, copy.tmuxPrefix), prefixInput),
    h("p", { class: "set-note" }, copy.tmuxPrefixHelp),
    prefixError);

  // ---- Notifications (the Android app only: the page itself shows none) ----
  /** @type {HTMLElement | null} */
  let notificationsSection = null;
  if (ctx.bridge?.available) {
    const failed = h("p", { class: "set-error", role: "alert", hidden: true }, copy.notificationsFailed);
    notificationsSection = section(copy.notifications,
      h("button", {
        type: "button",
        class: "btn",
        "data-test": "notification-settings",
        on: {
          click: () => {
            failed.hidden = true;
            // GUESS: the app's `openExternal` understands this address and opens its own notification settings.
            ctx.bridge.call("openExternal", { url: "porthole://notification-settings" }).catch(() => { failed.hidden = false; });
          },
        },
      }, copy.notificationSettings),
      failed);
  }

  // ---- Phone settings (the Android app only: native screens, so nothing to show in a plain browser) ----
  /** @type {HTMLElement | null} */
  let phoneSection = null;
  const phoneLinks = phoneSettingsLinks(ctx.bridge, copy);
  if (phoneLinks.length > 0) {
    const phoneFailed = h("p", { class: "set-error", role: "alert", hidden: true, "data-test": "phone-settings-failed" }, copy.phoneSettingsFailed);
    phoneSection = section(copy.phoneSettings,
      h("div", { class: "set-stack" }, ...phoneLinks.map((link) => h("button", {
        type: "button",
        class: "btn",
        "data-test": link.test,
        on: {
          click: () => {
            phoneFailed.hidden = true;
            ctx.bridge.call("openSettings", { screen: link.screen }).catch(() => { phoneFailed.hidden = false; });
          },
        },
      }, link.label))),
      phoneFailed);
  }

  const view = h("div", { class: "settings-view", "data-test": "settings" },
    h("h1", { class: "set-title" }, copy.settingsTitle),
    section(copy.machinesTitle, ...machineParts),
    talkSection,
    gesturesSection,
    textSizeSection,
    notificationsSection,
    phoneSection);
  root.append(view);

  const syncAll = () => { for (const fn of syncs) fn(); };
  syncAll();
  const unsubscribe = store.subscribe(syncAll);

  return {
    unmount() {
      alive = false;
      unsubscribe();
      view.remove();
    },
  };
}
