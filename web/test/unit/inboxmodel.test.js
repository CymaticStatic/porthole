import { expect, test } from "bun:test";
import { answerMode, contextRing, groupInbox } from "../../src/lib/inboxmodel.js";
const q = (o) => ({ qid: "q", pid: 1, text: "Pick", options: ["A", "B"], multi: false, count: 1, open: true, outcome: null, ...o });
const item = (id, column, updatedAt, project = "/work/porthole") => ({ id, column, updatedAt, project, contextLeft: null, question: null });
test("columns, grouped by project then machine, newest first", () => {
  const g = groupInbox({
    testdesk: [item("1", "needs-you", 9), item("2", "needs-you", 10), item("3", "done", 8), item("4", "needs-you", 5, "/work/finance")],
    testlaptop: [item("5", "needs-you", 7)],
  });
  expect(g.needsYou.map((p) => [p.project, p.machines.map((m) => [m.machine, m.items.map((i) => i.id)])])).toEqual([
    ["porthole", [["testdesk", ["2", "1"]], ["testlaptop", ["5"]]]],
    ["finance", [["testdesk", ["4"]]]],
  ]);
  expect(g.needsYou[0].machines[0].items[0].machine).toBe("testdesk");
  expect(g.done[0].machines[0].items.map((i) => i.id)).toEqual(["3"]);
});
test("groups and machines are ordered by their newest item, and empty columns are empty", () => {
  const g = groupInbox({ a: [item("1", "working", 3, "/w/old")], b: [item("2", "working", 8, "/w/old"), item("3", "working", 5, "/w/new")] });
  expect(g.working.map((p) => p.project)).toEqual(["old", "new"]);
  expect(g.working[0].machines.map((m) => m.machine)).toEqual(["b", "a"]);
  expect(g.needsYou).toEqual([]);
  expect(g.done).toEqual([]);
});
test("context ring: hidden without a number, warns below 15 %", () => {
  expect(contextRing({ contextLeft: null })).toBeNull();
  expect(contextRing({ contextLeft: 0.4 })).toEqual({ percent: 40, warn: false });
  expect(contextRing({ contextLeft: 0.15 })).toEqual({ percent: 15, warn: false });
  expect(contextRing({ contextLeft: 0.12 })).toEqual({ percent: 12, warn: true });
});
test("one multi-select question gets ticks; several questions answer in the terminal", () => {
  expect(answerMode({ question: q({}) })).toBe("buttons");
  expect(answerMode({ question: q({ multi: true }) })).toBe("ticks");
  expect(answerMode({ question: q({ count: 2 }) })).toBe("terminal");
  expect(answerMode({ question: q({ multi: true, count: 2 }) })).toBe("terminal");
  expect(answerMode({ question: null })).toBe("buttons");
});
