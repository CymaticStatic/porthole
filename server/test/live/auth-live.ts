// P1.5 live auth check against the INSTALLED hostd (port 8797) and its `tailscale serve` entry.
// Exit 0 = every check passed. Exit 1 = a check failed: STOP, change nothing, report to Ben.
// Exit 2 = could not run (no config, no token, tailscale or serve unreachable): also stop and report.
// `--ping` only asks GET /v1/machine with the local token (P1.6 evidence after a restart).
import { existsSync, readFileSync } from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { localTokenPath } from "../../src/auth/localtoken";
import { loadConfig } from "../../src/config";
import { run } from "../../src/exec";
import { asArray, asRecord, asString } from "../../src/json";
import { configPath } from "../../src/main";

const API = "http://127.0.0.1:8797";

function cannotRun(why: string): never {
  console.log("CANNOT RUN: " + why);
  process.exit(2);
}

const cfg = (() => {
  try { return loadConfig(configPath()); } catch (e) { return cannotRun(e instanceof Error ? e.message : String(e)); }
})();
const tokenFile = localTokenPath(cfg.runtimeDir);
if (!existsSync(tokenFile)) cannotRun("no local token at " + tokenFile + " (is porthole.service running?)");
const token = readFileSync(tokenFile, "utf8").trim();
const local = { "X-Porthole": "1", "X-Porthole-Local": token };

async function machine(base: string, headers: Record<string, string>, method = "GET"): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(base + "/v1/machine", { method, headers, signal: AbortSignal.timeout(10_000) });
  let body: Record<string, unknown> = {};
  try { body = asRecord(await r.json()); } catch { body = {}; }
  return { status: r.status, body };
}

/** Status code of a WebSocket upgrade to /v1/events (0 = no answer). Reads only the status line. */
function upgradeStatus(base: string, headers: Record<string, string>): Promise<number> {
  const u = new URL(base);
  const secure = u.protocol === "https:";
  const lines = ["GET /v1/events HTTP/1.1", "Host: " + u.host, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", ...Object.entries(headers).map(([k, v]) => k + ": " + v)];
  return new Promise((resolve) => {
    const port = Number(u.port || (secure ? 443 : 80));
    const sock: Socket = secure ? tlsConnect({ host: u.hostname, port, servername: u.hostname }) : netConnect(port, u.hostname);
    let buf = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (code: number) => { if (timer) clearTimeout(timer); sock.destroy(); resolve(code); };
    timer = setTimeout(() => done(0), 10_000);
    sock.once(secure ? "secureConnect" : "connect", () => sock.write(lines.join("\r\n") + "\r\n\r\n"));
    sock.on("data", (d: Buffer) => {
      buf += d.toString("latin1");
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (!m) return;
      // 101 = the server ACCEPTED the upgrade (a FAIL for every check here): close at once and read no frames.
      if (m[1] === "101") sock.removeAllListeners("data");
      done(Number(m[1]));
    });
    sock.on("error", () => done(0));
  });
}

if (process.argv.includes("--ping")) {
  const r = await machine(API, local).catch(() => cannotRun("hostd does not answer on " + API));
  console.log("ping /v1/machine: " + r.status);
  process.exit(r.status === 200 ? 0 : 1);
}

// Addresses from `tailscale status --json`: Self.DNSName is used by Task 1; Self/Peer TailscaleIPs and
// Peer DNSName are GUESS field names until this first run (a missing field stops with exit 2).
const st = await run([cfg.bin.tailscale, "status", "--json"]);
if (st.code !== 0) cannotRun("tailscale status failed: " + st.stderr.trim());
const status = asRecord(JSON.parse(st.stdout));
const selfIp = asString(asArray(asRecord(status.Self).TailscaleIPs)[0]);
if (!selfIp) cannotRun("tailscale status shows no address for this machine");
const peers = Object.values(asRecord(status.Peer)).map((p) => ({ name: asString(asRecord(p).DNSName).split(".")[0], ip: asString(asArray(asRecord(p).TailscaleIPs)[0]) }));
const allowedPeer = peers.find((p) => p.ip && p.name !== cfg.machineName && cfg.allowedNodes.includes(p.name));
const foreignPeer = peers.find((p) => p.ip && !cfg.allowedNodes.includes(p.name));
const spoofIp = allowedPeer?.ip ?? "100.64.0.1";
const wrongNodeIp = foreignPeer?.ip ?? "100.64.0.254";

let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log((ok ? "PASS " : "FAIL ") + name + ": " + detail);
  if (!ok) failed += 1;
}

// Through `tailscale serve` (cfg.origin is https://<this machine>.<tailnet>.ts.net on port 443).
const r1 = await machine(cfg.origin, { "X-Porthole": "1" }).catch((e) => cannotRun("cannot reach " + cfg.origin + ": " + String(e)));
const you1 = asRecord(r1.body.you);
check("serve: this allowed device gets 200", r1.status === 200 && asString(you1.device) === cfg.machineName && asString(you1.via) === "tailscale", r1.status + " " + JSON.stringify(you1));
const r2 = await machine(cfg.origin, { "X-Porthole": "1", "X-Forwarded-For": spoofIp });
const you2 = asRecord(r2.body.you);
const xff = asArray(you2.forwardedFor).map(asString);
check("serve: a spoofed X-Forwarded-For " + spoofIp + " is not believed", r2.status === 200 && asString(you2.device) === cfg.machineName, r2.status + " " + JSON.stringify(you2));
const verdict = r2.status !== 200 ? "unknown (spoofed request refused)"
  : xff.length === 1 && xff[0] !== spoofIp ? "serve sets one entry"
  : xff.length > 1 && xff[0] === spoofIp && xff[xff.length - 1] !== spoofIp ? "serve appends"
  : "serve passes the client value through";
console.log("xff: " + verdict + " " + JSON.stringify(xff));
check("serve: X-Forwarded-For comes from serve, not the client", verdict === "serve sets one entry" || verdict === "serve appends", verdict);
check("serve: a request without X-Porthole gets 403", (await machine(cfg.origin, {})).status === 403, "");
check("serve: a POST with a foreign Origin gets 403", (await machine(cfg.origin, { "X-Porthole": "1", Origin: "https://evil.example" }, "POST")).status === 403, "");
check("serve: a WebSocket from the preview origin gets 403", (await upgradeStatus(cfg.origin, { Origin: cfg.origin + ":8443" })) === 403, "");
check("serve: a WebSocket from a foreign origin gets 403", (await upgradeStatus(cfg.origin, { Origin: "https://evil.example" })) === 403, "");

// Direct to 127.0.0.1:8797 with injected identity headers (127.0.0.1 mode, SPEC P1.5).
check("direct: injected wrong login gets 403", (await machine(API, { "X-Porthole": "1", "Tailscale-User-Login": "someone@example.com", "X-Forwarded-For": selfIp })).status === 403, "");
check("direct: injected node " + (foreignPeer?.name ?? "(unknown address)") + " gets 403", (await machine(API, { "X-Porthole": "1", "Tailscale-User-Login": cfg.allowedLogin, "X-Forwarded-For": wrongNodeIp })).status === 403, wrongNodeIp);
const r9 = await machine(API, local);
check("direct: the local token works", r9.status === 200 && asString(asRecord(r9.body.you).device) === "local", String(r9.status));
check("direct: a WebSocket with a foreign Origin gets 403", (await upgradeStatus(API, { Origin: "https://evil.example", "X-Porthole-Local": token })) === 403, "");
check("direct: a WebSocket with the preview origin gets 403", (await upgradeStatus(API, { Origin: cfg.origin + ":8443", "X-Porthole-Local": token })) === 403, "");
if (cfg.singleForwardedFor) {
  const two = await machine(API, { "X-Porthole": "1", "Tailscale-User-Login": cfg.allowedLogin, "X-Forwarded-For": "100.64.0.254, " + selfIp });
  check("direct: two X-Forwarded-For entries get 403 (singleForwardedFor)", two.status === 403, String(two.status));
}

console.log(failed === 0 ? "ALL PASS" : failed + " FAILED: stop, change nothing, report to Ben (Needs Ben 5)");
process.exit(failed === 0 ? 0 : 1);
