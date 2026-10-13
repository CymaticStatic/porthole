import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MAX_UPLOAD, insideDir, safeName, sweepOld, writeUnique } from "../src/uploads/names";
import { uploadsFeature } from "../src/features/uploads";
import { localHeaders, startTestHostd } from "./helpers/client";
import type { TestHostd } from "./helpers/client";
import { Scratch } from "./helpers/scratch";

let s: Scratch;
let h: TestHostd;
beforeAll(async () => { s = new Scratch(); h = await startTestHostd(s, [uploadsFeature]); });
afterAll(async () => { await h.stop(); s.cleanup(); });

function upload(name: string, bytes: Uint8Array<ArrayBuffer>): Promise<Response> {
  const form = new FormData();
  form.append("file", new Blob([bytes]), name);
  return fetch(h.url + "/v1/uploads", { method: "POST", headers: { ...localHeaders(h), Origin: h.config.origin }, body: form });
}

test("safe names", () => {
  const t = new Date(2026, 9, 13, 12, 3, 4);
  expect(safeName("My photo (1).png", t)).toBe("120304-My_photo__1_.png");
  expect(safeName("...", t)).toBe("120304-upload");
  expect(safeName("../../etc/passwd", t)).toBe("120304-_.._etc_passwd");
  expect(safeName("x".repeat(300), t)).toHaveLength(7 + 100);
});

test("a clash gets -2 and never overwrites", () => {
  const dir = path.join(s.root, "clash");
  mkdirSync(dir, { recursive: true });
  const a = writeUnique(dir, "a.png", new Uint8Array([1]));
  const b = writeUnique(dir, "a.png", new Uint8Array([2]));
  expect([path.basename(a), path.basename(b)]).toEqual(["a.png", "a-2.png"]);
  expect([...readFileSync(a)]).toEqual([1]);
});

test("a path that leaves the uploads folder is refused", () => {
  const dir = path.join(s.root, "inside");
  mkdirSync(dir, { recursive: true });
  expect(insideDir(dir, path.join(dir, "a.png"))).toBe(true);
  expect(insideDir(dir, path.join(dir, "..x"))).toBe(true);
  expect(insideDir(dir, path.join(dir, "..", "a.png"))).toBe(false);
  expect(insideDir(dir, "/etc/passwd")).toBe(false);
  expect(insideDir(dir, dir)).toBe(false);
  expect(() => writeUnique(dir, "../escape.png", new Uint8Array([1]))).toThrow();
  expect(existsSync(path.join(s.root, "escape.png"))).toBe(false);
});

test("P2.4: an upload lands under uploads/<date>/ with mode 0600 and its path is returned", async () => {
  const r = await upload("shot.png", new Uint8Array([9, 8, 7]));
  expect(r.status).toBe(200);
  const body: { path: string } = await r.json(); // the route's own documented answer shape
  const p = body.path;
  expect(p.startsWith(path.join(h.config.stateDir, "uploads") + "/")).toBe(true);
  expect(path.basename(path.dirname(p))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(path.basename(p)).toMatch(/^\d{6}-shot\.png$/);
  expect(statSync(p).mode & 0o777).toBe(0o600);
  expect(statSync(path.dirname(p)).mode & 0o777).toBe(0o700);
  expect([...readFileSync(p)]).toEqual([9, 8, 7]);
});

test("a request with no file part is a 400", async () => {
  const form = new FormData();
  form.append("note", "hello");
  const r = await fetch(h.url + "/v1/uploads", { method: "POST", headers: { ...localHeaders(h), Origin: h.config.origin }, body: form });
  expect(r.status).toBe(400);
});

test("P2.4: 51 MB is refused and nothing is written", async () => {
  const r = await upload("big.bin", new Uint8Array(51 * 1024 * 1024));
  expect(r.status).toBe(413);
  const day = path.join(h.config.stateDir, "uploads");
  const all = existsSync(day) ? Bun.spawnSync(["/usr/bin/find", day, "-name", "*big.bin"]).stdout.toString() : "";
  expect(all).toBe("");
  expect(MAX_UPLOAD).toBe(50 * 1024 * 1024);
});

test("files older than 30 days are deleted, newer ones kept", () => {
  const root = path.join(s.root, "sweep");
  mkdirSync(path.join(root, "2026-09-01"), { recursive: true });
  const old = path.join(root, "2026-09-01", "old.png");
  const fresh = path.join(root, "2026-09-01", "fresh.png");
  writeFileSync(old, "o");
  writeFileSync(fresh, "f");
  const now = Date.now();
  utimesSync(old, (now - 31 * 86_400_000) / 1000, (now - 31 * 86_400_000) / 1000);
  utimesSync(fresh, (now - 29 * 86_400_000) / 1000, (now - 29 * 86_400_000) / 1000);
  expect(sweepOld(root, now)).toBe(1);
  expect([existsSync(old), existsSync(fresh)]).toEqual([false, true]);
});

test("a day folder left empty by the sweep is removed", () => {
  const root = path.join(s.root, "sweep-empty");
  mkdirSync(path.join(root, "2026-08-01"), { recursive: true });
  const old = path.join(root, "2026-08-01", "old.png");
  writeFileSync(old, "o");
  const now = Date.now();
  utimesSync(old, (now - 40 * 86_400_000) / 1000, (now - 40 * 86_400_000) / 1000);
  expect(sweepOld(root, now)).toBe(1);
  expect(existsSync(path.join(root, "2026-08-01"))).toBe(false);
});
