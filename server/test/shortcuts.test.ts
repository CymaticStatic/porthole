import { afterAll, beforeAll, expect, test } from "bun:test";
import { statSync } from "node:fs";
import path from "node:path";
import { asRecord, asString } from "../src/json";
import { shortcutsFeature, splitSteps } from "../src/features/shortcuts";
import { get, localHeaders, startTestHostd, type TestHostd } from "./helpers/client";
import { Scratch, useTestTimeout } from "./helpers/scratch";

useTestTimeout();

let s: Scratch;
let h: TestHostd;
beforeAll(async () => {
  s = new Scratch();
  h = await startTestHostd(s, [shortcutsFeature]);
});
afterAll(async () => {
  await h.stop();
  s.cleanup();
});

function put(host: TestHostd, p: string, body: unknown): Promise<Response> {
  return fetch(host.url + p, { method: "PUT", headers: { ...localHeaders(host), Origin: host.config.origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function errorOf(r: Response): Promise<string> {
  return asString(asRecord(await r.json()).error);
}

test("shortcuts round-trip and are checked with P1's step rules", async () => {
  expect(await (await get(h, "/v1/shortcuts")).json()).toEqual({ shortcuts: [] });
  const good = [{ label: "next window", steps: "C-b, n" }, { label: "clear", steps: "text:/clear, Enter" }];
  expect((await put(h, "/v1/shortcuts", { shortcuts: good })).status).toBe(200);
  expect(await (await get(h, "/v1/shortcuts")).json()).toEqual({ shortcuts: good });
  expect(statSync(path.join(h.config.stateDir, "shortcuts.json")).mode & 0o777).toBe(0o600);
  const bad = await put(h, "/v1/shortcuts", { shortcuts: [{ label: "x", steps: "C-b, Bogus" }] });
  expect(bad.status).toBe(400);
  expect(await errorOf(bad)).toStartWith("shortcut \"x\": ");
  expect((await put(h, "/v1/shortcuts", { shortcuts: [{ label: "a", steps: "Esc" }, { label: "a", steps: "Tab" }] })).status).toBe(400);
  expect(await (await get(h, "/v1/shortcuts")).json()).toEqual({ shortcuts: good });
});

test("a text: step holds a comma only when it is written \\,", async () => {
  expect(splitSteps("text:a\\, b, Enter")).toEqual(["text:a, b", "Enter"]);
  const ok = await put(h, "/v1/shortcuts", { shortcuts: [{ label: "comma", steps: "text:a\\, b, Enter" }] });
  expect(ok.status).toBe(200);
  expect(await (await get(h, "/v1/shortcuts")).json()).toEqual({ shortcuts: [{ label: "comma", steps: "text:a\\, b, Enter" }] });
  const split = await put(h, "/v1/shortcuts", { shortcuts: [{ label: "bad", steps: "text:hello, world" }] });
  expect(split.status).toBe(400);
  expect(await errorOf(split)).toStartWith("shortcut \"bad\": ");
});

test("splitSteps trims every part, keeps other backslashes and leaves empty parts to be refused", () => {
  expect(splitSteps("text:ls , Enter")).toEqual(["text:ls", "Enter"]);
  expect(splitSteps("text:a\\b")).toEqual(["text:a\\b"]);
  expect(splitSteps("text:a\\\\, b")).toEqual(["text:a\\, b"]);
  expect(splitSteps("Esc,, Tab")).toEqual(["Esc", "", "Tab"]);
  expect(splitSteps("\\,")).toEqual([","]);
});

test("limits: empty step, label length, 50 shortcuts, wrong shapes", async () => {
  expect(await (await get(h, "/v1/shortcuts")).json()).toEqual({ shortcuts: [{ label: "comma", steps: "text:a\\, b, Enter" }] });
  expect((await put(h, "/v1/shortcuts", { shortcuts: [{ label: "e", steps: "Esc," }] })).status).toBe(400);
  expect((await put(h, "/v1/shortcuts", { shortcuts: [{ label: "", steps: "Esc" }] })).status).toBe(400);
  expect((await put(h, "/v1/shortcuts", { shortcuts: [{ label: "x".repeat(41), steps: "Esc" }] })).status).toBe(400);
  expect((await put(h, "/v1/shortcuts", { shortcuts: [{ label: "x".repeat(40), steps: "Esc" }] })).status).toBe(200);
  const many = Array.from({ length: 51 }, (_, i) => ({ label: "s" + i, steps: "Esc" }));
  expect((await put(h, "/v1/shortcuts", { shortcuts: many })).status).toBe(400);
  expect((await put(h, "/v1/shortcuts", { shortcuts: many.slice(0, 50) })).status).toBe(200);
  expect((await put(h, "/v1/shortcuts", { shortcuts: [{ label: "t", steps: Array(33).fill("Tab").join(",") }] })).status).toBe(400);
  expect((await put(h, "/v1/shortcuts", { shortcuts: [{ label: "n", steps: 5 }] })).status).toBe(400);
  expect((await put(h, "/v1/shortcuts", { shortcuts: "Esc" })).status).toBe(400);
  expect((await put(h, "/v1/shortcuts", [])).status).toBe(400);
});
