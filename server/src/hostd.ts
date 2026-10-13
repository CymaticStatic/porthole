// createHostd: builds auth, the access log, the session registry and the features, then serves them
// on one 127.0.0.1 listener. Every request passes Auth.check before any handler runs, and every
// request leaves one access-log line (no message text, no query).

import { Auth } from "./auth/auth";
import { AccessLog } from "./auth/accesslog";
import { Whois } from "./auth/identity";
import { ensureLocalToken } from "./auth/localtoken";
import type { HostdConfig } from "./config";
import { SentLog } from "./deliver/sentlog";
import { EventsHub } from "./events/hub";
import { registerPid, unregisterPid } from "./pids";
import { json, match, type Channel, type Ctx, type Feature, type FeatureFactory, type WsData } from "./router";
import { Registry } from "./sessions/registry";

export interface Hostd {
  port: number;
  url: string;
  localToken: string;
  config: HostdConfig;
  registry: Registry;
  sentLog: SentLog;
  hub: EventsHub;
  stop(): Promise<void>;
}

const MAX_LOGGED_ROUTE = 200;

function withCors(res: Response, cors: Record<string, string>): Response {
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  return res;
}

export async function createHostd(config: HostdConfig, factories: FeatureFactory[]): Promise<Hostd> {
  const localToken = ensureLocalToken(config.runtimeDir);
  const auth = new Auth(config, new Whois(config.bin.tailscale), localToken);
  const accessLog = new AccessLog(config.stateDir);
  const registry = new Registry(config);
  const sentLog = new SentLog(config.stateDir);
  const hub = new EventsHub();
  const features: Feature[] = factories.map((make) => make({ config, registry, localToken, sentLog, hub }));
  const routes = features.flatMap((f) => f.routes);
  const channels = features.flatMap((f) => f.channels);

  const server = Bun.serve<WsData>({
    hostname: config.host,
    port: config.apiPort,
    async fetch(req, srv) {
      const pathname = new URL(req.url).pathname;
      const log = (device: string, route: string, session: string, status: number, reason: string) =>
        accessLog.write({ device, method: req.method, route: route.slice(0, MAX_LOGGED_ROUTE), session, status, reason });
      const cors = auth.corsHeaders(req);

      // A browser's preflight carries no credentials: it only needs an allowed exact Origin.
      if (req.method === "OPTIONS") {
        if (Object.keys(cors).length === 0) {
          log("-", pathname, "", 403, "preflight origin is not allowed");
          return json({ error: "origin is not allowed" }, 403);
        }
        log("-", pathname, "", 204, "");
        return new Response(null, { status: 204, headers: cors });
      }

      const upgrade = (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
      let channel: Channel | undefined;
      let channelParams: Record<string, string> | null = null;
      let route: (typeof routes)[number] | undefined;
      let routeParams: Record<string, string> | null = null;
      if (upgrade) {
        for (const c of channels) {
          channelParams = match(c.pattern, pathname);
          if (channelParams) { channel = c; break; }
        }
      } else {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          routeParams = match(r.pattern, pathname);
          if (routeParams) { route = r; break; }
        }
      }
      const routeName = channel?.pattern ?? route?.pattern ?? pathname;

      const verdict = await auth.check(req);
      if (!verdict.ok) {
        log("-", routeName, "", 403, verdict.reason);
        return json({ error: verdict.reason }, 403);
      }
      const ctx: Ctx = { device: verdict.device, via: verdict.via, route: routeName, session: "" };

      if (upgrade) {
        if (!channel || !channelParams) {
          log(ctx.device, routeName, "", 404, "no such channel");
          return json({ error: "not found" }, 404);
        }
        const data: WsData = { channel, params: channelParams, query: new URL(req.url).searchParams, ctx, state: {} };
        if (srv.upgrade(req, { data })) {
          log(ctx.device, routeName, "", 101, "");
          return undefined;
        }
        log(ctx.device, routeName, "", 400, "WebSocket upgrade failed");
        return json({ error: "WebSocket upgrade failed" }, 400);
      }

      if (!route || !routeParams) {
        log(ctx.device, routeName, "", 404, "no such route");
        return withCors(json({ error: "not found" }, 404), cors);
      }
      let res: Response;
      try {
        res = await route.handler(req, routeParams, ctx);
      } catch (e) {
        log(ctx.device, routeName, ctx.session, 500, e instanceof Error ? e.message : "handler failed");
        return withCors(json({ error: "internal error" }, 500), cors);
      }
      withCors(res, cors);
      log(ctx.device, routeName, ctx.session, res.status, "");
      return res;
    },
    websocket: {
      open(ws) {
        ws.data.channel.open(ws);
      },
      message(ws, data) {
        ws.data.channel.message(ws, data);
      },
      close(ws) {
        ws.data.channel.close(ws);
      },
    },
  });

  const port = server.port ?? config.apiPort;
  // Set only by the register call below: a start() failure calls stop() before that, and must not touch another hostd's pid.
  let registered = false;
  const hostd: Hostd = {
    port,
    url: "http://" + config.host + ":" + port,
    localToken,
    config,
    registry,
    sentLog,
    hub,
    async stop() {
      for (const f of features) await f.stop?.();
      while (registry.watching > 0) registry.stopWatching();
      await server.stop(true);
      if (registered) {
        registered = false;
        unregisterPid();
      }
    },
  };
  try {
    for (const f of features) await f.start?.();
  } catch (e) {
    await hostd.stop();
    throw e;
  }
  registerPid();
  registered = true;
  return hostd;
}
