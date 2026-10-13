import { expect, test } from "bun:test";
import { memoryStorage } from "../../src/lib/storage.js";
import { createDrafts } from "../../src/lib/drafts.js";

const O = "https://testdesk.example.ts.net", S = "tmux:abc:main:0.0";

test("a draft survives a new store object on the same storage (a reload)", () => {
  const st = memoryStorage();
  createDrafts(st, () => 5).put(O, S, "half a sent", ["/tmp/a.png"]);
  expect(createDrafts(st).get(O, S)).toEqual({ text: "half a sent", files: ["/tmp/a.png"], updatedAt: 5 });
});

test("drafts are per machine and per session", () => {
  const d = createDrafts(memoryStorage());
  d.put(O, S, "one", []);
  expect(d.get("https://testlaptop.example.ts.net", S)).toBeNull();
  expect(d.get(O, "tmux:abc:other:0.0")).toBeNull();
});

test("an empty draft with no files removes the key", () => {
  const st = memoryStorage(); const d = createDrafts(st);
  d.put(O, S, "x", []); d.put(O, S, "", []);
  expect(st.length).toBe(0);
});

test("quota errors are reported, not thrown", () => {
  const st = memoryStorage();
  st.setItem = () => { const e = new Error("full"); e.name = "QuotaExceededError"; throw e; };
  expect(createDrafts(st).put(O, S, "keep me", [])).toEqual({ ok: false, reason: "quota" });
});

test("sent history keeps the newest 50", () => {
  const d = createDrafts(memoryStorage());
  for (let i = 0; i < 55; i++) d.addSent(O, S, { clientMsgId: "web-" + i, text: "m" + i, at: i, status: "delivered", reason: null });
  const s = d.sent(O, S);
  expect(s.length).toBe(50);
  expect(s[0].clientMsgId).toBe("web-5");
  expect(s[49].clientMsgId).toBe("web-54");
});

test("corrupt stored JSON reads as no draft", () => {
  const st = memoryStorage(); st.setItem(`porthole:draft:${O}|${S}`, "{nope");
  expect(createDrafts(st).get(O, S)).toBeNull();
});

test("corrupt sent history reads as empty and clear removes the draft", () => {
  const st = memoryStorage(); st.setItem(`porthole:sent:${O}|${S}`, "{nope");
  const d = createDrafts(st);
  expect(d.sent(O, S)).toEqual([]);
  d.put(O, S, "x", []); d.clear(O, S);
  expect(d.get(O, S)).toBeNull();
});
