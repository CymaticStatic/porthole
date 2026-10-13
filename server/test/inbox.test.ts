import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { inboxDir } from "../src/deliver/inbox";
import { answerSteps, chunks, multiAnswerGroups, parseAnswer } from "../src/events/answer";
import { InboxStore } from "../src/events/inbox";
import { endDeadSessions, inboxFeature } from "../src/features/inbox";
import { sendFeature } from "../src/features/send";
import { sessionsFeature } from "../src/features/sessions";
import { get, openWs, pane, post, startTestHostd } from "./helpers/client";
import type { TestHostd } from "./helpers/client";
import { Scratch, waitFor } from "./helpers/scratch";
import type { HerdrAgentFixture } from "./helpers/scratch";

let s: Scratch;
let h: TestHostd;
let FAIL_SEND = "";
const HERDR_FIXTURE: HerdrAgentFixture = { terminal_id: "t1", agent_status: "idle", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", focused: false, revision: 1, name: "rev" };
beforeAll(async () => {
  s = new Scratch();
  // a tmux wrapper that fails every send-keys while FAIL_SEND exists and runs the real tmux otherwise (listing and capture are unaffected)
  FAIL_SEND = path.join(s.root, "fail-send-keys");
  const flaky = s.writeFake("tmux-flaky", "#!/bin/sh\nif [ -e '" + FAIL_SEND + "' ]; then for a in \"$@\"; do [ \"$a\" = send-keys ] && exit 1; done; fi\nexec /usr/bin/tmux \"$@\"\n");
  h = await startTestHostd(s, [sessionsFeature, sendFeature, inboxFeature], { bin: { tmux: flaky } });
});
afterAll(async () => { await h.stop(); s.cleanup(); });

function emit(e: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(path.join(h.config.runtimeDir, "events.sock"), () => {
      c.end(JSON.stringify({ v: 1, at: new Date().toISOString(), ...e }) + "\n", () => resolve());
    });
    c.on("error", reject);
  });
}
type Item = { id: string; sessionId: string; column: string; question: { qid: string; options: string[]; open: boolean } | null };
async function items(): Promise<Item[]> { return ((await (await get(h, "/v1/inbox")).json()) as { items: Item[] }).items; }
async function itemFor(qid: string): Promise<Item> {
  let found: Item | undefined;
  await waitFor(async () => { found = (await items()).find((i) => i.question?.qid === qid); return found !== undefined; });
  return found as Item;
}
/** A scratch pane whose fake omp echoes every key it receives (Task 1), plus that omp's pid as the registry sees it. */
async function echoPane(name: string): Promise<{ socket: string; id: string; pid: number }> {
  const p = await pane(s, name, s.ompEchoCommand(s.transcript("chat-basic.jsonl")));
  let pid = 0;
  await waitFor(async () => {
    const tree = (await (await get(h, "/v1/sessions")).json()) as { sessions: { id: string; omp: { pid: number } | null }[] };
    pid = tree.sessions.find((x) => x.id === p.id)?.omp?.pid ?? 0;
    return pid > 0;
  });
  return { socket: p.socket, id: p.id, pid };
}
function screen(p: { socket: string }, name: string): string {
  return s.tmux(p.socket, "capture-pane", "-p", "-J", "-t", "=" + name + ":0.0");
}
const UP = "^[[A", DOWN = "^[[B";
const ask = (pid: number, qid: string, extra: Record<string, unknown> = {}) =>
  emit({ pid, type: "question_open", qid, questions: [{ id: "c", question: "Which color?", options: ["red", "green", "blue"], multi: false, ...extra }] });

test("key steps: to the top, down to the row, Enter; typed text goes through the Other row", () => {
  expect(answerSteps(3, { optionIndexes: [1] })).toEqual([...Array(5).fill({ key: "Up" }), { key: "Down" }, { key: "Enter" }]);
  expect(answerSteps(2, { text: "teal" })).toEqual([...Array(4).fill({ key: "Up" }), { key: "Down" }, { key: "Down" }, { key: "Enter" }, { text: "teal" }, { key: "Enter" }]);
  expect(chunks(answerSteps(20, { optionIndexes: [19] })).map((c) => c.length)).toEqual([32, 10]);
  expect(parseAnswer({ optionIndexes: [2, 0] })).toEqual({ optionIndexes: [2, 0] });
  for (const bad of [{}, { optionIndexes: [] }, { optionIndexes: [1, 1] }, { optionIndexes: [-1] }, { optionIndexes: [1.5] }, { optionIndexes: ["1"] }, { optionIndexes: Array.from({ length: 21 }, (_, i) => i) }, { optionIndexes: [0], text: "x" }]) {
    expect(parseAnswer(bad)).toHaveProperty("error");
  }
});

test("multi-select key groups: one tick per group (up to the top, down to the row, Space), then Enter", () => {
  const up3 = Array(5).fill({ key: "Up" });
  expect(multiAnswerGroups(3, [2, 0])).toEqual([
    [...up3, { key: "Space" }],
    [...up3, { key: "Down" }, { key: "Down" }, { key: "Space" }],
    [{ key: "Enter" }],
  ]);
  expect(multiAnswerGroups(3, [1])).toEqual([[...up3, { key: "Down" }, { key: "Space" }], [{ key: "Enter" }]]);
});

test("P2.1/P2.3: an open question becomes a needs-you item with exactly one notify; option 2 presses the right keys; closed is read-only", async () => {
  const p = await echoPane("ask");
  const ws = await openWs(h, "/v1/events?device=bencell");
  await emit({ pid: p.pid, type: "session_start", cwd: s.root, sessionFile: null, tmux: null, pane: null });
  await ask(p.pid, "q1");
  const item = await itemFor("q1");
  expect(item).toMatchObject({ sessionId: p.id, column: "needs-you", question: { options: ["red", "green", "blue"], open: true } });
  const n = await ws.next("notify", 3000);
  expect(n).toMatchObject({ itemId: item.id, options: [{ index: 0, label: "red" }, { index: 1, label: "green" }] });
  await Bun.sleep(300);
  expect(ws.seen.filter((m) => m.type === "notify")).toHaveLength(1);

  const r = await post(h, "/v1/inbox/" + item.id + "/answer", { optionIndexes: [1] });
  expect(r.status).toBe(200);
  await waitFor(() => screen(p, "ask").includes(UP.repeat(5) + DOWN), 3000);
  const again = await post(h, "/v1/inbox/" + item.id + "/answer", { optionIndexes: [0] });
  expect([again.status, (await again.json()).reason]).toEqual([409, "Answer this in the terminal"]);

  await emit({ pid: p.pid, type: "question_closed", qid: "q1", outcome: "answered" });
  await waitFor(async () => (await items()).find((i) => i.id === item.id)?.question?.open === false);
  expect((await post(h, "/v1/inbox/" + item.id + "/answer", { optionIndexes: [0] })).status).toBe(409);
  ws.close();
});

test("typed answer goes through the Other row; multi-select, unknown omp and bad index are refused", async () => {
  const p = await echoPane("typed");
  await ask(p.pid, "q2");
  const item = await itemFor("q2");
  expect((await post(h, "/v1/inbox/" + item.id + "/answer", { optionIndexes: [7] })).status).toBe(409);
  expect((await post(h, "/v1/inbox/" + item.id + "/answer", { text: "teal" })).status).toBe(200);
  await waitFor(() => screen(p, "typed").includes(UP.repeat(5) + DOWN.repeat(3)) && screen(p, "typed").includes("teal"), 3000);

  await ask(p.pid, "q3", { multi: true });
  const multi = await itemFor("q3");
  expect((await (await post(h, "/v1/inbox/" + multi.id + "/answer", { text: "teal" })).json()).reason).toBe("Answer this in the terminal");
  expect((await (await post(h, "/v1/inbox/" + multi.id + "/answer", { optionIndexes: [0, 3] })).json()).reason).toBe("no such option");

  await ask(p.pid, "q3b");
  const plain = await itemFor("q3b");
  const pick = await post(h, "/v1/inbox/" + plain.id + "/answer", { optionIndexes: [0, 1] });
  expect([pick.status, (await pick.json()).reason]).toEqual([409, "pick one option"]);
  expect((await post(h, "/v1/inbox/" + plain.id + "/answer", { optionIndexes: [1] })).status).toBe(200);

  await ask(4_000_000, "q4");
  const stranger = await itemFor("q4");
  expect(stranger.sessionId).toBe("omp:4000000");
  expect((await (await post(h, "/v1/inbox/" + stranger.id + "/answer", { optionIndexes: [0] })).json()).reason).toBe("Answer this in the terminal");
});

test("multi-select answer: ticks in row order, then Enter; the claim is used up; several questions stay read-only", async () => {
  const p = await echoPane("multi");
  await ask(p.pid, "qm", { multi: true });
  const item = await itemFor("qm");
  const r = await post(h, "/v1/inbox/" + item.id + "/answer", { optionIndexes: [2, 0] });
  expect([r.status, (await r.json()).status]).toEqual([200, "sent"]);
  // cat -v echoes each key: tick row 0 (Up x5, Space), tick row 2 (Up x5, Down x2, Space), then Enter flushes the line.
  await waitFor(() => screen(p, "multi").includes(UP.repeat(5) + " " + UP.repeat(5) + DOWN.repeat(2) + " "), 5000);
  const again = await post(h, "/v1/inbox/" + item.id + "/answer", { optionIndexes: [1] });
  expect([again.status, (await again.json()).reason]).toEqual([409, "Answer this in the terminal"]);

  await emit({ pid: p.pid, type: "question_open", qid: "qm2", questions: [
    { id: "a", question: "A?", options: ["x", "y"], multi: true },
    { id: "b", question: "B?", options: ["x", "y"], multi: true },
  ] });
  const several = await itemFor("qm2");
  const refused = await post(h, "/v1/inbox/" + several.id + "/answer", { optionIndexes: [0, 1] });
  expect([refused.status, (await refused.json()).reason]).toEqual([409, "Answer this in the terminal"]);
});

test("P2.10: live voice refuses option answers, typed answers and Stop with a plain reason", async () => {
  const p = await echoPane("voice");
  await ask(p.pid, "q5");
  const item = await itemFor("q5");
  s.setLiveVoicePids([p.pid]);
  try {
    const opt = await post(h, "/v1/inbox/" + item.id + "/answer", { optionIndexes: [0] });
    expect([opt.status, (await opt.json()).reason]).toEqual([409, "live voice is on; keys would mix with it"]);
    const typed = await post(h, "/v1/inbox/" + item.id + "/answer", { text: "teal" });
    expect([typed.status, (await typed.json()).reason]).toEqual([409, "Answer at the desk"]);
    const stop = await post(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/keys", { keys: ["Esc"] });
    expect([stop.status, (await stop.json()).reason]).toEqual([409, "live voice is on; keys would mix with it"]);
    expect(screen(p, "voice")).not.toContain(UP);
    // The refused option answer must not have used the question up: with voice off it goes through (200).
    s.setLiveVoicePids([]);
    const after = await post(h, "/v1/inbox/" + item.id + "/answer", { optionIndexes: [0] });
    expect(after.status).toBe(200);
  } finally {
    s.setLiveVoicePids([]);
  }
});

test("a failed key send leaves the question read-only (keys may already be in the dialog)", async () => {
  const p = await echoPane("flaky");
  await ask(p.pid, "q7");
  const item = await itemFor("q7");
  writeFileSync(FAIL_SEND, "");
  try {
    const r = await post(h, "/v1/inbox/" + item.id + "/answer", { optionIndexes: [0] });
    expect([r.status, (await r.json()).status]).toEqual([502, "failed"]);
  } finally {
    rmSync(FAIL_SEND, { force: true });
  }
  // tmux works again, but the dialog state is unknown, so the retry is refused and no key is sent
  const again = await post(h, "/v1/inbox/" + item.id + "/answer", { optionIndexes: [0] });
  expect([again.status, (await again.json()).reason]).toEqual([409, "Answer this in the terminal"]);
  await Bun.sleep(200);
  expect(screen(p, "flaky")).not.toContain(UP);
});

test("P2.10: omp with a live inbox is reachable under live voice: the message goes through the inbox, not the keys", async () => {
  const p = await echoPane("voiceinbox");
  mkdirSync(inboxDir(h.config.inboxRoot, p.pid), { recursive: true });
  await waitFor(async () => {
    const tree = (await (await get(h, "/v1/sessions")).json()) as { sessions: { id: string; omp: { inbox: boolean } | null }[] };
    return tree.sessions.find((x) => x.id === p.id)?.omp?.inbox === true;
  }, 5000);
  // Stand in for omp's live-inbox extension: take (delete) every *.msg the moment it appears.
  const dir = inboxDir(h.config.inboxRoot, p.pid);
  const seen: string[] = [];
  const watcher = setInterval(() => {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".msg")) continue;
      seen.push(f);
      rmSync(path.join(dir, f), { force: true });
    }
  }, 20);
  s.setLiveVoicePids([p.pid]);
  try {
    const r = await post(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/send", { clientMsgId: "p2-10-inbox", text: "typed while voice is live" });
    const body = (await r.json()) as { status: string; route: string };
    expect([r.status, body.status, body.route]).toEqual([200, "delivered", "inbox"]);
    await Bun.sleep(100);
    expect(seen).toEqual(["p2-10-inbox.msg"]);
    expect(screen(p, "voiceinbox")).not.toContain("typed while voice is live");
  } finally {
    clearInterval(watcher);
    s.setLiveVoicePids([]);
  }
});

test("P2.3: unacked notify is replayed on reconnect; acked is not", async () => {
  const p = await echoPane("replay");
  const first = await openWs(h, "/v1/events?device=watch");
  await ask(p.pid, "q6");
  const n = await first.next("notify", 3000);
  first.close();
  const second = await openWs(h, "/v1/events?device=watch");
  const replayed = await second.next("notify", 3000);
  expect(replayed.id).toBe(n.id);
  second.send(JSON.stringify({ type: "ack", id: n.id }));
  await Bun.sleep(200);
  second.close();
  const third = await openWs(h, "/v1/events?device=watch");
  await Bun.sleep(500);
  expect(third.seen.filter((m) => m.type === "notify" && m.id === n.id)).toEqual([]);
  third.close();
});

test("a blocked herdr agent becomes a needs-you item", async () => {
  // Copy the fixture shape P1's registry test passes to setHerdrAgents; only the status matters here.
  s.setHerdrAgents([{ ...HERDR_FIXTURE, agent_status: "blocked" }]);
  await waitFor(async () => (await items()).some((i) => i.sessionId.startsWith("herdr:") && i.column === "needs-you"), 5000);
  s.setHerdrAgents([]);
});

test("an archived item is read-only even while its question is still open", async () => {
  const p = await echoPane("archived");
  await ask(p.pid, "q8");
  const item = await itemFor("q8");
  expect((await post(h, "/v1/inbox/" + item.id + "/archive", {})).status).toBe(200);
  const r = await post(h, "/v1/inbox/" + item.id + "/answer", { optionIndexes: [0] });
  expect([r.status, (await r.json()).reason]).toEqual([409, "Answer this in the terminal"]);
  await Bun.sleep(200);
  expect(screen(p, "archived")).not.toContain(UP);
  expect((await post(h, "/v1/inbox/nope/answer", { optionIndexes: [0] })).status).toBe(404);
  expect((await post(h, "/v1/inbox/" + item.id + "/answer", { optionIndexes: [0, 0] })).status).toBe(400);
});

test("Stop sends Esc through the keys route when live voice is off", async () => {
  const p = await echoPane("stop");
  const r = await post(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/keys", { keys: ["Esc"] });
  expect(r.status).toBe(200);
  await waitFor(() => screen(p, "stop").includes("^["), 3000);
});

test("endDeadSessions ends live omp items whose pid is gone, once, and leaves running and done ones alone", () => {
  const store = new InboxStore({ file: path.join(s.stateDir, "inbox-dead.json"), machine: "m" });
  const at = new Date().toISOString();
  store.omp({ type: "working", pid: 2147480011, at }, "omp:2147480011");
  store.omp({ type: "question_open", pid: 2147480012, at, qid: "dq", questions: [{ id: "c", question: "Q?", options: ["a", "b"], multi: false }] }, "omp:2147480012");
  store.omp({ type: "working", pid: process.pid, at }, "omp:" + process.pid);
  store.omp({ type: "turn_finished", pid: 2147480013, at }, "omp:2147480013");
  const alive = new Set([process.pid]);
  const ended = endDeadSessions(store, (pid) => alive.has(pid));
  expect(ended.map((c) => c.item.key).sort()).toEqual(["omp:2147480011", "omp:2147480012"]);
  const byKey = Object.fromEntries(store.list().map((i) => [i.key, i]));
  expect(byKey["omp:2147480011"]).toMatchObject({ column: "done", body: "Session ended" });
  expect(byKey["omp:2147480012"]).toMatchObject({ column: "done", question: { open: false, outcome: "ended" } });
  expect(byKey["omp:" + process.pid]?.column).toBe("working");
  expect(byKey["omp:2147480013"]?.body).toBe("Turn finished");
  expect(endDeadSessions(store, (pid) => alive.has(pid))).toEqual([]);
});

test("hostd ends an item whose omp pid is gone within a few ticks", async () => {
  await emit({ pid: 2147480021, type: "working" });
  await waitFor(async () => (await items()).some((i) => i.sessionId === "omp:2147480021"), 3000);
  await waitFor(async () => (await items()).find((i) => i.sessionId === "omp:2147480021")?.column === "done", 9000);
});
