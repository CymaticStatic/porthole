// The Unix socket omp's porthole-events extension reports to (SPEC 4.6, 5.4): newline-delimited JSON,
// one short connection per event, owner-only (socket 0600 inside a 0700 folder).

import { chmodSync, existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { UnixSocketListener } from "bun";

export type OmpEvent =
  | { type: "session_start"; pid: number; at: string; cwd: string; sessionFile: string | null; tmux: string | null; pane: string | null }
  | { type: "question_open"; pid: number; at: string; qid: string; questions: { id: string; question: string; options: string[]; multi: boolean }[] }
  | { type: "question_closed"; pid: number; at: string; qid: string; outcome: "answered" | "cancelled" }
  | { type: "working" | "turn_finished" | "session_end"; pid: number; at: string };

const MAX_CONNECTION_BYTES = 64 * 1024;
const PROBE_MS = 300;
const MAX_TEXT = 2000;
const MAX_ID = 200;
const MAX_QUESTIONS = 10;
const MAX_OPTIONS = 20;
const MAX_OPTION = 200;

const EVENT_TYPES: Record<string, true> = {
  session_start: true,
  question_open: true,
  question_closed: true,
  working: true,
  turn_finished: true,
  session_end: true,
};

type Rec = Record<string, unknown>;

function asRec(v: unknown): Rec | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : null;
}

function str(v: unknown, max: number): string | null {
  return typeof v === "string" ? v.slice(0, max) : null;
}

function optStr(v: unknown, max: number): string | null {
  return typeof v === "string" && v !== "" ? v.slice(0, max) : null;
}

function parseQuestions(v: unknown): { id: string; question: string; options: string[]; multi: boolean }[] | null {
  if (!Array.isArray(v)) return null;
  const out: { id: string; question: string; options: string[]; multi: boolean }[] = [];
  for (const raw of v.slice(0, MAX_QUESTIONS)) {
    const q = asRec(raw);
    if (!q || !Array.isArray(q.options)) return null;
    const id = str(q.id, MAX_ID);
    const question = str(q.question, MAX_TEXT);
    if (id === null || question === null) return null;
    const options: string[] = [];
    for (const o of q.options.slice(0, MAX_OPTIONS)) {
      if (typeof o !== "string") return null;
      options.push(o.slice(0, MAX_OPTION));
    }
    out.push({ id, question, options, multi: q.multi === true });
  }
  return out;
}

/** One line from the extension, or null when it is not a valid v1 event. */
export function parseEvent(line: string): OmpEvent | null {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return null; }
  const o = asRec(parsed);
  if (!o || o.v !== 1) return null;
  const pid = o.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  const type = o.type;
  if (typeof type !== "string" || EVENT_TYPES[type] !== true) return null;
  const at = str(o.at, 64);
  if (at === null) return null;
  switch (type) {
    case "session_start": {
      const cwd = str(o.cwd, MAX_TEXT);
      if (cwd === null) return null;
      return { type, pid, at, cwd, sessionFile: optStr(o.sessionFile, MAX_TEXT), tmux: optStr(o.tmux, MAX_TEXT), pane: optStr(o.pane, MAX_ID) };
    }
    case "question_open": {
      const qid = str(o.qid, MAX_ID);
      const questions = parseQuestions(o.questions);
      if (qid === null || questions === null) return null;
      return { type, pid, at, qid, questions };
    }
    case "question_closed": {
      const qid = str(o.qid, MAX_ID);
      if (qid === null || (o.outcome !== "answered" && o.outcome !== "cancelled")) return null;
      return { type, pid, at, qid, outcome: o.outcome };
    }
    case "working":
    case "turn_finished":
    case "session_end":
      return { type, pid, at };
    default:
      return null;
  }
}

/** True when something accepts connections on the Unix socket `file` within PROBE_MS. */
function answers(file: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const c = net.createConnection(file);
  const timer = setTimeout(() => done(false), PROBE_MS);
  function done(alive: boolean): void {
    clearTimeout(timer);
    c.destroy();
    resolve(alive);
  }
  c.on("connect", () => done(true));
  c.on("error", () => done(false));
  return promise;
}

interface ConnData { buf: string; decoder: TextDecoder }

export class EventsSocket {
  private listener: UnixSocketListener<ConnData> | null = null;

  constructor(private readonly file: string, private readonly onEvent: (e: OmpEvent) => void) {}

  /** Creates the 0700 folder and the 0600 socket; refuses when another process already answers on it. */
  async start(): Promise<void> {
    if (this.listener) return;
    const dir = path.dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    if (existsSync(this.file)) {
      if (await answers(this.file)) throw new Error("another hostd already listens on " + this.file);
      unlinkSync(this.file);
    }
    this.listener = Bun.listen<ConnData>({
      unix: this.file,
      socket: {
        open(sock) { sock.data = { buf: "", decoder: new TextDecoder() }; },
        data: (sock, chunk) => {
          sock.data.buf += sock.data.decoder.decode(chunk, { stream: true });
          if (sock.data.buf.length > MAX_CONNECTION_BYTES) { sock.data.buf = ""; sock.end(); return; }
          let i = sock.data.buf.indexOf("\n");
          while (i >= 0) {
            const e = parseEvent(sock.data.buf.slice(0, i));
            sock.data.buf = sock.data.buf.slice(i + 1);
            if (e) { try { this.onEvent(e); } catch { /* one bad handler call must not kill the listener */ } }
            i = sock.data.buf.indexOf("\n");
          }
        },
        error() { /* a broken client connection is not hostd's problem */ },
      },
    });
    chmodSync(this.file, 0o600);
  }

  /** Closes the listener and removes the socket file. */
  stop(): void {
    this.listener?.stop(true);
    this.listener = null;
    rmSync(this.file, { force: true });
  }
}
