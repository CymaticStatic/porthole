import { connect } from "node:net";
import type { ConfigOverrides } from "../../src/config";
import { createHostd, type Hostd } from "../../src/hostd";
import type { FeatureFactory } from "../../src/router";
import { sessionId } from "../../src/sessions/ids";
import { findOmp, readProcTable, transcriptOf } from "../../src/sessions/procs";
import { boundedMs, DEFAULT_WAIT_MS, type Scratch, waitFor } from "./scratch";

export type TestHostd = Hostd;

/** hostd on 127.0.0.1, port 0, every path inside the scratch folder. */
export function startTestHostd(s: Scratch, factories: FeatureFactory[], overrides: ConfigOverrides = {}): Promise<TestHostd> {
  return createHostd(s.config(overrides), factories);
}

export function localHeaders(h: TestHostd): Record<string, string> {
  return { "X-Porthole": "1", "X-Porthole-Local": h.localToken };
}

export function get(h: TestHostd, p: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(h.url + p, { headers: { ...localHeaders(h), ...headers } });
}

export function post(h: TestHostd, p: string, body: unknown): Promise<Response> {
  return fetch(h.url + p, {
    method: "POST",
    headers: { ...localHeaders(h), Origin: h.config.origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export interface WsMessage { type: string; [key: string]: unknown }
export interface TestWs {
  ws: WebSocket;
  /** Every JSON text message, in arrival order. */
  seen: WsMessage[];
  /** The next message of `type` that `next` has not returned yet. */
  next(type: string, timeoutMs?: number): Promise<WsMessage>;
  /** All binary frames so far, decoded as UTF-8. */
  output(): string;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  closed: Promise<number>;
  close(): void;
}

// Bun's WebSocket takes upgrade headers, but @types/node's global WebSocket (which wins over bun-types') does not.
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;

export async function openWs(h: TestHostd, p: string, origin: string = h.config.origin): Promise<TestWs> {
  const ws = new BunWebSocket(h.url.replace(/^http/, "ws") + p, { headers: { Origin: origin, "X-Porthole-Local": h.localToken } });
  ws.binaryType = "arraybuffer";
  const seen: WsMessage[] = [];
  const taken = new Set<WsMessage>();
  const dec = new TextDecoder();
  let out = "";
  ws.onmessage = (e: MessageEvent) => {
    if (typeof e.data === "string") seen.push(JSON.parse(e.data) as WsMessage);
    else out += dec.decode(new Uint8Array(e.data as ArrayBuffer), { stream: true });
  };
  const closed = new Promise<number>((resolve) => { ws.onclose = (e: CloseEvent) => resolve(e.code); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error("WebSocket to " + p + " did not open in time")); }, boundedMs(DEFAULT_WAIT_MS));
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("WebSocket to " + p + " did not open")); };
  });
  return {
    ws,
    seen,
    async next(type, timeoutMs = DEFAULT_WAIT_MS) {
      let found: WsMessage | undefined;
      await waitFor(() => {
        found = seen.find((m) => m.type === type && !taken.has(m));
        return found !== undefined;
      }, timeoutMs, 10);
      taken.add(found as WsMessage);
      return found as WsMessage;
    },
    output: () => out,
    send: (data) => ws.send(data),
    closed,
    close: () => ws.close(1000),
  };
}

/** Status code of a WebSocket upgrade, read from the raw HTTP answer (0 = no answer). */
export function rawUpgrade(port: number, p: string, headers: Record<string, string>): Promise<number> {
  const lines = ["GET " + p + " HTTP/1.1", "Host: 127.0.0.1:" + port, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", ...Object.entries(headers).map(([k, v]) => k + ": " + v)];
  return new Promise((resolve) => {
    const sock = connect(port, "127.0.0.1", () => sock.write(lines.join("\r\n") + "\r\n\r\n"));
    let buf = "";
    const timer = setTimeout(() => { sock.destroy(); resolve(0); }, boundedMs(DEFAULT_WAIT_MS));
    sock.on("data", (d: Buffer) => {
      buf += d.toString("latin1");
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (m) { clearTimeout(timer); sock.destroy(); resolve(Number(m[1])); }
    });
    sock.on("error", () => { clearTimeout(timer); resolve(0); });
  });
}

export interface TestPane { socket: string; pid: number; id: string }

/** A scratch tmux session running `command`; on `socket` when given, else on a new scratch server. `pid` = pane process. */
export async function pane(s: Scratch, session: string, command = "/bin/sh", socket?: string): Promise<TestPane> {
  const sock = socket ?? s.newTmuxServer(session, command);
  if (socket) s.tmux(socket, "new-session", "-d", "-s", session, "-x", "120", "-y", "40", "-c", s.root, command);
  return { socket: sock, pid: s.panePid(sock, "=" + session + ":0.0"), id: sessionId({ kind: "tmux", socket: sock, session, window: 0, pane: 0 }) };
}

/** A scratch tmux session running the fake omp on `transcript`; `pid` = the omp process, returned once it holds the transcript open. */
export async function ompPane(s: Scratch, session: string, transcript: string, socket?: string): Promise<TestPane> {
  const p = await pane(s, session, s.ompCommand(transcript), socket);
  let pid = 0;
  // comm is "omp" from exec on, before the script has opened its transcript: wait for the open file as well.
  await waitFor(() => {
    pid = findOmp(readProcTable(), p.pid) ?? 0;
    return pid > 0 && transcriptOf(pid, [s.transcripts]) !== null;
  });
  return { ...p, pid };
}
