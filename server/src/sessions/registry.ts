// The session tree (SPEC 4.2-4.4): every tmux pane on every socket plus every herdr agent, with
// status, live voice and the omp behind each pane. Scans only while someone is watching.

import { hostname } from "node:os";
import path from "node:path";
import type { HostdConfig } from "../config";
import { DirtyCache } from "../diff/git";
import { sessionId, type Where } from "./ids";
import { listAgents } from "./herdr";
import { liveVoicePids } from "./livevoice";
import { findOmp, hasInbox, readProcTable, transcriptOf, type ProcTable } from "./procs";
import { HERDR_STATUS, statusFromTranscript, type SessionStatus } from "./status";
import { listPanes, listSockets } from "./tmux";

export interface SessionInfo {
  id: string;
  kind: "tmux" | "herdr";
  name: string;
  cwd: string;
  status: SessionStatus;
  reported: boolean;
  questionCount: number;
  liveVoice: boolean | null;
  pinned: boolean;
  where: Where;
  attached: boolean;
  omp: { pid: number; transcript: string | null; inbox: boolean } | null;
  herdrStatus: string | null;
  dirty: boolean | null; // git working tree has changes; null: no git repo or git failed
}

export interface Tree {
  machine: string;
  scannedAt: string;
  sessions: SessionInfo[];
  sources: {
    tmux: { socket: string; ok: boolean; error: string }[];
    herdr: { ok: boolean; error: string };
    liveVoice: { ok: boolean; error: string };
  };
}

const SPINNER = /[\u2800-\u28ff]/g;

/** `root` and every process below it. */
function withDescendants(t: ProcTable, root: number): Set<number> {
  const found = new Set<number>([root]);
  const queue = [root];
  while (queue.length) {
    for (const child of t.children.get(queue.shift() as number) ?? []) {
      if (!found.has(child)) {
        found.add(child);
        queue.push(child);
      }
    }
  }
  return found;
}

export class Registry {
  private last: Tree | null = null;
  private lastAt = 0;
  private lastJson: string | null = null;
  private storedSeq = 0;
  private seq = 0;
  private pending: Promise<Tree> | null = null;
  private readonly listeners = new Set<(t: Tree) => void>();
  private watchers = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private readonly dirtyCache: DirtyCache;

  constructor(private readonly cfg: HostdConfig) {
    this.dirtyCache = new DirtyCache(cfg);
  }

  /** How many startWatching calls are not yet matched by stopWatching. */
  get watching(): number {
    return this.watchers;
  }

  async scan(): Promise<Tree> {
    const seq = ++this.seq;
    const cfg = this.cfg;
    const sockets = listSockets(cfg);
    const [lists, agents, voice] = await Promise.all([
      Promise.all(sockets.map(async (socket) => ({ socket, list: await listPanes(cfg, socket) }))),
      listAgents(cfg),
      liveVoicePids(cfg.bin.pactl),
    ]);
    const procs = readProcTable();
    const voicePids = voice.ok ? voice.pids : new Set<number>();
    const placed = new Set<number>();
    const sessions: SessionInfo[] = [];
    const host = hostname();
    const thalamus = cfg.thalamusDir;
    const isPinned = (cwd: string) => cwd === thalamus || cwd.startsWith(thalamus + "/");

    for (const { list } of lists) {
      if (!list.ok) continue;
      for (const p of list.panes) {
        const below = voicePids.size > 0 ? withDescendants(procs, p.panePid) : new Set<number>();
        let hasVoice = false;
        for (const pid of voicePids) {
          if (below.has(pid)) {
            hasVoice = true;
            placed.add(pid);
          }
        }
        const ompPid = findOmp(procs, p.panePid);
        const transcript = ompPid === null ? null : transcriptOf(ompPid, cfg.transcriptDirs);
        const info = transcript === null ? null : statusFromTranscript(transcript);
        const title = p.title.replace(SPINNER, "").trim();
        const where: Where = { kind: "tmux", socket: p.socket, session: p.session, window: p.window, pane: p.pane };
        sessions.push({
          id: sessionId(where),
          kind: "tmux",
          name: title === "" || title === host ? path.basename(p.cwd) : title,
          cwd: p.cwd,
          status: info !== null && info.reported !== null ? info.status : "unknown",
          reported: info !== null && info.reported !== null,
          questionCount: info?.questionCount ?? 0,
          liveVoice: voice.ok ? hasVoice : null,
          pinned: isPinned(p.cwd),
          where,
          attached: p.attached,
          omp: ompPid === null ? null : { pid: ompPid, transcript, inbox: hasInbox(cfg.inboxRoot, ompPid) },
          herdrStatus: null,
          dirty: null,
        });
      }
    }

    // herdr pane pids are not exposed (plan Verified facts 9), so a voice pid that no tmux pane
    // holds might belong to any herdr agent: its liveVoice is unknown then.
    const unplaced = [...voicePids].some((pid) => !placed.has(pid));
    if (agents.ok) {
      for (const a of agents.agents) {
        const where: Where = { kind: "herdr", workspace: a.workspace, tab: a.tab, pane: a.pane };
        sessions.push({
          id: sessionId(where),
          kind: "herdr",
          name: a.name || a.title || (a.cwd ? path.basename(a.cwd) : "") || a.pane,
          cwd: a.cwd,
          status: HERDR_STATUS[a.status] ?? "unknown",
          reported: false,
          questionCount: 0,
          liveVoice: !voice.ok || unplaced ? null : false,
          pinned: isPinned(a.cwd),
          where,
          attached: false,
          omp: null,
          herdrStatus: a.status,
          dirty: null,
        });
      }
    }

    const cwds = [...new Set(sessions.map((s) => s.cwd))];
    const dirtyByCwd = new Map(await Promise.all(cwds.map(async (cwd) => [cwd, await this.dirtyCache.lookup(cwd)] as const)));
    for (const s of sessions) s.dirty = dirtyByCwd.get(s.cwd) ?? null;

    sessions.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const an = a.status === "needs-you";
      const bn = b.status === "needs-you";
      if (an !== bn) return an ? -1 : 1;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const tree: Tree = {
      machine: cfg.machineName,
      scannedAt: new Date().toISOString(),
      sessions,
      sources: {
        tmux: lists.map(({ socket, list }) => ({ socket, ok: list.ok, error: list.ok ? "" : list.error })),
        herdr: { ok: agents.ok, error: agents.ok ? "" : agents.error },
        liveVoice: { ok: voice.ok, error: voice.ok ? "" : voice.error },
      },
    };
    this.store(tree, seq);
    return tree;
  }

  private store(tree: Tree, seq: number): void {
    if (seq < this.storedSeq) return;
    this.storedSeq = seq;
    this.last = tree;
    this.lastAt = Date.now();
    const json = JSON.stringify(tree.sessions);
    const changed = this.lastJson !== null && json !== this.lastJson;
    this.lastJson = json;
    if (!changed) return;
    for (const fn of this.listeners) {
      try { fn(tree); } catch { /* one bad listener must not stop the rest */ }
    }
  }

  async current(maxAgeMs = 2000): Promise<Tree> {
    if (maxAgeMs > 0) {
      if (this.last !== null && Date.now() - this.lastAt < maxAgeMs) return this.last;
      if (this.pending !== null) return this.pending;
    }
    const p = this.scan();
    if (maxAgeMs > 0) {
      this.pending = p;
      const clear = () => { if (this.pending === p) this.pending = null; };
      p.then(clear, clear);
    }
    return p;
  }

  async get(id: string, maxAgeMs = 2000): Promise<SessionInfo | null> {
    return (await this.current(maxAgeMs)).sessions.find((s) => s.id === id) ?? null;
  }

  /** Fires only when the JSON of `sessions` changed since the previous scan. Returns the unsubscribe. */
  onChange(fn: (t: Tree) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  startWatching(): void {
    this.watchers += 1;
    this.schedule();
  }

  stopWatching(): void {
    if (this.watchers > 0) this.watchers -= 1;
    if (this.watchers === 0 && this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.timer !== null || this.ticking || this.watchers === 0) return;
    this.timer = setTimeout(() => { void this.tick(); }, this.cfg.scanIntervalMs);
  }

  private async tick(): Promise<void> {
    this.timer = null;
    this.ticking = true;
    try {
      await this.scan();
    } catch {
      // A failed scan is retried on the next tick; sources report their own errors.
    } finally {
      this.ticking = false;
    }
    this.schedule();
  }
}
