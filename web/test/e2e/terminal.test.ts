// web/test/e2e/terminal.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readable } from "./readable";
import { startStack, type Stack } from "./stack";

let st: Stack;
beforeAll(async () => {
  st = await startStack({ fixtures: { desk: ["shell:term-p3"], laptop: [] } });
  await st.page.phone();
  await st.page.goto(st.termUrl("desk", "shell:term-p3"));
  await st.page.waitFor(`!!document.querySelector("[data-test=terminal] .xterm-screen")`, 10000);
});
afterAll(async () => { await st?.stop(); });

const screen = () => st.screen("desk", "shell:term-p3"); // GET /v1/sessions/:id/screen text

test("typing reaches the session and the toolbar is readable", async () => {
  await st.page.click("[data-test=terminal]"); await st.page.type("echo p3-one\r");
  await st.waitFor(async () => (await screen()).includes("p3-one"));
  expect(await readable(st.page, "[data-test=toolbar]")).toEqual([]);
});

test("Ctrl: one tap makes the next key a control key; a double tap locks it", async () => {
  await st.page.type("sleep 30"); await st.page.click("[data-key=Ctrl]");
  expect(await st.page.eval(`document.querySelector("[data-key=Ctrl]").dataset.latch`)).toBe("once");
  await st.page.type("c");
  expect(await st.page.eval(`document.querySelector("[data-key=Ctrl]").dataset.latch`)).toBe("off");
  await st.page.type("echo p3-after-ctrl-c\r");
  await st.waitFor(async () => (await screen()).includes("p3-after-ctrl-c"));
  await st.page.click("[data-key=Ctrl]"); await st.page.click("[data-key=Ctrl]");
  expect(await st.page.eval(`document.querySelector("[data-key=Ctrl]").dataset.latch`)).toBe("locked");
  expect(await st.page.eval(`document.querySelector("[data-key=Ctrl]").innerText`)).toContain("Ctrl locked");
  await st.page.click("[data-key=Ctrl]");
  expect(await st.page.eval(`document.querySelector("[data-key=Ctrl]").dataset.latch`)).toBe("off");
});

test("text size −/+ and the shortcut panel", async () => {
  expect(await st.page.eval(`document.querySelector("[data-test=terminal]").dataset.fontPx`)).toBe("14");
  await st.page.click("[data-key=Bigger]");
  await st.page.waitFor(`document.querySelector("[data-test=terminal]").dataset.fontPx === "16"`, 3000);
  await st.page.click("[data-key=Smaller]");
  await st.page.waitFor(`document.querySelector("[data-test=terminal]").dataset.fontPx === "14"`, 3000);
  await st.page.click("[data-key=Shortcuts]");
  await st.page.waitFor(`!!document.querySelector("[data-test=shortcut-panel]")`, 3000);
  expect(await readable(st.page, "[data-test=shortcut-panel]")).toEqual([]);
  await st.page.key("Escape");
});

test("one-finger swipe left/right moves the tmux window (the desk sees the same window)", async () => {
  expect(await st.tmuxFormat("desk", "shell:term-p3", "#{window_index}")).toBe("0");
  await st.page.swipe({ x: 320, y: 450, dx: -220, dy: 0 });
  await st.waitFor(async () => (await st.tmuxFormat("desk", "shell:term-p3", "#{window_index}")) === "1");
  await st.page.swipe({ x: 100, y: 450, dx: 220, dy: 0 });
  await st.waitFor(async () => (await st.tmuxFormat("desk", "shell:term-p3", "#{window_index}")) === "0");
});

test("P3-3b: after the connection is cut the terminal re-attaches to the same session", async () => {
  const before = st.proxies.desk.count("/v1/sessions/");
  st.proxies.desk.block("/v1/sessions/", true); st.proxies.desk.drop("/v1/sessions/");
  await st.page.waitFor(`document.querySelector("[data-test=strip]")?.innerText.includes("Reconnecting…")`, 5000);
  st.proxies.desk.block("/v1/sessions/", false);
  await st.page.waitFor(`document.querySelector("[data-test=terminal]")?.dataset.state === "up"`, 20000);
  expect(st.proxies.desk.count("/v1/sessions/")).toBeGreaterThan(before);
  expect(st.proxies.desk.lastUpgradePath("/v1/sessions/")).toContain(encodeURIComponent(st.sessionId("desk", "shell:term-p3")));
  await st.page.click("[data-test=terminal]"); await st.page.type("echo p3-reattached\r");
  await st.waitFor(async () => (await screen()).includes("p3-reattached"));
  await st.page.shot("p3-3-terminal-reattached");
});
