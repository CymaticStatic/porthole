// /proc lookups: which omp runs in a pane, which transcript it holds open (SPEC 4.1: never
// "newest file on disk"), and whether it has a live inbox.

import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";

export interface ProcTable { comm: Map<number, string>; children: Map<number, number[]> }

export function readProcTable(): ProcTable {
  const comm = new Map<number, string>();
  const children = new Map<number, number[]>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try { stat = readFileSync("/proc/" + name + "/stat", "utf8"); } catch { continue; }
    // stat: "<pid> (<comm>) <state> <ppid> ..."; comm may contain spaces or ")".
    const open = stat.indexOf("(");
    const close = stat.lastIndexOf(")");
    const pid = Number(name);
    const ppid = Number(stat.slice(close + 2).split(" ")[1]);
    comm.set(pid, stat.slice(open + 1, close));
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  return { comm, children };
}

/** Top-most process named "omp" at or below rootPid (subagent omps are its children). */
export function findOmp(t: ProcTable, rootPid: number): number | null {
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift() as number;
    if (t.comm.get(pid) === "omp") return pid;
    queue.push(...(t.children.get(pid) ?? []));
  }
  return null;
}

/** The `.jsonl` the omp holds open inside a watched folder (<dir>/<project>/<file>.jsonl). */
export function transcriptOf(pid: number, transcriptDirs: string[]): string | null {
  let fds: string[];
  try { fds = readdirSync("/proc/" + pid + "/fd"); } catch { return null; }
  for (const fd of fds) {
    let target: string;
    try { target = readlinkSync("/proc/" + pid + "/fd/" + fd); } catch { continue; }
    if (target.endsWith(".jsonl") && transcriptDirs.includes(path.dirname(path.dirname(target)))) return target;
  }
  return null;
}

export function hasInbox(inboxRoot: string, pid: number): boolean {
  return existsSync(path.join(inboxRoot, String(pid)));
}

export function ompAlive(pid: number): boolean {
  try { return readFileSync("/proc/" + pid + "/comm", "utf8").trim() === "omp"; } catch { return false; }
}
