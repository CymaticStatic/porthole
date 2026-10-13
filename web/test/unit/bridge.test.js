import { expect, test } from "bun:test";
import { createBridge } from "../../src/net/bridge.js";

test("in a plain browser every call resolves to null", async () => {
  const b = createBridge({});
  expect(b.available).toBe(false);
  expect(await b.call("speak", { text: "hi" })).toBeNull();
});
test("with PortholeNative: request/response by id, events by name, unknown methods refused", async () => {
  const sent = []; const native = { postMessage: (s) => sent.push(JSON.parse(s)), onmessage: null };
  const b = createBridge({ PortholeNative: native });
  const p = b.call("machines", {});
  native.onmessage({ data: JSON.stringify({ id: sent[0].id, ok: true, result: [{ name: "testdesk", origin: "https://testdesk.example.ts.net" }] }) });
  expect(await p).toEqual([{ name: "testdesk", origin: "https://testdesk.example.ts.net" }]);
  let seen = null; b.on("network", (d) => (seen = d));
  native.onmessage({ data: JSON.stringify({ event: "network", data: { online: true } }) });
  expect(seen).toEqual({ online: true });
  await expect(b.call("readFile", {})).rejects.toThrow("not allowed");
  expect(sent.length).toBe(1);
});
test("a native error answer rejects with its message; off() stops an event listener", async () => {
  const sent = []; const native = { postMessage: (s) => sent.push(JSON.parse(s)), onmessage: null };
  const b = createBridge({ PortholeNative: native });
  const p = b.call("pickFile", {});
  native.onmessage({ data: JSON.stringify({ id: sent[0].id, ok: false, error: "Cancelled" }) });
  await expect(p).rejects.toThrow("Cancelled");
  let n = 0; const off = b.on("network", () => n++);
  native.onmessage({ data: JSON.stringify({ event: "network", data: {} }) });
  off();
  native.onmessage({ data: JSON.stringify({ event: "network", data: {} }) });
  expect(n).toBe(1);
});

const emit = (native, event, data) => native.onmessage({ data: JSON.stringify({ event, data }) });

test("share events with no listener wait, and the first listener gets them in order; later ones arrive live", () => {
  const native = { postMessage() {}, onmessage: null };
  const b = createBridge({ PortholeNative: native });
  emit(native, "share", { path: "/a" });
  emit(native, "share", { path: "/b" });
  expect(b.pendingShares()).toBe(2);
  const seen = []; const off = b.on("share", (d) => seen.push(d.path));
  expect(seen).toEqual(["/a", "/b"]);
  expect(b.pendingShares()).toBe(0);
  emit(native, "share", { path: "/c" });
  expect(seen).toEqual(["/a", "/b", "/c"]);
  off();
  emit(native, "share", { path: "/d" });
  expect(b.pendingShares()).toBe(1);
  const again = []; b.on("share", (d) => again.push(d.path));
  expect(again).toEqual(["/d"]);
});
test("only share events are kept: other events with no listener are dropped", () => {
  const native = { postMessage() {}, onmessage: null };
  const b = createBridge({ PortholeNative: native });
  emit(native, "network", { online: true });
  expect(b.pendingShares()).toBe(0);
  let n = 0; b.on("network", () => n++);
  expect(n).toBe(0);
});
test("at most 10 shares are kept, the newest; a second share listener only hears new ones", () => {
  const native = { postMessage() {}, onmessage: null };
  const b = createBridge({ PortholeNative: native });
  for (let i = 1; i <= 12; i++) emit(native, "share", { path: `/f${i}` });
  expect(b.pendingShares()).toBe(10);
  const first = []; b.on("share", (d) => first.push(d.path));
  expect(first).toEqual(Array.from({ length: 10 }, (_, i) => `/f${i + 3}`));
  const second = []; b.on("share", (d) => second.push(d.path));
  expect(second).toEqual([]);
  emit(native, "share", { path: "/live" });
  expect(first.at(-1)).toBe("/live");
  expect(second).toEqual(["/live"]);
});
test("onShareQueued fires for each share nobody was listening for, and stops after off()", () => {
  const native = { postMessage() {}, onmessage: null };
  const b = createBridge({ PortholeNative: native });
  let n = 0; const off = b.onShareQueued(() => n++);
  emit(native, "share", { path: "/a" });
  emit(native, "share", { path: "/b" });
  expect(n).toBe(2);
  b.on("share", () => {});
  emit(native, "share", { path: "/c" });
  expect(n).toBe(2);
  off();
});
