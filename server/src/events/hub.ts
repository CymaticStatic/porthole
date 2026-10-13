// The set of open /v1/events sockets. Features broadcast through it and hook socket open and incoming messages.

import type { ServerWebSocket } from "bun";
import type { WsData } from "../router";

const MAX_INCOMING_CHARS = 4096;

type Socket = ServerWebSocket<WsData>;

export class EventsHub {
  private readonly sockets = new Set<Socket>();
  private readonly openListeners = new Set<(ws: Socket) => void>();
  private readonly messageListeners = new Set<(ws: Socket, msg: Record<string, unknown>) => void>();

  /** Adds the socket, then tells every onOpen listener (one listener's throw does not stop the others). */
  add(ws: Socket): void {
    this.sockets.add(ws);
    for (const fn of this.openListeners) {
      try { fn(ws); } catch { /* one bad listener must not stop the rest */ }
    }
  }

  onOpen(fn: (ws: Socket) => void): () => void {
    this.openListeners.add(fn);
    return () => { this.openListeners.delete(fn); };
  }

  onMessage(fn: (ws: Socket, msg: Record<string, unknown>) => void): () => void {
    this.messageListeners.add(fn);
    return () => { this.messageListeners.delete(fn); };
  }

  /** Text from a socket: a JSON object with a string `type` (at most 4096 characters) reaches the onMessage listeners; anything else is ignored. */
  receive(ws: Socket, text: string): void {
    if (text.length > MAX_INCOMING_CHARS) return;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return; }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const msg = parsed as Record<string, unknown>;
    if (typeof msg.type !== "string") return;
    for (const fn of this.messageListeners) {
      try { fn(ws, msg); } catch { /* one bad listener must not stop the rest */ }
    }
  }

  /** Sends `JSON.stringify(msg)` to one socket; true when the socket accepted it. */
  sendTo(ws: Socket, msg: object): boolean {
    try {
      return ws.send(JSON.stringify(msg)) > 0;
    } catch {
      return false;
    }
  }

  remove(ws: Socket): void {
    this.sockets.delete(ws);
  }

  /** Sends `JSON.stringify(msg)` to every added socket; returns how many accepted it. */
  broadcast(msg: object): number {
    const text = JSON.stringify(msg);
    let sent = 0;
    for (const ws of this.sockets) {
      try {
        if (ws.send(text) > 0) sent += 1;
      } catch {
        // A socket that is closing drops out through its own close handler.
      }
    }
    return sent;
  }

  get size(): number {
    return this.sockets.size;
  }
}
