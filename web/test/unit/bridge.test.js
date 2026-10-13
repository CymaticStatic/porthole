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
