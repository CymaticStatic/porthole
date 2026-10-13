// What changed in a folder: staged, unstaged and untracked, read through lock-free safe git (SPEC 4.9).

import type { HostdConfig } from "../config";
import { DIFF_SAFE, safeGit } from "./git";

export interface ChangedFile { path: string; from: string | null; status: string; binary: boolean; patch: string }
export type Changes =
  | { repo: true; root: string; staged: ChangedFile[]; unstaged: ChangedFile[]; untracked: { path: string }[] }
  | { repo: false; reason: string };

interface Entry { path: string; from: string | null; status: string }

const MAX_PATCH_CHARS = 200_000;
const NO_REPO = "No git repo here";
const DUBIOUS = "git will not read this folder because it belongs to another user (git's dubious ownership check)";

/** The path after `n` space-separated fields (the path itself may hold spaces). */
function afterFields(record: string, n: number): string {
  let i = -1;
  for (let k = 0; k < n; k++) {
    i = record.indexOf(" ", i + 1);
    if (i < 0) return "";
  }
  return record.slice(i + 1);
}

export function parsePorcelainV2(z: string): { staged: Entry[]; unstaged: Entry[]; untracked: string[] } {
  const staged: Entry[] = [];
  const unstaged: Entry[] = [];
  const untracked: string[] = [];
  const records = z.split("\0");
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec === "") continue;
    const kind = rec[0];
    if (kind === "?") {
      untracked.push(rec.slice(2));
    } else if (kind === "1" || kind === "2") {
      const xy = rec.slice(2, 4);
      const p = afterFields(rec, kind === "1" ? 8 : 9);
      const orig = kind === "2" ? (records[++i] ?? null) : null; // a rename/copy carries its original path as the next record
      const side = (letter: string): Entry => ({ path: p, from: orig !== null && (letter === "R" || letter === "C") ? orig : null, status: letter });
      if (xy[0] !== ".") staged.push(side(xy[0]));
      if (xy[1] !== ".") unstaged.push(side(xy[1]));
    } else if (kind === "u") {
      unstaged.push({ path: afterFields(rec, 10), from: null, status: "U" });
    }
    // "!" (ignored) and "#" (headers) are skipped.
  }
  return { staged, unstaged, untracked };
}

/** `--numstat -z`: `added\tdeleted\tpath\0`, or for a rename `added\tdeleted\t\0old\0new\0`. Binary files show `-` counts. */
function binaryPaths(z: string): Set<string> {
  const out = new Set<string>();
  const parts = z.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    let p = m[3];
    if (p === "") {
      i += 2;
      p = parts[i] ?? "";
    }
    if (m[1] === "-" && m[2] === "-") out.add(p);
  }
  return out;
}

function cut(patch: string): string {
  return patch.length > MAX_PATCH_CHARS ? patch.slice(0, MAX_PATCH_CHARS) + "\n… (cut)" : patch;
}

/** Fills in `patch` and `binary` for one side. Chunks are matched by their `b/` path; order is the fallback for quoted headers. */
function attach(entries: Entry[], binary: Set<string>, patchText: string): ChangedFile[] {
  const chunks = patchText === "" ? [] : patchText.split(/^(?=diff --git )/m);
  const byOrder = chunks.length === entries.length;
  return entries.map((e, i) => {
    const isBinary = binary.has(e.path);
    let chunk = chunks.find((c) => {
      const header = c.slice(0, c.indexOf("\n") < 0 ? c.length : c.indexOf("\n"));
      return header.endsWith(" b/" + e.path);
    });
    if (chunk === undefined && byOrder) chunk = chunks[i];
    return { ...e, binary: isBinary, patch: isBinary || chunk === undefined ? "" : cut(chunk) };
  });
}

export async function changes(cfg: HostdConfig, dir: string): Promise<Changes> {
  if (dir === "") return { repo: false, reason: NO_REPO };
  const top = await safeGit(cfg, dir, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { repo: false, reason: top.stderr.includes("dubious ownership") ? DUBIOUS : NO_REPO };
  const root = top.stdout.trim();
  if (root === "") return { repo: false, reason: NO_REPO };

  const status = await safeGit(cfg, root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
  if (status.code !== 0) return { repo: false, reason: "git status failed: " + (status.timedOut ? "timed out" : status.stderr.trim()) };
  const parsed = parsePorcelainV2(status.stdout);

  const side = async (entries: Entry[], cached: boolean): Promise<ChangedFile[] | string> => {
    if (entries.length === 0) return [];
    const base = cached ? ["diff", "--cached"] : ["diff"];
    const [num, patch] = await Promise.all([
      safeGit(cfg, root, [...base, ...DIFF_SAFE, "--numstat", "-z"]),
      safeGit(cfg, root, [...base, ...DIFF_SAFE, "--patch"]),
    ]);
    const failed = num.code !== 0 ? num : patch.code !== 0 ? patch : null;
    if (failed) return "git diff failed: " + (failed.timedOut ? "timed out" : failed.stderr.trim());
    return attach(entries, binaryPaths(num.stdout), patch.stdout);
  };
  const unstaged = await side(parsed.unstaged, false);
  if (typeof unstaged === "string") return { repo: false, reason: unstaged };
  const staged = await side(parsed.staged, true);
  if (typeof staged === "string") return { repo: false, reason: staged };
  return { repo: true, root, staged, unstaged, untracked: parsed.untracked.map((p) => ({ path: p })) };
}
