// A hostd lists itself in PIDS_DIR while it runs; the preview scan reads the folder to tell a hostd's own port from a dev server.
// Pids are refcounted because tests start several hostds in one process.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PIDS_DIR = path.join(process.env.XDG_RUNTIME_DIR ?? os.tmpdir(), "porthole-hostd-pids");
const running = new Map<string, number>(); // file -> hostds in this process using it

export function registerPid(dir = PIDS_DIR): void {
  const file = path.join(dir, String(process.pid));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, "", { mode: 0o600 });
  running.set(file, (running.get(file) ?? 0) + 1);
}

export function unregisterPid(dir = PIDS_DIR): void {
  const file = path.join(dir, String(process.pid));
  const left = (running.get(file) ?? 1) - 1;
  if (left > 0) {
    running.set(file, left);
    return;
  }
  running.delete(file);
  rmSync(file, { force: true });
}
