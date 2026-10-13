import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import path from "node:path";
import { doctorFeature } from "../src/features/doctor";
import { asArray, asRecord, asString } from "../src/json";
import { get, pane, startTestHostd, type TestHostd } from "./helpers/client";
import { Scratch, useTestTimeout } from "./helpers/scratch";

useTestTimeout();

let s: Scratch;
let h: TestHostd;
let listener: Server;
beforeAll(async () => {
  s = new Scratch();
  h = await startTestHostd(s, [doctorFeature]);
  // inboxFeature (Task 5) is not part of this test: stand in for its events socket.
  mkdirSync(h.config.runtimeDir, { recursive: true, mode: 0o700 });
  listener = createServer();
  await new Promise<void>((resolve) => listener.listen(path.join(h.config.runtimeDir, "events.sock"), resolve));
});
afterAll(async () => {
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  await h.stop();
  s.cleanup();
});

interface Check { id: string; ok: boolean; detail: string }

async function checks(): Promise<Check[]> {
  const body = asRecord(await (await get(h, "/v1/doctor")).json());
  return asArray(body.checks).map((c) => {
    const r = asRecord(c);
    return { id: asString(r.id), ok: r.ok === true, detail: asString(r.detail) };
  });
}

test("doctor reports tmux mouse, extensions, events socket and binaries", async () => {
  const p = await pane(s, "mouse", "/bin/sh");
  s.tmux(p.socket, "set-option", "-g", "mouse", "off");
  mkdirSync(h.config.ompExtensionsDir, { recursive: true });
  copyFileSync(path.join(import.meta.dir, "..", "..", "omp-extension", "live-inbox.ts"), path.join(h.config.ompExtensionsDir, "live-inbox.ts"));
  const list = await checks();
  const by = (id: string) => list.find((c) => c.id === id)?.ok;
  expect(by("tmux-mouse:" + p.socket)).toBe(false);
  expect(by("extension:live-inbox")).toBe(true);
  expect(by("extension:porthole-events")).toBe(false);
  expect(by("events-socket")).toBe(true);
  expect(by("git")).toBe(true);
  s.tmux(p.socket, "set-option", "-g", "mouse", "on");
  const again = await checks();
  expect(again.find((c) => c.id === "tmux-mouse:" + p.socket)?.ok).toBe(true);
});

test("check order: tmux sockets, extensions, events socket, voxtype, git, state-dir", async () => {
  const ids = (await checks()).map((c) => c.id).filter((id) => !id.startsWith("tmux-mouse:"));
  expect(ids).toEqual(["extension:porthole-events", "extension:live-inbox", "events-socket", "voxtype", "git", "state-dir"]);
});

test("doctor tells an old extension copy, a missing binary, a loose state folder and a dead events socket apart", async () => {
  mkdirSync(h.config.ompExtensionsDir, { recursive: true });
  writeFileSync(path.join(h.config.ompExtensionsDir, "live-inbox.ts"), "// an older copy\n");
  h.config.bin.voxtype = path.join(s.root, "no-such-voxtype");
  chmodSync(h.config.stateDir, 0o755);
  rmSync(path.join(h.config.runtimeDir, "events.sock"));
  const list = await checks();
  const by = (id: string) => list.find((c) => c.id === id);
  expect(by("extension:live-inbox")).toMatchObject({ ok: false, detail: "older than the repo copy" });
  expect(by("extension:porthole-events")).toMatchObject({ ok: false, detail: "not installed" });
  expect(by("voxtype")?.ok).toBe(false);
  expect(by("state-dir")?.ok).toBe(false);
  expect(by("events-socket")?.ok).toBe(false);
  chmodSync(h.config.stateDir, 0o700);
  expect((await checks()).find((c) => c.id === "state-dir")?.ok).toBe(true);
});
