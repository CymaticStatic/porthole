import { afterAll, beforeAll, expect, test } from "bun:test";
import { statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { InboxItem } from "../src/events/inbox";
import { MAX_HELD, KEEP_MS, MAX_PER_DEVICE, NotifyQueue, buildNotify } from "../src/events/notify";
import type { NotifyMsg } from "../src/events/notify";
import { Scratch } from "./helpers/scratch";

let s: Scratch;
beforeAll(() => { s = new Scratch(); });
afterAll(() => s.cleanup());

let clock = 5_000_000;
function item(id: string, options: string[], multi = false): InboxItem {
  return {
    id, key: "omp:1", sessionId: "omp:1", machine: "m", project: "/w/p", kind: "omp", column: "needs-you",
    title: "t".repeat(90), body: "b".repeat(250), contextLeft: null, createdAt: clock, updatedAt: clock, doneAt: null, archivedAt: null,
    question: { qid: "q", pid: 1, text: "Q?", options, multi, count: 1, open: true, outcome: null },
  };
}
function queue(name: string, sent: NotifyMsg[]): NotifyQueue {
  return new NotifyQueue({ file: path.join(s.stateDir, name + ".json"), now: () => clock, send: (m) => sent.push(m) });
}

test("summary limits and answer buttons only for 2-3 option single questions", () => {
  const m = buildNotify(item("i1", ["red", "green", "blue"]), 7, "now");
  expect([m.title.length, m.body.length, m.itemId, m.id]).toEqual([80, 200, "i1", 7]);
  expect(m.options).toEqual([{ index: 0, label: "red" }, { index: 1, label: "green" }]);
  expect(buildNotify(item("i2", ["a", "b", "c", "d"]), 1, "now").options).toEqual([]);
  expect(buildNotify(item("i3", ["a", "b"], true), 1, "now").options).toEqual([]);
});

test("unacked messages replay per device; acked ones never come back", () => {
  const sent: NotifyMsg[] = [];
  const q = queue("replay", sent);
  q.register("bencell");
  const a = q.notify(item("i1", ["x", "y"]));
  const b = q.notify(item("i2", ["x", "y"]));
  expect(sent.map((m) => m.id)).toEqual([a?.id ?? 0, b?.id ?? 0]);
  expect(q.pendingFor("bencell", 0).map((m) => m.itemId)).toEqual(["i1", "i2"]);
  q.ack("bencell", a?.id ?? 0);
  expect(q.pendingFor("bencell", 0).map((m) => m.itemId)).toEqual(["i2"]);
  expect(q.pendingFor("bencell", b?.id ?? 0)).toEqual([]);
  const again = queue("replay", []);
  expect(again.pendingFor("bencell", 0).map((m) => m.itemId)).toEqual(["i2"]);
  expect(again.notify(item("i3", []))?.id).toBe((b?.id ?? 0) + 1);
  expect(statSync(path.join(s.stateDir, "replay.json")).mode & 0o777).toBe(0o600);
});

test("each device has its own unacked queue", () => {
  const q = queue("devices", []);
  q.register("bencell");
  q.register("watch");
  const m = q.notify(item("i1", []));
  q.ack("bencell", m?.id ?? 0);
  expect(q.pendingFor("bencell", 0)).toEqual([]);
  expect(q.pendingFor("watch", 0).map((x) => x.itemId)).toEqual(["i1"]);
  expect(q.pendingFor("stranger", 0)).toEqual([]);
});

test("at most 100 per device, kept 24 h", () => {
  const q = queue("cap", []);
  q.register("bencell");
  for (let i = 0; i < MAX_PER_DEVICE + 5; i++) { q.notify(item("i" + i, [])); clock += 1_001; }
  const left = q.pendingFor("bencell", 0);
  expect(left).toHaveLength(MAX_PER_DEVICE);
  expect(left[0].itemId).toBe("i5");
  clock += KEEP_MS;
  expect(q.pendingFor("bencell", 0)).toEqual([]);
});

test("P2.3: the 61st notification in a minute is held back, then released", () => {
  const sent: NotifyMsg[] = [];
  const q = queue("rate", sent);
  for (let i = 0; i < 60; i++) expect(q.notify(item("i" + i, []))).not.toBeNull();
  expect(q.notify(item("late", []))).toBeNull();
  expect(sent).toHaveLength(60);
  clock += 30_000;
  expect(q.tick()).toEqual([]);
  clock += 30_000;
  const released = q.tick();
  expect(released.map((m) => m.itemId)).toEqual(["late"]);
  expect(released[0].id).toBe(61);
  expect(sent).toHaveLength(61);
});

test("held notifications: capped at 200 (oldest dropped), built from the current item at release", () => {
  const sent: NotifyMsg[] = [];
  const closed = new Set<string>();
  const q = new NotifyQueue({
    file: path.join(s.stateDir, "held.json"), now: () => clock, send: (m) => sent.push(m),
    current: (id) => {
      const it = item(id, ["yes", "no"]);
      if (closed.has(id) && it.question) it.question.open = false;
      return it;
    },
  });
  for (let i = 0; i < 60; i++) q.notify(item("s" + i, []));
  for (let i = 0; i < MAX_HELD + 25; i++) expect(q.notify(item("h" + i, ["a", "b"]))).toBeNull();
  closed.add("h30");
  clock += 61_000;
  const out: NotifyMsg[] = [];
  for (let n = 0; n < 8; n++) { out.push(...q.tick()); clock += 61_000; }
  const held = out.filter((m) => m.itemId.startsWith("h"));
  expect(held).toHaveLength(MAX_HELD);
  expect(held[0].itemId).toBe("h25");
  expect(held.at(-1)?.itemId).toBe("h" + (MAX_HELD + 24));
  // Rebuilt from the current item: the one whose question closed while it waited has no buttons, the rest do.
  expect(held.find((m) => m.itemId === "h30")?.options).toEqual([]);
  expect(held.find((m) => m.itemId === "h31")?.options).toEqual([{ index: 0, label: "yes" }, { index: 1, label: "no" }]);
});

test("a corrupt queue file restarts ids from an epoch-seconds base, above any earlier count", () => {
  const file = path.join(s.stateDir, "corrupt.json");
  writeFileSync(file, "{not json");
  const q = new NotifyQueue({ file, now: () => 1_760_000_000_000, send: () => undefined });
  expect(q.notify(item("i1", []))?.id).toBe(1_760_000_000);
});
