// The shapes every feature module uses (plan Task 8): routes, WebSocket channels, and the
// dependencies hostd hands to a FeatureFactory. Matching and JSON answers live here too.

import type { ServerWebSocket } from "bun";
import type { HostdConfig } from "./config";
import type { SentLog } from "./deliver/sentlog";
import type { EventsHub } from "./events/hub";
import type { Registry } from "./sessions/registry";

export interface Ctx { device: string; via: "tailscale" | "local"; route: string; session: string }

export interface Route {
  method: string;
  pattern: string;
  handler(req: Request, params: Record<string, string>, ctx: Ctx): Response | Promise<Response>;
}

export interface WsData {
  channel: Channel;
  params: Record<string, string>;
  query: URLSearchParams;
  ctx: Ctx;
  state: Record<string, unknown>;
}

export interface Channel {
  pattern: string;
  open(ws: ServerWebSocket<WsData>): void;
  message(ws: ServerWebSocket<WsData>, data: string | Buffer): void;
  close(ws: ServerWebSocket<WsData>): void;
}

export interface Feature {
  routes: Route[];
  channels: Channel[];
  start?(): Promise<void>;
  stop?(): void | Promise<void>;
}

export interface FeatureDeps {
  config: HostdConfig;
  registry: Registry;
  localToken: string;
  sentLog: SentLog;
  hub: EventsHub;
}

export type FeatureFactory = (d: FeatureDeps) => Feature;

/** `:name` segments capture one URL-decoded path segment; everything else must match exactly. */
export function match(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split("/");
  const have = pathname.split("/");
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(":")) {
      if (have[i] === "") return null;
      try { params[want[i].slice(1)] = decodeURIComponent(have[i]); } catch { return null; }
    } else if (want[i] !== have[i]) {
      return null;
    }
  }
  return params;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
