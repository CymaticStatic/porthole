// Step syntax: one "step" is a key name hostd's /keys accepts (SPEC V8), the
// terminal-only pseudo-step "prefix", or "text:<text>". Pure functions, no DOM.

/** @typedef {{ok: true, steps: string[]} | {ok: false, reason: string}} ParseResult */
/** @typedef {{label: string, steps: string[], stop?: boolean}} KeyButton */

export const MAX_STEPS = 32;

/** Named keys and the bytes a terminal receives for them. */
const NAMED = /** @type {Record<string, string>} */ ({
  Enter: "\r",
  Tab: "\t",
  Esc: "\x1b",
  Space: " ",
  BSpace: "\x7f",
  Up: "\x1b[A",
  Down: "\x1b[B",
  Right: "\x1b[C",
  Left: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
});

/** What a button shows for each named key. */
const LABELS = /** @type {Record<string, string>} */ ({
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
  BSpace: "Backspace",
  PageUp: "Page Up",
  PageDown: "Page Down",
});

const CTRL = /^C-([a-z])$/;
const encoder = new TextEncoder();

/** One user-visible character (a code point) that is not a control or blank. */
function isPrintableChar(/** @type {string} */ s) {
  return [...s].length === 1 && !/[\p{C}\p{Z}]/u.test(s);
}

/** @param {string} step @param {boolean} allowPrefix */
function isValidStep(step, allowPrefix) {
  if (step.startsWith("text:")) return step.length > 5;
  if (step === "prefix") return allowPrefix;
  return step in NAMED || CTRL.test(step) || isPrintableChar(step);
}

/** Split on commas that are not preceded by a backslash. */
function splitUnescaped(/** @type {string} */ text) {
  const parts = [];
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && text[i + 1] === ",") {
      cur += ",";
      i++;
    } else if (ch === ",") {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

/** @param {string} raw */
function hintFor(raw) {
  const m = /^(?:ctrl|control|c)[-+ ]([a-z])$/i.exec(raw);
  if (m) return ` Try C-${m[1].toLowerCase()} for Ctrl+${m[1].toUpperCase()}.`;
  return " Use a name like Enter, Esc, Tab, Up or C-c, or text:<words to type>.";
}

/**
 * @param {string} text
 * @param {{allowPrefix?: boolean}} [opts]
 * @returns {ParseResult}
 */
export function parseSteps(text, opts = {}) {
  const allowPrefix = opts.allowPrefix === true;
  if (text.trim() === "") return { ok: false, reason: "Add at least one step, such as Enter." };
  const steps = splitUnescaped(text).map((s) => s.trim());
  if (steps.length > MAX_STEPS) {
    return { ok: false, reason: `That is ${steps.length} steps; Porthole allows up to ${MAX_STEPS}.` };
  }
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const n = i + 1;
    if (step === "") return { ok: false, reason: `Step ${n} is empty. Remove the extra comma, or write \\, for a comma you want to type.` };
    if (step === "text:") return { ok: false, reason: `Step ${n}, "text:", has nothing to type after the colon.` };
    if (step === "prefix" && !allowPrefix) {
      return { ok: false, reason: `Step ${n}, "prefix", only works in the terminal view.` };
    }
    if (!isValidStep(step, allowPrefix)) {
      return { ok: false, reason: `Step ${n}, "${step}", isn't a key Porthole knows.${hintFor(step)}` };
    }
  }
  return { ok: true, steps };
}

/** @param {string[]} steps */
export function formatSteps(steps) {
  return steps.map((s) => s.replaceAll(",", "\\,")).join(", ");
}

/** @param {string} step */
export function stepLabel(step) {
  if (step.startsWith("text:")) return `Type: ${step.slice(5)}`;
  if (step === "prefix") return "tmux prefix";
  const ctrl = CTRL.exec(step);
  if (ctrl) return `Ctrl+${ctrl[1].toUpperCase()}`;
  return LABELS[step] ?? step;
}

/**
 * Bytes the terminal receives for one step. `prefix` is the tmux prefix key
 * (a step name such as "C-b").
 * @param {string} step
 * @param {string} [prefix]
 * @returns {Uint8Array}
 */
export function stepBytes(step, prefix = "C-b") {
  if (step === "prefix") {
    if (prefix === "prefix") throw new RangeError('The tmux prefix cannot be "prefix".');
    return stepBytes(prefix, "C-b");
  }
  if (step.startsWith("text:")) return encoder.encode(step.slice(5));
  if (step in NAMED) return encoder.encode(NAMED[step]);
  const ctrl = CTRL.exec(step);
  if (ctrl) return Uint8Array.of(ctrl[1].charCodeAt(0) - 96);
  if (isPrintableChar(step)) return encoder.encode(step);
  throw new RangeError(`Unknown step: ${step}`);
}

/**
 * The chat view's button row (SPEC 4.3). Custom shortcuts with a Ctrl+C or
 * `prefix` step are left out: no Ctrl+C in chat, and hostd's /keys never gets
 * the terminal-only prefix.
 * @param {{name: string, steps: string[]}[]} shortcuts
 * @returns {KeyButton[]}
 */
export function chatKeyRow(shortcuts) {
  /** @type {KeyButton[]} */
  const row = [
    { label: "Esc", steps: ["Esc"] },
    { label: "↑", steps: ["Up"] },
    { label: "↓", steps: ["Down"] },
    { label: "Enter", steps: ["Enter"] },
    { label: "Tab", steps: ["Tab"] },
    { label: "Stop", steps: ["Esc"], stop: true },
  ];
  for (const s of shortcuts) {
    if (s.steps.includes("C-c") || s.steps.includes("prefix")) continue;
    row.push({ label: s.name, steps: [...s.steps] });
  }
  return row;
}
