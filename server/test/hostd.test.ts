import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AccessLog } from "../src/auth/accesslog";
import { SentLog } from "../src/deliver/sentlog";
import { machineFeature } from "../src/features/machine";
import { sessionsFeature } from "../src/features/sessions";
import type { FeatureFactory } from "../src/router";
import { get, localHeaders, openWs, pane, rawUpgrade, startTestHostd, type TestHostd } from "./helpers/client";
import { Scratch, useTestTimeout, waitFor } from "./helpers/scratch";

useTestTimeout();

let s: Scratch;
let h: TestHostd;
beforeEach(async () => {
  s = new Scratch();
  h = await startTestHostd(s, [machineFeature, sessionsFeature]);
});
afterEach(async () => {
  await h.stop();
  s.cleanup();
});

test("GET /v1/machine with the local token", async () => {
  const r = await get(h, "/v1/machine");
  expect(r.status).toBe(200);
  const body = (await r.json()) as Record<string, unknown>;
  expect(body.name).toBe("testhost");
  expect(body.version).toBe("0.1.0");
  expect(body.authMode).toBe("127.0.0.1");
  expect(body.you).toEqual({ device: "local", via: "local", forwardedFor: [] });
  expect(Object.keys(body.features as object).sort()).toEqual(["herdr", "pactl", "tailscale", "tmux"]);
  expect("sessions" in body).toBe(false);
});

test("refusals are 403 and logged without text", async () => {
  expect((await fetch(h.url + "/v1/machine", { headers: { "X-Porthole-Local": h.localToken } })).status).toBe(403);
  expect((await get(h, "/v1/machine", { Origin: "https://evil.example" })).status).toBe(403);
  const lines = readFileSync(new AccessLog(s.stateDir).file, "utf8").trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1]) as { status: number; reason: string; route: string };
  expect(last.status).toBe(403);
  expect(last.reason.length).toBeGreaterThan(0);
  expect(last.route).toBe("/v1/machine");
});

test("GET /v1/sessions lists the scratch session; unknown path 404; OPTIONS 204 with CORS", async () => {
  const p = await pane(s, "work", "/bin/sh");
  const tree = (await (await get(h, "/v1/sessions")).json()) as { sessions: { id: string }[] };
  expect(tree.sessions.map((x) => x.id)).toEqual([p.id]);
  expect((await get(h, "/v1/nothing-here")).status).toBe(404);
  const opt = await fetch(h.url + "/v1/sessions", { method: "OPTIONS", headers: { Origin: h.config.origin } });
  expect(opt.status).toBe(204);
  expect(opt.headers.get("access-control-allow-origin")).toBe(h.config.origin);
});

test("OPTIONS needs an exact allowed Origin (else 403) and never reaches a route handler", async () => {
  let handled = 0;
  const probe: FeatureFactory = () => ({
    routes: [{ method: "OPTIONS", pattern: "/v1/probe", handler: () => { handled++; return new Response("handler ran"); } }],
    channels: [],
  });
  const h2 = await startTestHostd(s, [probe]);
  try {
    const bad = await fetch(h2.url + "/v1/probe", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    expect(bad.status).toBe(403);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
    const none = await fetch(h2.url + "/v1/probe", { method: "OPTIONS" });
    expect(none.status).toBe(403);
    // Even with the local token and the API header, a preflight is answered by hostd itself.
    const withToken = await fetch(h2.url + "/v1/probe", { method: "OPTIONS", headers: localHeaders(h2) });
    expect(withToken.status).toBe(403);
    const ok = await fetch(h2.url + "/v1/probe", { method: "OPTIONS", headers: { ...localHeaders(h2), Origin: h2.config.origin } });
    expect(ok.status).toBe(204);
    expect(await ok.text()).toBe("");
    expect(handled).toBe(0);
  } finally {
    await h2.stop();
  }
});

test("events: snapshot on open, update on change, through the hub", async () => {
  const p = await pane(s, "one", "/bin/sh");
  const ws = await openWs(h, "/v1/events");
  const first = await ws.next("sessions");
  expect(((first.tree as { sessions: unknown[] }).sessions).length).toBe(1);
  expect(h.hub.size).toBe(1);
  s.tmux(p.socket, "new-session", "-d", "-s", "two", "/bin/sh");
  await waitFor(() => ws.seen.some((m) => m.type === "sessions" && (m.tree as { sessions: unknown[] }).sessions.length === 2));
  ws.close();
  await waitFor(() => h.hub.size === 0);
});

test("WebSocket upgrades need the exact control-room Origin", async () => {
  const token = { "X-Porthole-Local": h.localToken };
  expect(await rawUpgrade(h.port, "/v1/events", token)).toBe(403);
  expect(await rawUpgrade(h.port, "/v1/events", { ...token, Origin: "https://evil.example" })).toBe(403);
  expect(await rawUpgrade(h.port, "/v1/events", { ...token, Origin: h.config.origin + ":8443" })).toBe(403);
  expect(await rawUpgrade(h.port, "/v1/events", { ...token, Origin: h.config.origin })).toBe(101);
});

test("binds only to config.host", () => {
  expect(h.url.startsWith("http://127.0.0.1:")).toBe(true);
  expect(localHeaders(h)["X-Porthole-Local"]).toBe(h.localToken);
});

test("features get sentLog and hub, start before createHostd resolves, and stop with hostd", async () => {
  const calls: string[] = [];
  const probe: FeatureFactory = (deps) => ({
    routes: [],
    channels: [],
    async start() {
      await Bun.sleep(50);
      calls.push("start:" + (deps.sentLog instanceof SentLog) + ":" + deps.hub.size);
    },
    stop() {
      calls.push("stop");
    },
  });
  const h2 = await startTestHostd(s, [probe]);
  expect(calls).toEqual(["start:true:0"]);
  expect(h2.sentLog.file).toBe(new SentLog(s.stateDir).file);
  await h2.stop();
  expect(calls).toEqual(["start:true:0", "stop"]);
});
