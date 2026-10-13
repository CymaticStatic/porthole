import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { copy } from "../../src/lib/copy.js";
import { createBridge } from "../../src/net/bridge.js";
import { readAllUtterances, speakThroughBridge, summaryUtterances } from "../../src/lib/speech.js";

const lines = readFileSync(path.join(import.meta.dir, "..", "fixtures", "reply-p3.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const reply = lines.at(-1).message.content.find((p) => p.type === "text").text;

test("fixture reply: first paragraph plus decision titles", () => {
  expect(summaryUtterances(reply)).toEqual(["The tests pass and the page loads on the phone.", "1. Merge the branch", "2. Turn on the advisor"]);
});
test("no decision section: first paragraph only, marks stripped", () => {
  expect(summaryUtterances("Done **now**, see `a.txt`.\n\nMore.")).toEqual(["Done now, see a.txt."]);
});
test("None. means no titles", () => {
  expect(summaryUtterances("Ok.\n\n## Needs your decision\n\nNone.")).toEqual(["Ok."]);
});
test("titles fall back to the first line", () => {
  expect(summaryUtterances("Hi.\n\n### Needs your decision\n\n1. Pick a name\n   context")).toEqual(["Hi.", "1. Pick a name"]);
});
test("a reply that starts with a heading uses the first paragraph after it", () => {
  expect(summaryUtterances("## Result\n\nAll good.")).toEqual(["All good."]);
});
test("the heading match ignores case and level; a single ordered 'None.' item means no titles", () => {
  expect(summaryUtterances("Ok.\n\n# NEEDS YOUR DECISION\n\n1. None.")).toEqual(["Ok."]);
  expect(summaryUtterances("Ok.\n\n# needs your decision\n\n1. **A**\n2. **B**")).toEqual(["Ok.", "1. A", "2. B"]);
});
test("a list before the heading is not a decision list", () => {
  expect(summaryUtterances("Ok.\n\n1. one\n2. two\n\n## Needs your decision\n\n1. **Real**")).toEqual(["Ok.", "1. Real"]);
});
test("empty or decision-less input", () => {
  expect(summaryUtterances("")).toEqual([]);
  expect(summaryUtterances("```\ncode only\n```")).toEqual([]);
});

test("read all: whole reply without tables and code", () => {
  const md = "Intro **bold**.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n\n- first\n- second\n\n## Next\n\nEnd with `code`.";
  expect(readAllUtterances(md)).toEqual(["Intro bold.", "first", "second", "Next", "End with code."]);
});
test("read all: the fixture reply, numbered items spoken in full", () => {
  expect(readAllUtterances(reply)).toEqual([
    "The tests pass and the page loads on the phone.",
    "I checked both machines.",
    "Needs your decision",
    "1. Merge the branch It is ready.",
    "2. Turn on the advisor It costs a little each run.",
  ]);
});
test("entities are spoken as characters", () => {
  expect(summaryUtterances("Tom &amp; Jerry &lt;3.\n\n## Needs your decision\n\n1. **R&amp;D budget**")).toEqual(["Tom & Jerry <3.", "1. R&D budget"]);
  expect(readAllUtterances("A &amp; B.")).toEqual(["A & B."]);
});

/** A bridge whose native side answers every call with `reply` (plus the call's id). */
function bridgeAnswering(reply) {
  const sent = [];
  const native = { postMessage: (s) => { const m = JSON.parse(s); sent.push(m); queueMicrotask(() => native.onmessage({ data: JSON.stringify({ id: m.id, ...reply }) })); }, onmessage: null };
  return { bridge: createBridge({ PortholeNative: native }), sent };
}
test("speaking through the app: a finished reading and a stopped one are not failures", async () => {
  const done = bridgeAnswering({ ok: true, result: { finished: true } });
  expect(await speakThroughBridge(done.bridge, ["One.", "Two."])).toBe(true);
  expect(done.sent[0].method).toBe("speak");
  expect(done.sent[0].args).toEqual({ utterances: ["One.", "Two."] });
  const stopped = bridgeAnswering({ ok: true, result: { finished: false } });
  expect(await speakThroughBridge(stopped.bridge, ["One."])).toBe(true);
});
test("speaking through the app: an error answer (the phone could not speak it) is a failure", async () => {
  const failed = bridgeAnswering({ ok: false, error: "Text-to-speech failed" });
  expect(await speakThroughBridge(failed.bridge, ["One."])).toBe(false);
});
test("read-aloud failure words", () => {
  expect(copy.readAloudFailed).toBe("Couldn't read this aloud.");
});
