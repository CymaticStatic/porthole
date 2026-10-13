// The preview listener (SPEC 4.10): opens one scanned local port per device behind a cookie, and proxies HTTP and
// WebSockets to it. The upstream sees its own address (Host, Origin, Referer), never the Tailscale name or the proxy's port.

import { randomBytes } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";
import type { Auth } from "../auth/auth";
import { AccessLog } from "../auth/accesslog";
import type { HostdConfig } from "../config";
import { pidsDir } from "../pids";
import { json } from "../router";
import { hostdPids, refusedReason } from "./scan";

const COOKIE = "porthole_preview";
const OPEN_PATH = "/__porthole/preview";
const UPSTREAM_WS_TIMEOUT_MS = 5000;
const IDLE_TIMEOUT_S = 255; // long-polling and event-stream pages must survive quiet stretches

// Bun's WebSocket takes upgrade headers, but @types/node's global WebSocket (which wins over bun-types') does not.
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;

interface PipeData {
  upstream: WebSocket;
  client: ServerWebSocket<PipeData> | null;
  queue: (string | ArrayBuffer)[];
  closedCode: number | null;
}

/** The `porthole_preview` token on the request, or null; and the cookie header with that pair removed (null when nothing is left). */
function splitCookie(header: string | null): { token: string | null; rest: string | null } {
  let token: string | null = null;
  const rest: string[] = [];
  for (const part of (header ?? "").split(";")) {
    const pair = part.trim();
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.slice(0, eq) === COOKIE) token ??= pair.slice(eq + 1);
    else rest.push(pair);
  }
  return { token, rest: rest.length > 0 ? rest.join("; ") : null };
}

/** A close code that may legally be sent in a close frame (1005, 1006 and 1015 are for local reporting only). */
function sendableCode(code: number): number {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999) ? code : 1000;
}

/** An absolute Location that points at the upstream's own address becomes a path (and query), so the phone stays on the proxy. */
function rewriteLocation(location: string, port: number): string {
  for (const prefix of ["http://127.0.0.1:" + port, "http://localhost:" + port]) {
    if (!location.startsWith(prefix)) continue;
    const rest = location.slice(prefix.length);
    if (rest === "") return "/";
    if (rest[0] === "/") return rest;
    if (rest[0] === "?" || rest[0] === "#") return "/" + rest;
  }
  return location;
}

export class PreviewProxy {
  private server: Server<PipeData> | null = null;
  private readonly tokens = new Map<string, { device: string; port: number }>();
  private readonly accessLog: AccessLog;

  /**
   * `allowed(port)`: the port is inside the configured ranges and in the latest scan. `ownerOf(port)`: the pid the latest scan
   * saw listening there, or null. Both are asked again on every request, not only when the preview is opened.
   */
  constructor(
    private readonly cfg: HostdConfig,
    private readonly auth: Auth,
    private readonly allowed: (port: number) => boolean,
    private readonly ownerOf: (port: number) => number | null,
  ) {
    this.accessLog = new AccessLog(cfg.stateDir);
  }

  /** The preview page's own origin: what a browser sends as Origin from a page this proxy served. */
  private get previewOrigin(): string {
    return this.cfg.origin + ":8443";
  }

  /** One access.log line per open, refusal, upgrade or upstream failure. Only the path is logged, never the query. */
  private record(device: string, method: string, pathname: string, port: number, status: number, reason: string): void {
    try {
      this.accessLog.write({ device, method, route: pathname.slice(0, 200), session: port > 0 ? "port:" + port : "", status, reason });
    } catch { /* a full disk must not take the preview down */ }
  }

  /** Why `port` may not be proxied right now, or null: the always-refused list, then the ranges and the latest scan. */
  private refusal(port: number): string | null {
    const refused = refusedReason(port, this.cfg, hostdPids(pidsDir(this.cfg.runtimeDir)), this.ownerOf(port));
    if (refused !== null) return refused;
    return this.allowed(port) ? null : "port " + port + " was not found by the latest scan";
  }

  get port(): number {
    return this.server?.port ?? 0;
  }

  start(): void {
    if (this.server) return;
    this.server = Bun.serve<PipeData>({
      hostname: "127.0.0.1",
      port: this.cfg.previewPort,
      idleTimeout: IDLE_TIMEOUT_S,
      fetch: (req, srv) => this.handle(req, srv),
      websocket: {
        open: (ws) => this.opened(ws),
        message: (ws, data) => this.fromClient(ws, data),
        close: (ws, code) => {
          try { ws.data.upstream.close(sendableCode(code)); } catch { /* already closed */ }
        },
      },
    });
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
    this.tokens.clear();
  }

  private opened(ws: ServerWebSocket<PipeData>): void {
    const d = ws.data;
    d.client = ws;
    for (const m of d.queue) ws.send(m);
    d.queue = [];
    if (d.closedCode !== null) ws.close(sendableCode(d.closedCode));
  }

  private fromClient(ws: ServerWebSocket<PipeData>, data: string | Buffer): void {
    // A Buffer is a plain Uint8Array here; the cast only works around @types/node's SharedArrayBuffer-widened Buffer type.
    try { ws.data.upstream.send(data as string | Uint8Array<ArrayBuffer>); } catch { ws.close(1011); }
  }

  private async handle(req: Request, srv: Server<PipeData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const verdict = await this.auth.identify(req);
    if (!verdict.ok) {
      this.record("-", req.method, url.pathname, 0, 403, verdict.reason);
      return json({ error: verdict.reason }, 403);
    }
    const device = verdict.device;

    if (req.method === "GET" && url.pathname === OPEN_PATH) return this.open(url, device);

    const cookie = splitCookie(req.headers.get("cookie"));
    const entry = cookie.token === null ? undefined : this.tokens.get(cookie.token);
    if (cookie.token === null || !entry || entry.device !== device) {
      this.record(device, req.method, url.pathname, 0, 403, "no open preview");
      return json({ error: "open the preview from Porthole first" }, 403);
    }

    // The port must still qualify: a dead server, a replaced process or narrowed ranges end the preview, and the token with it.
    const refusal = this.refusal(entry.port);
    if (refusal !== null) {
      this.tokens.delete(cookie.token);
      this.record(device, req.method, url.pathname, entry.port, 403, refusal);
      return json({ error: "this preview is closed: " + refusal }, 403);
    }

    const upgrade = (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
    if (upgrade || (req.method !== "GET" && req.method !== "HEAD")) {
      // A page this proxy served sends exactly the preview origin; the control-room origin, null and anything else are refused.
      if (req.headers.get("origin") !== this.previewOrigin) {
        this.record(device, req.method, url.pathname, entry.port, 403, "Origin is not the preview origin");
        return json({ error: "this request needs the preview Origin (" + this.previewOrigin + ")" }, 403);
      }
    }
    if (!upgrade) return this.forward(req, entry.port, url, device);
    const res = await this.upgrade(req, srv, entry.port, url, cookie.rest);
    this.record(device, req.method, url.pathname, entry.port, res?.status ?? 101, res === undefined ? "" : "WebSocket not accepted");
    return res;
  }

  private open(url: URL, device: string): Response {
    const text = url.searchParams.get("port") ?? "";
    const port = /^\d{1,5}$/.test(text) ? Number(text) : 0;
    if (port < 1 || port > 65535) {
      this.record(device, "GET", url.pathname, 0, 400, "bad port");
      return json({ error: "port must be a number from 1 to 65535" }, 400);
    }
    const refused = refusedReason(port, this.cfg, hostdPids(pidsDir(this.cfg.runtimeDir)), this.ownerOf(port));
    if (refused !== null) {
      this.record(device, "GET", url.pathname, port, 403, refused);
      return json({ error: refused }, 403);
    }
    if (!this.allowed(port)) {
      this.record(device, "GET", url.pathname, port, 404, "not found by the latest scan");
      return json({ error: "port " + port + " was not found by the latest scan" }, 404);
    }
    for (const [token, e] of this.tokens) if (e.device === device) this.tokens.delete(token);
    const token = randomBytes(32).toString("hex");
    this.tokens.set(token, { device, port });
    this.record(device, "GET", url.pathname, port, 302, "");
    return new Response(null, {
      status: 302,
      headers: { Location: "/", "Set-Cookie": COOKIE + "=" + token + "; Path=/; HttpOnly; Secure; SameSite=Lax" },
    });
  }

  private async forward(req: Request, port: number, url: URL, device: string): Promise<Response> {
    const headers = new Headers(req.headers);
    for (const name of [...headers.keys()]) {
      if (name === "accept-encoding" || name === "x-porthole-local" || name.startsWith("x-forwarded-") || name.startsWith("tailscale-")) headers.delete(name);
    }
    const rest = splitCookie(req.headers.get("cookie")).rest;
    if (rest === null) headers.delete("cookie");
    else headers.set("cookie", rest);
    headers.set("host", "127.0.0.1:" + port);
    // Dev frameworks compare Origin and Referer with Host (Django, Rails, Next server actions): show them the upstream's own address.
    const own = "http://127.0.0.1:" + port;
    if (headers.get("origin") === this.previewOrigin) headers.set("origin", own);
    const referer = headers.get("referer");
    if (referer !== null && (referer === this.previewOrigin || referer.startsWith(this.previewOrigin + "/"))) {
      headers.set("referer", own + referer.slice(this.previewOrigin.length));
    }
    let upstream: Response;
    try {
      upstream = await fetch("http://127.0.0.1:" + port + url.pathname + url.search, {
        method: req.method,
        headers,
        body: req.body,
        redirect: "manual",
        decompress: false, // hand the bytes and Content-Encoding through unchanged
        signal: req.signal,
      });
    } catch {
      this.record(device, req.method, url.pathname, port, 502, "nothing answered");
      return json({ error: "nothing answered on port " + port }, 502);
    }
    const out = new Headers(upstream.headers);
    const location = out.get("location");
    if (location !== null) out.set("location", rewriteLocation(location, port));
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
  }

  /** Connects upstream first; the client is upgraded only once the upstream socket is open. */
  private async upgrade(req: Request, srv: Server<PipeData>, port: number, url: URL, cookie: string | null): Promise<Response | undefined> {
    const headers: Record<string, string> = { Origin: "http://127.0.0.1:" + port };
    if (cookie !== null) headers.Cookie = cookie;
    const protocols = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
    const upstream = new BunWebSocket("ws://127.0.0.1:" + port + url.pathname + url.search, protocols.length > 0 ? { protocols, headers } : { headers });
    upstream.binaryType = "arraybuffer";
    const opened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), UPSTREAM_WS_TIMEOUT_MS);
      upstream.onopen = () => { clearTimeout(timer); resolve(true); };
      upstream.onerror = () => { clearTimeout(timer); resolve(false); };
      upstream.onclose = () => { clearTimeout(timer); resolve(false); };
    });
    if (!opened) {
      try { upstream.close(); } catch { /* never opened */ }
      return json({ error: "the preview app on port " + port + " did not accept the WebSocket" }, 502);
    }
    // Upstream traffic that arrives before the client socket exists is queued, then flushed by `opened`.
    const data: PipeData = { upstream, client: null, queue: [], closedCode: null };
    upstream.onmessage = (e: MessageEvent) => {
      if (data.client) data.client.send(e.data as string | ArrayBuffer);
      else data.queue.push(e.data as string | ArrayBuffer);
    };
    upstream.onclose = (e: CloseEvent) => {
      if (data.client) data.client.close(sendableCode(e.code));
      else data.closedCode = e.code;
    };
    const accepted = srv.upgrade(req, { data, headers: upstream.protocol ? { "Sec-WebSocket-Protocol": upstream.protocol } : undefined });
    if (!accepted) {
      upstream.close();
      return json({ error: "WebSocket upgrade failed" }, 400);
    }
    return undefined;
  }
}
