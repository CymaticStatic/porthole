import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configFeature } from "../src/features/config";
import { asRecord, asString } from "../src/json";
import { get, localHeaders, startTestHostd, type TestHostd } from "./helpers/client";
import { Scratch, useTestTimeout } from "./helpers/scratch";

useTestTimeout();

let s: Scratch;
let h: TestHostd;
let file: string;
beforeAll(async () => {
  s = new Scratch();
  file = path.join(s.root, "hostd.json");
  const origin = s.config().origin;
  writeFileSync(file, JSON.stringify({ machineName: "testbox", origin, peers: [] }), { mode: 0o644 });
  h = await startTestHostd(s, [configFeature(file)], { peers: [] });
});
afterAll(async () => {
  await h.stop();
  s.cleanup();
});

function put(host: TestHostd, p: string, body: unknown): Promise<Response> {
  return fetch(host.url + p, { method: "PUT", headers: { ...localHeaders(host), Origin: host.config.origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

test("config changes apply at once; peers need a restart; bad values are refused", async () => {
  expect(await (await get(h, "/v1/config")).json()).toMatchObject({ previewRanges: "none", usageCollection: true, peers: [], restartNeeded: false });
  const r = await put(h, "/v1/config", { previewRanges: "3000-3999", usageCollection: false });
  expect(await r.json()).toMatchObject({ previewRanges: "3000-3999", usageCollection: false, restartNeeded: false });
  expect(h.config.previewRanges).toBe("3000-3999");
  expect(h.config.usageCollection).toBe(false);
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ machineName: "testbox", previewRanges: "3000-3999", usageCollection: false });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(await (await put(h, "/v1/config", { peers: ["https://benacer-omarchy.tailafe04c.ts.net"] })).json()).toMatchObject({ restartNeeded: true });
  expect(h.config.peers).toEqual([]);
  expect(await (await get(h, "/v1/config")).json()).toMatchObject({ peers: ["https://benacer-omarchy.tailafe04c.ts.net"], restartNeeded: true });
  expect((await put(h, "/v1/config", { previewRanges: "9-x" })).status).toBe(400);
  expect((await put(h, "/v1/config", { peers: ["http://evil.example"] })).status).toBe(400);
  expect((await put(h, "/v1/config", { apiPort: 1 })).status).toBe(400);
});

test("a refused change writes nothing; wrong types and non-objects are refused", async () => {
  const before = readFileSync(file, "utf8");
  const rangesBefore = h.config.previewRanges;
  const bad = await put(h, "/v1/config", { previewRanges: "none", usageCollection: "yes" });
  expect(bad.status).toBe(400);
  expect(asString(asRecord(await bad.json()).error)).toContain("usageCollection");
  expect((await put(h, "/v1/config", { voiceEnhance: 1 })).status).toBe(400);
  expect((await put(h, "/v1/config", { peers: "https://x.ts.net" })).status).toBe(400);
  expect((await put(h, "/v1/config", { peers: [5] })).status).toBe(400);
  expect((await put(h, "/v1/config", [])).status).toBe(400);
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(h.config.previewRanges).toBe(rangesBefore);
});

test("voiceEnhance applies at once", async () => {
  expect(h.config.voiceEnhance).toBe(false);
  expect(await (await put(h, "/v1/config", { voiceEnhance: true })).json()).toMatchObject({ voiceEnhance: true });
  expect(h.config.voiceEnhance).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ voiceEnhance: true });
});
