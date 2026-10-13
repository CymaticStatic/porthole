// Which local ports Porthole offers as previews (SPEC 4.10): `ss -ltnpH`, minus the always-refused ports, minus
// ports outside the configured ranges, minus ports that do not answer HTTP. A refused port is never contacted.

import { existsSync, readdirSync } from "node:fs";
import { parseRanges, type HostdConfig } from "../config";
import { run } from "../exec";

export interface Listener { port: number; pid: number | null; process: string | null }
export interface Preview { port: number; pid: number | null; process: string | null; url: string }

const LOCAL_HOSTS = new Set(["127.0.0.1", "[::1]", "0.0.0.0", "*", "[::]"]);
const NEVER = new Set([8443, 8795, 8796, 9222, 9223, 9224, 9225, 8797, 8798]);
const SS_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 1000;
const USERS = /users:\(\("([^"]*)",pid=(\d+)/;

/** `ss -ltnpH` lines: one entry per port, loopback and wildcard listeners only; pid and process when `ss` shows them. */
export function parseSs(text: string): Listener[] {
  const byPort = new Map<number, Listener>();
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const local = fields[3];
    if (local === undefined) continue;
    const colon = local.lastIndexOf(":");
    if (colon < 0 || !LOCAL_HOSTS.has(local.slice(0, colon))) continue;
    const port = Number(local.slice(colon + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const users = USERS.exec(line);
    const found: Listener = { port, pid: users ? Number(users[2]) : null, process: users ? users[1] : null };
    const have = byPort.get(port);
    if (!have || (have.pid === null && found.pid !== null)) byPort.set(port, found);
  }
  return [...byPort.values()];
}

/** Why a port is never previewed, or null. Checked before any probe or proxy connection. */
export function refusedReason(port: number, cfg: HostdConfig, hostdPids: ReadonlySet<number>, owner: number | null): string | null {
  if (port < 1024) return "ports below 1024 are never previewed";
  if (NEVER.has(port) || port === cfg.apiPort || port === cfg.previewPort) return "port " + port + " is never previewed";
  if (owner !== null && hostdPids.has(owner)) return "port " + port + " belongs to a Porthole hostd";
  return null;
}

/** Pids of the running hostds (their pid files in `dir`, written by createHostd), plus this process. A stale file of a dead pid is ignored. */
export function hostdPids(dir: string): Set<number> {
  const pids = new Set<number>([process.pid]);
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return pids; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (existsSync("/proc/" + pid)) pids.add(pid);
  }
  return pids;
}

async function answersHttp(port: number): Promise<boolean> {
  try {
    await fetch("http://127.0.0.1:" + port + "/", { method: "HEAD", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: "manual" });
    return true;
  } catch {
    return false;
  }
}

export async function scan(cfg: HostdConfig, pids: ReadonlySet<number>): Promise<Preview[]> {
  const parsed = parseRanges(cfg.previewRanges);
  if ("error" in parsed || parsed.ranges.length === 0) return [];
  const r = await run([cfg.bin.ss, "-ltnpH"], { timeoutMs: SS_TIMEOUT_MS });
  if (r.code !== 0) return [];
  const candidates = parseSs(r.stdout).filter(
    (l) => refusedReason(l.port, cfg, pids, l.pid) === null && parsed.ranges.some(([lo, hi]) => l.port >= lo && l.port <= hi),
  );
  const alive = await Promise.all(candidates.map((l) => answersHttp(l.port)));
  return candidates
    .filter((_, i) => alive[i])
    .sort((a, b) => a.port - b.port)
    .map((l) => ({ port: l.port, pid: l.pid, process: l.process, url: cfg.origin + ":8443/__porthole/preview?port=" + l.port }));
}
