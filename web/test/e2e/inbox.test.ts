// web/test/e2e/inbox.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readable } from "./readable";
import { startStack, type Stack } from "./stack";

let st: Stack;
beforeAll(async () => {
  st = await startStack({ fixtures: { desk: ["status-needs-you.jsonl", "status-done.jsonl"], laptop: ["status-working.jsonl", "status-done.jsonl"] } });
  await st.emitQuestion("desk", "status-needs-you.jsonl", { qid: "q-p3", questions: [{ id: "q1", question: "Which plan should I use?", options: ["Small", "Large"], multi: false }] });
  await st.emitEvent("laptop", "status-working.jsonl", { type: "working" });
  await st.emitEvent("desk", "status-done.jsonl", { type: "turn_finished" });
  await st.emitEvent("laptop", "status-done.jsonl", { type: "turn_finished" });
  await st.page.phone(); await st.page.goto("https://testdesk.example.ts.net/#/inbox");
  await st.page.waitFor(`document.querySelectorAll("[data-test=inbox-card]").length >= 4`, 10000);
});
afterAll(async () => { await st?.stop(); });

test("P3-1: the inbox is readable at 412 px with both machines' items", async () => {
  expect(await readable(st.page, "[data-test=inbox]")).toEqual([]);
  const t = await st.page.eval(`document.querySelector("[data-test=inbox]").innerText`);
  for (const s of ["Needs you", "Working", "Done", "Which plan should I use?", "testlaptop"]) expect(t).toContain(s);
  await st.page.shot("p3-1-inbox");
});

test("an option button answers through hostd", async () => {
  await st.page.click("[data-test=inbox-card] [data-option='1']");
  await st.page.waitFor(`document.querySelector("[data-test=inbox-card]")?.innerText.includes("Answered: Large")`, 10000);
});

test("cards are grouped by project, then machine", async () => {
  const shape = await st.page.eval(`[...document.querySelectorAll("[data-test=inbox-card]")].map(c => [!!c.closest("[data-test=inbox-group]"), c.closest("[data-test=inbox-machine]")?.dataset.machine === c.dataset.machine])`);
  expect(shape.length).toBeGreaterThanOrEqual(4);
  for (const s of shape) expect(s).toEqual([true, true]);
  const done = await st.page.eval(`[...document.querySelectorAll("[data-test=section-done] [data-test=inbox-machine]")].map(m => m.dataset.machine).sort()`);
  expect(done).toEqual(["testdesk", "testlaptop"]);
});

test("Stop on a working card sends Esc to that session on its own machine", async () => {
  await st.page.click(`[data-test=inbox-card][data-column=working][data-machine=testlaptop] [data-action=stop]`);
  await st.waitFor(async () => st.proxies.laptop.requests("/v1/sessions/").some((r) => r.method === "POST" && r.path.endsWith("/keys")));
  const k = st.proxies.laptop.requests("/v1/sessions/").filter((r) => r.method === "POST" && r.path.endsWith("/keys")).at(-1);
  expect(k.body).toEqual({ keys: ["Esc"] });
  expect(k.path).toContain(encodeURIComponent(st.sessionId("laptop", "status-working.jsonl")));
});

test("swiping any card left archives it (a Working card here)", async () => {
  // Item ids repeat across machines ("i1" on each), so the machine is part of every selector.
  const id = await st.page.eval(`document.querySelector("[data-test=inbox-card][data-column=working][data-machine=testlaptop]").dataset.item`);
  const sel = `[data-test=inbox-card][data-item='${id}'][data-machine=testlaptop]`;
  const box = await st.page.eval(`(() => { const r = document.querySelector("${sel}").getBoundingClientRect(); return { x: r.right - 20, y: r.top + r.height / 2 }; })()`);
  await st.page.swipe({ x: box.x, y: box.y, dx: -200, dy: 0 });
  await st.page.waitFor(`!document.querySelector("${sel}")`, 10000);
  expect(st.proxies.laptop.requests("/v1/inbox/").filter((r) => r.method === "POST").map((r) => r.path)).toContain(`/v1/inbox/${encodeURIComponent(id)}/archive`);
});
