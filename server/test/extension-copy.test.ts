import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const COPY = path.join(import.meta.dir, "..", "..", "omp-extension", "live-inbox.ts");
const PINNED = "ba0db0c7e79566e4d2540c9896d014609ab1248537519bc3f7e95ccbb7d44aeb";
const ORIGIN_REPO = "/home/cymatic/Projects/idea-board";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

test("live-inbox.ts matches the pinned sha256 of idea-board 94bcde4", () => {
  expect(sha(readFileSync(COPY))).toBe(PINNED);
});

test.skipIf(!existsSync(ORIGIN_REPO))("live-inbox.ts is a byte copy of idea-board 94bcde4 in git", () => {
  const original = Bun.spawnSync(["git", "-C", ORIGIN_REPO, "show", "94bcde4:live-inbox/live-inbox.ts"]).stdout;
  expect(sha(readFileSync(COPY))).toBe(sha(original));
});

test("no template literals in code (omp dependency rewriter trap)", () => {
  const code = readFileSync(COPY, "utf8").split("\n").filter((l) => !l.trim().startsWith("//"));
  expect(code.filter((l) => l.includes("`"))).toEqual([]);
});
