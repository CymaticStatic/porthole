import { expect, test } from "bun:test";
import { openSocket } from "../../src/net/socket.js";

class FakeWs {
  static all = [];
  constructor(url) { this.url = url; this.sent = []; this.closed = false; FakeWs.all.push(this); }
  send(d) { this.sent.push(d); }
  close() { this.closed = true; this.onclose?.({}); }
}

/** Timers the test fires by hand. */
function fakeTimers() {
  const list = [];
  return {
    list,
    setTimeout: (fn, ms) => (list.push({ fn, ms, live: true }), list.length),
    clearTimeout: (id) => { if (list[id - 1]) list[id - 1].live = false; },
    live: (ms) => list.filter((t) => t.live && t.ms === ms),
  };
}

const HEARTBEAT = { ping: "ping!", isPong: (d) => d === "pong!", pingMs: 10_000, silentMs: 25_000 };

function setup(extra = {}) {
  FakeWs.all = [];
  const t = fakeTimers();
  const states = [];
  const got = [];
  const sock = openSocket({ url: () => "wss://x/v1/events", WebSocket: FakeWs, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout, onState: (s) => states.push(s), onMessage: (d) => got.push(d), ...extra });
  return { t, states, got, sock };
}

test("a nudge on an up link closes the old socket and dials a new one at once", () => {
  const { states, sock } = setup();
  FakeWs.all[0].onopen({});
  expect(states).toEqual(["connecting", "up"]);
  sock.nudge();
  expect(FakeWs.all.length).toBe(2);
  expect(FakeWs.all[0].closed).toBe(true);
  expect(states.at(-1)).toBe("connecting");
  FakeWs.all[1].onopen({});
  expect(states.at(-1)).toBe("up");
  // the dropped socket can no longer disturb the new link
  FakeWs.all[0].onclose?.({});
  FakeWs.all[0].onmessage?.({ data: "late" });
  expect(states.at(-1)).toBe("up");
});

test("a nudge on a link that is still connecting dials again too", () => {
  const { sock } = setup();
  sock.nudge();
  expect(FakeWs.all.length).toBe(2);
  expect(FakeWs.all[0].closed).toBe(true);
});

test("a nudge after close does nothing", () => {
  const { sock } = setup();
  sock.close();
  sock.nudge();
  expect(FakeWs.all.length).toBe(1);
});

test("heartbeat: pings every 10 s once open; a pong arms a 25 s silence limit that redials", () => {
  const { t, states, sock } = setup({ heartbeat: HEARTBEAT });
  const ws = FakeWs.all[0];
  ws.onopen({});
  expect(t.live(10_000).length).toBe(1);
  t.live(10_000)[0].fn();
  expect(ws.sent).toEqual(["ping!"]);
  expect(t.live(25_000).length).toBe(0); // not judged before the first answer
  ws.onmessage({ data: "pong!" });
  expect(t.live(25_000).length).toBe(1);
  // any message keeps the link alive: the limit restarts
  const first = t.live(25_000)[0];
  ws.onmessage({ data: JSON.stringify({ type: "sessions" }) });
  expect(first.live).toBe(false);
  expect(t.live(25_000).length).toBe(1);
  // 25 s with nothing: close it and dial a new one
  t.live(25_000)[0].fn();
  expect(ws.closed).toBe(true);
  expect(FakeWs.all.length).toBe(2);
  expect(states.at(-1)).toBe("connecting");
  expect(t.live(25_000).length).toBe(0); // the old socket's timers are gone
  sock.close();
});

test("heartbeat: a server that never answers pings is never redialled for being quiet", () => {
  const { t } = setup({ heartbeat: HEARTBEAT });
  const ws = FakeWs.all[0];
  ws.onopen({});
  for (let i = 0; i < 5; i++) t.live(10_000).at(-1).fn();
  ws.onmessage({ data: JSON.stringify({ type: "sessions" }) });
  expect(ws.sent).toEqual(Array(5).fill("ping!"));
  expect(t.live(25_000).length).toBe(0);
  expect(FakeWs.all.length).toBe(1);
});

test("heartbeat timers stop when the socket closes or the link is ended", () => {
  const { t, sock } = setup({ heartbeat: HEARTBEAT });
  const ws = FakeWs.all[0];
  ws.onopen({});
  ws.onmessage({ data: "pong!" });
  ws.onclose({});
  expect(t.live(10_000).length).toBe(0);
  expect(t.live(25_000).length).toBe(0);
  t.live(1000)[0].fn(); // the 1 s retry
  FakeWs.all[1].onopen({});
  expect(t.live(10_000).length).toBe(1);
  sock.close();
  expect(t.live(10_000).length).toBe(0);
});
