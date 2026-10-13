import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ANY_ARCHIVE_MS, ARCHIVE_KEEP_MS, DONE_ARCHIVE_MS, InboxStore } from "../src/events/inbox";
import type { OmpEvent } from "../src/events/socket";
import { Scratch } from "./helpers/scratch";

let s: Scratch;
beforeAll(() => { s = new Scratch(); });
afterAll(() => s.cleanup());

let clock = 1_000_000;
let n = 0;
function store(): InboxStore {
  n += 1;
  return new InboxStore({ file: path.join(s.stateDir, "inbox-" + n + ".json"), machine: "bendesk-omarchy", now: () => clock });
}
const at = "2026-10-13T00:00:00Z";
const ask = (pid: number, qid: string): OmpEvent => ({ type: "question_open", pid, at, qid, questions: [{ id: "c", question: "Which color?", options: ["red", "green", "blue"], multi: false }] });

test("a question makes one needs-you item; closing it moves it to working", () => {
  const st = store();
  st.omp({ type: "session_start", pid: 10, at, cwd: "/work/porthole", sessionFile: null, tmux: null, pane: null }, "tmux:a:s:0.0");
  const c = st.omp(ask(10, "q1"), "tmux:a:s:0.0");
  expect(c?.becameNeedsYou).toBe(true);
  expect(c?.item).toMatchObject({ column: "needs-you", title: "porthole", project: "/work/porthole", sessionId: "tmux:a:s:0.0", question: { qid: "q1", options: ["red", "green", "blue"], open: true, count: 1 } });
  expect(st.omp(ask(10, "q2"), "tmux:a:s:0.0")?.item.id).toBe(c?.item.id);
  st.omp({ type: "question_closed", pid: 10, at, qid: "q2", outcome: "answered" }, "tmux:a:s:0.0");
  expect(st.list()).toHaveLength(1);
  expect(st.list()[0]).toMatchObject({ column: "working", question: { open: false, outcome: "answered" } });
});

test("P2.2: a done item is archived after 10 min, any item after 6 h, archive kept 7 days", () => {
  const st = store();
  st.omp({ type: "turn_finished", pid: 20, at }, "omp:20");
  st.omp({ type: "working", pid: 21, at }, "omp:21");
  st.omp(ask(22, "q"), "omp:22");
  clock += DONE_ARCHIVE_MS - 1;
  expect(st.list().map((i) => i.key).sort()).toEqual(["omp:20", "omp:21", "omp:22"]);
  clock += 1;
  expect(st.list().map((i) => i.key).sort()).toEqual(["omp:21", "omp:22"]);
  expect(st.archived().map((i) => i.key)).toEqual(["omp:20"]);
  clock += ANY_ARCHIVE_MS - DONE_ARCHIVE_MS;
  expect(st.list()).toEqual([]);
  expect(st.archived().map((i) => i.key).sort()).toEqual(["omp:20", "omp:21", "omp:22"]);
  clock += ARCHIVE_KEEP_MS;
  expect(st.archived()).toEqual([]);
});

test("a question asked late in a long session is archived 6 h after its last update, not after the session started", () => {
  const st = store();
  st.omp({ type: "working", pid: 25, at }, "omp:25");
  clock += ANY_ARCHIVE_MS - 60_000;
  st.omp(ask(25, "late"), "omp:25");
  clock += 120_000;
  expect(st.list().map((i) => i.key)).toEqual(["omp:25"]);
  clock += ANY_ARCHIVE_MS;
  expect(st.list()).toEqual([]);
});

test("manual archive; the next event starts a new item; session end closes an open question", () => {
  const st = store();
  const first = st.omp({ type: "working", pid: 30, at }, "omp:30")?.item.id ?? "";
  expect(st.archive(first)).toBe(true);
  expect(st.archive(first)).toBe(false);
  expect(st.list()).toEqual([]);
  const second = st.omp(ask(30, "q"), "omp:30")?.item;
  expect(second?.id).not.toBe(first);
  st.omp({ type: "session_end", pid: 30, at }, "omp:30");
  expect(st.get(second?.id ?? "")).toMatchObject({ column: "done", question: { open: false, outcome: "ended" } });
});

test("a stale question_closed does not close the current question; turn_finished closes an open one", () => {
  const st = store();
  st.omp(ask(35, "q1"), "omp:35");
  expect(st.omp({ type: "question_closed", pid: 35, at, qid: "other", outcome: "answered" }, "omp:35")).toBeNull();
  const done = st.omp({ type: "turn_finished", pid: 35, at }, "omp:35");
  expect(done?.turnFinished).toBe(true);
  expect(done?.item).toMatchObject({ column: "done", question: { open: false, outcome: "cancelled" } });
});

test("a lost question_closed: working (or session_start) on the live item closes the question and clears the done time", () => {
  const st = store();
  st.omp(ask(36, "q1"), "omp:36");
  const w = st.omp({ type: "working", pid: 36, at }, "omp:36");
  expect(w?.item).toMatchObject({ column: "working", doneAt: null, body: "Working", question: { open: false, outcome: "cancelled" } });
  expect(w?.becameNeedsYou).toBe(false);

  st.omp(ask(37, "q1"), "omp:37");
  st.omp({ type: "turn_finished", pid: 37, at }, "omp:37");
  st.omp(ask(37, "q2"), "omp:37");
  const s2 = st.omp({ type: "session_start", pid: 37, at, cwd: "/work/x", sessionFile: null, tmux: null, pane: null }, "omp:37");
  expect(s2?.item).toMatchObject({ column: "working", doneAt: null, question: { qid: "q2", open: false, outcome: "cancelled" } });
});

test("an item loaded with a missing archivedAt is dropped, not treated as archived", () => {
  const file = path.join(s.stateDir, "inbox-bad.json");
  const good = { id: "i1", key: "omp:50", sessionId: "omp:50", machine: "m", project: "/p", kind: "omp", column: "working", title: "p", body: "Working", question: null, contextLeft: null, createdAt: clock, updatedAt: clock, doneAt: null, archivedAt: null };
  const noArchived = { ...good, id: "i2", key: "omp:51", archivedAt: undefined };
  const badDone = { ...good, id: "i3", key: "omp:52", doneAt: "x" };
  writeFileSync(file, JSON.stringify({ nextId: 4, items: [good, noArchived, badDone] }));
  const st = new InboxStore({ file, machine: "m", now: () => clock });
  expect(st.list().map((i) => i.id)).toEqual(["i1"]);
});

test("the temp file is chmodded 0600, and a failing save still returns the Change", () => {
  const dir = path.join(s.stateDir, "inbox-save");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "inbox.json");
  writeFileSync(file + ".tmp", "stale", { mode: 0o644 });
  const st = new InboxStore({ file, machine: "m", now: () => clock });
  expect(st.omp({ type: "working", pid: 60, at }, "omp:60")?.item.column).toBe("working");
  expect(statSync(file).mode & 0o777).toBe(0o600);

  // The store file's path is a directory, so the rename fails: the change must still come back.
  const blocked = path.join(s.stateDir, "inbox-blocked");
  mkdirSync(path.join(blocked, "inbox.json"), { recursive: true });
  const st2 = new InboxStore({ file: path.join(blocked, "inbox.json"), machine: "m", now: () => clock });
  const c = st2.omp(ask(61, "q"), "omp:61");
  expect(c?.becameNeedsYou).toBe(true);
  expect(st2.list()[0]).toMatchObject({ column: "needs-you" });
});

test("items survive a restart, and the store file is private", () => {
  const file = path.join(s.stateDir, "inbox-restart.json");
  const a = new InboxStore({ file, machine: "m", now: () => clock });
  const id = a.omp(ask(40, "q"), "omp:40")?.item.id;
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const b = new InboxStore({ file, machine: "m", now: () => clock });
  expect(b.get(id ?? "")?.question?.open).toBe(true);
  expect(b.omp({ type: "working", pid: 41, at }, "omp:41")?.item.id).not.toBe(id);
});

test("herdr states: blocked needs you, working, done", () => {
  const st = store();
  expect(st.herdr("herdr:w:t:p", "idle", "agent", "/w")).toBeNull();
  expect(st.herdr("herdr:w:t:p", "blocked", "agent", "/w")?.becameNeedsYou).toBe(true);
  expect(st.herdr("herdr:w:t:p", "working", "agent", "/w")?.item.column).toBe("working");
  expect(st.herdr("herdr:w:t:p", "done", "agent", "/w")?.turnFinished).toBe(true);
  expect(st.list()[0]).toMatchObject({ kind: "herdr", column: "done", question: null });
});

test("herdr: an unchanged status makes no new change, and an archived item is not recreated by it", () => {
  const st = store();
  expect(st.herdr("herdr:w:t:q", "blocked", "agent", "/w")).not.toBeNull();
  expect(st.herdr("herdr:w:t:q", "blocked", "agent", "/w")).toBeNull();
  const id = st.list()[0].id;
  expect(st.archive(id)).toBe(true);
  expect(st.herdr("herdr:w:t:q", "blocked", "agent", "/w")).toBeNull();
  expect(st.list()).toEqual([]);
});
