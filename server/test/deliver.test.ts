import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { HostdConfig } from "../src/config";
import { Deliverer } from "../src/deliver/deliver";
import { inboxDir, stageInbox } from "../src/deliver/inbox";
import { SentLog } from "../src/deliver/sentlog";
import { sendFeature } from "../src/features/send";
import { sessionId } from "../src/sessions/ids";
import { Registry } from "../src/sessions/registry";
import { localHeaders, ompPane, pane, post, startTestHostd } from "./helpers/client";
import { Scratch, waitFor } from "./helpers/scratch";

let s: Scratch;
let cfg: HostdConfig;
let log: SentLog;
let d: Deliverer;
beforeEach(() => {
  s = new Scratch();
  cfg = s.config();
  log = new SentLog(cfg.stateDir);
  d = new Deliverer(cfg, new Registry(cfg), log);
});
afterEach(() => s.cleanup());

const HERDR_ID = sessionId({ kind: "herdr", workspace: "w1", tab: "w1:t1", pane: "w1:p1" });
function herdrAgent(status: string): void {
  s.setHerdrAgents([{ terminal_id: "t1", agent_status: status, workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", focused: false, revision: 1, name: "rev" }]);
}
function herdrPrompts(): { target: string; text: string }[] {
  return s.fakeFile("herdr-prompts.log").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const capture = (sock: string, session: string) => s.tmux(sock, "capture-pane", "-p", "-J", "-t", "=" + session + ":0.0");
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
/** Deletes every *.msg in `dir` as omp's live-inbox would, and counts how many it saw. */
function watcher(dir: string): { seen: string[]; stop(): void } {
  const seen: string[] = [];
  const t = setInterval(() => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".msg")) {
        seen.push(f);
        rmSync(path.join(dir, f), { force: true });
      }
    }
  }, 20);
  return { seen, stop: () => clearInterval(t) };
}
async function deadPid(): Promise<number> {
  const p = Bun.spawn(["true"]);
  await p.exited;
  return p.pid;
}

test("plain tmux send types the text and Enter once (P1.3 b)", async () => {
  const p = await pane(s, "work", "cat > /dev/null");
  const r = await d.send(p.id, "m-tmux-1", "hello porthole");
  expect([r.status, r.route]).toEqual(["delivered", "tmux"]);
  await waitFor(() => capture(p.socket, "work").includes("hello porthole"));
  const again = await d.send(p.id, "m-tmux-1", "hello porthole");
  expect(again).toEqual(r);
  await Bun.sleep(300);
  expect(count(capture(p.socket, "work"), "hello porthole")).toBe(1);
});

test("multi-line text arrives as lines, then one Enter", async () => {
  const p = await pane(s, "work", "cat > /dev/null");
  const r = await d.send(p.id, "m-lines", "line one\nline two\nline three");
  expect(r.status).toBe("delivered");
  await waitFor(() => /line one\nline two\nline three/.test(capture(p.socket, "work")));
});

test("the same id sent twice at the same moment is delivered once", async () => {
  const p = await pane(s, "work", "cat > /dev/null");
  const [a, b] = await Promise.all([d.send(p.id, "m-race", "race text"), d.send(p.id, "m-race", "race text")]);
  expect(a.status).toBe("delivered");
  expect(b).toEqual(a);
  await Bun.sleep(300);
  expect(count(capture(p.socket, "work"), "race text")).toBe(1);
  herdrAgent("idle");
  await Promise.all([d.send(HERDR_ID, "h-race", "once"), d.send(HERDR_ID, "h-race", "once")]);
  expect(herdrPrompts()).toEqual([{ target: "w1:p1", text: "once" }]);
});

test("an id used for one session is refused for another, and the first record stays", async () => {
  const p1 = await pane(s, "one", "cat > /dev/null");
  const p2 = await pane(s, "two", "cat > /dev/null", p1.socket);
  const first = await d.send(p1.id, "m-shared", "first");
  const other = await d.send(p2.id, "m-shared", "first");
  expect([other.status, other.reason]).toEqual(["refused", "this message id was already used for another session"]);
  expect(d.status("m-shared")).toEqual(first);
  expect(capture(p2.socket, "two")).not.toContain("first");
});

test("a refused id can be retried and is then delivered once", async () => {
  herdrAgent("idle");
  s.setLiveVoicePids([99999]);
  const refused = await d.send(HERDR_ID, "m-retry", "after the retry");
  expect([refused.status, refused.reason]).toEqual(["refused", "cannot tell if live voice is on for this herdr pane"]);
  s.setLiveVoicePids([]);
  const ok = await d.send(HERDR_ID, "m-retry", "after the retry");
  expect(ok.status).toBe("delivered");
  expect(await d.send(HERDR_ID, "m-retry", "after the retry")).toEqual(ok);
  expect(herdrPrompts()).toEqual([{ target: "w1:p1", text: "after the retry" }]);
});

test("a failed id can be retried", async () => {
  herdrAgent("idle");
  s.failHerdrPrompt(true);
  expect((await d.send(HERDR_ID, "m-fail-retry", "x")).status).toBe("failed");
  s.failHerdrPrompt(false);
  expect((await d.send(HERDR_ID, "m-fail-retry", "x")).status).toBe("delivered");
});

test("inbox route: delivered when omp takes the file, exactly once for the same id (P1.3 a)", async () => {
  const p = await ompPane(s, "omp", s.transcript("chat-basic.jsonl"));
  const dir = inboxDir(cfg.inboxRoot, p.pid);
  mkdirSync(dir, { recursive: true });
  const w = watcher(dir);
  try {
    const r = await d.send(p.id, "m-inbox", "through the inbox");
    expect([r.status, r.route, r.pid]).toEqual(["delivered", "inbox", p.pid]);
    expect(await d.send(p.id, "m-inbox", "through the inbox")).toEqual(r);
    await Bun.sleep(200);
    expect(w.seen).toEqual(["m-inbox.msg"]);
  } finally {
    w.stop();
  }
});

test("inbox route without a reader stays pending, then reconcile marks it delivered", async () => {
  const p = await ompPane(s, "omp", s.transcript("chat-basic.jsonl"));
  const dir = inboxDir(cfg.inboxRoot, p.pid);
  mkdirSync(dir, { recursive: true });
  const r = await d.send(p.id, "m-wait", "nobody reads");
  expect(r.status).toBe("pending");
  expect(existsSync(path.join(dir, "m-wait.msg"))).toBe(true);
  expect(d.hasPending()).toBe(true);
  rmSync(path.join(dir, "m-wait.msg"));
  await d.reconcilePending();
  expect(d.status("m-wait")?.status).toBe("delivered");
  expect(d.hasPending()).toBe(false);
});

test("omp without an inbox is refused while live voice is on or unknown", async () => {
  const p = await ompPane(s, "omp", s.transcript("chat-basic.jsonl"));
  s.setLiveVoicePids([p.pid]);
  expect((await d.send(p.id, "m-lv-1", "x")).reason).toBe("live voice is on and this omp has no inbox; turn live voice off or restart omp");
  s.setLiveVoicePids([]);
  s.breakPactl(true);
  expect((await d.send(p.id, "m-lv-2", "x")).reason).toBe("cannot tell if live voice is on; refusing to type into this omp");
  s.breakPactl(false);
  const ok = await d.send(p.id, "m-lv-3", "x");
  expect([ok.status, ok.route]).toEqual(["delivered", "tmux"]);
});

test("herdr: delivered when idle, refused on a question, failed on a forced failure (P1.3 c)", async () => {
  herdrAgent("idle");
  const ok = await d.send(HERDR_ID, "h-1", "hi herdr");
  expect([ok.status, ok.route]).toEqual(["delivered", "herdr"]);
  expect(herdrPrompts()).toEqual([{ target: "w1:p1", text: "hi herdr" }]);
  herdrAgent("blocked");
  const q = await d.send(HERDR_ID, "h-2", "should not go");
  expect([q.status, q.reason]).toEqual(["refused", "the agent is showing a question; answer it with the key row first"]);
  expect(herdrPrompts().length).toBe(1);
  herdrAgent("idle");
  s.failHerdrPrompt(true);
  const f = await d.send(HERDR_ID, "h-3", "forced");
  expect(f.status).toBe("failed");
  expect(f.reason).toBe("herdr could not send: fake failure");
  s.setLiveVoicePids([99999]);
  expect((await d.send(HERDR_ID, "h-4", "x")).reason).toBe("cannot tell if live voice is on for this herdr pane");
});

test("crash recovery: half-typed tmux/herdr records fail, inbox records follow the files", async () => {
  const omp = await ompPane(s, "omp", s.transcript("chat-basic.jsonl"));
  const live = inboxDir(cfg.inboxRoot, omp.pid);
  mkdirSync(live, { recursive: true });
  const dead = await deadPid();
  const deadDir = inboxDir(cfg.inboxRoot, dead);
  mkdirSync(deadDir, { recursive: true });
  const base = { reason: "", text: "t", sessionId: omp.id } as const;
  log.append({ ...base, clientMsgId: "c-tmux", status: "pending", route: "tmux", pid: null, file: null });
  log.append({ ...base, clientMsgId: "c-herdr", status: "pending", route: "herdr", pid: null, file: null });
  // .part only, omp alive: hostd died before the rename -> commit it, stay pending.
  const partLive = stageInbox(live, "c-part-live", "t");
  log.append({ ...base, clientMsgId: "c-part-live", status: "pending", route: "inbox", pid: omp.pid, file: partLive.final });
  // .part only, omp dead -> failed, .part removed.
  const partDead = stageInbox(deadDir, "c-part-dead", "t");
  log.append({ ...base, clientMsgId: "c-part-dead", status: "pending", route: "inbox", pid: dead, file: partDead.final });
  // .msg present, omp dead -> failed, .msg removed.
  const msgDead = stageInbox(deadDir, "c-msg-dead", "t");
  Bun.spawnSync(["mv", msgDead.part, msgDead.final]);
  log.append({ ...base, clientMsgId: "c-msg-dead", status: "pending", route: "inbox", pid: dead, file: msgDead.final });
  // neither file -> delivered.
  log.append({ ...base, clientMsgId: "c-gone", status: "pending", route: "inbox", pid: omp.pid, file: path.join(live, "c-gone.msg") });

  const fresh = new Deliverer(cfg, new Registry(cfg), new SentLog(cfg.stateDir));
  await fresh.reconcilePending();
  const st = (id: string) => [fresh.status(id)?.status, fresh.status(id)?.reason];
  expect(st("c-tmux")).toEqual(["failed", "hostd stopped while typing; check the pane"]);
  expect(st("c-herdr")).toEqual(["failed", "hostd stopped while typing; check the pane"]);
  expect(st("c-part-live")).toEqual(["pending", ""]);
  expect([existsSync(partLive.part), existsSync(partLive.final)]).toEqual([false, true]);
  expect(st("c-part-dead")).toEqual(["failed", "omp exited before reading the message"]);
  expect(existsSync(partDead.part)).toBe(false);
  expect(st("c-msg-dead")).toEqual(["failed", "omp exited before reading the message"]);
  expect(existsSync(msgDead.final)).toBe(false);
  expect(st("c-gone")).toEqual(["delivered", ""]);
  rmSync(partLive.final);
  await fresh.reconcilePending();
  expect(st("c-part-live")).toEqual(["delivered", ""]);
});

test("HTTP: hostd start reconciles, checks bodies, and never returns text", async () => {
  const p = await pane(s, "work", "cat > /dev/null");
  log.append({ clientMsgId: "boot-1", sessionId: p.id, status: "pending", reason: "", route: "tmux", text: "t", pid: null, file: null });
  const h = await startTestHostd(s, [sendFeature]);
  try {
    expect(new SentLog(cfg.stateDir).latest("boot-1")?.status).toBe("failed");
    const url = "/v1/sessions/" + encodeURIComponent(p.id);
    const noOrigin = await fetch(h.url + url + "/send", { method: "POST", headers: localHeaders(h), body: JSON.stringify({ clientMsgId: "h-a", text: "x" }) });
    expect(noOrigin.status).toBe(403);
    expect((await post(h, url + "/send", { clientMsgId: "bad id!", text: "x" })).status).toBe(400);
    expect((await post(h, url + "/send", { clientMsgId: "h-big", text: "x".repeat(600 * 1024) })).status).toBe(400);
    expect(new SentLog(cfg.stateDir).latest("h-big")).toBeUndefined();
    const sent = await post(h, url + "/send", { clientMsgId: "h-ok", text: "over http" });
    expect(sent.status).toBe(200);
    const body = (await sent.json()) as Record<string, unknown>;
    expect(body.status).toBe("delivered");
    expect("text" in body).toBe(false);
    const got = await fetch(h.url + "/v1/sends/h-ok", { headers: localHeaders(h) });
    expect("text" in ((await got.json()) as object)).toBe(false);
    expect((await fetch(h.url + "/v1/sends/nope", { headers: localHeaders(h) })).status).toBe(404);
    expect((await post(h, url + "/keys", { keys: ["Esc"] })).status).toBe(200);
    expect((await post(h, url + "/keys", { steps: ["Esc"] })).status).toBe(400);
    herdrAgent("blocked");
    expect((await post(h, "/v1/sessions/" + encodeURIComponent(HERDR_ID) + "/send", { clientMsgId: "h-q", text: "x" })).status).toBe(409);
    herdrAgent("idle");
    s.failHerdrPrompt(true);
    expect((await post(h, "/v1/sessions/" + encodeURIComponent(HERDR_ID) + "/send", { clientMsgId: "h-f", text: "x" })).status).toBe(502);
  } finally {
    await h.stop();
  }
});

test("empty and oversized messages are refused before anything is typed or staged", async () => {
  const p = await pane(s, "work", "cat > /dev/null");
  const empty = await d.send(p.id, "m-empty", "  \n\t ");
  expect([empty.status, empty.route, empty.reason]).toEqual(["refused", "none", "the message is empty"]);
  const big = await d.send(p.id, "m-big", "x".repeat(512 * 1024 + 1));
  expect([big.status, big.route, big.reason]).toEqual(["refused", "none", "the message is longer than 512 KiB"]);
  expect(big.text).toBe("");
  expect(d.status("m-big")?.status).toBe("refused");
  const edge = await d.send(p.id, "m-edge", "y".repeat(512 * 1024));
  expect(edge.status).toBe("delivered");
});

test("inbox route: the whole inbox folder vanishing is failed, not delivered", async () => {
  const p = await ompPane(s, "omp", s.transcript("chat-basic.jsonl"));
  const dir = inboxDir(cfg.inboxRoot, p.pid);
  mkdirSync(dir, { recursive: true });
  const t = setInterval(() => {
    if (existsSync(path.join(dir, "m-dir-gone.msg"))) rmSync(dir, { recursive: true, force: true });
  }, 10);
  try {
    const r = await d.send(p.id, "m-dir-gone", "omp left with the folder");
    expect([r.status, r.reason, r.route]).toEqual(["failed", "omp exited before reading the message", "inbox"]);
    expect(d.status("m-dir-gone")?.status).toBe("failed");
    expect(d.hasPending()).toBe(false);
  } finally {
    clearInterval(t);
  }
});
