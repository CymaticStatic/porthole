import { afterAll, beforeAll, expect, test } from "bun:test";
import path from "node:path";
import { parseSs, refusedReason } from "../src/preview/scan";
import { previewFeature } from "../src/features/preview";
import { get, rawUpgrade, startTestHostd } from "./helpers/client";
import type { TestHostd } from "./helpers/client";
import { Scratch } from "./helpers/scratch";

let s: Scratch;
let h: TestHostd;
let up: Bun.Subprocess<"ignore", "pipe", "inherit">;
let P = 0;
let proxyPort = 0;
beforeAll(async () => {
  s = new Scratch();
  up = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "preview-upstream.ts")], { stdout: "pipe" });
  const reader = (up.stdout as ReadableStream<Uint8Array>).getReader();
  P = Number(new TextDecoder().decode((await reader.read()).value).trim());
  const lines = [
    "LISTEN 0 512 127.0.0.1:" + P + " 0.0.0.0:* users:((\"bun\",pid=" + up.pid + ",fd=5))",
    "LISTEN 0 512 127.0.0.1:8795 0.0.0.0:* users:((\"bun\",pid=" + up.pid + ",fd=6))",
    "LISTEN 0 512 127.0.0.1:9224 0.0.0.0:* users:((\"chrome\",pid=1,fd=7))",
  ];
  s.writeFake("ss", "#!/bin/sh\ncat <<'EOF'\n" + lines.join("\n") + "\nEOF\n");
  h = await startTestHostd(s, [previewFeature], { previewRanges: "1024-65535" });
  const list = (await (await get(h, "/v1/previews")).json()) as { proxy: { port: number } };
  proxyPort = list.proxy.port;
});
afterAll(async () => { await h.stop(); up.kill(); s.cleanup(); });

const proxy = (p: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
  fetch("http://127.0.0.1:" + proxyPort + p, { ...init, headers: { "X-Porthole-Local": h.localToken, ...headers }, redirect: "manual" });
async function open(port: number): Promise<Response> { return proxy("/__porthole/preview?port=" + port); }

test("ss parsing and the always-refused list", () => {
  expect(parseSs("LISTEN 0 4096 [::1]:3000 [::]:* users:((\"node\",pid=42,fd=3))\nLISTEN 0 5 *:5000 *:*")).toEqual([
    { port: 3000, pid: 42, process: "node" },
    { port: 5000, pid: null, process: null },
  ]);
  for (const p of [80, 8443, 8795, 8796, 9222, 9224, 9225, 8797, 8798]) expect(refusedReason(p, h.config, new Set(), null)).not.toBeNull();
  expect(refusedReason(4321, h.config, new Set([77]), 77)).toBe("port 4321 belongs to a Porthole hostd");
});

test("P2.6: a scratch server on a listed port is listed with its open URL", async () => {
  const list = (await (await get(h, "/v1/previews")).json()) as { previews: { port: number; pid: number; process: string; url: string }[] };
  expect(list.previews).toEqual([{ port: P, pid: up.pid, process: "bun", url: h.config.origin + ":8443/__porthole/preview?port=" + P }]);
});

test("P2.6: reachable through the proxy over HTTP and WebSocket", async () => {
  const r = await open(P);
  expect(r.status).toBe(302);
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  expect(cookie).toMatch(/^porthole_preview=[0-9a-f]{64}$/);
  const page = await proxy("/hello?x=1", { Cookie: cookie, "Accept-Encoding": "gzip", "X-Forwarded-For": "100.64.0.9" });
  // the request reaches the proxy as host 127.0.0.1:<proxyPort>; the upstream must see its own port, and no forwarded-for
  expect(await page.text()).toBe("upstream /hello?x=1 enc=none host=127.0.0.1:" + P + " xff=none");

  // the upstream builds an absolute Location from the Host it saw; the proxy must hand the phone a path, not 127.0.0.1:<port>
  const redir = await proxy("/redir", { Cookie: cookie });
  expect([redir.status, redir.headers.get("location")]).toEqual([302, "/target"]);

  // query kept; the porthole_preview cookie pair removed but the app's own cookie forwarded; Origin is the upstream's own address
  const ws = new WebSocket("ws://127.0.0.1:" + proxyPort + "/ws?token=abc", { headers: { Cookie: cookie + "; app=1", Origin: h.config.origin + ":8443", "X-Porthole-Local": h.localToken } } as unknown as string[]);
  const echoed = await new Promise<string>((resolve, reject) => {
    ws.onopen = () => ws.send("ping");
    ws.onmessage = (e) => resolve(String(e.data));
    ws.onerror = () => reject(new Error("ws error"));
  });
  expect(echoed).toBe("echo ping q=?token=abc cookie=app=1 origin=http://127.0.0.1:" + P);
  ws.close();

  expect(await rawUpgrade(proxyPort, "/ws", { Cookie: cookie, Origin: h.config.origin, "X-Porthole-Local": h.localToken })).toBe(403);
  expect((await proxy("/hello", { Cookie: cookie, "X-Porthole-Local": "wrong" })).status).toBe(403);
  expect((await fetch("http://127.0.0.1:" + proxyPort + "/hello", { headers: { Cookie: cookie } })).status).toBe(403);
});

test("P2.6: a POST needs the control-room Origin and is forwarded with it", async () => {
  const cookie = ((await open(P)).headers.get("set-cookie") ?? "").split(";")[0];
  expect((await proxy("/form", { Cookie: cookie }, { method: "POST", body: "a=1" })).status).toBe(403);
  const ok = await proxy("/form", { Cookie: cookie, Origin: h.config.origin + ":8443" }, { method: "POST", body: "a=1" });
  expect([ok.status, (await ok.text()).startsWith("upstream /form")]).toEqual([200, true]);
});

test("P2.6: ports 8795 and 9224, and a port the scan did not find, are refused", async () => {
  expect((await open(8795)).status).toBe(403);
  expect((await open(9224)).status).toBe(403);
  const missing = await open(65000);
  expect(missing.status).toBe(404);
  expect(await missing.text()).toContain("not found by the latest scan");
  expect((await proxy("/hello")).status).toBe(403);   // no cookie
});
