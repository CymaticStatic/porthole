// Who may use hostd (SPEC 5.4), 127.0.0.1 mode. See the README for this mode's limit.

import { timingSafeEqual } from "node:crypto";
import type { HostdConfig } from "../config";
import type { Whois } from "./identity";

export type Verdict = { ok: true; device: string; via: "tailscale" | "local" } | { ok: false; reason: string };

function deny(reason: string): Verdict {
  return { ok: false, reason };
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class Auth {
  private readonly origins: Set<string>;

  constructor(private readonly cfg: HostdConfig, private readonly whois: Whois, private readonly localToken: string) {
    this.origins = new Set([cfg.origin, ...cfg.peers]);
  }

  async check(req: Request): Promise<Verdict> {
    const pathname = new URL(req.url).pathname;
    const origin = req.headers.get("origin");
    const upgrade = (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
    if (origin !== null && !this.origins.has(origin)) return deny("origin " + origin + " is not allowed");
    if ((req.method !== "GET" && req.method !== "HEAD") || upgrade) {
      if (origin === null) return deny("this request needs the control-room Origin");
    }
    const isApi = pathname === "/v1" || pathname.startsWith("/v1/");
    if (isApi && !upgrade && req.headers.get("x-porthole") !== "1") {
      return deny("missing the X-Porthole: 1 header");
    }
    return this.identify(req);
  }

  /** Local token or Tailscale identity only: no Origin or X-Porthole rules (the preview proxy's pages cannot meet them). */
  async identify(req: Request): Promise<Verdict> {
    const local = req.headers.get("x-porthole-local");
    if (local !== null) return sameSecret(local, this.localToken) ? { ok: true, device: "local", via: "local" } : deny("wrong local token");
    const login = req.headers.get("tailscale-user-login");
    if (login !== this.cfg.allowedLogin) return deny("Tailscale login " + (login ?? "(none)") + " is not allowed");
    // tailscale serve appends the real address last; earlier entries can come from the client.
    const entries = (req.headers.get("x-forwarded-for") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
    if (this.cfg.singleForwardedFor && entries.length > 1) return deny("more than one X-Forwarded-For entry");
    const ip = entries.pop() ?? "";
    if (!ip) return deny("no Tailscale device address on the request");
    const who = await this.whois.lookup(ip);
    if (!who) return deny("Tailscale does not know the device at " + ip);
    if (who.login !== this.cfg.allowedLogin) return deny("device " + who.node + " belongs to another Tailscale login");
    if (!this.cfg.allowedNodes.includes(who.node)) return deny("device " + who.node + " is not on the allowlist");
    return { ok: true, device: who.node, via: "tailscale" };
  }

  corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get("origin");
    if (origin === null || !this.origins.has(origin)) return {};
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, X-Porthole",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    };
  }
}
