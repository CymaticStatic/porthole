// Stands in for `tailscale serve` in front of one test hostd (plan C1): HTTPS on 127.0.0.1:<free port>, every request forwarded
// to hostd with `X-Porthole-Local: <token>` (the local-identity path, V3). WebSocket upgrades are tunnelled byte for byte: the
// proxy rewrites the request head (adds the header, keeps the page's Origin) and then pipes both sockets together, so every
// text and binary frame passes untouched. Test controls drop sockets, refuse upgrades, reset the next request and record traffic.
import { createServer, type Server } from "node:https";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import type { TestHostd } from "../../../server/test/helpers/client";

/** One HTTP request the proxy saw. `path` is the raw (still percent-encoded) path without the query. */
export interface SeenRequest { method: string; path: string; body: unknown }

export interface Proxy {
  /** The loopback port Chromium's host-resolver-rules map the machine name to. */
  port: number;
  /** Closes every open socket whose path starts with `prefix`. */
  drop(prefix: string): void;
  /** While `on`, new upgrades on `prefix` are answered 503. */
  block(prefix: string, on: boolean): void;
  /** Resets the next HTTP request on `prefix` (connection closed, no answer). */
  failNext(prefix: string): void;
  /** WebSocket upgrades seen on `prefix` (blocked ones included). */
  count(prefix: string): number;
  /** Path and query of the newest upgrade on `prefix` ("" when there was none). */
  lastUpgradePath(prefix: string): string;
  /** Every HTTP request seen on `prefix`, oldest first; `body` is the parsed JSON body (undefined otherwise). */
  requests(prefix: string): SeenRequest[];
  stop(): Promise<void>;
}

interface Conn { path: string; destroy(): void }

const LOCAL = "x-porthole-local";
// Not forwarded back to the page: the proxy answers every request with `Connection: close` (see onRequest).
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection"]);

export async function startProxy(opts: { target: TestHostd; cert: string; key: string }): Promise<Proxy> {
  const { target } = opts;
  const seen: SeenRequest[] = [];
  const upgrades: { path: string; full: string }[] = [];
  const blocked = new Set<string>();
  const armed = new Map<string, number>();
  const conns = new Set<Conn>();

  const isBlocked = (p: string): boolean => [...blocked].some((b) => p.startsWith(b));

  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://proxy.invalid");
    const method = req.method ?? "GET";
    const hit = [...armed.keys()].find((p) => url.pathname.startsWith(p) && (armed.get(p) ?? 0) > 0);
    if (hit !== undefined) {
      armed.set(hit, (armed.get(hit) ?? 1) - 1);
      seen.push({ method, path: url.pathname, body: undefined });
      req.socket.destroy();
      return;
    }
    const conn: Conn = { path: url.pathname, destroy: () => req.socket.destroy() };
    conns.add(conn);
    res.on("close", () => conns.delete(conn));

    const json = (req.headers["content-type"] ?? "").includes("json");
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { if (json) chunks.push(c); });
    // Recorded once the whole body has arrived, so a test that sees the request also sees its body.
    req.on("end", () => {
      let body: unknown;
      if (json) {
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = undefined; }
      }
      seen.push({ method, path: url.pathname, body });
    });

    const headers = { ...req.headers, [LOCAL]: target.localToken, connection: "close" };
    const up = httpRequest({ host: "127.0.0.1", port: target.port, method, path: req.url, headers, agent: false }, (ures) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(ures.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) out[k] = v;
      // One connection per request: Chromium then never resends a reset request on its own (it does that on reused sockets).
      out.connection = "close";
      res.writeHead(ures.statusCode ?? 502, ures.statusMessage, out);
      ures.pipe(res);
    });
    up.on("error", () => {
      if (res.headersSent) res.destroy();
      else { res.writeHead(502, { connection: "close" }); res.end(); }
    });
    req.on("aborted", () => up.destroy());
    req.pipe(up);
  }

  function onUpgrade(req: IncomingMessage, sock: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://proxy.invalid");
    upgrades.push({ path: url.pathname, full: url.pathname + url.search });
    sock.on("error", () => sock.destroy());
    if (isBlocked(url.pathname)) {
      sock.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const up = net.connect(target.port, "127.0.0.1");
    const conn: Conn = { path: url.pathname, destroy: () => { sock.destroy(); up.destroy(); } };
    conns.add(conn);
    const gone = (): void => { conns.delete(conn); sock.destroy(); up.destroy(); };
    sock.on("close", gone);
    up.on("close", gone);
    up.on("error", gone);
    up.on("connect", () => {
      const lines = [(req.method ?? "GET") + " " + (req.url ?? "/") + " HTTP/1.1"];
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i].toLowerCase() !== LOCAL) lines.push(req.rawHeaders[i] + ": " + req.rawHeaders[i + 1]);
      }
      lines.push("X-Porthole-Local: " + target.localToken);
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length > 0) up.write(head);
      sock.pipe(up);
      up.pipe(sock);
    });
  }

  const server: Server = createServer({ cert: opts.cert, key: opts.key }, onRequest);
  server.on("upgrade", onUpgrade);
  server.on("tlsClientError", () => undefined); // a browser that drops a handshake is not a test failure
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;

  return {
    port,
    drop(prefix) {
      for (const c of [...conns]) if (c.path.startsWith(prefix)) c.destroy();
    },
    block(prefix, on) {
      if (on) blocked.add(prefix);
      else blocked.delete(prefix);
    },
    failNext(prefix) {
      armed.set(prefix, (armed.get(prefix) ?? 0) + 1);
    },
    count: (prefix) => upgrades.filter((u) => u.path.startsWith(prefix)).length,
    lastUpgradePath: (prefix) => upgrades.filter((u) => u.path.startsWith(prefix)).at(-1)?.full ?? "",
    requests: (prefix) => seen.filter((r) => r.path.startsWith(prefix)),
    async stop() {
      for (const c of [...conns]) c.destroy();
      conns.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    },
  };
}
