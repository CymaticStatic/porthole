// web/test/e2e/talk.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { startStack, type Stack } from "./stack";

const STUB = `
  window.__spoken = [];
  const fake = { speaking: false, pending: false, paused: false,
    speak(u) { window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend(new Event("end")), 0); },
    cancel() {}, pause() {}, resume() {}, getVoices() { return []; }, addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(window, "speechSynthesis", { value: fake, configurable: true });`;

let st: Stack;
beforeAll(async () => {
  st = await startStack({ fixtures: { desk: ["chat-p3.jsonl"], laptop: [] } });
  await st.page.onNewDocument(STUB);
  await st.page.phone();
  await st.page.goto("https://testdesk.example.ts.net/#/inbox");
  await st.page.eval(`localStorage.setItem("porthole:settings", JSON.stringify({ readAloud: true }))`);
  await st.page.goto(st.chatUrl("desk", "chat-p3.jsonl"));
  await st.page.waitFor(`document.querySelectorAll("[data-test=bubble]").length >= 4`, 10000);
});
afterAll(async () => { await st?.stop(); });

test("P3-4: a new fixture turn speaks only its final reply: first paragraph plus decision titles, never the tool-use message", async () => {
  expect(await st.page.eval("window.__spoken")).toEqual([]);
  const line = readFileSync(path.join(import.meta.dir, "..", "fixtures", "reply-p3.jsonl"), "utf8");
  await st.append("desk", "chat-p3.jsonl", line);
  await st.page.waitFor(`window.__spoken.length >= 3`, 15000);
  await Bun.sleep(1000);
  const spoken = await st.page.eval("window.__spoken");
  expect(spoken).not.toContain("Let me run the tests before I answer.");
  expect(spoken).toEqual(["The tests pass and the page loads on the phone.", "1. Merge the branch", "2. Turn on the advisor"]);
});
