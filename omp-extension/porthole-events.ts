// porthole-events: tells Porthole's hostd what this omp session is doing (SPEC 4.6).
// One short Unix-socket connection per event. If hostd is down or slow the event is
// dropped: nothing here may block, slow or crash omp. No template literals (the omp
// extension dependency rewriter rejects them) and no raw timers.
import net from "node:net";
import path from "node:path";

const TIMEOUT_MS = 500;
const MAX_TEXT = 2000;
const MAX_OPTIONS = 20;
const MAX_OPTION = 200;

interface Ctx { hasUI?: boolean; cwd?: string; sessionManager?: { getSessionFile?: () => string | undefined } }
interface ExtensionApi { on(event: string, handler: (event: unknown, ctx: Ctx) => unknown): void }

function socketPath(): string {
  if (process.env.PORTHOLE_EVENTS_SOCKET) return process.env.PORTHOLE_EVENTS_SOCKET;
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  return path.join(process.env.XDG_RUNTIME_DIR || "/run/user/" + uid, "porthole", "events.sock");
}

function cut(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function post(body: Record<string, unknown>): void {
  try {
    const line = JSON.stringify(Object.assign({ v: 1, pid: process.pid, at: new Date().toISOString() }, body)) + "\n";
    const sock = net.createConnection(socketPath());
    sock.on("error", () => sock.destroy());
    sock.setTimeout(TIMEOUT_MS, () => sock.destroy());
    sock.unref();
    sock.end(line);
  } catch {
    // hostd unreachable: drop the event, omp carries on.
  }
}

function questions(args: unknown): Record<string, unknown>[] {
  const list = rec(args).questions;
  if (!Array.isArray(list)) return [];
  return list.slice(0, 10).map((q) => {
    const r = rec(q);
    const opts = Array.isArray(r.options) ? r.options : [];
    return {
      id: cut(r.id, 100),
      question: cut(r.question, MAX_TEXT),
      options: opts.slice(0, MAX_OPTIONS).map((o) => cut(rec(o).label, MAX_OPTION)),
      multi: r.multi === true,
    };
  });
}

export default function portholeEvents(pi: ExtensionApi) {
  let active = false;

  pi.on("session_start", (_event, ctx) => {
    try {
      if (!ctx || !ctx.hasUI) return;
      active = true;
      const file = ctx.sessionManager && ctx.sessionManager.getSessionFile ? ctx.sessionManager.getSessionFile() : undefined;
      post({ type: "session_start", cwd: ctx.cwd || process.cwd(), sessionFile: file || null, tmux: process.env.TMUX || null, pane: process.env.TMUX_PANE || null });
    } catch {
      // never let Porthole break omp
    }
  });

  pi.on("tool_execution_start", (event) => {
    try {
      const e = rec(event);
      if (!active || e.toolName !== "ask") return;
      post({ type: "question_open", qid: cut(e.toolCallId, 200), questions: questions(e.args) });
    } catch {
      // never let Porthole break omp
    }
  });

  pi.on("tool_execution_end", (event) => {
    try {
      const e = rec(event);
      if (!active || e.toolName !== "ask") return;
      post({ type: "question_closed", qid: cut(e.toolCallId, 200), outcome: e.isError === true ? "cancelled" : "answered" });
    } catch {
      // never let Porthole break omp
    }
  });

  pi.on("agent_start", () => {
    try { if (active) post({ type: "working" }); } catch { /* ignore */ }
  });
  pi.on("agent_end", () => {
    try { if (active) post({ type: "turn_finished" }); } catch { /* ignore */ }
  });
  pi.on("session_shutdown", () => {
    try { if (active) post({ type: "session_end" }); } catch { /* ignore */ }
    active = false;
  });
}
