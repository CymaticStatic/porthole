import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { AccessLog } from "../src/auth/accesslog";
import { Auth } from "../src/auth/auth";
import { Whois } from "../src/auth/identity";
import { ensureLocalToken, localTokenPath } from "../src/auth/localtoken";
import { Scratch } from "./helpers/scratch";

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

test("each rule refuses on its own", async () => {
  const cases: Array<[string, Request]> = [
    ["no X-Porthole", req("GET", "/v1/machine", { ...fromPhone, "X-Porthole": "" })],
    ["wrong login header", req("GET", "/v1/machine", { ...fromPhone, "Tailscale-User-Login": "someone@example.com" })],
    ["node not on the allowlist", req("GET", "/v1/machine", { ...fromPhone, "X-Forwarded-For": "100.64.0.2" })],
    ["node owned by another login", req("GET", "/v1/machine", { ...fromPhone, "X-Forwarded-For": "100.64.0.3" })],
    ["unknown address", req("GET", "/v1/machine", { ...fromPhone, "X-Forwarded-For": "100.64.0.9" })],
    ["spoofed first X-Forwarded-For entry", req("GET", "/v1/machine", { ...fromPhone, "X-Forwarded-For": "100.64.0.1, 100.64.0.2" })],
    ["no identity at all", req("GET", "/v1/machine", { "X-Porthole": "1" })],
    ["POST without Origin", req("POST", "/v1/sessions/x/send", fromPhone)],
    ["POST from a foreign site", req("POST", "/v1/sessions/x/send", { ...fromPhone, Origin: "https://evil.example" })],
    ["POST from the preview port", req("POST", "/v1/sessions/x/send", { ...fromPhone, Origin: CONTROL + ":8443" })],
    ["GET with a foreign Origin", req("GET", "/v1/machine", { ...fromPhone, Origin: "https://evil.example" })],
    ["WebSocket without Origin", req("GET", "/v1/events", { ...fromPhone, ...upgrade })],
    ["WebSocket from the preview port", req("GET", "/v1/events", { ...fromPhone, ...upgrade, Origin: CONTROL + ":8443" })],
    ["wrong local token", req("GET", "/v1/machine", { "X-Porthole": "1", "X-Porthole-Local": "guess" })],
  ];
  for (const [name, r] of cases) {
    const v = await auth.check(r);
    expect([name, v.ok]).toEqual([name, false]);
  }
});

test("exact origins, preflight and the local token pass", async () => {
  expect((await auth.check(req("POST", "/v1/sessions/x/send", { ...fromPhone, Origin: CONTROL }))).ok).toBe(true);
  expect((await auth.check(req("POST", "/v1/sessions/x/send", { ...fromPhone, Origin: "https://peer.example.ts.net" }))).ok).toBe(true);
  expect((await auth.check(req("GET", "/v1/events", { ...fromPhone, ...upgrade, "X-Porthole": "", Origin: CONTROL }))).ok).toBe(true);
  expect((await auth.check(req("OPTIONS", "/v1/sessions/x/send", { ...fromPhone, "X-Porthole": "", Origin: CONTROL }))).ok).toBe(true);
  expect(await auth.check(req("GET", "/v1/machine", { "X-Porthole": "1", "X-Porthole-Local": "local-secret" }))).toEqual({ ok: true, device: "local", via: "local" });
  expect(auth.corsHeaders(req("GET", "/v1/machine", { Origin: CONTROL }))["Access-Control-Allow-Origin"]).toBe(CONTROL);
  expect(auth.corsHeaders(req("GET", "/v1/machine", { Origin: "https://evil.example" }))).toEqual({});
});

test("whois answers are cached", async () => {
  await auth.check(req("GET", "/v1/machine", fromPhone));
  await auth.check(req("GET", "/v1/machine", fromPhone));
  expect(s.fakeCalls("tailscale").filter((c) => c[0] === "whois").length).toBe(1);
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
