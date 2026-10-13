import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { pidsWithArg } from "./browser";
import { startStack, type Stack } from "./stack";

let st: Stack;
beforeAll(async () => { st = await startStack({ fixtures: { desk: ["chat-p3.jsonl"], laptop: [] } }); }, 120_000);
afterAll(async () => { await st?.stop(); });

test("the page loads over the mapped TLS name with security headers", async () => {
  const r = await st.page.eval(`fetch("/").then(r => ({ s: r.status, csp: r.headers.get("content-security-policy"), n: r.headers.get("x-content-type-options") }))`);
  expect(r.s).toBe(200);
  expect(r.csp).toContain("script-src 'self'");
  expect(r.n).toBe("nosniff");
  expect(await st.page.eval("location.origin")).toBe("https://testdesk.example.ts.net");
});

test("an API call from the page reaches hostd with X-Porthole", async () => {
  const r = await st.page.eval(`fetch("/v1/sessions", { headers: { "X-Porthole": "1" } }).then(r => r.json())`);
  expect(r.machine).toBe("testdesk");
});

test("stop() ends the recorded Chromium and leaves nothing on its profile", async () => {
  const { pid, profileDir } = st.chrome;
  expect(pid).toBeGreaterThan(0);
  expect(pidsWithArg(`--user-data-dir=${profileDir}`)).toContain(pid);
  await st.stop();
  expect(existsSync(`/proc/${pid}`)).toBe(false);
  expect(pidsWithArg(`--user-data-dir=${profileDir}`)).toEqual([]);
});
