import { afterEach, beforeEach, expect, test } from "bun:test";
import { hostname } from "node:os";
import path from "node:path";
import type { HostdConfig } from "../src/config";
import { sessionId } from "../src/sessions/ids";
import { Registry, type SessionInfo, type Tree } from "../src/sessions/registry";
import { statusFromTranscript } from "../src/sessions/status";
import { type HerdrAgentFixture, Scratch, useTestTimeout, waitFor } from "./helpers/scratch";

useTestTimeout();

let s: Scratch;
let cfg: HostdConfig;
beforeEach(() => {
  s = new Scratch();
  cfg = s.config();
});
afterEach(() => s.cleanup());

const bySession = (t: Tree, session: string): SessionInfo => {
  const found = t.sessions.find((x) => x.where.kind === "tmux" && x.where.session === session);
  if (!found) throw new Error("no session " + session + " in " + JSON.stringify(t.sessions.map((x) => x.id)));
  return found;
};
const addSession = (sock: string, session: string, command: string, cwd = s.root) =>
  s.tmux(sock, "new-session", "-d", "-s", session, "-x", "120", "-y", "40", "-c", cwd, command);
const herdrAgent = (status: HerdrAgentFixture["agent_status"], extra: Record<string, string> = {}) =>
  s.setHerdrAgents([{ terminal_id: "t1", agent_status: status, workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", focused: false, revision: 1, ...extra }]);

test("finds a scratch tmux omp session with its transcript and status", async () => {
  const file = s.transcript("chat-basic.jsonl");
  const sock = s.newTmuxServer("work", s.ompCommand(file));
  let t: Tree = await new Registry(cfg).scan();
  await waitFor(async () => {
    t = await new Registry(cfg).scan();
    return t.sessions[0]?.omp !== null && t.sessions[0]?.omp !== undefined;
  });
  expect(t.sessions.length).toBe(1);
  const one = t.sessions[0];
  expect(one.id).toBe(sessionId({ kind: "tmux", socket: sock, session: "work", window: 0, pane: 0 }));
  expect(one.kind).toBe("tmux");
  expect(one.omp?.pid).toBeGreaterThan(0);
  expect(one.omp?.transcript?.endsWith("chat-basic.jsonl")).toBe(true);
  expect(one.omp?.inbox).toBe(false);
  expect(one.status).toBe(statusFromTranscript(file).status);
  expect(one.liveVoice).toBe(false);
  expect(one.herdrStatus).toBeNull();
});

test("live voice shows on the matching session only; unknown when pactl fails", async () => {
  const sock = s.newTmuxServer("work", s.ompCommand(s.transcript("chat-basic.jsonl")));
  addSession(sock, "other", "/bin/sh");
  const r = new Registry(cfg);
  let pid = 0;
  await waitFor(async () => {
    pid = bySession(await r.scan(), "work").omp?.pid ?? 0;
    return pid > 0;
  });
  s.setLiveVoicePids([pid]);
  const t = await r.scan();
  expect([bySession(t, "work").liveVoice, bySession(t, "other").liveVoice]).toEqual([true, false]);
  s.breakPactl(true);
  const broken = await r.scan();
  expect([bySession(broken, "work").liveVoice, bySession(broken, "other").liveVoice]).toEqual([null, null]);
  expect(broken.sources.liveVoice.ok).toBe(false);
});

test("herdr agents become sessions; their liveVoice is null while an unplaced live-voice pid exists", async () => {
  herdrAgent("idle", { name: "rev", cwd: "/work" });
  const r = new Registry(cfg);
  const t = await r.scan();
  const h = t.sessions.find((x) => x.kind === "herdr");
  expect(h && [h.id, h.status, h.herdrStatus, h.name, h.liveVoice]).toEqual([sessionId({ kind: "herdr", workspace: "w1", tab: "w1:t1", pane: "w1:p1" }), "idle", "idle", "rev", false]);
  herdrAgent("blocked", { name: "rev" });
  const blocked = (await r.scan()).sessions.find((x) => x.kind === "herdr");
  expect([blocked?.status, blocked?.herdrStatus]).toEqual(["needs-you", "blocked"]);
  s.setLiveVoicePids([99999]);
  expect((await r.scan()).sessions.find((x) => x.kind === "herdr")?.liveVoice).toBeNull();
  expect(t.sources.herdr.ok).toBe(true);
});

test("names: spinner stripped, hostname falls back to the folder", async () => {
  const sock = s.newTmuxServer("work", "/bin/sh");
  const r = new Registry(cfg);
  s.tmux(sock, "select-pane", "-t", "=work:0.0", "-T", "\u280b fixing auth ");
  expect(bySession(await r.scan(), "work").name).toBe("fixing auth");
  s.tmux(sock, "select-pane", "-t", "=work:0.0", "-T", hostname());
  expect(bySession(await r.scan(), "work").name).toBe(path.basename(s.root));
});

test("Thalamus is pinned first, then needs-you, then by name", async () => {
  const sock = s.newTmuxServer("aaa", "/bin/sh");
  addSession(sock, "zzz", "/bin/sh", s.thalamusDir);
  addSession(sock, "ask", s.ompCommand(s.transcript("status-needs-you.jsonl")));
  const r = new Registry(cfg);
  let t: Tree = await r.scan();
  await waitFor(async () => {
    t = await r.scan();
    return bySession(t, "ask").status === "needs-you";
  });
  expect(t.sessions[0].pinned).toBe(true);
  expect((t.sessions[0].where as { session: string }).session).toBe("zzz");
  expect((t.sessions[1].where as { session: string }).session).toBe("ask");
  expect(bySession(t, "aaa").pinned).toBe(false);
});

test("a dead tmux socket is reported, not thrown", async () => {
  s.newTmuxServer("alive", "/bin/sh");
  // A killed tmux server leaves its socket file behind (plan Verified facts 7): that is a dead socket.
  const dead = s.newTmuxServer("gone", "/bin/sh");
  s.tmux(dead, "kill-server");
  const t = await new Registry(cfg).scan();
  expect(t.sources.tmux.find((x) => x.socket === dead)?.ok).toBe(false);
  expect(t.sessions.map((x) => (x.where as { session: string }).session)).toEqual(["alive"]);
});

test("an idle registry does not scan; watching scans; stopping stops", async () => {
  const r = new Registry(cfg);
  await Bun.sleep(cfg.scanIntervalMs * 3);
  expect(s.fakeCalls("herdr").length).toBe(0);
  r.startWatching();
  await waitFor(() => s.fakeCalls("herdr").length > 0);
  r.stopWatching();
  await Bun.sleep(cfg.scanIntervalMs);
  const n = s.fakeCalls("herdr").length;
  await Bun.sleep(cfg.scanIntervalMs * 3);
  expect(s.fakeCalls("herdr").length).toBe(n);
});

test("P1.1 acceptance: two sockets, three omp statuses, a herdr pane, one live-voice pid", async () => {
  const sockA = s.newTmuxServer("needs", s.ompCommand(s.transcript("status-needs-you.jsonl")));
  addSession(sockA, "working", s.ompCommand(s.transcript("status-working.jsonl")));
  const sockB = s.newTmuxServer("done", s.ompCommand(s.transcript("status-done.jsonl")));
  herdrAgent("working", { name: "herdr-agent" });
  const r = new Registry(cfg);
  let t: Tree = await r.scan();
  await waitFor(async () => {
    t = await r.scan();
    return ["needs", "working", "done"].every((n) => t.sessions.some((x) => x.where.kind === "tmux" && x.where.session === n && x.omp));
  });
  s.setLiveVoicePids([bySession(t, "working").omp?.pid ?? -1]);
  t = await r.scan();
  const view = Object.fromEntries(t.sessions.map((x) => [x.id, [x.status, x.liveVoice]]));
  expect(view).toEqual({
    [sessionId({ kind: "tmux", socket: sockA, session: "needs", window: 0, pane: 0 })]: ["needs-you", false],
    [sessionId({ kind: "tmux", socket: sockA, session: "working", window: 0, pane: 0 })]: ["working", true],
    [sessionId({ kind: "tmux", socket: sockB, session: "done", window: 0, pane: 0 })]: ["done", false],
    [sessionId({ kind: "herdr", workspace: "w1", tab: "w1:t1", pane: "w1:p1" })]: ["working", false],
  });
  expect(t.sources.tmux.map((x) => x.ok)).toEqual([true, true]);
  expect([t.sources.herdr.ok, t.sources.liveVoice.ok]).toEqual([true, true]);
  expect(t.sessions[0].status).toBe("needs-you");
});
