import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ChatItem } from "../src/transcript/parse";
import { parseLine } from "../src/transcript/parse";
import { Follower, readAfter, readPage } from "../src/transcript/tail";
import { FIXTURES, Scratch, useTestTimeout, waitFor } from "./helpers/scratch";

useTestTimeout();

let s: Scratch;
beforeEach(() => { s = new Scratch(); });
afterEach(() => s.cleanup());

const shape = (items: ChatItem[]) => items.map((i) => [i.kind, i.text, i.tools.join(","), i.via]);

test("user, assistant, tool calls and live-delegation become chat items; the rest is skipped", () => {
  const page = readPage(path.join(FIXTURES, "chat-basic.jsonl"), null, 50);
  expect(shape(page.items)).toEqual([
    ["user", "List the files", "", "typed"],
    ["assistant", "Looking now.", "", null],
    ["tools", "", "read,grep", null],
    ["assistant", "There is **one** file: `a.txt`.", "", null],
    ["user", "Also check the tests", "", "live-voice"],
  ]);
  expect(page.hasOlder).toBe(false);
  expect(parseLine("{not json", 0)).toEqual([]);
});

test("assistant text items carry omp's stopReason: toolUse before tool calls, stop for the reply that ends the turn", () => {
  const page = readPage(path.join(FIXTURES, "chat-basic.jsonl"), null, 50);
  expect(page.items.map((i) => [i.kind, i.stopReason])).toEqual([
    ["user", null],
    ["assistant", "toolUse"],
    ["tools", null],
    ["assistant", "stop"],
    ["user", null],
  ]);
  const noReason = JSON.stringify({ type: "message", id: "a9", parentId: null, timestamp: "2026-10-13T09:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "no reason" }] } });
  expect(parseLine(noReason, 0).map((i) => i.stopReason)).toEqual([null]);
});

test("pages walk backwards by cursor; after returns only newer lines", () => {
  const file = path.join(FIXTURES, "chat-basic.jsonl");
  const last = readPage(file, null, 1);
  expect(shape(last.items)).toEqual([["user", "Also check the tests", "", "live-voice"]]);
  expect(last.hasOlder).toBe(true);
  const older = readPage(file, last.start, 2);
  // readPage keeps whole lines: the line holding "Looking now." + its tools comes in whole.
  expect(shape(older.items).map((r) => r[0])).toEqual(["assistant", "tools", "assistant"]);
  const after = readAfter(file, older.items[0].cursor);
  expect(shape(after.items).map((r) => r[1])).toEqual(["There is **one** file: `a.txt`.", "Also check the tests"]);
  expect(after.end).toBe(readFileSync(file).length);
});

test("readAfter skips a line longer than the read window instead of returning nothing", () => {
  const mk = (id: string, text: string) => JSON.stringify({ type: "message", id, parentId: null, timestamp: "2026-10-13T09:00:00.000Z", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
  const big = mk("u1", "x".repeat(600 * 1024));
  const file = path.join(s.root, "big.jsonl");
  writeFileSync(file, big + mk("u2", "after the big line"));
  const after = readAfter(file, 0);
  expect(after.items.map((i) => i.text)).toEqual(["after the big line"]);
  expect(after.start).toBe(Buffer.byteLength(big));
  expect(after.end).toBe(readFileSync(file).length);
});

test("the follower appends complete lines only and resets when the file shrinks", async () => {
  const file = s.transcript("chat-basic.jsonl");
  const got: ChatItem[] = [];
  let resets = 0;
  const f = new Follower(file, readFileSync(file).length, (items) => got.push(...items), () => { resets += 1; }, 50);
  f.start();
  const line = '{"type":"message","id":"u9","parentId":"s1","timestamp":"2026-10-13T09:01:00.000Z","message":{"role":"user","content":[{"type":"text","text":"half then whole"}]}}';
  appendFileSync(file, line.slice(0, 40));
  await Bun.sleep(200);
  expect(got.length).toBe(0);
  appendFileSync(file, line.slice(40) + "\n");
  await waitFor(() => got.length === 1);
  expect(got[0].text).toBe("half then whole");
  writeFileSync(file, "");
  await waitFor(() => resets === 1);
  f.stop();
});
