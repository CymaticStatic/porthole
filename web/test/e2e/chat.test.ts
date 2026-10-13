// web/test/e2e/chat.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { readable } from "./readable";
import { startStack, type Stack } from "./stack";

const CLIP = `window.__copied = []; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { window.__copied.push(t); }, readText: async () => "" } });`;
const box = `document.querySelector("[data-test=composer] textarea")`;
const keyRow = `[...document.querySelectorAll("[data-test=keyrow] button")]`;

let st: Stack; let url: string;
beforeAll(async () => {
  st = await startStack({ fixtures: { desk: ["chat-p3.jsonl"], laptop: [] } });
  await st.page.onNewDocument(CLIP);
  await st.page.phone();
  url = st.chatUrl("desk", "chat-p3.jsonl");
  await st.page.goto(url);
  await st.page.waitFor(`document.querySelectorAll("[data-test=bubble]").length >= 4`, 10000);
});
afterAll(async () => { await st?.stop(); });

test("P3-1: user, table, live-delegation and collapsed tools are readable at 412 px", async () => {
  expect(await readable(st.page, "[data-test=chat]")).toEqual([]);
  expect(await st.page.eval(`!!document.querySelector("[data-test=chat] .table-scroll table")`)).toBe(true);
  expect(await st.page.eval(`document.querySelector("[data-via=live-voice]")?.innerText`)).toContain("Also check the tests");
  expect(await st.page.eval(`[...document.querySelectorAll("[data-test=chat] details")].map(d => [d.open, d.querySelector("summary").innerText])`)).toEqual([[false, "Used 2 tools: read, grep"]]);
  expect(await st.page.eval(`document.querySelectorAll("[data-test=chat] script, [data-test=chat] [onerror]").length`)).toBe(0);
  await st.page.shot("p3-1-chat");
});

test("key row: Esc ↑ ↓ Enter Tab Stop, Stop sends Esc, no Ctrl+C anywhere in the chat view", async () => {
  expect(await st.page.eval(`${keyRow}.slice(0, 6).map(b => b.innerText.trim())`)).toEqual(["Esc", "↑", "↓", "Enter", "Tab", "Stop"]);
  expect(await st.page.eval(`[...document.querySelectorAll("#view button")].filter(b => /ctrl\\s*\\+?\\s*c/i.test(b.innerText) || b.dataset.key === "C-c").length`)).toBe(0);
  await st.page.click(`[data-test=keyrow] [data-key=Stop]`);
  await st.waitFor(async () => st.proxies.desk.requests("/v1/sessions/").some((r) => r.method === "POST" && r.path.endsWith("/keys")));
  const keys = st.proxies.desk.requests("/v1/sessions/").filter((r) => r.method === "POST" && r.path.endsWith("/keys"));
  expect(keys.at(-1).body).toEqual({ keys: ["Esc"] });
  expect(keys.at(-1).path).toContain(encodeURIComponent(st.sessionId("desk", "chat-p3.jsonl")));
});

test("live voice at the desk: the key row is disabled and says why, then comes back", async () => {
  await st.setLiveVoice("desk", "chat-p3.jsonl", true);
  await st.page.waitFor(`${keyRow}.every(b => b.disabled)`, 15000);
  expect(await st.page.eval(`document.querySelector("[data-test=keyrow-note]").innerText`)).toBe("Live voice is on at the desk: keys go to the live panel (Space mutes, Esc ends it)");
  expect(await readable(st.page, "[data-test=keyrow]")).toEqual([]);
  await st.page.shot("p3-live-voice-keys");
  await st.setLiveVoice("desk", "chat-p3.jsonl", false);
  await st.page.waitFor(`${keyRow}.every(b => !b.disabled) && !document.querySelector("[data-test=keyrow-note]")`, 15000);
});

test("P3-2d: a send made while the machine is unreachable is held, then B1 sends it exactly once on reconnect and D1's fleet-level send-result listener applies the result", async () => {
  const sends = () => st.proxies.desk.requests("/v1/sessions/").filter((r) => r.method === "POST" && r.path.endsWith("/send"));
  const before = sends().length;
  st.proxies.desk.block("/v1/events", true); st.proxies.desk.drop("/v1/events");
  await st.page.waitFor(`document.querySelector("[data-test=strip]")?.innerText.includes("Reconnecting…")`, 5000);
  await st.page.click("[data-test=composer] textarea"); await st.page.type("held until the link is back");
  await st.page.click("[data-test=send]");
  await st.page.waitFor(`document.querySelector("[data-test=send-status]")?.innerText.includes("Not sent yet")`, 5000);
  expect(sends().length).toBe(before);
  st.proxies.desk.block("/v1/events", false);
  await st.waitFor(async () => sends().length === before + 1, 20000);
  await st.page.waitFor(`${box}.value === ""`, 10000);
  await st.page.waitFor(`!document.querySelector("[data-test=send-status]")?.innerText.includes("Not sent yet")`, 5000);
  await Bun.sleep(1500);
  expect(sends().length).toBe(before + 1);
  expect(sends().at(-1).body.text).toBe("held until the link is back");
  // the sent-history entry exists only because D1's fleet-level listener applied B1's onSendResult action (`addSent`); P3-2e proves the same with the chat closed
  expect(await st.page.eval(`Object.keys(localStorage).filter((k) => k.startsWith("porthole:sent:")).flatMap((k) => JSON.parse(localStorage.getItem(k))).filter((i) => i.text === "held until the link is back").map((i) => i.status)`)).toEqual(["delivered"]);
});

test("sent history: the held send that B1 delivered (recorded by D1's fleet-level listener) can be reopened, copied and put back", async () => {
  await st.page.click("[data-test=sent-open]");
  await st.page.waitFor(`document.querySelectorAll("[data-test=sent-item]").length >= 1`, 5000);
  expect(await readable(st.page, "[data-test=sent]")).toEqual([]);
  expect(await st.page.eval(`document.querySelector("[data-test=sent-item]").innerText`)).toContain("held until the link is back");
  await st.page.click("[data-test=sent-item] [data-test=sent-copy]");
  expect(await st.page.eval("window.__copied")).toEqual(["held until the link is back"]);
  await st.page.click("[data-test=sent-item] [data-test=sent-putback]");
  await st.page.waitFor(`${box}.value === "held until the link is back"`, 5000);
  await st.page.eval(`(() => { const t = ${box}; t.value = ""; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
});

test("P3-2e: a send held while the chat is closed is still delivered once, clears the draft and lands in the sent history", async () => {
  const sends = () => st.proxies.desk.requests("/v1/sessions/").filter((r) => r.method === "POST" && r.path.endsWith("/send"));
  const TEXT = "sent from the inbox side";
  const chatHash = new URL(url).hash;
  const before = sends().length;
  st.proxies.desk.block("/v1/events", true); st.proxies.desk.drop("/v1/events");
  await st.page.waitFor(`document.querySelector("[data-test=strip]")?.innerText.includes("Reconnecting…")`, 5000);
  await st.page.click("[data-test=composer] textarea"); await st.page.type(TEXT);
  await st.page.click("[data-test=send]");
  await st.page.waitFor(`document.querySelector("[data-test=send-status]")?.innerText.includes("Not sent yet")`, 5000);
  expect(sends().length).toBe(before);
  // leave the chat: no composer is mounted, so nothing view-level can hear the result
  await st.page.eval(`location.hash = "#/inbox"`);
  await st.page.waitFor(`!document.querySelector("[data-test=composer]")`, 5000);
  st.proxies.desk.block("/v1/events", false);
  await st.waitFor(async () => sends().length === before + 1, 20000);
  const sentTexts = `Object.keys(localStorage).filter((k) => k.startsWith("porthole:sent:")).flatMap((k) => JSON.parse(localStorage.getItem(k))).filter((i) => i.text === ${JSON.stringify(TEXT)}).map((i) => i.status)`;
  const draftTexts = `Object.keys(localStorage).filter((k) => k.startsWith("porthole:draft:")).flatMap((k) => { const d = JSON.parse(localStorage.getItem(k)); return d && d.text ? [d.text] : []; })`;
  // still on the inbox: D1's listener has already cleared the draft and recorded the message
  await st.page.waitFor(`${sentTexts}.length === 1`, 10000);
  expect(await st.page.eval(sentTexts)).toEqual(["delivered"]);
  expect(await st.page.eval(draftTexts)).toEqual([]);
  await Bun.sleep(1500);
  expect(sends().length).toBe(before + 1);
  expect(sends().at(-1).body.text).toBe(TEXT);
  // reopen the chat: the draft is empty and the sent history holds the message
  await st.page.eval(`location.hash = ${JSON.stringify(chatHash)}`);
  await st.page.waitFor(`document.querySelector("[data-test=composer] textarea")`, 10000);
  expect(await st.page.eval(`${box}.value`)).toBe("");
  await st.page.click("[data-test=sent-open]");
  await st.page.waitFor(`[...document.querySelectorAll("[data-test=sent-item]")].some((i) => i.innerText.includes(${JSON.stringify(TEXT)}))`, 5000);
  expect(sends().length).toBe(before + 1);
  // remount the chat so the sheet is closed for the tests that follow
  await st.page.eval(`location.hash = "#/inbox"`);
  await st.page.waitFor(`!document.querySelector("[data-test=composer]")`, 5000);
  await st.page.eval(`location.hash = ${JSON.stringify(chatHash)}`);
  await st.page.waitFor(`document.querySelector("[data-test=composer] textarea")`, 10000);
});

test("attachments: a chosen file and a pasted image each put their full uploaded path in the message", async () => {
  expect(await st.page.eval(`(() => { const c = document.querySelector("[data-test=attach-camera]"), p = document.querySelector("[data-test=attach-photo]"); return [c.accept, c.getAttribute("capture"), p.accept]; })()`)).toEqual(["image/*", "environment", "image/*"]);
  await st.page.click("[data-test=attach]");
  await st.page.setFiles("[data-test=attach-file]", [path.join(import.meta.dir, "..", "fixtures", "chat-p3.jsonl")]);
  await st.page.waitFor(`${box}.value.trim().split("\\n").length === 1`, 10000);
  await st.page.eval(`(() => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "shot.png", { type: "image/png" })); ${box}.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
  await st.page.waitFor(`${box}.value.trim().split("\\n").length === 2`, 10000);
  const lines: string[] = (await st.page.eval(`${box}.value`)).trim().split("\n");
  expect(st.proxies.desk.requests("/v1/uploads").filter((r) => r.method === "POST").length).toBe(2);
  for (const l of lines) { expect(l.startsWith("/")).toBe(true); expect(existsSync(l)).toBe(true); }
  expect(lines[1].endsWith(".png")).toBe(true);
  expect(await st.page.eval(`document.querySelectorAll("[data-test=attach-chip]").length`)).toBe(2);
  await st.page.click("[data-test=send]");
  await st.page.waitFor(`${box}.value === ""`, 10000);
  const sent = st.proxies.desk.requests("/v1/sessions/").filter((r) => r.method === "POST" && r.path.endsWith("/send")).at(-1);
  expect(sent.body.text.trim().split("\n")).toEqual(lines);
});

test("P3-2a: reloading mid-draft keeps the draft", async () => {
  await st.page.click("[data-test=composer] textarea");
  await st.page.type("half a thought about the plan");
  await st.page.reload();
  await st.page.waitFor(`document.querySelector("[data-test=composer] textarea")?.value === "half a thought about the plan"`, 10000);
});

test("P3-2b: a send that cannot reach the machine keeps the draft and says why", async () => {
  st.proxies.desk.failNext("/v1/sessions/");
  await st.page.click("[data-test=send]");
  await st.page.waitFor(`document.querySelector("[data-test=send-status]")?.innerText.includes("Not sent yet")`, 10000);
  expect(await st.page.eval(`document.querySelector("[data-test=composer] textarea").value`)).toBe("half a thought about the plan");
});

test("P3-2c: a send hostd refuses or fails keeps the draft and shows hostd's reason", async () => {
  await st.killPane("desk", "chat-p3.jsonl");
  await st.page.click("[data-test=send]");
  await st.page.waitFor(`document.querySelector("[data-test=send-status]")?.innerText.includes("Couldn't send")`, 15000);
  const why = await st.page.eval(`document.querySelector("[data-test=send-reason]").innerText`);
  expect(why.length).toBeGreaterThan(0);
  expect(await st.page.eval(`document.querySelector("[data-test=composer] textarea").value`)).toBe("half a thought about the plan");
  await st.page.shot("p3-2-send-failed");
});
