// GET /v1/sessions (the tree) and the /v1/events socket: a snapshot on open, then every change.

import { json, type FeatureFactory } from "../router";

export const sessionsFeature: FeatureFactory = (d) => {
  let unsubscribe: (() => void) | null = null;
  let unsubscribePing: (() => void) | null = null;
  return {
    routes: [
      {
        method: "GET",
        pattern: "/v1/sessions",
        async handler() {
          return json(await d.registry.current());
        },
      },
    ],
    channels: [
      {
        pattern: "/v1/events",
        open(ws) {
          d.hub.add(ws);
          d.registry.startWatching();
          void d.registry.current().then((tree) => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: "sessions", tree }));
          });
        },
        message(ws, data) {
          d.hub.receive(ws, typeof data === "string" ? data : data.toString("utf8"));
        },
        close(ws) {
          d.hub.remove(ws);
          d.registry.stopWatching();
        },
      },
    ],
    async start() {
      unsubscribe = d.registry.onChange((tree) => {
        d.hub.broadcast({ type: "sessions", tree });
      });
      // The page's heartbeat: {type:"ping"} gets {type:"pong"} back on the same socket, echoing a string or number id.
      unsubscribePing = d.hub.onMessage((ws, m) => {
        if (m.type !== "ping") return;
        const pong: { type: "pong"; id?: string | number } = { type: "pong" };
        if (typeof m.id === "string" || typeof m.id === "number") pong.id = m.id;
        d.hub.sendTo(ws, pong);
      });
    },
    stop() {
      unsubscribe?.();
      unsubscribe = null;
      unsubscribePing?.();
      unsubscribePing = null;
    },
  };
};
