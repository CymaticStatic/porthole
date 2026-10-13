import { afterEach, beforeEach, expect, test } from "bun:test";
import { ptyFeature } from "../src/features/pty";
import { cleanEnv } from "../src/exec";
import { sessionId } from "../src/sessions/ids";
import { listClients, socketPath } from "../src/sessions/tmux";
import { openWs, ompPane, pane, startTestHostd, type TestHostd } from "./helpers/client";
import { Scratch, useTestTimeout, waitFor } from "./helpers/scratch";

useTestTimeout();

let s: Scratch;
let h: TestHostd;
beforeEach(async () => {
  s = new Scratch();
  h = await startTestHostd(s, [ptyFeature]);
});
afterEach(async () => {
  try {
    await h.stop();
  } finally {
    s.cleanup();
  }
});

const enc = new TextEncoder();
const capture = (sock: string, session: string) => s.tmux(sock, "capture-pane", "-p", "-t", "=" + session + ":0.0");

test("attach, type, see the echo", async () => {
  const p = await pane(s, "work", "/bin/sh");
  const ws = await openWs(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/pty?cols=100&rows=30");
  await waitFor(async () => (await listClients(h.config, p.socket)).length === 1);
  ws.send(enc.encode("echo pty-$((40+2))\r"));
  await waitFor(() => ws.output().includes("pty-42"));
  await waitFor(() => capture(p.socket, "work").includes("pty-42"));
  ws.close();
  expect(await ws.closed).toBe(1000);
});

test("resize changes our own client's width", async () => {
  const p = await pane(s, "work", "/bin/sh");
  const ws = await openWs(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/pty?cols=80&rows=24");
  await waitFor(async () => (await listClients(h.config, p.socket)).length === 1);
  const ours = (await listClients(h.config, p.socket))[0];
  ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
  await waitFor(() => s.tmux(p.socket, "display", "-p", "-c", ours.tty, "#{client_width}").trim() === "100");
  ws.close();
});

test("close detaches only our client", async () => {
  const p = await pane(s, "work", "/bin/sh");
  const other = Bun.spawn([h.config.bin.tmux, "-S", socketPath(h.config, p.socket), "attach-session", "-t", "=work"], {
    terminal: { cols: 80, rows: 24, data() {} },
    env: cleanEnv({ TERM: "xterm-256color" }),
  });
  try {
    await waitFor(async () => (await listClients(h.config, p.socket)).some((c) => c.pid === other.pid));
    const ws = await openWs(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/pty");
    await waitFor(async () => (await listClients(h.config, p.socket)).length === 2);
    ws.close();
    await waitFor(async () => {
      const left = await listClients(h.config, p.socket);
      return left.length === 1 && left[0].pid === other.pid;
    });
    // The second client stays attached after our socket is long closed.
    await Bun.sleep(500);
    const left = await listClients(h.config, p.socket);
    expect(left.map((c) => c.pid)).toEqual([other.pid]);
  } finally {
    other.kill();
  }
});

test("live voice at open makes it read-only and typed bytes never reach the pane", async () => {
  const p = await pane(s, "work", "cat");
  s.setLiveVoicePids([p.pid]);
  const ws = await openWs(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/pty");
  expect((await ws.next("readonly")).reason).toBe("live voice is on; typing here would mix with it");
  ws.send(enc.encode("never-typed\r"));
  await Bun.sleep(500);
  expect(capture(p.socket, "work")).not.toContain("never-typed");
  ws.close();
});

test("live voice turning on mid-session drops input from then on", async () => {
  const p = await pane(s, "work", "cat");
  const ws = await openWs(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/pty");
  // tmux discards keys that arrive before its client has set up its terminal, so wait for it to attach.
  await waitFor(async () => (await listClients(h.config, p.socket)).length === 1);
  ws.send(enc.encode("before-voice\r"));
  await waitFor(() => capture(p.socket, "work").includes("before-voice"));
  expect(ws.seen.some((m) => m.type === "readonly")).toBe(false);
  s.setLiveVoicePids([p.pid]);
  await Bun.sleep(h.config.scanIntervalMs + 100);
  ws.send(enc.encode("after-voice\r"));
  expect((await ws.next("readonly")).reason).toBe("live voice is on; typing here would mix with it");
  await Bun.sleep(500);
  expect(capture(p.socket, "work")).not.toContain("after-voice");
  s.setLiveVoicePids([]);
  await Bun.sleep(h.config.scanIntervalMs + 100);
  ws.send(enc.encode("still-dropped\r"));
  await Bun.sleep(500);
  expect(capture(p.socket, "work")).not.toContain("still-dropped");
  ws.close();
});

test("unknown live voice (pactl failing) makes an omp pane read-only", async () => {
  const p = await ompPane(s, "omp", s.transcript("chat-basic.jsonl"));
  s.breakPactl(true);
  const ws = await openWs(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/pty");
  expect((await ws.next("readonly")).reason).toBe("cannot tell if live voice is on, so typing is off");
  ws.close();
});

test("unknown live voice (pactl failing) leaves a plain shell pane writable", async () => {
  const p = await pane(s, "work", "cat");
  s.breakPactl(true);
  const ws = await openWs(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/pty");
  await waitFor(async () => (await listClients(h.config, p.socket)).length === 1);
  ws.send(enc.encode("plain-typed\r"));
  await waitFor(() => capture(p.socket, "work").includes("plain-typed"));
  expect(ws.seen.some((m) => m.type === "readonly")).toBe(false);
  ws.close();
});

test("the first input after an idle gap re-scans live voice instead of trusting the cached tree", async () => {
  // A scan interval far longer than the test: only a forced fresh scan can see live voice come on.
  await h.stop();
  h = await startTestHostd(s, [ptyFeature], { scanIntervalMs: 60_000 });
  const p = await pane(s, "work", "cat");
  const ws = await openWs(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/pty");
  await waitFor(async () => (await listClients(h.config, p.socket)).length === 1);
  ws.send(enc.encode("first-ok\r"));
  await waitFor(() => capture(p.socket, "work").includes("first-ok"));
  s.setLiveVoicePids([p.pid]);
  // Real delay on purpose: the idle gap itself (more than 1 s without input) is what is under test.
  await Bun.sleep(1200);
  ws.send(enc.encode("after-idle\r"));
  expect((await ws.next("readonly")).reason).toBe("live voice is on; typing here would mix with it");
  await Bun.sleep(300);
  expect(capture(p.socket, "work")).not.toContain("after-idle");
  ws.close();
});

test("a resize after the attach process exited does not block teardown", async () => {
  const p = await pane(s, "work", "/bin/sh");
  const ws = await openWs(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/pty");
  await waitFor(async () => (await listClients(h.config, p.socket)).length === 1);
  const ours = (await listClients(h.config, p.socket))[0];
  s.tmux(p.socket, "detach-client", "-t", ours.tty);
  // Resize frames keep arriving while our attach process exits and its terminal closes.
  for (let i = 0; i < 40 && ws.ws.readyState === 1; i++) {
    ws.send(JSON.stringify({ type: "resize", cols: 90 + i, rows: 30 }));
    await Bun.sleep(5);
  }
  expect(await ws.closed).toBe(1000);
  expect(await listClients(h.config, p.socket)).toEqual([]);
});

test("herdr is read-only and streams the screen", async () => {
  s.setHerdrAgents([{ terminal_id: "t1", agent_status: "idle", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", focused: false, revision: 1, name: "rev" }]);
  s.setHerdrScreen("w1:p1", "hello herdr\n");
  const id = sessionId({ kind: "herdr", workspace: "w1", tab: "w1:t1", pane: "w1:p1" });
  const ws = await openWs(h, "/v1/sessions/" + encodeURIComponent(id) + "/pty");
  expect((await ws.next("readonly")).reason).toBe("herdr terminals are read-only in P1");
  expect((await ws.next("screen")).text).toContain("hello herdr");
  ws.close();
});

test("unknown session gets an error and a clean close", async () => {
  const ws = await openWs(h, "/v1/sessions/" + encodeURIComponent("tmux:nope:nope:0.0") + "/pty");
  expect((await ws.next("error")).error).toBe("no such session");
  expect(await ws.closed).toBe(1000);
});
