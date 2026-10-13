import { expect, test } from "bun:test";
import { createReconnector, delayFor } from "../../src/lib/reconnect.js";

test("delays are 1, 2, 4, 8, 15, 15 seconds", () => {
  expect([0, 1, 2, 3, 4, 5, 9].map(delayFor)).toEqual([1, 2, 4, 8, 15, 15, 15]);
});

function fakeTimers() {
  const q = []; return { q, setTimeout: (fn, ms) => (q.push({ fn, ms }), q.length), clearTimeout: (id) => { if (q[id - 1]) q[id - 1].fn = null; } };
}

test("closes back off, an open resets, a nudge skips the wait", () => {
  const t = fakeTimers(); let calls = 0;
  const r = createReconnector({ connect: () => calls++, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
  r.start(); expect(calls).toBe(1);
  r.closed(); expect(t.q.at(-1).ms).toBe(1000); t.q.at(-1).fn(); expect(calls).toBe(2);
  r.closed(); expect(t.q.at(-1).ms).toBe(2000);
  r.nudge(); expect(calls).toBe(3); expect(t.q.at(-1).fn).toBeNull();
  r.closed(); expect(t.q.at(-1).ms).toBe(4000);
  r.opened(); expect(r.state()).toBe("up");
  r.closed(); expect(t.q.at(-1).ms).toBe(1000);
});

test("stop cancels a waiting retry and ignores later closes", () => {
  const t = fakeTimers(); let calls = 0;
  const r = createReconnector({ connect: () => calls++, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
  r.start(); r.closed(); r.stop(); r.closed(); r.nudge();
  expect(calls).toBe(1); expect(t.q.length).toBe(1); expect(t.q[0].fn).toBeNull();
});

test("state follows start, close, retry and open; nudge does nothing unless waiting", () => {
  const t = fakeTimers(); let calls = 0;
  const r = createReconnector({ connect: () => calls++, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
  r.start(); expect(r.state()).toBe("connecting");
  r.nudge(); expect(calls).toBe(1);
  r.opened(); expect(r.state()).toBe("up");
  r.nudge(); expect(calls).toBe(1);
  r.closed(); expect(r.state()).toBe("waiting");
  r.closed(); expect(t.q.length).toBe(1);
  t.q[0].fn(); expect(r.state()).toBe("connecting"); expect(calls).toBe(2);
});

test("the wait caps at 15 seconds", () => {
  const t = fakeTimers();
  const r = createReconnector({ connect: () => {}, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
  r.start();
  const seen = [];
  for (let i = 0; i < 7; i++) { r.closed(); seen.push(t.q.at(-1).ms); t.q.at(-1).fn(); }
  expect(seen).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
});
