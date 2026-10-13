// Every tmux call hostd makes. Always `tmux -S <socket folder>/<name>` with TMUX unset.
// Never attach/resize/kill here; the PTY module owns its own attach (Task 11).

import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import type { HostdConfig } from "../config";
import { cleanEnv, run, type RunResult } from "../exec";
import { tmuxTarget, type TmuxWhere } from "./ids";

const SEP = "\x1f";
const PANE_FIELDS = ["session_name", "window_index", "pane_index", "pane_pid", "pane_current_path", "pane_title", "window_name", "session_attached", "pane_current_command"] as const;

export interface TmuxPane extends TmuxWhere { panePid: number; cwd: string; title: string; windowName: string; attached: boolean; command: string }
export type PaneList = { ok: true; panes: TmuxPane[] } | { ok: false; error: string };
export interface TmuxClient { pid: number; tty: string; size: string }

export function socketPath(cfg: HostdConfig, socket: string): string {
  return path.join(cfg.tmuxSocketDir, socket);
}

export function listSockets(cfg: HostdConfig): string[] {
  let names: string[];
  try { names = readdirSync(cfg.tmuxSocketDir); } catch { return []; }
  return names.filter((n) => {
    try { return lstatSync(path.join(cfg.tmuxSocketDir, n)).isSocket(); } catch { return false; }
  }).sort();
}

/** Longest a tmux client may take. A healthy one answers in milliseconds; a hung one is killed instead of stalling hostd. */
const TMUX_TIMEOUT_MS = 10_000;

function tmux(cfg: HostdConfig, socket: string, args: string[], input?: string): Promise<RunResult> {
  return run([cfg.bin.tmux, "-S", socketPath(cfg, socket), ...args], { env: cleanEnv(), input, timeoutMs: TMUX_TIMEOUT_MS });
}

function failure(r: RunResult): string {
  return r.timedOut ? "tmux " + r.stderr : r.stderr.trim() || "tmux exited with " + r.code;
}

export async function listPanes(cfg: HostdConfig, socket: string): Promise<PaneList> {
  const r = await tmux(cfg, socket, ["list-panes", "-a", "-F", PANE_FIELDS.map((f) => "#{" + f + "}").join(SEP)]);
  if (r.code !== 0) return { ok: false, error: failure(r) };
  const panes = r.stdout.split("\n").filter(Boolean).map((line): TmuxPane => {
    const f = line.split(SEP);
    return { kind: "tmux", socket, session: f[0], window: Number(f[1]), pane: Number(f[2]), panePid: Number(f[3]), cwd: f[4], title: f[5], windowName: f[6], attached: f[7] !== "0", command: f[8] };
  });
  return { ok: true, panes };
}

export async function capturePane(cfg: HostdConfig, w: TmuxWhere): Promise<{ ok: boolean; text: string; error: string }> {
  const r = await tmux(cfg, w.socket, ["capture-pane", "-p", "-J", "-S", "-2000", "-t", tmuxTarget(w)]);
  return r.code === 0 ? { ok: true, text: r.stdout, error: "" } : { ok: false, text: "", error: failure(r) };
}

const SEND_CHUNK_BYTES = 8192;

/** Split text into pieces of at most `max` UTF-8 bytes, never inside a character. */
function chunks(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  let size = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch);
    if (size + n > max && cur) {
      out.push(cur);
      cur = "";
      size = 0;
    }
    cur += ch;
    size += n;
  }
  if (cur) out.push(cur);
  return out;
}

/** SPEC 4.5: type the text literally (`send-keys -l`, in chunks of at most 8 KiB), then press Enter once. */
export async function sendText(cfg: HostdConfig, w: TmuxWhere, text: string): Promise<{ ok: boolean; error: string }> {
  for (const piece of chunks(text, SEND_CHUNK_BYTES)) {
    const typed = await tmux(cfg, w.socket, ["send-keys", "-l", "-t", tmuxTarget(w), "--", piece]);
    if (typed.code !== 0) return { ok: false, error: failure(typed) };
  }
  const enter = await tmux(cfg, w.socket, ["send-keys", "-t", tmuxTarget(w), "Enter"]);
  return enter.code === 0 ? { ok: true, error: "" } : { ok: false, error: failure(enter) };
}

export async function sendKeys(cfg: HostdConfig, w: TmuxWhere, args: string[]): Promise<{ ok: boolean; error: string }> {
  const r = await tmux(cfg, w.socket, ["send-keys", "-t", tmuxTarget(w), ...args]);
  return r.code === 0 ? { ok: true, error: "" } : { ok: false, error: failure(r) };
}

export async function listClients(cfg: HostdConfig, socket: string): Promise<TmuxClient[]> {
  const r = await tmux(cfg, socket, ["list-clients", "-F", "#{client_pid} #{client_tty} #{client_width}x#{client_height}"]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").filter(Boolean).map((l) => {
    const [pid, tty, size] = l.split(" ");
    return { pid: Number(pid), tty, size };
  });
}

/** Detach exactly one client, by its tty (Verified facts 6). */
export async function detachClient(cfg: HostdConfig, socket: string, tty: string): Promise<boolean> {
  return (await tmux(cfg, socket, ["detach-client", "-t", tty])).code === 0;
}
