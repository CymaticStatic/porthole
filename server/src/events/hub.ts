// The set of open /v1/events sockets. Features broadcast through it; P2 adds notify/ack messages here.

import type { ServerWebSocket } from "bun";
import type { WsData } from "../router";

export class EventsHub {
  private readonly sockets = new Set<ServerWebSocket<WsData>>();

  add(ws: ServerWebSocket<WsData>): void {
    this.sockets.add(ws);
  }

  remove(ws: ServerWebSocket<WsData>): void {
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
