import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { contrast } from "./oklch";

const css = readFileSync(path.join(import.meta.dir, "..", "..", "styles", "tokens.css"), "utf8");
const darkStart = css.indexOf("@media (prefers-color-scheme: dark)");
function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+):\s*(oklch\([^)]*\))/g)].map((m) => [m[1], m[2]]));
}
const light = tokens(css.slice(0, darkStart));
const dark = tokens(css.slice(darkStart));
const TEXT: [string, string][] = [
  ["--text", "--bg"], ["--text", "--surface"], ["--text", "--surface-2"], ["--text", "--mine"],
  ["--text-2", "--bg"], ["--text-2", "--surface"], ["--text-2", "--surface-2"],
  ["--accent", "--surface"], ["--accent", "--bg"], ["--on-accent", "--accent"],
  ["--needs-text", "--surface"], ["--danger", "--surface"],
];
const MARKS: [string, string][] = [
  ["--needs", "--surface"], ["--working", "--surface"], ["--done", "--surface"], ["--idle", "--surface"], ["--live", "--surface"], ["--border", "--bg"],
];
for (const [name, t] of [["light", light], ["dark", dark]] as const) {
  test(`${name}: text pairs reach 4.5:1`, () => {
    for (const [f, b] of TEXT) expect(`${f}/${b} ${contrast(t[f]!, t[b]!) >= 4.5}`).toBe(`${f}/${b} true`);
  });
  test(`${name}: status marks reach 3:1`, () => {
    for (const [f, b] of MARKS.filter(([f]) => f !== "--border")) expect(`${f}/${b} ${contrast(t[f]!, t[b]!) >= 3}`).toBe(`${f}/${b} true`);
  });
}
