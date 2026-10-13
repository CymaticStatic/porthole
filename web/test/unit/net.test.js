import { expect, test } from "bun:test";
import { createApi } from "../../src/net/api.js";
import { createMachine } from "../../src/net/machine.js";
import { createFleet } from "../../src/net/fleet.js";
import { memoryStorage } from "../../src/lib/storage.js";
import { createOutbox } from "../../src/lib/outbox.js";

const O = "https://testdesk.example.ts.net";
function fakeFetch(answers) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); const a = answers.shift(); if (a instanceof Error) throw a; return new Response(JSON.stringify(a.body), { status: a.status, headers: { "Content-Type": "application/json" } }); };
  return { f, calls };
}

test("every request carries X-Porthole: 1, no cookies, no cache", async () => {
  const { f, calls } = fakeFetch([{ status: 200, body: { ok: 1 } }, { status: 200, body: {} }]);
  const api = createApi({ origin: O, fetch: f });
  await api.get("/v1/sessions"); await api.post("/v1/sessions/x/send", { text: "a", clientMsgId: "web-1" });
  for (const c of calls) {
    expect(new Headers(c.init.headers).get("X-Porthole")).toBe("1");
    expect([c.init.mode, c.init.credentials, c.init.cache]).toEqual(["cors", "omit", "no-store"]);
  }
  expect(new Headers(calls[1].init.headers).get("Content-Type")).toBe("application/json");
  expect(calls[0].url).toBe(O + "/v1/sessions");
});

test("network failure is status 0 with a plain sentence, never a throw", async () => {
  const { f } = fakeFetch([new TypeError("Failed to fetch")]);
  const r = await createApi({ origin: O, fetch: f }).get("/v1/sessions");
  expect(r.ok).toBe(false); expect(r.status).toBe(0); expect(r.error).not.toContain("fetch");
});

test("hostd's error text is passed through", async () => {
  const { f } = fakeFetch([{ status: 409, body: { error: "That session is read-only." } }]);
  expect(await createApi({ origin: O, fetch: f }).get("/v1/x")).toEqual({ ok: false, status: 409, error: "That session is read-only." });
});

class FakeWs { static all = []; constructor(url) { this.url = url; this.sent = []; FakeWs.all.push(this); } send(d) { this.sent.push(d); } close() { this.onclose?.({}); } }

test("machine link: device query, tree from the sessions push (no polling), ack every notify", async () => {
  FakeWs.all = [];
  const { f, calls } = fakeFetch(Array(4).fill(0).map(() => ({ status: 200, body: { items: [] } })));
  const timers = []; const m = createMachine({ name: "testdesk", origin: O, deviceId: "web-abc123def456", deps: { fetch: f, WebSocket: FakeWs, setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout() {}, outbox: createOutbox(memoryStorage()) } });
  m.start();
  const ws = FakeWs.all[0];
  expect(ws.url).toBe("wss://testdesk.example.ts.net/v1/events?device=web-abc123def456&since=0");
  ws.onopen?.({}); await Bun.sleep(0);
  expect(calls.map((c) => c.url.replace(O, ""))).toEqual(["/v1/inbox"]);
  const tree = { machine: "testdesk", sessions: [{ id: "tmux:t:main:0.0" }], sources: [], scannedAt: "2026-10-13T10:00:00Z" };
  ws.onmessage?.({ data: JSON.stringify({ type: "sessions", tree }) });
  expect(m.tree()).toEqual(tree);
  expect(timers).toEqual([]);
  ws.onmessage?.({ data: JSON.stringify({ type: "notify", id: 7, itemId: "i", title: "t", body: "b", options: [], at: "" }) });
  expect(ws.sent.map((d) => JSON.parse(d))).toEqual([{ type: "ack", id: 7 }]);
  ws.close(); expect(m.state()).toBe("down"); expect(timers.at(-1).ms).toBe(1000);
  timers.at(-1).fn(); FakeWs.all[1].onopen?.({}); await Bun.sleep(0);
  expect(FakeWs.all[1].url).toContain("since=7");
  expect(calls.length).toBe(2); expect(m.state()).toBe("up");
  expect(calls.some((c) => c.url.endsWith("/v1/sessions"))).toBe(false);
});

test("fleet: views report their own links; the strip sees them; drop removes them", () => {
  const fleet = createFleet({ machines: [], deviceId: "web-abc123def456", deps: { fetch: async () => new Response("{}"), WebSocket: FakeWs, setTimeout() {}, clearTimeout() {} } });
  let nudged = 0; let changes = 0; fleet.subscribe(() => changes++);
  const drop = fleet.reportLink("Terminal", "down", () => nudged++);
  expect(fleet.links()).toEqual([{ name: "Terminal", state: "down", retry: expect.any(Function) }]);
  expect(fleet.anyDown()).toBe(true);
  fleet.nudgeAll(); expect(nudged).toBe(1);
  fleet.reportLink("Terminal", "up"); expect(fleet.anyDown()).toBe(false);
  drop(); expect(fleet.links()).toEqual([]);
  expect(changes).toBe(3);
});

test("held sends: B1 is the only sender; every answer reaches onSendResult; a failed re-post stays held for the next up", async () => {
  FakeWs.all = [];
  const OTHER = "https://other.example.ts.net", SID = "tmux:t:main:0.0", URL1 = "/v1/sessions/tmux%3At%3Amain%3A0.0/send";
  const outbox = createOutbox(memoryStorage());
  outbox.put({ clientMsgId: "web-1", origin: O, sessionId: SID, text: "hello", status: "held", at: 1 });
  outbox.put({ clientMsgId: "web-2", origin: OTHER, sessionId: "s2", text: "elsewhere", status: "held", at: 2 });
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const posts = []; let sendFails = true;
  const f = async (url, init) => {
    if (!url.endsWith("/send")) return json(200, { items: [] });
    posts.push({ url: url.replace(O, ""), body: JSON.parse(init.body) });
    if (sendFails) throw new TypeError("Failed to fetch");
    return json(200, { status: "delivered" });
  };
  const timers = [];
  const m = createMachine({ name: "testdesk", origin: O, deviceId: "web-abc123def456", deps: { fetch: f, WebSocket: FakeWs, setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout() {}, outbox } });
  const got = [];
  // this listener plays D1's role (the real one is the fleet-level listener in main.js): it applies the action; B1 itself never edits the outbox
  const off = m.onSendResult((r) => { got.push(r); if (r.action.outbox === "remove") outbox.remove(r.clientMsgId); });

  // first "up": the machine is reachable for the socket but the re-post fails (status 0): the entry stays held
  m.start(); FakeWs.all[0].onopen?.({}); await Bun.sleep(10);
  expect(posts).toEqual([{ url: URL1, body: { text: "hello", clientMsgId: "web-1" } }]);
  expect(got).toEqual([{ clientMsgId: "web-1", sessionId: SID, action: { draft: "keep", outbox: "keep", show: "sendHeld", poll: false } }]);
  expect(outbox.get("web-1").status).toBe("held");

  // the link drops and comes back: the same entry is re-posted with the same clientMsgId and now delivers
  FakeWs.all[0].close(); sendFails = false; timers.at(-1).fn(); FakeWs.all[1].onopen?.({}); await Bun.sleep(10);
  expect(posts.length).toBe(2);
  expect(posts[1]).toEqual(posts[0]);
  expect(got[1]).toEqual({ clientMsgId: "web-1", sessionId: SID, action: { draft: "clear", outbox: "remove", show: null, poll: false } });
  expect(outbox.held(O)).toEqual([]);
  expect(outbox.held(OTHER).map((e) => e.clientMsgId)).toEqual(["web-2"]); // another machine's entry is never touched

  // after off(), B1 still sends held entries but nobody hears the result, so nothing applies the action
  off();
  outbox.put({ clientMsgId: "web-3", origin: O, sessionId: SID, text: "later", status: "held", at: 3 });
  FakeWs.all[1].close(); timers.at(-1).fn(); FakeWs.all[2].onopen?.({}); await Bun.sleep(10);
  expect(posts.length).toBe(3);
  expect(posts[2].body).toEqual({ text: "later", clientMsgId: "web-3" });
  expect(got.length).toBe(2);
  expect(outbox.get("web-3").status).toBe("held"); // B1 never edits the outbox: with no listener the entry stays held and is re-posted at the next up
});
