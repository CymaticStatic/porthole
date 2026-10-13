import { expect, test } from "bun:test";
import { memoryStorage } from "../../src/lib/storage.js";
import { createOutbox, nextAction } from "../../src/lib/outbox.js";

const E = { clientMsgId: "web-1", origin: "https://testdesk.example.ts.net", sessionId: "s", text: "hi", status: "held", at: 1 };

test("outbox persists across store objects", () => {
  const st = memoryStorage(); createOutbox(st).put(E);
  expect(createOutbox(st).get("web-1")).toEqual(E);
  expect(createOutbox(st).held(E.origin).map((e) => e.clientMsgId)).toEqual(["web-1"]);
});

test("update patches, remove deletes, held is per origin and status", () => {
  const st = memoryStorage(); const o = createOutbox(st);
  o.put(E); o.put({ ...E, clientMsgId: "web-2", origin: "https://testlaptop.example.ts.net" });
  expect(o.held(E.origin).length).toBe(1);
  expect(o.update("web-1", { status: "sending" })?.status).toBe("sending");
  expect(o.held(E.origin)).toEqual([]);
  expect(o.update("nope", { status: "x" })).toBeNull();
  o.remove("web-1");
  expect(o.all().map((e) => e.clientMsgId)).toEqual(["web-2"]);
  o.remove("web-2");
  expect(st.length).toBe(0);
});

test("corrupt outbox reads as empty", () => {
  const st = memoryStorage(); st.setItem("porthole:outbox", "{nope");
  expect(createOutbox(st).all()).toEqual([]);
});

test.each([
  [{ ok: true, data: { status: "delivered" } }, { draft: "clear", outbox: "remove", show: null, poll: false }],
  [{ ok: true, data: { status: "pending" } }, { draft: "keep", outbox: "keep", show: "pendingTitle", poll: true }],
  [{ ok: true, data: { status: "refused", reason: "Live voice is on" } }, { draft: "keep", outbox: "remove", show: "sendFailedTitle", poll: false }],
  [{ ok: true, data: { status: "failed", reason: "pane gone" } }, { draft: "keep", outbox: "remove", show: "sendFailedTitle", poll: false }],
  [{ ok: false, status: 0, error: "x" }, { draft: "keep", outbox: "keep", show: "sendHeld", poll: false }],
  [{ ok: false, status: 404, error: "Not found" }, { draft: "keep", outbox: "remove", show: "sendFailedTitle", poll: false }],
])("nextAction %#", (answer, want) => {
  expect(nextAction(E, answer)).toEqual(want);
});
