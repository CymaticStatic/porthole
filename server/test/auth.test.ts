import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AccessLog } from "../src/auth/accesslog";
import { Auth } from "../src/auth/auth";
import { Whois } from "../src/auth/identity";
import { ensureLocalToken, localTokenPath } from "../src/auth/localtoken";
import { Scratch, useTestTimeout } from "./helpers/scratch";

useTestTimeout();

let s: Scratch;
let auth: Auth;
const BEN = "bengovernale@gmail.com";
const CONTROL = "https://testhost.example.ts.net";

beforeEach(() => {
  s = new Scratch();
  s.setWhois({
    "100.64.0.1": { node: "bencell", login: BEN },
    "100.64.0.2": { node: "benacer", login: BEN },
    "100.64.0.3": { node: "bencell", login: "someone@example.com" },
  });
  const cfg = s.config();
  auth = new Auth(cfg, new Whois(cfg.bin.tailscale), "local-secret");
});
afterEach(() => s.cleanup());

function req(method: string, p: string, headers: Record<string, string>): Request {
  return new Request("http://127.0.0.1:8797" + p, { method, headers });
}
const fromPhone = { "X-Porthole": "1", "Tailscale-User-Login": BEN, "X-Forwarded-For": "100.64.0.1" };
const upgrade = { Upgrade: "websocket", Connection: "Upgrade" };

test("Ben's phone through tailscale serve is allowed", async () => {
  expect(await auth.check(req("GET", "/v1/machine", fromPhone))).toEqual({ ok: true, device: "bencell", via: "tailscale" });
});

test("each rule refuses on its own, for its own reason", async () => {
  const cases: Array<[string, Request, string]> = [
    ["no X-Porthole", req("GET", "/v1/machine", { ...fromPhone, "X-Porthole": "" }), "missing the X-Porthole"],
    ["wrong login header", req("GET", "/v1/machine", { ...fromPhone, "Tailscale-User-Login": "someone@example.com" }), "Tailscale login someone@example.com is not allowed"],
    ["node not on the allowlist", req("GET", "/v1/machine", { ...fromPhone, "X-Forwarded-For": "100.64.0.2" }), "device benacer is not on the allowlist"],
    ["node owned by another login", req("GET", "/v1/machine", { ...fromPhone, "X-Forwarded-For": "100.64.0.3" }), "belongs to another Tailscale login"],
    ["unknown address", req("GET", "/v1/machine", { ...fromPhone, "X-Forwarded-For": "100.64.0.9" }), "does not know the device at 100.64.0.9"],
    ["spoofed first X-Forwarded-For entry", req("GET", "/v1/machine", { ...fromPhone, "X-Forwarded-For": "100.64.0.1, 100.64.0.2" }), "device benacer is not on the allowlist"],
    ["no identity at all", req("GET", "/v1/machine", { "X-Porthole": "1" }), "Tailscale login (none) is not allowed"],
    ["POST without Origin", req("POST", "/v1/sessions/x/send", fromPhone), "needs the control-room Origin"],
    ["POST from a foreign site", req("POST", "/v1/sessions/x/send", { ...fromPhone, Origin: "https://evil.example" }), "origin https://evil.example is not allowed"],
    ["POST from the preview port", req("POST", "/v1/sessions/x/send", { ...fromPhone, Origin: CONTROL + ":8443" }), "origin " + CONTROL + ":8443 is not allowed"],
    ["GET with a foreign Origin", req("GET", "/v1/machine", { ...fromPhone, Origin: "https://evil.example" }), "origin https://evil.example is not allowed"],
    ["WebSocket without Origin", req("GET", "/v1/events", { ...fromPhone, ...upgrade }), "needs the control-room Origin"],
    ["WebSocket from the preview port", req("GET", "/v1/events", { ...fromPhone, ...upgrade, Origin: CONTROL + ":8443" }), "origin " + CONTROL + ":8443 is not allowed"],
    ["OPTIONS without Origin", req("OPTIONS", "/v1/sessions/x/send", { ...fromPhone, "X-Porthole": "" }), "needs the control-room Origin"],
    ["OPTIONS with a bad Origin", req("OPTIONS", "/v1/sessions/x/send", { ...fromPhone, "X-Porthole": "", Origin: "https://evil.example" }), "origin https://evil.example is not allowed"],
    ["wrong local token", req("GET", "/v1/machine", { "X-Porthole": "1", "X-Porthole-Local": "guess" }), "wrong local token"],
    ["local token without X-Porthole", req("GET", "/v1/machine", { "X-Porthole-Local": "local-secret" }), "missing the X-Porthole"],
  ];
  for (const [name, r, reason] of cases) {
    const v = await auth.check(r);
    expect([name, v.ok]).toEqual([name, false]);
    expect([name, v.ok === false ? v.reason : ""]).toEqual([name, expect.stringContaining(reason)]);
  }
});

test("exact origins, preflight and the local token pass", async () => {
  expect((await auth.check(req("POST", "/v1/sessions/x/send", { ...fromPhone, Origin: CONTROL }))).ok).toBe(true);
  expect((await auth.check(req("POST", "/v1/sessions/x/send", { ...fromPhone, Origin: "https://peer.example.ts.net" }))).ok).toBe(true);
  expect((await auth.check(req("GET", "/v1/events", { ...fromPhone, ...upgrade, "X-Porthole": "", Origin: CONTROL }))).ok).toBe(true);
  expect(await auth.check(req("GET", "/v1/machine", { "X-Porthole": "1", "X-Porthole-Local": "local-secret" }))).toEqual({ ok: true, device: "local", via: "local" });
  expect(auth.corsHeaders(req("GET", "/v1/machine", { Origin: CONTROL }))["Access-Control-Allow-Origin"]).toBe(CONTROL);
  expect(auth.corsHeaders(req("GET", "/v1/machine", { Origin: "https://evil.example" }))).toEqual({});
});

test("whois answers are cached, and concurrent lookups of one address share one process", async () => {
  await auth.check(req("GET", "/v1/machine", fromPhone));
  await auth.check(req("GET", "/v1/machine", fromPhone));
  expect(s.fakeCalls("tailscale").filter((c) => c[0] === "whois").length).toBe(1);
  const fresh = new Whois(s.config().bin.tailscale);
  const answers = await Promise.all(Array.from({ length: 8 }, () => fresh.lookup("100.64.0.2")));
  for (const a of answers) expect(a).toEqual({ node: "benacer", login: BEN });
  expect(s.fakeCalls("tailscale").filter((c) => c[0] === "whois" && c[c.length - 1] === "100.64.0.2").length).toBe(1);
});

test("an empty or damaged local token file is replaced and never matches an empty header", async () => {
  const file = localTokenPath(s.runtimeDir);
  ensureLocalToken(s.runtimeDir);
  writeFileSync(file, "");
  const token = ensureLocalToken(s.runtimeDir);
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect(readFileSync(file, "utf8").trim()).toBe(token);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const a = new Auth(s.config(), new Whois(s.config().bin.tailscale), token);
  const v = await a.check(req("GET", "/v1/machine", { "X-Porthole": "1", "X-Porthole-Local": "" }));
  expect(v).toEqual({ ok: false, reason: "wrong local token" });
  writeFileSync(file, "not-a-token\n");
  expect(ensureLocalToken(s.runtimeDir)).toMatch(/^[0-9a-f]{64}$/);
});

test("local token and access log are owner-only; the log never holds message text", () => {
  const token = ensureLocalToken(s.runtimeDir);
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect(ensureLocalToken(s.runtimeDir)).toBe(token);
  expect(statSync(localTokenPath(s.runtimeDir)).mode & 0o777).toBe(0o600);
  expect(statSync(s.runtimeDir).mode & 0o777).toBe(0o700);
  const log = new AccessLog(s.stateDir);
  log.write({ device: "bencell", method: "POST", route: "POST /v1/sessions/:id/send", session: "tmux:a:b:0.0", status: 200, reason: "" });
  expect(statSync(log.file).mode & 0o777).toBe(0o600);
  expect(path.basename(log.file)).toBe("access.log");
  const line = JSON.parse(readFileSync(log.file, "utf8").trim());
  expect(Object.keys(line).sort()).toEqual(["at", "device", "method", "reason", "route", "session", "status"]);
});

test("with singleForwardedFor, more than one X-Forwarded-For entry is refused", async () => {
  const strict = new Auth(s.config({ singleForwardedFor: true }), new Whois(s.config().bin.tailscale), "local-secret");
  expect(await strict.check(req("GET", "/v1/machine", fromPhone))).toEqual({ ok: true, device: "bencell", via: "tailscale" });
  expect(await strict.check(req("GET", "/v1/machine", { ...fromPhone, "X-Forwarded-For": "100.64.0.2, 100.64.0.1" }))).toEqual({ ok: false, reason: "more than one X-Forwarded-For entry" });
  expect((await auth.check(req("GET", "/v1/machine", { ...fromPhone, "X-Forwarded-For": "100.64.0.2, 100.64.0.1" }))).ok).toBe(true);
});
