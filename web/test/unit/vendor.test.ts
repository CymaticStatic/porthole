import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..", "..", "..");
const rows = readFileSync(path.join(ROOT, "web/vendor/VENDOR.md"), "utf8")
  .split("\n").map((l) => l.match(/^\| `(web\/vendor\/[^`]+)` \| ([^|]+) \| ([^|]+) \| MIT \| ([0-9a-f]{64}) \|$/)).filter((m) => m !== null);

test("every vendored file is listed and matches its recorded hash", () => {
  expect(rows.length).toBe(7);
  for (const m of rows) {
    const sum = createHash("sha256").update(readFileSync(path.join(ROOT, m[1]))).digest("hex");
    expect(`${m[1]} ${sum}`).toBe(`${m[1]} ${m[4]}`);
  }
});

test("pinned versions", () => {
  const v = Object.fromEntries(rows.map((m) => [m[2].trim(), m[3].trim()]));
  expect(v).toEqual({ "@xterm/xterm": "6.0.0", "@xterm/addon-fit": "0.11.0", marked: "18.1.1" });
});
