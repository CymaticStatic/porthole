import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const COPY = path.join(import.meta.dir, "..", "..", "omp-extension", "live-inbox.ts");

test("live-inbox.ts is a byte copy of idea-board 94bcde4", () => {
  const original = Bun.spawnSync(["git", "-C", "/home/cymatic/Projects/idea-board", "show", "94bcde4:live-inbox/live-inbox.ts"]).stdout;
  const copy = readFileSync(COPY);
  expect(createHash("sha256").update(copy).digest("hex")).toBe(createHash("sha256").update(original).digest("hex"));
  expect(createHash("sha256").update(copy).digest("hex").startsWith("ba0db0c7e79566e4")).toBe(true);
});

test("no template literals in code (omp dependency rewriter trap)", () => {
  const code = readFileSync(COPY, "utf8").split("\n").filter((l) => !l.trim().startsWith("//"));
  expect(code.filter((l) => l.includes("`"))).toEqual([]);
});
