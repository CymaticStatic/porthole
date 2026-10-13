import { expect, test } from "bun:test";
import { memoryStorage } from "../../src/lib/storage.js";
import { createTalkHistory } from "../../src/lib/talkhistory.js";

const O = "https://testdesk.example.ts.net", S = "tmux:abc:main:0.0";

test("an empty store reads as an empty list", () => {
  expect(createTalkHistory(memoryStorage()).list()).toEqual([]);
});

test("each transcription keeps its text, time, machine and session, newest first", () => {
  let t = 100;
  const h = createTalkHistory(memoryStorage(), () => t);
  h.add({ text: "first", origin: O, sessionId: S });
  t = 200;
  h.add({ text: "second", origin: O, sessionId: "tmux:abc:other:0.0" });
  expect(h.list()).toEqual([
    { text: "second", at: 200, origin: O, sessionId: "tmux:abc:other:0.0" },
    { text: "first", at: 100, origin: O, sessionId: S },
  ]);
});

test("the history survives a new module object on the same storage (a reload)", () => {
  const st = memoryStorage();
  createTalkHistory(st, () => 7).add({ text: "still here", origin: O, sessionId: S });
  expect(createTalkHistory(st).list().map((e) => e.text)).toEqual(["still here"]);
});

test("only the newest 50 are kept", () => {
  const h = createTalkHistory(memoryStorage());
  for (let i = 0; i < 55; i++) h.add({ text: "t" + i, origin: O, sessionId: S });
  const l = h.list();
  expect(l.length).toBe(50);
  expect(l[0].text).toBe("t54");
  expect(l[49].text).toBe("t5");
});

test("blank text is not kept", () => {
  const h = createTalkHistory(memoryStorage());
  expect(h.add({ text: "   ", origin: O, sessionId: S })).toEqual({ ok: false, reason: "empty" });
  expect(h.list()).toEqual([]);
});

test("a missing machine or session is stored as empty text", () => {
  const h = createTalkHistory(memoryStorage(), () => 1);
  h.add({ text: "hello" });
  expect(h.list()).toEqual([{ text: "hello", at: 1, origin: "", sessionId: "" }]);
});

test("corrupt stored JSON reads as empty and the next add starts clean", () => {
  const st = memoryStorage(); st.setItem("porthole:talkhistory", "{nope");
  const h = createTalkHistory(st);
  expect(h.list()).toEqual([]);
  expect(h.add({ text: "ok", origin: O, sessionId: S })).toEqual({ ok: true });
  expect(h.list().length).toBe(1);
});

test("entries of the wrong shape are dropped, good ones kept", () => {
  const st = memoryStorage();
  st.setItem("porthole:talkhistory", JSON.stringify([null, 5, { text: 3 }, { text: "" }, { text: "good", at: 9, origin: O, sessionId: S }]));
  expect(createTalkHistory(st).list()).toEqual([{ text: "good", at: 9, origin: O, sessionId: S }]);
});

test("quota errors are reported, not thrown", () => {
  const st = memoryStorage();
  st.setItem = () => { const e = new Error("full"); e.name = "QuotaExceededError"; throw e; };
  expect(createTalkHistory(st).add({ text: "keep me", origin: O, sessionId: S })).toEqual({ ok: false, reason: "quota" });
});

test("clear empties the list", () => {
  const st = memoryStorage(); const h = createTalkHistory(st);
  h.add({ text: "x", origin: O, sessionId: S });
  h.clear();
  expect(h.list()).toEqual([]);
  expect(st.length).toBe(0);
});
