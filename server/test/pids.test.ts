import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pidsDir } from "../src/pids";
import { hostdPids } from "../src/preview/scan";
import { startTestHostd } from "./helpers/client";
import { Scratch } from "./helpers/scratch";

let s: Scratch;
beforeAll(() => { s = new Scratch(); });
afterAll(() => s.cleanup());

test("a scratch hostd writes its pid file under its own runtimeDir, never the real runtime folder, and removes it on stop", async () => {
  const realFile = path.join(process.env.XDG_RUNTIME_DIR ?? os.tmpdir(), "porthole-hostd-pids", String(process.pid));
  const realBefore = existsSync(realFile);
  const dir = pidsDir(s.runtimeDir);
  expect(dir).toBe(path.join(s.runtimeDir, "hostd-pids"));
  const h = await startTestHostd(s, []);
  try {
    expect(existsSync(path.join(dir, String(process.pid)))).toBe(true);
    expect(existsSync(realFile)).toBe(realBefore); // the old module-level folder is untouched
    expect(hostdPids(dir).has(process.pid)).toBe(true);
  } finally {
    await h.stop();
  }
  expect(existsSync(path.join(dir, String(process.pid)))).toBe(false);
});

test("hostdPids reads the folder it is given and ignores files of dead pids and odd names", () => {
  const dir = path.join(s.root, "other-pids");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "4194304999"), ""); // no such process
  writeFileSync(path.join(dir, "not-a-pid"), "");
  writeFileSync(path.join(dir, String(process.ppid)), "");
  expect([...hostdPids(dir)].sort()).toEqual([process.pid, process.ppid].sort());
  expect([...hostdPids(path.join(s.root, "missing"))]).toEqual([process.pid]);
});
