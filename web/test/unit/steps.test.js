import { expect, test } from "bun:test";
import { chatKeyRow, formatSteps, parseSteps, stepBytes, stepLabel } from "../../src/lib/steps.js";

const bytes = (s, p = "C-b") => [...stepBytes(s, p)];

test("splits on unescaped commas only", () => {
  expect(parseSteps("C-c, text:echo a\\, b ,Enter")).toEqual({ ok: true, steps: ["C-c", "text:echo a, b", "Enter"] });
});
test("round-trips through formatSteps", () => {
  const steps = ["Esc", "text:x, y", "Enter"];
  expect(parseSteps(formatSteps(steps))).toEqual({ ok: true, steps });
});
test("refuses unknown names, empty lists and more than 32 steps with a plain reason", () => {
  expect(parseSteps("Ctrl-C")).toEqual({ ok: false, reason: 'Step 1, "Ctrl-C", isn\'t a key Porthole knows. Try C-c for Ctrl+C.' });
  expect(parseSteps("  ").ok).toBe(false);
  expect(parseSteps(Array(33).fill("Enter").join(",")).ok).toBe(false);
  expect(parseSteps(Array(32).fill("Enter").join(",")).ok).toBe(true);
});
test("names the bad step and refuses empty steps", () => {
  const r = parseSteps("Enter, Bogus");
  expect(r.ok).toBe(false);
  expect(r.reason).toContain('Step 2, "Bogus"');
  expect(parseSteps("Enter,,Tab").ok).toBe(false);
  expect(parseSteps("text:").ok).toBe(false);
});
test("single printable characters are steps, blanks and controls are not", () => {
  expect(parseSteps("y, é, \\,")).toEqual({ ok: true, steps: ["y", "é", ","] });
  expect(parseSteps("ab").ok).toBe(false);
  expect(parseSteps("c-c").ok).toBe(false);
});
test("prefix only parses when allowed", () => {
  expect(parseSteps("prefix, c").ok).toBe(false);
  expect(parseSteps("prefix, c", { allowPrefix: true })).toEqual({ ok: true, steps: ["prefix", "c"] });
});
test("labels", () => {
  expect(["C-c", "Esc", "Up", "text:git status", "BSpace"].map(stepLabel)).toEqual(["Ctrl+C", "Esc", "↑", "Type: git status", "Backspace"]);
  expect(["Down", "Left", "Right", "Tab", "Enter"].map(stepLabel)).toEqual(["↓", "←", "→", "Tab", "Enter"]);
});
test("terminal bytes", () => {
  expect(bytes("Enter")).toEqual([13]);
  expect(bytes("Tab")).toEqual([9]);
  expect(bytes("Esc")).toEqual([27]);
  expect(bytes("Space")).toEqual([32]);
  expect(bytes("BSpace")).toEqual([127]);
  expect(bytes("C-c")).toEqual([3]);
  expect(bytes("C-a")).toEqual([1]);
  expect(bytes("C-z")).toEqual([26]);
  expect(bytes("Up")).toEqual([27, 91, 65]);
  expect(bytes("Left")).toEqual([27, 91, 68]);
  expect(bytes("Home")).toEqual([27, 91, 72]);
  expect(bytes("End")).toEqual([27, 91, 70]);
  expect(bytes("PageUp")).toEqual([27, 91, 53, 126]);
  expect(bytes("PageDown")).toEqual([27, 91, 54, 126]);
  expect(bytes("text:é")).toEqual([195, 169]);
  expect(bytes("y")).toEqual([121]);
  expect(bytes("prefix")).toEqual([2]);
  expect(bytes("prefix", "C-a")).toEqual([1]);
  expect(() => stepBytes("Nope")).toThrow();
});
test("chat key row: fixed keys, Stop sends Esc, no Ctrl+C anywhere", () => {
  const row = chatKeyRow([
    { name: "Clear", steps: ["C-c"] },
    { name: "New window", steps: ["prefix", "c"] },
    { name: "Status", steps: ["text:git status", "Enter"] },
  ]);
  expect(row.map((b) => b.label)).toEqual(["Esc", "↑", "↓", "Enter", "Tab", "Stop", "Status"]);
  expect(row.find((b) => b.label === "Stop")).toEqual({ label: "Stop", steps: ["Esc"], stop: true });
  expect(row.some((b) => b.steps.includes("C-c") || /ctrl\+c/i.test(b.label))).toBe(false);
});
