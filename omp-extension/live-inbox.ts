// Live inbox: post text into this session's chat from outside omp (Ben, 2026-10-12).
//
// Live voice mode replaces the message box with the live panel, which ignores
// everything except Escape, Ctrl+C and Space, so nothing can be typed or pasted
// into the chat while it runs, and spoken words reach the agent only when the
// realtime voice model chooses to delegate them. This gives every interactive
// omp process a private inbox folder:
//
//   $XDG_RUNTIME_DIR/omp-inbox/<omp pid>/
//
// A finished file named *.msg dropped there (write elsewhere, then rename in) is
// read, deleted, and sent as a normal user message: the same as typing it and
// pressing Enter (it steers if the agent is busy). Senders: `omp-voice send`
// (Super+Alt+Insert, the clipboard) and `omp-voice dictate` (Roccat T3) when the
// focused session is in live mode.
//
// The folder is mode 0700 on the user's private runtime tmpfs. Files that are
// not *.msg (in-progress temp files, dotfiles) are never touched.
//
// No template literals: the extension dependency rewriter has rejected them before.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import path from "node:path";

const MAX_BYTES = 512 * 1024;
const POLL_MS = 1000;
const MESSAGE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.msg$/;
const INBOX_ROOT = path.join(process.env.XDG_RUNTIME_DIR || "/run/user/" + process.getuid(), "omp-inbox");

interface Ctx {
  hasUI: boolean;
  ui: { notify(message: string, level: "info" | "warning" | "error"): void };
}
interface ExtensionApi {
  on(event: string, handler: (event: unknown, ctx: Ctx) => void): void;
  sendUserMessage(content: string): void;
}

/** Remove inbox folders left behind by omp processes that no longer exist. */
function sweepStale(): void {
  let names: string[] = [];
  try { names = readdirSync(INBOX_ROOT); } catch { return; }
  for (const name of names) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || existsSync("/proc/" + pid)) continue;
    try { rmSync(path.join(INBOX_ROOT, name), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Read and remove every finished message, oldest name first. */
export function takeMessages(dir: string, onTooBig: (name: string, bytes: number) => void): string[] {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return []; }
  const out: string[] = [];
  for (const name of names.filter((n) => MESSAGE_FILE.test(n)).sort()) {
    const file = path.join(dir, name);
    try {
      const size = statSync(file).size;
      if (size > MAX_BYTES) {
        unlinkSync(file);
        onTooBig(name, size);
        continue;
      }
      const text = readFileSync(file, "utf8");
      unlinkSync(file);
      if (text.trim()) out.push(text.trim());
    } catch { /* vanished or unreadable: skip, never crash the session */ }
  }
  return out;
}

export default function liveInbox(pi: ExtensionApi) {
  let dir: string | undefined;
  let watcher: FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let draining = false;

  const drain = (ctx: Ctx) => {
    if (!dir || draining) return;
    draining = true;
    try {
      const messages = takeMessages(dir, (name, bytes) => {
        ctx.ui.notify("Live inbox: ignored " + name + " (" + bytes + " bytes, limit " + MAX_BYTES + ")", "warning");
      });
      for (const text of messages) pi.sendUserMessage(text);
    } finally {
      draining = false;
    }
  };

  const stop = () => {
    try { watcher?.close(); } catch { /* already closed */ }
    watcher = undefined;
    clearInterval(timer);
    timer = undefined;
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    dir = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    try {
      if (!ctx.hasUI || dir) return;
      mkdirSync(INBOX_ROOT, { recursive: true, mode: 0o700 });
      sweepStale();
      dir = path.join(INBOX_ROOT, String(process.pid));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      try {
        watcher = watch(dir, () => drain(ctx));
      } catch { /* the poll below still delivers */ }
      timer = setInterval(() => drain(ctx), POLL_MS);
      timer.unref();
      drain(ctx);
    } catch {
      stop();
    }
  });

  pi.on("session_shutdown", () => stop());
  process.once("exit", () => stop());
}
