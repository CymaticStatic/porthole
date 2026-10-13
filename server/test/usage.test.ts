import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseOmpUsage, usageFeature } from "../src/features/usage";
import { get, startTestHostd } from "./helpers/client";
import type { TestHostd } from "./helpers/client";
import { Scratch } from "./helpers/scratch";

const fixture = path.join(import.meta.dir, "fixtures", "omp-usage.json");
let s: Scratch;
let h: TestHostd;
let calls: string;
beforeAll(async () => {
  s = new Scratch();
  calls = path.join(s.root, "omp-cli-calls");
  s.writeFake("omp-cli", "#!/bin/sh\necho \"$*\" >> '" + calls + "'\ncat '" + fixture + "'\n");
  h = await startTestHostd(s, [usageFeature]);
});
afterAll(async () => { await h.stop(); s.cleanup(); });

test("parses the recorded omp output into the two Claude windows", () => {
  const w = parseOmpUsage(JSON.parse(readFileSync(fixture, "utf8")));
  expect(w.map((x) => x.id).sort()).toEqual(["5h", "7d"]);
  for (const x of w) expect(x.usedPercent).toBeGreaterThanOrEqual(0);
  // The exact numbers recorded in the fixture; the per-model `anthropic:7d:fable` limit (3 %) is not the 7-day window.
  expect(w).toEqual([
    { id: "5h", usedPercent: 14, resetsAt: new Date(1791912599819).toISOString(), status: "ok" },
    { id: "7d", usedPercent: 58, resetsAt: new Date(1792227599819).toISOString(), status: "ok" },
  ]);
});

test("several accounts: the highest percentage per window wins; a limit without usedFraction is left out", () => {
  const limit = (id: string, amount: unknown, status = "ok") => ({ id, amount, window: { resetsAt: 1000 }, status });
  const w = parseOmpUsage({
    reports: [
      { limits: [limit("anthropic:5h", { usedFraction: 0.2 }), limit("anthropic:7d", { remainingFraction: 0.1 })] },
      { limits: [limit("anthropic:5h", { usedFraction: 0.915 }, "warning"), limit("openai:5h", { usedFraction: 0.99 })] },
    ],
  });
  expect(w).toEqual([{ id: "5h", usedPercent: 91.5, resetsAt: new Date(1000).toISOString(), status: "warning" }]);
});

test("unexpected shapes give no windows, never a throw", () => {
  expect(parseOmpUsage(null)).toEqual([]);
  expect(parseOmpUsage({ reports: "x" })).toEqual([]);
  expect(parseOmpUsage({ reports: [{ limits: [{ id: "anthropic:5h", amount: { usedFraction: "0.5" } }] }] })).toEqual([]);
});

test("P2.7: /v1/usage returns the numbers, cached for a minute, with the exact flags", async () => {
  const a = (await (await get(h, "/v1/usage")).json()) as { windows: unknown[]; readAt: string };
  const b = (await (await get(h, "/v1/usage")).json()) as { readAt: string };
  expect(a.windows).toHaveLength(2);
  expect(b.readAt).toBe(a.readAt);
  expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(["usage --json -p anthropic -r"]);
});

test("?refresh=1 within 10 s of a read does not call omp again", async () => {
  await get(h, "/v1/usage?refresh=1");
  expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
});

test("a failed omp call is a 502 with the first stderr line, and nothing stale is shown", async () => {
  const bin = s.writeFake("omp-fail", "#!/bin/sh\necho 'not logged in' >&2\necho 'second line' >&2\nexit 3\n");
  const bad = await startTestHostd(s, [usageFeature], { bin: { omp: bin } });
  try {
    const r = await get(bad, "/v1/usage");
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "omp usage failed: not logged in" });
  } finally { await bad.stop(); }
});

test("unreadable output is a 502", async () => {
  const bin = s.writeFake("omp-junk", "#!/bin/sh\necho 'not json'\n");
  const bad = await startTestHostd(s, [usageFeature], { bin: { omp: bin } });
  try {
    const r = await get(bad, "/v1/usage");
    expect(r.status).toBe(502);
    expect(((await r.json()) as { error: string }).error).toStartWith("omp usage failed:");
  } finally { await bad.stop(); }
});

test("hidden when usage collection is off, and omp is never called", async () => {
  const offCalls = path.join(s.root, "omp-off-calls");
  const bin = s.writeFake("omp-off", "#!/bin/sh\necho x >> '" + offCalls + "'\ncat '" + fixture + "'\n");
  const off = await startTestHostd(s, [usageFeature], { usageCollection: false, bin: { omp: bin } });
  try {
    const r = await get(off, "/v1/usage");
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "usage collection is off" });
    expect(existsSync(offCalls)).toBe(false);
  } finally { await off.stop(); }
});
