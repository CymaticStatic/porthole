// web/test/e2e/acceptance.test.ts (plan E1)
// The one check no single screen's file covers: one stack with both machines, walking inbox → drawer → chat → terminal → changes
// by tapping (no `goto` after the first page load) and asserting `readable` on each screen, first at 412 px, then at a wide size
// where the sidebar is on screen without being opened. (The security greps are web/test/unit/security.test.ts.)
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readable } from "./readable";
import { startStack, type Stack } from "./stack";

const CHAT = "chat-p3.jsonl";
const WORK = "status-needs-you.jsonl";
const REPO = "repo:diff-p3";

let st: Stack;
beforeAll(async () => {
  st = await startStack({ fixtures: { desk: [CHAT, WORK, REPO], laptop: ["status-working.jsonl"] } });
  await st.emitQuestion("desk", WORK, { qid: "q-p3", questions: [{ id: "q1", question: "Which plan should I use?", options: ["Small", "Large"], multi: false }] });
  await st.emitEvent("laptop", "status-working.jsonl", { type: "working" });
  await st.page.phone();
  await st.page.goto("https://testdesk.example.ts.net/#/inbox");
  await st.page.waitFor(`document.querySelectorAll("[data-test=inbox-card]").length >= 2`, 10000);
}, 120_000);
afterAll(async () => { await st?.stop(); });

/** Opens the phone drawer (if it is closed) and waits until its slide-in has finished, so taps land where the rows are. */
async function openDrawer(): Promise<void> {
  if ((await st.page.eval(`document.querySelector("[data-test=drawer]").getAttribute("aria-hidden")`)) === "false") return;
  await st.page.click("[data-test=menu]");
  await st.page.waitFor(`document.querySelector("[data-test=drawer]")?.getAttribute("aria-hidden") === "false"`, 5000);
  await st.page.waitFor(`Math.abs(document.querySelector("[data-test=drawer]").getBoundingClientRect().left) < 1`, 5000);
}

/** Taps a sidebar row. On a phone the drawer is opened first (with the menu button); on a wide window the sidebar is already there. */
async function tapSidebar(selector: string, wide: boolean): Promise<void> {
  if (!wide) await openDrawer();
  await st.page.click(selector);
}

async function walk(wide: boolean): Promise<void> {
  const where = wide ? "wide" : "phone";
  const chatId = st.sessionId("desk", CHAT);
  const repoId = st.sessionId("desk", REPO);

  // inbox (the start screen on a phone; on a wide window reached through the sidebar)
  if (wide) await tapSidebar("[data-test=nav-inbox]", true);
  await st.page.waitFor(`location.hash === "#/inbox" && document.querySelectorAll("[data-test=inbox-card]").length >= 2`, 10000);
  expect(await readable(st.page, "[data-test=inbox]"), `inbox ${where}`).toEqual([]);
  expect(await readable(st.page, ".topbar"), `top bar on inbox ${where}`).toEqual([]);

  // the sidebar: a drawer on a phone, a permanent column on a wide window
  if (wide) {
    expect(await st.page.eval(`(() => { const d = document.querySelector("[data-test=drawer]"); return d.getAttribute("aria-hidden") === "false" && d.getBoundingClientRect().width > 0 && !document.querySelector(".shell").classList.contains("drawer-open"); })()`), "sidebar visible without opening it").toBe(true);
  } else {
    await openDrawer();
  }
  expect(await readable(st.page, "[data-test=drawer]"), `drawer ${where}`).toEqual([]);
  const side = await st.page.eval(`document.querySelector("[data-test=drawer]").innerText`);
  for (const s of ["testdesk", "testlaptop", "Inbox", "Chats", "Terminals", "Settings"]) expect(side).toContain(s);
  // the drawer stays open: the next tap is on one of its rows

  // chat
  await tapSidebar(`[data-test=chats] [data-kind=chat][data-fk="chat|testdesk|${chatId}"]`, wide);
  await st.page.waitFor(`location.hash.startsWith("#/chat/testdesk/") && document.querySelectorAll("[data-test=bubble]").length >= 4`, 10000);
  expect(await readable(st.page, "[data-test=chat]"), `chat ${where}`).toEqual([]);
  expect(await readable(st.page, ".topbar"), `top bar on chat ${where}`).toEqual([]);

  // terminal
  await tapSidebar(`[data-test=terminals][data-machine=testdesk] [data-kind=pane][data-id="${repoId}"]`, wide);
  await st.page.waitFor(`location.hash.startsWith("#/term/testdesk/") && !!document.querySelector("[data-test=terminal] .xterm-screen")`, 10000);
  expect(await readable(st.page, "[data-test=terminal]"), `terminal ${where}`).toEqual([]);
  expect(await readable(st.page, ".topbar"), `top bar on terminal ${where}`).toEqual([]);

  // changes: reached from the terminal's own top bar
  await st.page.click("[data-test=changes-link]");
  await st.page.waitFor(`location.hash.startsWith("#/changes/testdesk/") && document.querySelectorAll("[data-test=diff-file]").length === 3`, 10000);
  await st.page.eval(`document.querySelectorAll("[data-test=diff-file] details").forEach(d => d.open = true)`);
  expect(await readable(st.page, "[data-test=diff]"), `changes ${where}`).toEqual([]);
  expect(await st.page.eval(`document.documentElement.scrollWidth <= window.innerWidth`), `no sideways scroll on changes ${where}`).toBe(true);
}

test("P3 walk at 412 px: inbox → drawer → chat → terminal → changes, every screen readable", async () => {
  await walk(false);
});

test("P3 walk at a wide size: the sidebar is on screen without opening it, every screen readable", async () => {
  await st.page.wide();
  await st.page.waitFor(`document.querySelector("[data-test=drawer]")?.getAttribute("aria-hidden") === "false" && Math.abs(document.querySelector("[data-test=drawer]").getBoundingClientRect().left) < 1 && document.querySelector("[data-test=drawer]").getBoundingClientRect().width > 200`, 5000);
  await walk(true);
});

test("previews and settings are reachable from the sidebar by tapping", async () => {
  await st.page.wide();
  await st.page.click("[data-test=nav-previews][data-machine=testdesk]");
  await st.page.waitFor(`location.hash === "#/previews/testdesk" && !!document.querySelector("[data-test=previews]")`, 10000);
  expect(await readable(st.page, "[data-test=previews]")).toEqual([]);
  await st.page.click("[data-test=nav-settings]");
  await st.page.waitFor(`location.hash === "#/settings"`, 10000);
});
