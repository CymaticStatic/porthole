import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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

/** The fake `ss`: the main upstream plus the refused ports, plus any extra scratch upstreams. */
function writeSs(extra: { port: number; pid: number }[] = []): void {
  const lines = [
    "LISTEN 0 512 127.0.0.1:" + P + " 0.0.0.0:* users:((\"bun\",pid=" + up.pid + ",fd=5))",
    "LISTEN 0 512 127.0.0.1:8795 0.0.0.0:* users:((\"bun\",pid=" + up.pid + ",fd=6))",
    "LISTEN 0 512 127.0.0.1:9224 0.0.0.0:* users:((\"chrome\",pid=1,fd=7))",
    ...extra.map((e) => "LISTEN 0 512 127.0.0.1:" + e.port + " 0.0.0.0:* users:((\"bun\",pid=" + e.pid + ",fd=8))"),
  ];
  s.writeFake("ss", "#!/bin/sh\ncat <<'EOF'\n" + lines.join("\n") + "\nEOF\n");
}

async function spawnUpstream(): Promise<{ proc: Bun.Subprocess<"ignore", "pipe", "inherit">; port: number }> {
  const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "preview-upstream.ts")], { stdout: "pipe" });
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  return { proc, port: Number(new TextDecoder().decode((await reader.read()).value).trim()) };
}
const cookieOf = (r: Response): string => (r.headers.get("set-cookie") ?? "").split(";")[0];

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
  expect(await page.text()).toBe("upstream /hello?x=1 enc=none host=127.0.0.1:" + P + " xff=none origin=none referer=none");

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

test("P2.6: a POST needs the preview Origin and is forwarded with the upstream's own Origin and Referer", async () => {
  const cookie = ((await open(P)).headers.get("set-cookie") ?? "").split(";")[0];
  expect((await proxy("/form", { Cookie: cookie }, { method: "POST", body: "a=1" })).status).toBe(403);
  // the control-room origin (no :8443) is not the preview origin either
  const control = await proxy("/form", { Cookie: cookie, Origin: h.config.origin }, { method: "POST", body: "a=1" });
  const refusal = (await control.json()) as { error: string };
  expect([control.status, refusal.error]).toEqual([403, "this request needs the preview Origin (" + h.config.origin + ":8443)"]);
  const ok = await proxy("/form", { Cookie: cookie, Origin: h.config.origin + ":8443", Referer: h.config.origin + ":8443/page?a=1" }, { method: "POST", body: "a=1" });
  expect([ok.status, await ok.text()]).toEqual([200, "upstream /form enc=none host=127.0.0.1:" + P + " xff=none origin=http://127.0.0.1:" + P + " referer=http://127.0.0.1:" + P + "/page?a=1"]);
  // a Referer from some other site is not touched
  const other = await proxy("/form", { Cookie: cookie, Origin: h.config.origin + ":8443", Referer: "https://example.com/x" }, { method: "POST", body: "a=1" });
  expect(await other.text()).toEndWith("referer=https://example.com/x");
});

test("P2.6: ports 8795 and 9224, and a port the scan did not find, are refused", async () => {
  expect((await open(8795)).status).toBe(403);
  expect((await open(9224)).status).toBe(403);
  const missing = await open(65000);
  expect(missing.status).toBe(404);
  expect(await missing.text()).toContain("not found by the latest scan");
  expect((await proxy("/hello")).status).toBe(403);   // no cookie
});

test("P2.6: a preview ends when its server dies (found by a rescan): requests get 403", async () => {
  const second = await spawnUpstream();
  try {
    writeSs([{ port: second.port, pid: second.proc.pid }]);
    await get(h, "/v1/previews"); // rescan
    const cookie = cookieOf(await open(second.port));
    expect((await proxy("/hello", { Cookie: cookie })).status).toBe(200);
    second.proc.kill(); // the exact child this test started
    await second.proc.exited;
    await get(h, "/v1/previews"); // the rescan's probe finds nothing on the port
    const closed = await proxy("/hello", { Cookie: cookie });
    const body = (await closed.json()) as { error: string };
    expect([closed.status, body.error]).toEqual([403, "this preview is closed: port " + second.port + " was not found by the latest scan"]);
    expect((await rawUpgrade(proxyPort, "/ws", { Cookie: cookie, Origin: h.config.origin + ":8443", "X-Porthole-Local": h.localToken }))).toBe(403);
  } finally {
    second.proc.kill();
    writeSs();
    await get(h, "/v1/previews");
  }
});

test("P2.6: narrowing previewRanges cuts off an open preview at once, and the token does not come back", async () => {
  const cookie = cookieOf(await open(P));
  expect((await proxy("/hello", { Cookie: cookie })).status).toBe(200);
  h.config.previewRanges = "1-2"; // what PUT /v1/config does: the feature reads it on every call
  try {
    const cut = await proxy("/hello", { Cookie: cookie });
    const body = (await cut.json()) as { error: string };
    expect([cut.status, body.error]).toEqual([403, "this preview is closed: port " + P + " was not found by the latest scan"]);
  } finally {
    h.config.previewRanges = "1024-65535";
  }
  await get(h, "/v1/previews"); // widened again and rescanned: the old token was dropped, not merely paused
  expect((await proxy("/hello", { Cookie: cookie })).status).toBe(403);
  expect((await open(P)).status).toBe(302);
  h.config.previewRanges = "none";
  try {
    expect((await open(P)).status).toBe(404);
  } finally {
    h.config.previewRanges = "1024-65535";
  }
  await get(h, "/v1/previews");
});

test("P2.6: opens and refusals are written to access.log with device and port, never a query", async () => {
  await open(P);
  await open(8795);
  await proxy("/hello?secret=zzz", { Cookie: "porthole_preview=" + "0".repeat(64) });
  const lines = readFileSync(path.join(h.config.stateDir, "access.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { device: string; method: string; route: string; session: string; status: number; reason: string });
  const opened = lines.filter((l) => l.route === "/__porthole/preview" && l.session === "port:" + P);
  expect(opened.length).toBeGreaterThan(0);
  expect(opened.some((l) => l.status === 302 && l.device !== "")).toBe(true);
  expect(opened.some((l) => l.status === 404 && l.reason === "not found by the latest scan")).toBe(true); // the 'none' ranges open above
  expect(lines.some((l) => l.route === "/__porthole/preview" && l.session === "port:8795" && l.status === 403 && l.reason.includes("never previewed"))).toBe(true);
  expect(lines.some((l) => l.route === "/hello" && l.status === 403 && l.reason === "no open preview")).toBe(true);
  const text = readFileSync(path.join(h.config.stateDir, "access.log"), "utf8");
  expect(text.includes("secret=zzz") || text.includes("token=abc") || text.includes("x=1")).toBe(false);
});

test("P2.6: the hostd pid file lives under this hostd's runtimeDir", () => {
  expect(existsSync(path.join(h.config.runtimeDir, "hostd-pids", String(process.pid)))).toBe(true);
});
