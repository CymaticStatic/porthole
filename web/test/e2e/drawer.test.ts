// web/test/e2e/drawer.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readable } from "./readable";
import { startStack, type Stack } from "./stack";

let st: Stack;
beforeAll(async () => { st = await startStack({ fixtures: { desk: ["chat-p3.jsonl", "status-needs-you.jsonl", "shell:term-p3"], laptop: ["status-working.jsonl"] } }); await st.page.phone(); await st.page.goto("https://testdesk.example.ts.net/#/inbox"); });
afterAll(async () => { await st?.stop(); });

test("P3-1: the drawer is readable at 412 px and lists both machines and the groups", async () => {
  await st.page.click("[data-test=menu]");
  await st.page.waitFor(`document.querySelector("[data-test=drawer]")?.getAttribute("aria-hidden") === "false"`, 5000);
  expect(await readable(st.page, "[data-test=drawer]")).toEqual([]);
  const text = await st.page.eval(`document.querySelector("[data-test=drawer]").innerText`);
  for (const s of ["testdesk", "testlaptop", "Inbox", "Chats", "Terminals", "Settings", "Config", "1 needs you"]) expect(text).toContain(s);
  await st.page.shot("p3-1-drawer");
});

test("Terminals is a tree: socket → session → window → pane (SPEC 4.2)", async () => {
  const tree = await st.page.eval(`(() => {
    const t = document.querySelector("[data-test=terminals][data-machine=testdesk]");
    const kids = (el, kind) => [...el.querySelectorAll(":scope > [role=group] > [data-kind=" + kind + "], :scope > [data-kind=" + kind + "]")];
    return kids(t, "socket").map((so) => ({ socket: kids(so, "session").map((se) => ({ [se.dataset.label]: kids(se, "window").map((w) => [w.dataset.label, kids(w, "pane").length]) })) }));
  })()`);
  expect(tree.length).toBe(1);
  expect(tree[0].socket.find((x: Record<string, unknown>) => "term-p3" in x)).toEqual({ "term-p3": [["Window 0", 1], ["Window 1", 1]] });
  await st.page.click(`[data-test=terminals][data-machine=testdesk] [data-kind=pane][data-id="${st.sessionId("desk", "shell:term-p3")}"]`);
  await st.page.waitFor(`location.hash.startsWith("#/term/testdesk/")`, 5000);
  await st.page.click("[data-test=menu]");
  await st.page.waitFor(`document.querySelector("[data-test=drawer]")?.getAttribute("aria-hidden") === "false"`, 5000);
});

test("Esc closes the drawer and returns focus to the menu button", async () => {
  await st.page.key("Escape");
  expect(await st.page.eval(`document.activeElement?.dataset.test`)).toBe("menu");
});

test("P3-3a: cutting the events socket shows Reconnecting… and recovers by itself", async () => {
  st.proxies.desk.block("/v1/events", true); st.proxies.desk.drop("/v1/events");
  await st.page.waitFor(`document.querySelector("[data-test=strip]")?.innerText.includes("Reconnecting…")`, 5000);
  await st.page.shot("p3-3-reconnecting");
  st.proxies.desk.block("/v1/events", false);
  await st.page.waitFor(`!document.querySelector("[data-test=strip]")?.innerText.includes("Reconnecting…")`, 20000);
  expect(st.proxies.desk.count("/v1/events")).toBeGreaterThanOrEqual(2);
});
