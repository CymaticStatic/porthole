// web/test/e2e/settings.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readable } from "./readable";
import { startStack, type Stack } from "./stack";

let st: Stack;
beforeAll(async () => { st = await startStack({ fixtures: { desk: [], laptop: [] } }); await st.page.phone(); });
afterAll(async () => { await st?.stop(); });

test("talk toggles and a remapped gesture are saved on this device", async () => {
  await st.page.goto("https://testdesk.example.ts.net/#/settings");
  await st.page.waitFor(`!!document.querySelector("[data-test=talk-auto-send]")`, 10000);
  await st.page.click("[data-test=talk-auto-send]");
  await st.page.click("[data-test=talk-auto-stop]");
  await st.page.eval(`(() => { const s = document.querySelector("[data-test=gesture-select][data-gesture=swipe1-left]"); s.value = "none"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  const saved = JSON.parse(await st.page.eval(`localStorage.getItem("porthole:settings")`));
  expect(saved.talkAutoSend).toBe(false);
  expect(saved.talkAutoStop).toBe(false);
  expect(saved.gestures).toEqual({ "swipe1-left": "none" });
  await st.page.click("[data-test=gesture-reset]");
  expect(JSON.parse(await st.page.eval(`localStorage.getItem("porthole:settings")`)).gestures ?? {}).toEqual({});
  expect(await readable(st.page, "[data-test=settings]")).toEqual([]);
  await st.page.shot("p3-settings-device");
});

test("a bad shortcut cannot be saved and says why; a good one round-trips through hostd", async () => {
  await st.page.goto("https://testdesk.example.ts.net/#/config/testdesk");
  await st.page.click("[data-test=shortcut-add]");
  await st.page.click("[data-test=shortcut-label]"); await st.page.type("Stop it");
  await st.page.click("[data-test=shortcut-steps]"); await st.page.type("Ctrl-C");
  expect(await st.page.eval(`document.querySelector("[data-test=shortcut-save]").disabled`)).toBe(true);
  expect(await st.page.eval(`document.querySelector("[data-test=shortcut-error]").innerText`)).toContain("Try C-c");
  await st.page.eval(`document.querySelector("[data-test=shortcut-steps]").value = ""`);
  await st.page.click("[data-test=shortcut-steps]"); await st.page.type("C-c, text:echo done\\, ok, Enter");
  await st.page.click("[data-test=shortcut-save]");
  await st.waitFor(async () => JSON.stringify(await st.api("desk", "/v1/shortcuts")).includes("Stop it"));
  expect(await readable(st.page, "[data-test=config]")).toEqual([]);
});

test("config and doctor are readable", async () => {
  await st.page.goto("https://testdesk.example.ts.net/#/config/testdesk");
  await st.page.waitFor(`document.querySelectorAll("[data-test=doctor-check]").length > 0`, 10000);
  expect(await readable(st.page, "[data-test=config]")).toEqual([]);
  await st.page.shot("p3-settings-config");
});
