// The headless e2e stack (plan C1): two test hostds (testdesk, testlaptop) on the server Scratch harness, a TLS proxy in front
// of each (standing in for `tailscale serve`), one throwaway Chromium that reaches them by name, and a CDP page.
// Everything lives under scratch folders; stop() ends exactly what this stack started.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chatFeature } from "../../../server/src/features/chat";
import { configFeature } from "../../../server/src/features/config";
import { diffFeature } from "../../../server/src/features/diff";
import { doctorFeature } from "../../../server/src/features/doctor";
import { inboxFeature } from "../../../server/src/features/inbox";
import { machineFeature } from "../../../server/src/features/machine";
import { previewFeature } from "../../../server/src/features/preview";
import { ptyFeature } from "../../../server/src/features/pty";
import { sendFeature } from "../../../server/src/features/send";
import { sessionsFeature } from "../../../server/src/features/sessions";
import { shortcutsFeature } from "../../../server/src/features/shortcuts";
import { uploadsFeature } from "../../../server/src/features/uploads";
import { usageFeature } from "../../../server/src/features/usage";
import { voiceFeature } from "../../../server/src/features/voice";
import { webFeature } from "../../../server/src/features/web";
import { FEATURES } from "../../../server/src/main";
import type { FeatureFactory } from "../../../server/src/router";
import { sessionId as makeSessionId } from "../../../server/src/sessions/ids";
import { ompPane, pane, startTestHostd, type TestHostd, type TestPane } from "../../../server/test/helpers/client";
import { Scratch } from "../../../server/test/helpers/scratch";
import { href } from "../../src/lib/route.js";
import { startChrome, type Chrome } from "./browser";
import { connectPage, type Page } from "./cdp";
import { startProxy, type Proxy } from "./tsproxy";

export type Machine = "desk" | "laptop";
export type { Chrome, Page, Proxy, TestHostd };

export interface StackOptions {
  /** Fixture strings per machine: "<file>.jsonl", "shell:<name>" or "repo:<name>". */
  fixtures: { desk: string[]; laptop: string[] };
}

export interface Stack {
  desk: TestHostd;
  laptop: TestHostd;
  proxies: { desk: Proxy; laptop: Proxy };
  chrome: Chrome;
  page: Page;
  stop(): Promise<void>;
  chatUrl(m: Machine, f: string): string;
  termUrl(m: Machine, f: string): string;
  changesUrl(m: Machine, f: string): string;
  sessionId(m: Machine, f: string): string;
  killPane(m: Machine, f: string): void;
  append(m: Machine, f: string, line: string): void;
  screen(m: Machine, f: string): Promise<string>;
  tmuxFormat(m: Machine, f: string, format: string): string;
  setLiveVoice(m: Machine, f: string, on: boolean): Promise<void>;
  emitQuestion(m: Machine, f: string, q: { qid: string; questions: { id: string; question: string; options: string[]; multi: boolean }[] }): Promise<void>;
  emitEvent(m: Machine, f: string, event: { type: string; [key: string]: unknown }): Promise<void>;
  /** Parsed answer of a request to that hostd through its proxy (with `X-Porthole: 1`); JSON when the answer is JSON, else text. */
  api(m: Machine, path: string, init?: RequestInit): Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Polls `fn` every 100 ms until it returns something truthy (returned); throws with the last value after `ms`. */
  waitFor<T>(fn: () => T | Promise<T>, ms?: number): Promise<NonNullable<T>>;
}

interface Entry {
  pane: TestPane;
  session: string;
  /** Transcript copy (omp fixtures only). */
  transcript: string | null;
}

interface Side {
  name: string;
  origin: string;
  scratch: Scratch;
  hostd: TestHostd;
  proxy: Proxy;
  entries: Map<string, Entry>;
  voicePids: Set<number>;
}

const WEB_FIXTURES = path.join(import.meta.dir, "..", "fixtures");
const SERVER_FIXTURES = path.join(import.meta.dir, "..", "..", "..", "server", "test", "fixtures");
const WEB_DIR = path.join(import.meta.dir, "..", "..");
const POLL_MS = 100;
const GIT_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.invalid", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.invalid" };

function featuresFor(configFile: string): FeatureFactory[] {
  const list = [
    machineFeature, sessionsFeature, chatFeature, sendFeature, ptyFeature, inboxFeature, uploadsFeature, diffFeature, previewFeature,
    usageFeature, voiceFeature, shortcutsFeature, configFeature(configFile), doctorFeature, webFeature(WEB_DIR),
  ];
  // Same list as production, only the config file differs (never the real ~/.config one).
  if (list.length !== FEATURES.length) throw new Error("server/src/main.ts FEATURES changed (" + FEATURES.length + " entries): update web/test/e2e/stack.ts");
  return list;
}

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error("git " + args.join(" ") + " failed: " + r.stderr.toString());
}

function fixtureText(file: string): string {
  for (const dir of [WEB_FIXTURES, SERVER_FIXTURES]) {
    const f = path.join(dir, file);
    if (existsSync(f)) return readFileSync(f, "utf8");
  }
  throw new Error("fixture " + file + " is in neither " + WEB_FIXTURES + " nor " + SERVER_FIXTURES);
}

/** All of a machine's fixtures live on one scratch tmux server (one socket per machine, like a real desk): the first fixture sets `shared.socket`. */
interface Shared { socket?: string }

async function makeEntry(s: Scratch, f: string, shared: Shared): Promise<Entry> {
  if (f.endsWith(".jsonl")) {
    const session = f.slice(0, -".jsonl".length);
    const transcript = s.writeTranscript(f, fixtureText(f));
    const p = await ompPane(s, session, transcript, shared.socket);
    shared.socket = p.socket;
    return { pane: p, session, transcript };
  }
  if (f.startsWith("shell:")) {
    const session = f.slice("shell:".length);
    const p = await pane(s, session, "/bin/sh", shared.socket);
    shared.socket = p.socket;
    s.tmux(p.socket, "new-window", "-d", "-t", "=" + session + ":1", "-c", s.root, "/bin/sh");
    return { pane: p, session, transcript: null };
  }
  if (f.startsWith("repo:")) {
    const session = f.slice("repo:".length);
    const dir = path.join(s.root, session);
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    writeFileSync(path.join(dir, "staged.txt"), "one\ntwo\n");
    writeFileSync(path.join(dir, "unstaged.txt"), "alpha\nbeta\n");
    git(dir, "add", "staged.txt", "unstaged.txt");
    git(dir, "commit", "-q", "-m", "base");
    writeFileSync(path.join(dir, "staged.txt"), "one\ntwo staged edit\n");
    git(dir, "add", "staged.txt");
    writeFileSync(path.join(dir, "unstaged.txt"), "alpha\nbeta\n" + "x".repeat(200) + "\n");
    writeFileSync(path.join(dir, "new.txt"), "a new file\n");
    if (shared.socket) s.tmux(shared.socket, "new-session", "-d", "-s", session, "-x", "120", "-y", "40", "-c", dir, "/bin/sh");
    const socket = shared.socket ?? s.newTmuxServer(session, "/bin/sh", dir);
    shared.socket = socket;
    const p: TestPane = { socket, pid: s.panePid(socket, "=" + session + ":0.0"), id: makeSessionId({ kind: "tmux", socket, session, window: 0, pane: 0 }) };
    return { pane: p, session, transcript: null };
  }
  throw new Error("unknown fixture kind " + JSON.stringify(f) + ' (want "<file>.jsonl", "shell:<name>" or "repo:<name>")');
}

async function waitFor<T>(fn: () => T | Promise<T>, ms = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  let last: unknown = undefined;
  for (;;) {
    try {
      last = await fn();
      if (last) return last as NonNullable<T>;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (Date.now() > deadline) throw new Error("waitFor timed out after " + ms + " ms; last value: " + JSON.stringify(last));
    await Bun.sleep(POLL_MS);
  }
}

function writeEventLine(sock: string, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock, () => { c.end(line + "\n", () => resolve()); });
    c.on("error", reject);
  });
}

interface SessionRow { id: string; liveVoice: boolean; omp: { pid: number } | null }

export async function startStack(opts: StackOptions): Promise<Stack> {
  const undo: (() => void | Promise<void>)[] = [];
  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      for (const fn of undo.splice(0).reverse()) {
        try { await fn(); } catch (e) { console.error("stack stop step failed: " + (e instanceof Error ? e.message : String(e))); }
      }
    })();
    return stopping;
  };

  try {
    const root = mkdtempSync(path.join(tmpdir(), "porthole-e2e-"));
    undo.push(() => rmSync(root, { recursive: true, force: true }));

    const cert = path.join(root, "cert.pem");
    const key = path.join(root, "key.pem");
    const ssl = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=porthole-test",
      "-addext", "subjectAltName=DNS:testdesk.example.ts.net,DNS:testlaptop.example.ts.net", "-keyout", key, "-out", cert], { stdout: "pipe", stderr: "pipe" });
    if (ssl.exitCode !== 0) throw new Error("openssl failed: " + ssl.stderr.toString());

    const sides = {} as Record<Machine, Side>;
    const other: Record<Machine, Machine> = { desk: "laptop", laptop: "desk" };
    const origin = (m: Machine): string => `https://test${m}.example.ts.net`;
    for (const m of ["desk", "laptop"] as const) {
      const scratch = new Scratch();
      undo.push(() => scratch.cleanup());
      const hostd = await startTestHostd(scratch, featuresFor(path.join(scratch.root, "hostd.json")), {
        machineName: "test" + m,
        origin: origin(m),
        peers: [origin(other[m])],
      });
      undo.push(() => hostd.stop());
      const proxy = await startProxy({ target: hostd, cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") });
      undo.push(() => proxy.stop());
      sides[m] = { name: "test" + m, origin: origin(m), scratch, hostd, proxy, entries: new Map(), voicePids: new Set() };
    }
    for (const m of ["desk", "laptop"] as const) {
      const shared: Shared = {};
      for (const f of opts.fixtures[m]) sides[m].entries.set(f, await makeEntry(sides[m].scratch, f, shared));
    }

    const entry = (m: Machine, f: string): Entry => {
      const e = sides[m].entries.get(f);
      if (!e) throw new Error(`no fixture "${f}" on ${m} (have: ${[...sides[m].entries.keys()].join(", ") || "none"})`);
      return e;
    };
    const direct = async (m: Machine, p: string): Promise<Response> => {
      const h = sides[m].hostd;
      return fetch(h.url + p, { headers: { "X-Porthole": "1", "X-Porthole-Local": h.localToken } });
    };
    const sessions = async (m: Machine): Promise<SessionRow[]> => ((await (await direct(m, "/v1/sessions")).json()) as { sessions: SessionRow[] }).sessions;

    // Every fixture must be visible to hostd (omp panes: with their omp process found) before a test starts.
    for (const m of ["desk", "laptop"] as const) {
      for (const [f, e] of sides[m].entries) {
        await waitFor(async () => (await sessions(m)).some((r) => r.id === e.pane.id && (e.transcript === null || r.omp !== null)), 15_000)
          .catch((err: unknown) => { throw new Error(`fixture ${f} on ${m} never showed up in GET /v1/sessions: ${err instanceof Error ? err.message : String(err)}`); });
      }
    }

    const chrome = await startChrome({ scratch: root, map: { "testdesk.example.ts.net": sides.desk.proxy.port, "testlaptop.example.ts.net": sides.laptop.proxy.port } });
    undo.push(() => chrome.stop());
    const page = await connectPage(chrome.port);
    undo.push(() => page.close());
    await page.goto(sides.desk.origin + "/");

    const url = (view: "chat" | "term" | "changes", m: Machine, f: string): string =>
      sides[m].origin + "/" + href({ view, machine: sides[m].name, sessionId: entry(m, f).pane.id });
    const emit = (m: Machine, f: string, event: Record<string, unknown>): Promise<void> =>
      writeEventLine(path.join(sides[m].hostd.config.runtimeDir, "events.sock"), JSON.stringify({ v: 1, at: new Date().toISOString(), pid: entry(m, f).pane.pid, ...event }));

    return {
      desk: sides.desk.hostd,
      laptop: sides.laptop.hostd,
      proxies: { desk: sides.desk.proxy, laptop: sides.laptop.proxy },
      chrome,
      page,
      stop,
      chatUrl: (m, f) => url("chat", m, f),
      termUrl: (m, f) => url("term", m, f),
      changesUrl: (m, f) => url("changes", m, f),
      sessionId: (m, f) => entry(m, f).pane.id,
      killPane(m, f) {
        const e = entry(m, f);
        sides[m].scratch.tmux(e.pane.socket, "kill-pane", "-t", "=" + e.session + ":0.0");
      },
      append(m, f, line) {
        const e = entry(m, f);
        if (e.transcript === null) throw new Error(`fixture ${f} on ${m} has no transcript`);
        appendFileSync(e.transcript, line.endsWith("\n") ? line : line + "\n");
      },
      async screen(m, f) {
        const r = (await (await direct(m, "/v1/sessions/" + encodeURIComponent(entry(m, f).pane.id) + "/screen")).json()) as { text: string };
        return r.text;
      },
      tmuxFormat(m, f, format) {
        const e = entry(m, f);
        return sides[m].scratch.tmux(e.pane.socket, "display-message", "-p", "-t", "=" + e.session + ":", format).trim();
      },
      async setLiveVoice(m, f, on) {
        const e = entry(m, f);
        const side = sides[m];
        if (on) side.voicePids.add(e.pane.pid); else side.voicePids.delete(e.pane.pid);
        side.scratch.setLiveVoicePids([...side.voicePids]);
        await waitFor(async () => (await sessions(m)).some((r) => r.id === e.pane.id && r.liveVoice === on), 10_000);
      },
      emitQuestion: (m, f, q) => emit(m, f, { type: "question_open", qid: q.qid, questions: q.questions }),
      emitEvent: (m, f, event) => emit(m, f, event),
      async api(m, p, init = {}) {
        const headers = new Headers(init.headers);
        headers.set("X-Porthole", "1");
        if (!headers.has("Origin")) headers.set("Origin", sides[m].origin);
        const r = await fetch(`https://127.0.0.1:${sides[m].proxy.port}${p}`, { ...init, headers, tls: { rejectUnauthorized: false } } as RequestInit);
        const text = await r.text();
        try { return JSON.parse(text); } catch { return text; }
      },
      waitFor,
    };
  } catch (e) {
    await stop();
    throw e;
  }
}
