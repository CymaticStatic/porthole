import { afterAll, beforeAll, expect, test } from "bun:test";
import { readable } from "./readable";
import { startStack, type Stack } from "./stack";

let st: Stack;
beforeAll(async () => {
  st = await startStack({ fixtures: { desk: ["repo:diff-p3"], laptop: [] } }); // "repo:<name>" = a scratch git repo with one staged edit, one unstaged edit with a 200-char line, one new file, and a plain shell pane in it
  await st.page.phone();
}, 120_000);
afterAll(async () => { await st?.stop(); });

test("P3-1: a diff is readable at 412 px, long lines wrap, no sideways page scroll", async () => {
  await st.page.goto(st.changesUrl("desk", "repo:diff-p3"));
  await st.page.waitFor(`document.querySelectorAll("[data-test=diff-file]").length === 3`, 10000);
  await st.page.eval(`document.querySelectorAll("[data-test=diff-file] details").forEach(d => d.open = true)`);
  expect(await readable(st.page, "[data-test=diff]")).toEqual([]);
  expect(await st.page.eval(`document.querySelector("[data-test=diff]").innerText`)).toMatch(/Staged[\s\S]*Not staged[\s\S]*New files/);
  // the 200-character line is on screen in full (wrapped), not cut off
  expect(await st.page.eval(`document.querySelector("[data-test=diff]").innerText.includes("x".repeat(200))`)).toBe(true);
  expect(await st.page.eval(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true);
  await st.page.shot("p3-1-diff");
});

test("P3-1: on a wide window the diff shows old and new side by side", async () => {
  await st.page.wide();
  await st.page.waitFor(`document.querySelectorAll("[data-test=diff] .sbs-row").length > 0`, 10000);
  await st.page.eval(`document.querySelectorAll("[data-test=diff-file] details").forEach(d => d.open = true)`);
  expect(await readable(st.page, "[data-test=diff]")).toEqual([]);
  await st.page.shot("p3-1-diff-wide");
  await st.page.phone();
  await st.page.waitFor(`document.querySelectorAll("[data-test=diff] .sbs-row").length === 0`, 10000);
});

test("previews and usage are readable", async () => {
  await st.page.goto("https://testdesk.example.ts.net/#/previews/testdesk");
  await st.page.waitFor(`!!document.querySelector("[data-test=previews]")`, 10000);
  expect(await readable(st.page, "[data-test=previews]")).toEqual([]);
  await st.page.goto("https://testdesk.example.ts.net/#/usage");
  await st.page.waitFor(`!!document.querySelector("[data-test=usage]")`, 10000);
  expect(await readable(st.page, "[data-test=usage]")).toEqual([]);
});
