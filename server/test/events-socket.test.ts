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
    expect(statSync(dir).mode & 0o777).toBe(0o755); // a folder that already existed is not ours to chmod
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

/** Connects, sends `text`, and resolves with whether the server closed the connection within `ms`. */
function closedWithin(file: string, text: string, ms: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const c = net.createConnection(file);
  const timer = setTimeout(() => { c.destroy(); resolve(false); }, ms);
  c.on("error", () => undefined);
  c.on("close", () => { clearTimeout(timer); resolve(true); });
  if (text !== "") c.write(text);
  return promise;
}

test("a connection of short valid lines is cut off at the total-bytes limit; a silent one at the idle timeout", async () => {
  const file = path.join(s.runtimeDir, "ev3", "events.sock");
  const got: OmpEvent[] = [];
  const sock = new EventsSocket(file, (e) => got.push(e), { idleMs: 300 });
  await sock.start();
  try {
    const line = '{"v":1,"pid":7,"at":"x","type":"working"}\n';
    const lines = 4000;
    expect(line.length * lines).toBeGreaterThan(2 * 64 * 1024);
    expect(await closedWithin(file, line.repeat(lines), 3000)).toBe(true);
    expect(got.length * line.length).toBeLessThanOrEqual(64 * 1024);
    expect(got.length).toBeLessThan(lines);
    const before = got.length;
    await sendRaw(file, line);
    await waitFor(() => got.length === before + 1, 3000);

    const t0 = Date.now();
    expect(await closedWithin(file, "", 3000)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2500);
    // A trickle that never finishes a line is idle-cut too, and its half line is never delivered.
    expect(await closedWithin(file, '{"v":1,"pid":9,"at":"x","type":"work', 3000)).toBe(true);
    expect(got.some((e) => e.pid === 9)).toBe(false);
  } finally {
    sock.stop();
  }
});

test("start() chmods only a folder it created", async () => {
  const shared = path.join(s.runtimeDir, "shared-dir");
  mkdirSync(shared, { recursive: true, mode: 0o755 });
  const a = new EventsSocket(path.join(shared, "events.sock"), () => undefined);
  await a.start();
  a.stop();
  expect(statSync(shared).mode & 0o777).toBe(0o755);
  const fresh = path.join(s.runtimeDir, "fresh-dir");
  const b = new EventsSocket(path.join(fresh, "events.sock"), () => undefined);
  await b.start();
  b.stop();
  expect(statSync(fresh).mode & 0o777).toBe(0o700);
});
