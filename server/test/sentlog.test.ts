import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { CLIENT_MSG_ID, commitInbox, inboxDir, stageInbox, waitTaken } from "../src/deliver/inbox";
import { SentLog } from "../src/deliver/sentlog";
import { Scratch } from "./helpers/scratch";

let s: Scratch;
beforeEach(() => { s = new Scratch(); });
afterEach(() => s.cleanup());

const base = { sessionId: "tmux:a:b:0.0", reason: "", route: "tmux" as const, text: "hello", pid: null, file: null };

test("records survive a restart and the newest record per id wins", () => {
  const a = new SentLog(s.stateDir);
  a.append({ ...base, clientMsgId: "m1", status: "pending" });
  a.append({ ...base, clientMsgId: "m1", status: "delivered" });
  a.append({ ...base, clientMsgId: "m2", status: "pending" });
  const b = new SentLog(s.stateDir);
  expect(b.latest("m1")?.status).toBe("delivered");
  expect(b.pending().map((r) => r.clientMsgId)).toEqual(["m2"]);
  expect(b.latest("m1")?.text).toBe("hello");
  expect(path.basename(b.file)).toBe("sent.jsonl");
  expect(statSync(b.file).mode & 0o777).toBe(0o600);
  expect(readFileSync(b.file, "utf8").trim().split("\n").length).toBe(3);
});

test("ids are safe inbox file names", () => {
  expect(CLIENT_MSG_ID.test("c-1700000000.abc_1")).toBe(true);
  for (const bad of [".hidden", "../x", "a/b", "", "x".repeat(101)]) expect(CLIENT_MSG_ID.test(bad)).toBe(false);
});

test("write-then-rename, and taken means the extension removed the file", async () => {
  const dir = inboxDir(s.inboxRoot, 4242);
  mkdirSync(dir, { mode: 0o700 });
  const staged = stageInbox(dir, "m1", "hi there");
  expect(readdirSync(dir)).toEqual([".m1.msg.part"]);
  expect(statSync(staged.part).mode & 0o777).toBe(0o600);
  commitInbox(staged);
  expect(readdirSync(dir)).toEqual(["m1.msg"]);
  expect(readFileSync(staged.final, "utf8")).toBe("hi there");
  setTimeout(() => rmSync(staged.final), 150);
  expect(await waitTaken(staged.final, 2000, 20)).toBe(true);
  const again = stageInbox(dir, "m2", "nobody reads this");
  commitInbox(again);
  expect(await waitTaken(again.final, 200, 20)).toBe(false);
  expect(existsSync(again.final)).toBe(true);
});

test("stageInbox refuses to replace an unconsumed message", () => {
  const dir = inboxDir(s.inboxRoot, 4243);
  mkdirSync(dir, { mode: 0o700 });
  commitInbox(stageInbox(dir, "m1", "first"));
  expect(() => stageInbox(dir, "m1", "second")).toThrow(/already exists/);
  expect(readFileSync(path.join(dir, "m1.msg"), "utf8")).toBe("first");
  expect(readdirSync(dir)).toEqual(["m1.msg"]);
});

test("a torn last line is terminated so the next record survives a restart", () => {
  const a = new SentLog(s.stateDir);
  a.append({ ...base, clientMsgId: "m1", status: "pending" });
  appendFileSync(a.file, '{"at":"x","clientMsgId":"torn"');
  const b = new SentLog(s.stateDir);
  expect(readFileSync(b.file, "utf8").endsWith("\n")).toBe(true);
  b.append({ ...base, clientMsgId: "m2", status: "pending" });
  const c = new SentLog(s.stateDir);
  expect(c.latest("m1")?.status).toBe("pending");
  expect(c.latest("m2")?.status).toBe("pending");
  expect(c.latest("torn")).toBeUndefined();
});
