// Upload file names and housekeeping (SPEC 4.8): safe names, per-day folders, never-overwrite writes,
// a "stays inside the uploads folder" check, and the 30-day sweep.

import { lstatSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MAX_UPLOAD = 50 * 1024 * 1024;
export const KEEP_DAYS = 30;

const MAX_NAME = 100;
const MAX_CLASH = 999;
const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** "HHMMSS-" (local time) + the original name with anything outside [A-Za-z0-9._-] turned into "_". */
export function safeName(original: string, now: Date): string {
  const cleaned = original.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, MAX_NAME);
  return two(now.getHours()) + two(now.getMinutes()) + two(now.getSeconds()) + "-" + (cleaned || "upload");
}

/** root/YYYY-MM-DD for the local date; creates nothing. */
export function dayFolder(root: string, now: Date): string {
  return path.join(root, now.getFullYear() + "-" + two(now.getMonth() + 1) + "-" + two(now.getDate()));
}

/** True when `file` resolves to a place strictly below `dir`. */
export function insideDir(dir: string, file: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

/** Writes `data` as `name` in `dir` (mode 0600, never overwriting): a clash becomes stem-2.ext, stem-3.ext, … */
export function writeUnique(dir: string, name: string, data: Uint8Array): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; n <= MAX_CLASH; n++) {
    const file = path.join(dir, n === 1 ? name : stem + "-" + n + ext);
    if (!insideDir(dir, file)) throw new Error("upload path escapes its folder");
    try {
      writeFileSync(file, data, { flag: "wx", mode: 0o600 });
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new Error("too many uploads with the same name");
}

/** Deletes files older than KEEP_DAYS (by mtime) in the day folders under `root`, then empty day folders. Returns the file count. */
export function sweepOld(root: string, nowMs: number): number {
  let removed = 0;
  const cutoff = nowMs - KEEP_DAYS * 86_400_000;
  let days: string[];
  try { days = readdirSync(root); } catch { return 0; }
  for (const day of days) {
    if (!DAY_FOLDER.test(day)) continue;
    const dir = path.join(root, day);
    try {
      if (!lstatSync(dir).isDirectory()) continue;
      for (const entry of readdirSync(dir)) {
        const file = path.join(dir, entry);
        const st = lstatSync(file);
        if (st.isDirectory() || st.mtimeMs >= cutoff) continue;
        unlinkSync(file);
        removed++;
      }
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
      // A folder that vanished or cannot be read is skipped; the next sweep tries again.
    }
  }
  return removed;
}
