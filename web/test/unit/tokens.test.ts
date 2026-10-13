import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const STYLES = path.join(import.meta.dir, "..", "..", "styles");
const files = readdirSync(STYLES).filter((n) => n.endsWith(".css"));
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

test("--fs-2 is the 14 px floor and --fs-1 is 12 px", () => {
  const t = strip(readFileSync(path.join(STYLES, "tokens.css"), "utf8"));
  expect(t).toMatch(/--fs-1:\s*0\.75rem/);
  expect(t).toMatch(/--fs-2:\s*0\.875rem/);
});

test("var(--fs-1) appears in exactly one rule, `.meta`", () => {
  const uses: string[] = [];
  for (const f of files) {
    for (const m of strip(readFileSync(path.join(STYLES, f), "utf8")).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (m[2]!.includes("var(--fs-1)")) uses.push(`${f}: ${m[1]!.trim()}`);
    }
  }
  expect(uses).toEqual(["base.css: .meta"]);
});
