// WS /v1/sessions/:id/pty: a real terminal on a tmux session (our own `tmux attach` client in a
// Bun PTY), or a read-only screen feed for a herdr pane. SPEC 4.3: live voice is re-checked on
// every input frame; once it is on (or unknown) the socket is read-only until it closes. Closing
// detaches only the client this socket started, never anyone else's.

import type { ServerWebSocket } from "bun";
import type { HostdConfig } from "../config";
import { cleanEnv } from "../exec";
import type { FeatureFactory, WsData } from "../router";
import { readScreen } from "../sessions/herdr";
import type { SessionInfo, Tree } from "../sessions/registry";
import { detachClient, listClients, socketPath } from "../sessions/tmux";

type Ws = ServerWebSocket<WsData>;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const COLS = { min: 20, max: 400 };
const ROWS = { min: 5, max: 200 };
const KILL_AFTER_MS = 2000;
const SCREEN_EVERY_MS = 1000;
const SCREEN_LINES = 200;
const LIVE_VOICE_ON = "live voice is on; typing here would mix with it";
const LIVE_VOICE_UNKNOWN = "cannot tell if live voice is on, so typing is off";
const HERDR_READONLY = "herdr terminals are read-only in P1";

/** The part of Bun's subprocess-with-terminal this module uses. */
interface PtyProc {
  pid: number;
  exitCode: number | null;
  exited: Promise<number>;
  kill(): void;
  terminal: { write(bytes: Uint8Array): unknown; resize(cols: number, rows: number): void; close(): void };
}

interface PtyState {
  id: string;
  proc: PtyProc | null;
  socket: string;
  readonly: boolean;
  closed: boolean;
  watching: boolean;
  screenTimer: NodeJS.Timeout | null;
  teardown: Promise<void> | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function size(raw: string | null | undefined, fallback: number, min: number, max: number): number {
  if (raw === null || raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? clamp(n, min, max) : fallback;
}

function reasonFor(liveVoice: boolean | null): string {
  return liveVoice === null ? LIVE_VOICE_UNKNOWN : LIVE_VOICE_ON;
}

function sendJson(ws: Ws, body: unknown): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(body));
}

export const ptyFeature: FeatureFactory = (d) => {
  const cfg: HostdConfig = d.config;
  const open = new Map<Ws, PtyState>();
  let unsubscribe: (() => void) | null = null;

  function makeReadonly(ws: Ws, st: PtyState, reason: string): void {
    if (st.readonly) return;
    st.readonly = true;
    sendJson(ws, { type: "readonly", reason });
  }

  // A scan that sees live voice (or loses track of it) switches every open tmux socket to
  // read-only straight away, without waiting for the next keystroke.
  function onTree(tree: Tree): void {
    for (const [ws, st] of open) {
      if (st.readonly || st.closed || st.proc === null) continue;
      const s = tree.sessions.find((x) => x.id === st.id);
      if (s && s.liveVoice !== false) makeReadonly(ws, st, reasonFor(s.liveVoice));
    }
  }

  async function attach(ws: Ws, st: PtyState, session: SessionInfo & { where: { kind: "tmux"; socket: string; session: string } }): Promise<void> {
    const cols = size(ws.data.query.get("cols"), DEFAULT_COLS, COLS.min, COLS.max);
    const rows = size(ws.data.query.get("rows"), DEFAULT_ROWS, ROWS.min, ROWS.max);
    if (session.liveVoice !== false) makeReadonly(ws, st, reasonFor(session.liveVoice));
    st.socket = session.where.socket;
    const proc = Bun.spawn([cfg.bin.tmux, "-S", socketPath(cfg, session.where.socket), "attach-session", "-t", "=" + session.where.session], {
      terminal: {
        cols,
        rows,
        data(_terminal: unknown, bytes: Uint8Array) {
          if (ws.readyState === 1) ws.send(bytes);
        },
      },
      env: cleanEnv({ TERM: "xterm-256color" }),
    } as never) as unknown as PtyProc;
    st.proc = proc;
    void proc.exited.then(() => {
      try { proc.terminal.close(); } catch { /* already closed */ }
      if (!st.closed && ws.readyState === 1) ws.close(1000);
    });
  }

  function streamScreen(ws: Ws, st: PtyState, pane: string): void {
    const tick = async (): Promise<void> => {
      if (st.closed) return;
      const r = await readScreen(cfg, pane, SCREEN_LINES);
      if (st.closed) return;
      sendJson(ws, r.ok ? { type: "screen", text: r.text } : { type: "error", error: r.error });
      st.screenTimer = setTimeout(() => { void tick(); }, SCREEN_EVERY_MS);
    };
    void tick();
  }

  async function setup(ws: Ws, st: PtyState): Promise<void> {
    const session = await d.registry.get(st.id, cfg.scanIntervalMs);
    if (st.closed) return;
    if (session === null) {
      sendJson(ws, { type: "error", error: "no such session" });
      ws.close(1000);
      return;
    }
    if (session.where.kind === "herdr") {
      st.readonly = true;
      sendJson(ws, { type: "readonly", reason: HERDR_READONLY });
      streamScreen(ws, st, session.where.pane);
      return;
    }
    await attach(ws, st, session as SessionInfo & { where: { kind: "tmux"; socket: string; session: string } });
  }

  async function input(ws: Ws, st: PtyState, bytes: Uint8Array): Promise<void> {
    if (st.closed || st.readonly || st.proc === null) return;
    const session = await d.registry.get(st.id, cfg.scanIntervalMs);
    if (st.closed || st.readonly || st.proc === null || session === null) return;
    if (session.liveVoice !== false) {
      makeReadonly(ws, st, reasonFor(session.liveVoice));
      return;
    }
    st.proc.terminal.write(bytes);
  }

  function control(st: PtyState, text: string): void {
    if (st.closed || st.proc === null) return;
    let msg: unknown;
    try { msg = JSON.parse(text); } catch { return; }
    if (typeof msg !== "object" || msg === null) return;
    const m = msg as { type?: unknown; cols?: unknown; rows?: unknown };
    if (m.type !== "resize" || typeof m.cols !== "number" || typeof m.rows !== "number") return;
    if (!Number.isFinite(m.cols) || !Number.isFinite(m.rows)) return;
    st.proc.terminal.resize(clamp(m.cols, COLS.min, COLS.max), clamp(m.rows, ROWS.min, ROWS.max));
  }

  // Detach only our own client (found by its pid), then make sure our own child is gone.
  function teardown(st: PtyState): Promise<void> {
    st.teardown ??= (async () => {
      st.closed = true;
      clearTimeout(st.screenTimer ?? undefined);
      st.screenTimer = null;
      const proc = st.proc;
      if (proc === null || proc.exitCode !== null) return;
      const fallback = setTimeout(() => { if (proc.exitCode === null) proc.kill(); }, KILL_AFTER_MS);
      void proc.exited.then(() => clearTimeout(fallback));
      const ours = (await listClients(cfg, st.socket)).find((c) => c.pid === proc.pid);
      if (ours) await detachClient(cfg, st.socket, ours.tty);
      else if (proc.exitCode === null) proc.kill();
    })();
    return st.teardown;
  }

  function release(st: PtyState): void {
    if (st.watching) {
      st.watching = false;
      d.registry.stopWatching();
    }
    if (open.size === 0 && unsubscribe !== null) {
      unsubscribe();
      unsubscribe = null;
    }
  }

  return {
    routes: [],
    channels: [
      {
        pattern: "/v1/sessions/:id/pty",
        open(ws) {
          const st: PtyState = {
            id: ws.data.params.id,
            proc: null,
            socket: "",
            readonly: false,
            closed: false,
            watching: true,
            chain: Promise.resolve(),
            screenTimer: null,
            teardown: null,
          };
          open.set(ws, st);
          d.registry.startWatching();
          unsubscribe ??= d.registry.onChange(onTree);
          st.chain = setup(ws, st).catch(() => {
            sendJson(ws, { type: "error", error: "could not open the terminal" });
            if (ws.readyState === 1) ws.close(1011);
          });
        },
        message(ws, data) {
          const st = open.get(ws);
          if (!st) return;
          if (typeof data === "string") {
            st.chain = st.chain.then(() => control(st, data));
          } else {
            const bytes = new Uint8Array(data);
            st.chain = st.chain.then(() => input(ws, st, bytes)).catch(() => undefined);
          }
        },
        close(ws) {
          const st = open.get(ws);
          if (!st) return;
          open.delete(ws);
          st.closed = true;
          release(st);
          st.chain = st.chain.then(() => teardown(st)).catch(() => undefined);
        },
      },
    ],
    async stop() {
      const states = [...open.values()];
      for (const [ws, st] of open) {
        open.delete(ws);
        st.closed = true;
        release(st);
      }
      unsubscribe?.();
      unsubscribe = null;
      await Promise.all(states.map((st) => st.chain.then(() => teardown(st)).catch(() => undefined)));
    },
  };
};
