import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { EventsSocket, parseEvent } from "../src/events/socket";
import type { OmpEvent } from "../src/events/socket";
import { Scratch, waitFor } from "./helpers/scratch";

let s: Scratch;
beforeAll(() => { s = new Scratch(); });
afterAll(() => s.cleanup());

function sendRaw(file: string, text: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const c = net.createConnection(file);
  c.on("error", () => resolve());
  c.on("close", () => resolve());
  c.end(text);
  return promise;
}

test("parseEvent accepts the extension's events and rejects junk", () => {
  expect(parseEvent('{"v":1,"pid":5,"at":"x","type":"working"}')).toEqual({ type: "working", pid: 5, at: "x" });
  expect(parseEvent('{"v":1,"pid":5,"at":"x","type":"question_open","qid":"q","questions":[{"id":"a","question":"Q?","options":["x","y"],"multi":false}]}')?.type).toBe("question_open");
  for (const bad of ["", "nope", "[]", '{"v":2,"pid":5,"type":"working"}', '{"v":1,"pid":-1,"type":"working"}', '{"v":1,"pid":5,"type":"rm -rf"}', '{"v":1,"pid":5,"type":"question_open","qid":"q","questions":"x"}']) {
    expect(parseEvent(bad)).toBeNull();
  }
});

test("parseEvent fills missing optional strings with null and bounds text", () => {
  expect(parseEvent('{"v":1,"pid":5,"at":"x","type":"session_start","cwd":"/w","sessionFile":null}')).toEqual({ type: "session_start", pid: 5, at: "x", cwd: "/w", sessionFile: null, tmux: null, pane: null });
  const long = parseEvent(JSON.stringify({ v: 1, pid: 5, at: "x", type: "question_open", qid: "q", questions: [{ id: "a", question: "x".repeat(5000), options: Array(40).fill("o".repeat(500)), multi: true }] }));
  expect(long?.type === "question_open" && long.questions[0].question.length).toBe(2000);
  expect(long?.type === "question_open" && long.questions[0].options.length).toBe(20);
  expect(long?.type === "question_open" && long.questions[0].options[0].length).toBe(200);
  expect(parseEvent('{"v":1,"pid":5,"at":"x","type":"question_closed","qid":"q","outcome":"maybe"}')).toBeNull();
  expect(parseEvent('{"v":1,"pid":5,"at":"x","type":"question_closed","qid":"q","outcome":"cancelled"}')).toEqual({ type: "question_closed", pid: 5, at: "x", qid: "q", outcome: "cancelled" });
});

test("owner-only socket, events delivered, oversized connection dropped, stale file replaced, removed on stop", async () => {
  const dir = path.join(s.runtimeDir, "ev");
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const file = path.join(dir, "events.sock");
  writeFileSync(file, "stale");
  const got: OmpEvent[] = [];
  const sock = new EventsSocket(file, (e) => got.push(e));
  await sock.start();
  try {
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await sendRaw(file, '{"v":1,"pid":7,"at":"x","type":"working"}\n{"v":1,"pid":7,"at":"x","type":"turn_finished"}\n');
    await sendRaw(file, "garbage\n");
    await sendRaw(file, "x".repeat(70_000));
    await waitFor(() => got.length === 2, 3000);
    expect(got.map((e) => e.type)).toEqual(["working", "turn_finished"]);
    const again = new EventsSocket(file, () => undefined);
    await expect(again.start()).rejects.toThrow("another hostd");
  } finally {
    sock.stop();
  }
  expect(existsSync(file)).toBe(false);
});

test("a throwing handler does not stop later events", async () => {
  const file = path.join(s.runtimeDir, "ev2", "events.sock");
  let calls = 0;
  const sock = new EventsSocket(file, () => { calls += 1; if (calls === 1) throw new Error("boom"); });
  await sock.start();
  try {
    await sendRaw(file, '{"v":1,"pid":8,"at":"x","type":"working"}\n{"v":1,"pid":8,"at":"x","type":"turn_finished"}\n');
    await waitFor(() => calls === 2, 3000);
  } finally {
    sock.stop();
  }
});
