// A hostd lists itself in the pid folder while it runs; the preview scan reads the folder to tell a hostd's own port from a dev server.
// The folder lives inside the hostd's runtimeDir, so a scratch hostd (config overrides) never writes the real runtime folder.
// Pids are refcounted because tests start several hostds in one process.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const running = new Map<string, number>(); // file -> hostds in this process using it

/** The pid folder of the hostd whose runtimeDir is given. */
export function pidsDir(runtimeDir: string): string {
  return path.join(runtimeDir, "hostd-pids");
}

export function registerPid(dir: string): void {
  const file = path.join(dir, String(process.pid));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, "", { mode: 0o600 });
  running.set(file, (running.get(file) ?? 0) + 1);
}

export function unregisterPid(dir: string): void {
  const file = path.join(dir, String(process.pid));
  const left = (running.get(file) ?? 1) - 1;
  if (left > 0) {
    running.set(file, left);
    return;
  }
  running.delete(file);
  rmSync(file, { force: true });
}
