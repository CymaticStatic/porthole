// The chat view's key row (SPEC 4.3): Esc ↑ ↓ Enter Tab Stop, then this machine's saved shortcuts.
// Every press is `POST /v1/sessions/:id/keys {keys: steps}`. There is no Ctrl+C button (chatKeyRow leaves it out).
// While the session is in live voice at the desk hostd refuses keys, so the row is disabled and says why.
import { h } from "../dom/h.js";
import { chatKeyRow, parseSteps } from "../lib/steps.js";

/** The six built-in buttons, in order; their `data-key` is the key name, never the label. */
const BUILT_IN = ["Esc", "Up", "Down", "Enter", "Tab", "Stop"];
const ERROR_MS = 6000;

/**
 * @param {{ctx: any, machine: any, sessionId: string}} o
 * @returns {{el: HTMLElement, destroy(): void}}
 */
export function createKeyRow({ ctx, machine, sessionId }) {
  const { copy } = ctx;
  /** @type {{label: string, steps: string[], stop?: boolean}[]} */
  let buttons = chatKeyRow([]);
  let liveVoice = false;
  let alive = true;
  /** @type {any} */
  let errorTimer = null;

  const row = h("div", { class: "keyrow", "data-test": "keyrow", role: "group", "aria-label": copy.keyRow });
  const problem = h("p", { class: "keyrow-problem", "data-test": "keyrow-error", role: "status" });
  problem.hidden = true;
  const el = h("div", { class: "keyrow-wrap" }, row, problem);
  /** @type {HTMLElement | null} the "why it is off" note: in the page only while live voice is on */
  let note = null;

  /** @param {string} text */
  function showProblem(text) {
    problem.textContent = text;
    problem.hidden = false;
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      problem.hidden = true;
      problem.textContent = "";
    }, ERROR_MS);
  }

  /** @param {string[]} steps */
  async function press(steps) {
    if (liveVoice) return;
    const r = await machine.api.post(`/v1/sessions/${encodeURIComponent(sessionId)}/keys`, { keys: steps });
    if (!alive || r.ok) return;
    showProblem(r.status === 0 || !r.error ? copy.keyFailed : `${copy.keyFailed} ${copy.reasonLine(r.error)}`);
  }

  function renderButtons() {
    row.replaceChildren(
      ...buttons.map((b, i) => {
        const name = i < BUILT_IN.length ? BUILT_IN[i] : b.label;
        const builtIn = i < BUILT_IN.length;
        const label = builtIn ? copy.keys[/** @type {keyof typeof copy.keys} */ (name)] : b.label;
        const btn = /** @type {HTMLButtonElement} */ (h(
          "button",
          {
            type: "button",
            class: "keyrow-key" + (b.stop ? " keyrow-stop" : ""),
            "data-key": name,
            "aria-label": builtIn ? copy.keyNames[/** @type {keyof typeof copy.keyNames} */ (name)] : b.label,
            on: { click: () => void press(b.steps) },
          },
          label,
        ));
        btn.disabled = liveVoice;
        return btn;
      }),
    );
  }

  function readLiveVoice() {
    const sessions = machine.tree()?.sessions;
    const mine = Array.isArray(sessions) ? sessions.find((/** @type {any} */ s) => s && s.id === sessionId) : null;
    const next = mine?.liveVoice === true;
    if (next === liveVoice) return;
    liveVoice = next;
    for (const b of /** @type {NodeListOf<HTMLButtonElement>} */ (row.querySelectorAll("button"))) b.disabled = liveVoice;
    note?.remove();
    note = null;
    if (liveVoice) {
      note = h("p", { class: "keyrow-note", "data-test": "keyrow-note" }, copy.liveVoiceKeys);
      row.after(note);
    }
  }

  async function loadShortcuts() {
    const r = await machine.api.get("/v1/shortcuts");
    if (!alive || !r.ok || !Array.isArray(r.data?.shortcuts)) return;
    /** @type {{name: string, steps: string[]}[]} */
    const shortcuts = [];
    for (const s of r.data.shortcuts) {
      if (!s || typeof s.label !== "string" || typeof s.steps !== "string") continue;
      const parsed = parseSteps(s.steps, { allowPrefix: true });
      if (parsed.ok) shortcuts.push({ name: s.label, steps: parsed.steps });
    }
    buttons = chatKeyRow(shortcuts);
    renderButtons();
  }

  renderButtons();
  readLiveVoice();
  const off = machine.subscribe(readLiveVoice);
  void loadShortcuts();

  return {
    el,
    destroy() {
      alive = false;
      off();
      clearTimeout(errorTimer);
    },
  };
}
