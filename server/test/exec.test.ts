import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TIMEOUT_CODE, run } from "../src/exec";
import { useTestTimeout } from "./helpers/scratch";

useTestTimeout();

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "porthole-exec-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("a hung child is killed at the timeout, the call returns the timeout result quickly, and no process is left", async () => {
  const fake = path.join(dir, "hang");
  const pidFile = path.join(dir, "pid");
  // exec keeps the shell's pid, so the recorded pid is the process that sleeps.
  writeFileSync(fake, '#!/bin/sh\necho $$ > "' + pidFile + '"\nexec sleep 30\n');
  chmodSync(fake, 0o755);
  const started = Date.now();
  const r = await run([fake], { timeoutMs: 300 });
  const took = Date.now() - started;
  expect(r.timedOut).toBe(true);
  expect(r.code).toBe(TIMEOUT_CODE);
  expect(r.stderr).toBe("timed out after 300 ms");
  expect(took).toBeLessThan(5000);
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  expect(pid).toBeGreaterThan(1);
  expect(alive(pid)).toBe(false);
});

test("a child that finishes in time is not touched by the timeout", async () => {
  const r = await run(["/bin/sh", "-c", "echo out; echo err >&2; exit 3"], { timeoutMs: 5000 });
  expect(r).toEqual({ code: 3, stdout: "out\n", stderr: "err\n", timedOut: false });
});
