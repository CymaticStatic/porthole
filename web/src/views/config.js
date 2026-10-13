// Config for one machine (`#/config/<machine>`, SPEC 4.2 item 6): the custom shortcuts editor, the few hostd
// settings the app may change, and the doctor's checks. Everything here is read from and written to that
// machine's hostd; nothing is stored on this device.
import { h } from "../dom/h.js";
import { copy } from "../lib/copy.js";
import { asArray, asObject } from "../lib/json.js";
import { parseSteps, stepLabel } from "../lib/steps.js";
import { section, toggleRow } from "./settings.js";

/** @typedef {{label: string, steps: string}} Shortcut */

// hostd's rules, repeated here so a bad name is caught before the request. See server/src/features/shortcuts.ts.
const LABEL_MAX = 40;

const LABEL_TOO_LONG = copy.labelTooLong(LABEL_MAX);

/** A message that says it is loading, then is replaced. @param {string} text */
const note = (text) => h("p", { class: "set-note" }, text);

/** @param {unknown} p @returns {p is string} */
const isString = (p) => typeof p === "string";

/**
 * Loads into `box`: "Loading…", then `render(data)` on success, or the failure sentence and a Try again button.
 * @param {HTMLElement} box
 * @param {() => Promise<import("../net/api.js").ApiResult>} fetcher
 * @param {string} failed
 * @param {(data: unknown) => void} render
 * @param {() => boolean} alive
 */
function loadInto(box, fetcher, failed, render, alive) {
  const run = () => {
    box.replaceChildren(note(copy.loading));
    fetcher().then((r) => {
      if (!alive()) return;
      if (r.ok) return render(r.data);
      box.replaceChildren(
        h("p", { class: "set-error", role: "alert" }, failed),
        ...(r.error ? [h("p", { class: "set-note" }, copy.reasonLine(r.error))] : []),
        h("button", { type: "button", class: "btn", on: { click: run } }, copy.tryAgain));
    });
  };
  run();
}

/** @param {string} stepsText */
function chips(stepsText) {
  const r = parseSteps(stepsText);
  if (!r.ok) return h("span", { class: "chip-row set-sub" }, stepsText);
  return h("span", { class: "chip-row" }, r.steps.map((s) => h("span", { class: "chip" }, stepLabel(s))));
}

/**
 * @param {HTMLElement} root
 * @param {Pick<import("../lib/types.js").Ctx, "fleet"> & {route: {view: string, machine?: string}}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(root, ctx) {
  let alive = true;
  const isAlive = () => alive;
  const name = ctx.route.machine ?? "";
  const machine = ctx.fleet.machine(name);

  const view = h("div", { class: "settings-view", "data-test": "config" }, h("h1", { class: "set-title" }, copy.configTitle(name)));
  root.append(view);
  const handle = {
    unmount() {
      alive = false;
      view.remove();
    },
  };
  if (!machine) {
    view.append(h("p", { class: "set-error", role: "alert" }, copy.cannotReach(name)));
    return handle;
  }
  const api = machine.api;

  // ---- Shortcuts ----
  /** @type {Shortcut[]} */
  let items = [];
  /** The label of the shortcut being edited, "" for a new one, null when the editor is closed. @type {string | null} */
  let editing = null;
  let saving = false;

  const list = h("div", { class: "set-stack", "data-test": "shortcut-list" });
  const status = h("p", { class: "set-note", role: "status", "data-test": "shortcut-status" });
  const labelInput = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "field", maxlength: String(LABEL_MAX + 20), autocomplete: "off", "data-test": "shortcut-label" }));
  const stepsInput = /** @type {HTMLInputElement} */ (h("input", {
    type: "text",
    class: "field mono",
    autocapitalize: "none",
    autocomplete: "off",
    spellcheck: "false",
    "data-test": "shortcut-steps",
  }));
  const previewBox = h("div", { class: "set-stack", "data-test": "shortcut-preview" });
  const errorLine = h("p", { class: "set-error", role: "alert", hidden: true, "data-test": "shortcut-error" });
  const saveButton = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn btn-primary", disabled: true, "data-test": "shortcut-save" }, copy.shortcutSave));
  const cancelButton = h("button", { type: "button", class: "btn", "data-test": "shortcut-cancel" }, copy.cancel);
  const editor = h("div", { class: "set-editor", hidden: true, "data-test": "shortcut-editor" },
    h("label", { class: "set-field" }, h("span", {}, copy.shortcutLabel), labelInput),
    h("label", { class: "set-field" }, h("span", {}, copy.shortcutSteps), stepsInput),
    h("p", { class: "set-note" }, copy.shortcutStepsHelp),
    previewBox,
    errorLine,
    h("div", { class: "set-actions" }, saveButton, cancelButton));
  const addButton = h("button", { type: "button", class: "btn", "data-test": "shortcut-add" }, copy.shortcutAdd);

  /** What is wrong with the draft, as a sentence, or "" when nothing needs saying. Also says whether it can be saved. */
  function check() {
    const label = labelInput.value.trim();
    const stepsText = stepsInput.value;
    /** @type {string} */
    let message = "";
    if ([...label].length > LABEL_MAX) message = LABEL_TOO_LONG;
    else if (label !== "" && items.some((it) => it.label === label && it.label !== editing)) message = copy.labelTaken;
    const parsed = parseSteps(stepsText);
    if (message === "" && stepsText.trim() !== "" && !parsed.ok) message = copy.reasonLine(parsed.reason);
    return { message, canSave: message === "" && label !== "" && parsed.ok, parsed };
  }

  /** Updates the disabled state, the error line and the preview. Never touches the inputs, so typing keeps its focus. */
  function refreshEditor() {
    const { message, canSave, parsed } = check();
    errorLine.textContent = message;
    errorLine.hidden = message === "";
    labelInput.setAttribute("aria-invalid", String(message === LABEL_TOO_LONG || message === copy.labelTaken));
    stepsInput.setAttribute("aria-invalid", String(message !== "" && parsed.ok === false));
    saveButton.disabled = !canSave || saving;
    previewBox.replaceChildren(...(parsed.ok ? [h("span", { class: "set-sub" }, copy.shortcutPreview), chips(stepsInput.value)] : []));
  }
  labelInput.addEventListener("input", refreshEditor);
  stepsInput.addEventListener("input", refreshEditor);

  /** @param {Shortcut | null} item */
  function openEditor(item) {
    editing = item ? item.label : "";
    labelInput.value = item ? item.label : "";
    stepsInput.value = item ? item.steps : "";
    status.textContent = "";
    editor.hidden = false;
    addButton.hidden = true;
    refreshEditor();
    labelInput.focus();
  }
  function closeEditor() {
    editing = null;
    editor.hidden = true;
    addButton.hidden = false;
  }

  /** @param {Shortcut[]} next @returns {Promise<boolean>} */
  async function persist(next) {
    saving = true;
    saveButton.disabled = true;
    const r = await api.put("/v1/shortcuts", { shortcuts: next });
    saving = false;
    if (!alive) return false;
    if (!r.ok) {
      const failure = `${copy.shortcutSaveFailed} ${copy.reasonLine(r.error)}`;
      status.textContent = editor.hidden ? failure : "";
      errorLine.textContent = failure;
      errorLine.hidden = false;
      saveButton.disabled = !check().canSave;
      return false;
    }
    items = next;
    renderList();
    status.textContent = copy.shortcutSaved;
    return true;
  }

  saveButton.addEventListener("click", async () => {
    if (!check().canSave) return;
    const entry = { label: labelInput.value.trim(), steps: stepsInput.value.trim() };
    const next = items.some((it) => it.label === editing) ? items.map((it) => (it.label === editing ? entry : it)) : [...items, entry];
    if (await persist(next)) closeEditor();
  });
  cancelButton.addEventListener("click", () => closeEditor());
  addButton.addEventListener("click", () => openEditor(null));

  function renderList() {
    list.replaceChildren(
      ...items.map((it) =>
        h("div", { class: "set-row set-row-stack", "data-test": "shortcut-row", "data-label": it.label },
          h("span", { class: "set-row-text" }, h("strong", {}, it.label), chips(it.steps)),
          h("div", { class: "set-actions" },
            h("button", { type: "button", class: "btn", "aria-label": `${copy.editShortcut} ${it.label}`, on: { click: () => openEditor(it) } }, copy.editShortcut),
            h("button", {
              type: "button",
              class: "btn",
              "aria-label": `${copy.shortcutRemove} ${it.label}`,
              "data-test": "shortcut-remove",
              on: { click: () => { closeEditor(); void persist(items.filter((x) => x !== it)); } },
            }, copy.shortcutRemove)))));
  }

  const shortcutBody = h("div", { class: "set-stack" });
  const shortcutSection = section(copy.shortcutsEditor, shortcutBody);
  loadInto(shortcutBody, () => api.get("/v1/shortcuts"), copy.configFailed, (data) => {
    const body = asObject(data);
    items = Array.isArray(body.shortcuts)
      ? body.shortcuts.map(asObject).filter((s) => typeof s.label === "string" && typeof s.steps === "string").map((s) => ({ label: String(s.label), steps: String(s.steps) }))
      : [];
    renderList();
    shortcutBody.replaceChildren(list, status, addButton, editor);
  }, isAlive);

  // ---- Settings on this machine ----
  const hostBody = h("div", { class: "set-stack" });
  const hostSection = section(copy.hostSettings, hostBody);
  loadInto(hostBody, () => api.get("/v1/config"), copy.configFailed, (data) => {
    const cfg = asObject(data);
    let saved = {
      previewRanges: String(cfg.previewRanges ?? "none"),
      usageCollection: cfg.usageCollection === true,
      peers: Array.isArray(cfg.peers) ? cfg.peers.filter(isString) : [],
      voiceEnhance: cfg.voiceEnhance === true,
    };
    const labels = /** @type {Record<string, string>} */ (copy.configLabels);
    const rangesInput = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "field", autocomplete: "off", spellcheck: "false", "data-test": "config-ranges" }));
    rangesInput.value = saved.previewRanges;
    const peersInput = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "field", rows: "3", autocapitalize: "none", spellcheck: "false", "data-test": "config-peers" }));
    peersInput.value = saved.peers.join("\n");
    const usage = toggleRow({ label: labels.usageCollection, test: "config-usage", checked: saved.usageCollection, onChange: () => {} });
    const voice = toggleRow({ label: labels.voiceEnhance, test: "config-voice", checked: saved.voiceEnhance, onChange: () => {} });
    const result = h("p", { class: "set-note", role: "status", "data-test": "config-result" });
    const failure = h("p", { class: "set-error", role: "alert", hidden: true });
    const save = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn btn-primary", "data-test": "config-save" }, copy.shortcutSave));
    save.addEventListener("click", async () => {
      const peers = peersInput.value.split("\n").map((s) => s.trim()).filter((s) => s !== "");
      /** @type {Record<string, unknown>} */
      const body = {};
      if (rangesInput.value.trim() !== saved.previewRanges) body.previewRanges = rangesInput.value.trim();
      if (usage.input.checked !== saved.usageCollection) body.usageCollection = usage.input.checked;
      if (voice.input.checked !== saved.voiceEnhance) body.voiceEnhance = voice.input.checked;
      if (peers.join("\n") !== saved.peers.join("\n")) body.peers = peers;
      result.textContent = "";
      failure.hidden = true;
      if (Object.keys(body).length === 0) {
        result.textContent = copy.configSaved;
        return;
      }
      save.disabled = true;
      const r = await api.put("/v1/config", body);
      save.disabled = false;
      if (!alive) return;
      if (!r.ok) {
        failure.textContent = `${copy.configSaveFailed} ${copy.reasonLine(r.error)}`;
        failure.hidden = false;
        return;
      }
      const out = asObject(r.data);
      saved = {
        previewRanges: String(out.previewRanges ?? saved.previewRanges),
        usageCollection: out.usageCollection === true,
        peers: Array.isArray(out.peers) ? /** @type {string[]} */ (out.peers) : peers,
        voiceEnhance: out.voiceEnhance === true,
      };
      result.textContent = out.restartNeeded === true ? copy.restartNeeded(name) : copy.configSaved;
    });
    hostBody.replaceChildren(
      h("label", { class: "set-field" }, h("span", {}, labels.previewRanges), rangesInput),
      h("p", { class: "set-note" }, copy.rangesHelp),
      usage.el,
      voice.el,
      h("label", { class: "set-field" }, h("span", {}, labels.peers), peersInput),
      h("p", { class: "set-note" }, copy.peersHelp),
      h("div", { class: "set-actions" }, save),
      result,
      failure);
  }, isAlive);

  // ---- Checks (the doctor, including the omp extension files) ----
  const doctorBody = h("div", { class: "set-stack" });
  const doctorSection = section(copy.doctorTitle, doctorBody);
  /** @param {unknown} data */
  const renderChecks = (data) => {
    const checks = /** @type {{id: string, ok: boolean, detail?: string}[]} */ (asArray(asObject(data).checks));
    const rows = checks.map((c) =>
      h("div", { class: `doctor-row ${c.ok ? "doctor-ok" : "doctor-bad"}`, "data-test": "doctor-check", "data-id": c.id, "data-ok": String(c.ok === true) },
        h("span", { class: "doctor-mark", "aria-hidden": "true" }, c.ok ? "✓" : "▲"),
        h("span", { class: "set-row-text" },
          h("strong", {}, copy.doctorLabel(String(c.id))),
          h("span", { class: "doctor-word" }, c.ok ? copy.doctorOk : copy.doctorBad),
          !c.ok && c.detail ? h("span", { class: "set-sub" }, copy.reasonLine(c.detail)) : null)));
    doctorBody.replaceChildren(
      ...(rows.length > 0 ? rows : [note(copy.doctorNone)]),
      h("div", { class: "set-actions" }, h("button", { type: "button", class: "btn", "data-test": "doctor-again", on: { click: runDoctor } }, copy.checkAgain)));
  };
  function runDoctor() {
    loadInto(doctorBody, () => api.get("/v1/doctor"), copy.doctorFailed, renderChecks, isAlive);
  }
  runDoctor();

  view.append(shortcutSection, hostSection, doctorSection);
  return handle;
}
