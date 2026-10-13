import { expect, test } from "bun:test";
import { createChat, finishedReplies, toolSummary } from "../../src/lib/chatmodel.js";
const it = (cursor, kind = "assistant", text = "t" + cursor, stopReason = null) => ({ cursor, id: "i" + cursor, at: "2026-10-13T09:00:00Z", kind, text, tools: [], via: null, stopReason });
test("append returns only new items and keeps order", () => {
  const c = createChat();
  c.backlog({ items: [it(1), it(2)], start: 1, end: 2, hasOlder: false });
  expect(c.append([it(2), it(3)], 3).map((i) => i.cursor)).toEqual([3]);
  expect(c.items().map((i) => i.cursor)).toEqual([1, 2, 3]);
});
test("a reconnect backlog does not report old items as new", () => {
  const c = createChat(); c.backlog({ items: [it(1)], start: 1, end: 1, hasOlder: false });
  expect(c.backlog({ items: [it(1), it(2)], start: 1, end: 2, hasOlder: false }).map((i) => i.cursor)).toEqual([2]);
});
test("tool summary", () => {
  expect(toolSummary({ ...it(1, "tools"), tools: ["read", "grep"] })).toBe("Used 2 tools: read, grep");
  expect(toolSummary({ ...it(1, "tools"), tools: ["read"] })).toBe("Used 1 tool: read");
});
test("only the final assistant message of a finished turn is a reply to read aloud", () => {
  const fresh = [it(4, "assistant", "Let me run the tests before I answer.", "toolUse"), it(5, "tools"), it(6, "assistant", "The tests pass.", "stop"), it(7, "user", "thanks")];
  expect(finishedReplies(fresh).map((i) => i.cursor)).toEqual([6]);
  expect(finishedReplies([it(8, "assistant", "half", null)])).toEqual([]);
});
test("a text item and its tools item share one cursor and are both kept, in arrival order", () => {
  const c = createChat();
  const text = { ...it(5), id: "m:text" };
  const tools = { ...it(5, "tools"), id: "m:tools", tools: ["read"] };
  c.append([text], 5);
  c.append([tools], 5);
  expect(c.items().map((i) => i.id)).toEqual(["m:text", "m:tools"]);
  expect(c.append([text, tools], 5)).toEqual([]);
});
test("older pages slot in before what is already shown", () => {
  const c = createChat();
  c.backlog({ items: [it(5), it(6)], start: 5, end: 6, hasOlder: true });
  expect(c.older({ items: [it(3), it(4), it(5)], start: 3, end: 5, hasOlder: false }).map((i) => i.cursor)).toEqual([3, 4]);
  expect(c.items().map((i) => i.cursor)).toEqual([3, 4, 5, 6]);
});
test("newestAssistant skips user and tools items", () => {
  const c = createChat();
  expect(c.newestAssistant()).toBeNull();
  c.append([it(1), it(2, "user"), it(3, "tools")], 3);
  expect(c.newestAssistant()?.cursor).toBe(1);
});
