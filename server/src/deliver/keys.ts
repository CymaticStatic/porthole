// The key row (SPEC 5.2): a short list of named keys, single characters and literal text steps.

export type KeyStep = { key: string } | { text: string };

const NAMED = ["Tab", "Enter", "Esc", "Space", "BSpace", "Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown"];
const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

/** tmux key names; every name is the same in tmux except Esc. A single character is typed literally instead. */
export const TMUX_KEYS: Record<string, string> = {
  ...Object.fromEntries(NAMED.map((k) => [k, k])),
  ...Object.fromEntries(LETTERS.map((l) => ["C-" + l, "C-" + l])),
  Esc: "Escape",
};

/** herdr key names. `esc` and `ctrl+c` are verified from herdr's help text; the rest are lower-case guesses (Needs Ben 2). */
export const HERDR_KEYS: Record<string, string> = {
  Tab: "tab",
  Enter: "enter",
  Esc: "esc",
  Space: "space",
  BSpace: "backspace",
  Up: "up",
  Down: "down",
  Left: "left",
  Right: "right",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  ...Object.fromEntries(LETTERS.map((l) => ["C-" + l, "ctrl+" + l])),
};

const MAX_STEPS = 32;

export function parseSteps(keys: unknown): KeyStep[] | { error: string } {
  if (!Array.isArray(keys)) return { error: "keys must be a list of strings" };
  if (keys.length < 1 || keys.length > MAX_STEPS) return { error: "keys must hold 1 to " + MAX_STEPS + " entries" };
  const steps: KeyStep[] = [];
  for (const k of keys) {
    if (typeof k !== "string") return { error: "every key must be a string" };
    if (k.startsWith("text:")) {
      const text = k.slice(5);
      if (text === "") return { error: "a text: step needs some text" };
      steps.push({ text });
    } else if (Object.hasOwn(TMUX_KEYS, k) || ([...k].length === 1 && k >= " " && k !== "\x7f")) {
      steps.push({ key: k });
    } else {
      return { error: "unknown key: " + k.slice(0, 40) };
    }
  }
  return steps;
}
