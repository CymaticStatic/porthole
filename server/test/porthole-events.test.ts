import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import portholeEvents from "../../omp-extension/porthole-events";
import { Scratch, waitFor } from "./helpers/scratch";

type Handler = (event: unknown, ctx: unknown) => unknown;
let s: Scratch;
let sock: string;
let server: net.Server;
const lines: Record<string, unknown>[] = [];

beforeAll(async () => {
  s = new Scratch();
  sock = path.join(s.root, "ev.sock");
  process.env.PORTHOLE_EVENTS_SOCKET = sock;
  server = net.createServer((c) => {
    let buf = "";
    c.on("data", (d) => { buf += d.toString("utf8"); });
    c.on("end", () => { for (const l of buf.split("\n").filter(Boolean)) lines.push(JSON.parse(l)); });
  });
  await new Promise<void>((r) => server.listen(sock, () => r()));
});
afterAll(() => { server.close(); s.cleanup(); });

function load(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  portholeEvents({ on: (name: string, fn: (event: unknown, ctx: never) => unknown) => { handlers.set(name, fn as Handler); } });
  return handlers;
}
const ui = { hasUI: true, cwd: "/work/repo", sessionManager: { getSessionFile: () => "/t/s.jsonl" } };

test("reports session start, question open/closed, working, turn finished, session end", async () => {
  lines.length = 0;
  const h = load();
  h.get("session_start")?.({}, ui);
  h.get("agent_start")?.({}, ui);
  h.get("tool_execution_start")?.({ toolCallId: "call-1", toolName: "ask", args: { questions: [{ id: "color", question: "Which color?", options: [{ label: "red" }, { label: "green" }, { label: "blue" }] }] } }, ui);
  h.get("tool_execution_start")?.({ toolCallId: "call-2", toolName: "bash", args: { command: "ls" } }, ui);
  h.get("tool_execution_end")?.({ toolCallId: "call-1", toolName: "ask", result: {}, isError: false }, ui);
  h.get("agent_end")?.({}, ui);
  h.get("session_shutdown")?.({}, ui);
  await waitFor(() => lines.length === 6, 3000);
  const byType = (t: string) => lines.find((l) => l.type === t) as Record<string, unknown>;
  expect(lines.map((l) => l.type).sort()).toEqual(["question_closed", "question_open", "session_end", "session_start", "turn_finished", "working"]);
  expect(byType("session_start")).toMatchObject({ v: 1, pid: process.pid, cwd: "/work/repo", sessionFile: "/t/s.jsonl" });
  expect(byType("question_open")).toMatchObject({ qid: "call-1", questions: [{ id: "color", question: "Which color?", options: ["red", "green", "blue"], multi: false }] });
  expect(byType("question_closed")).toMatchObject({ qid: "call-1", outcome: "answered" });
});

test("a session without a UI (a subagent) sends nothing", async () => {
  lines.length = 0;
  const h = load();
  h.get("session_start")?.({}, { hasUI: false, cwd: "/x" });
  h.get("agent_end")?.({}, { hasUI: false });
  await Bun.sleep(300);
  expect(lines).toEqual([]);
});

test("never blocks or throws when hostd is down or stuck", async () => {
  const h = load();
  process.env.PORTHOLE_EVENTS_SOCKET = path.join(s.root, "missing.sock");
  h.get("session_start")?.({}, ui); // makes the extension active, so every call below really tries to connect
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) h.get("agent_end")?.({}, ui);
  expect(performance.now() - t0).toBeLessThan(50);
  const stuckPath = path.join(s.root, "stuck.sock");
  const stuck = net.createServer(() => { /* accepts, never reads */ });
  await new Promise<void>((r) => stuck.listen(stuckPath, () => r()));
  process.env.PORTHOLE_EVENTS_SOCKET = stuckPath;
  const t1 = performance.now();
  h.get("agent_end")?.({}, ui);
  expect(performance.now() - t1).toBeLessThan(20);
  await Bun.sleep(700); // past the 500 ms socket timeout: the connection is gone, no error escaped
  stuck.close();
  process.env.PORTHOLE_EVENTS_SOCKET = sock;
});

test("source rules: no template literals, only node:net and node:path imports", () => {
  const src = readFileSync(path.join(import.meta.dir, "..", "..", "omp-extension", "porthole-events.ts"), "utf8");
  expect(src.includes(String.fromCharCode(96))).toBe(false);
  const imports = src.split("\n").filter((l) => l.startsWith("import "));
  expect(imports.every((l) => /from "node:(net|path)";$/.test(l))).toBe(true);
  expect(/setTimeout\(|setInterval\(/.test(src.replace(/\.setTimeout\(/g, ""))).toBe(false);
});
