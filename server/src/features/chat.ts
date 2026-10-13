// GET /v1/sessions/:id/chat (pages), the /v1/sessions/:id/chat socket (backlog, then appended
// lines) and GET /v1/sessions/:id/screen (the pane's visible text).

import type { ServerWebSocket } from "bun";
import { json, type FeatureFactory, type WsData } from "../router";
import { readScreen } from "../sessions/herdr";
import type { Tree } from "../sessions/registry";
import { capturePane } from "../sessions/tmux";
import type { ChatItem } from "../transcript/parse";
import { Follower, readAfter, readPage, type Page } from "../transcript/tail";

const DEFAULT_CHAT_LIMIT = 50;
const MAX_CHAT_LIMIT = 200;
const DEFAULT_SCREEN_LINES = 200;
const MAX_SCREEN_LINES = 2000;
const NO_TRANSCRIPT_NOTE = "this session has no omp transcript; use Terminal or Screen";

/** An integer in [min, max]; anything missing or unparsable gives `fallback`. */
function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** A cursor (byte offset): null when absent, NaN when present but not a number. */
function cursor(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : NaN;
}

interface ChatSocket {
  id: string;
  file: string | null;
  follower: Follower | null;
  closed: boolean;
}

export const chatFeature: FeatureFactory = (d) => {
  const sockets = new Map<ServerWebSocket<WsData>, ChatSocket>();
  let unsubscribe: (() => void) | null = null;

  const send = (ws: ServerWebSocket<WsData>, msg: unknown): void => {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  };

  const fail = (ws: ServerWebSocket<WsData>, error: string): void => {
    send(ws, { type: "error", error });
    ws.close(1000);
  };

  /** Stop any follower, send a fresh backlog of `file`, and follow `file` from the page's end. */
  const follow = (ws: ServerWebSocket<WsData>, cs: ChatSocket, file: string): void => {
    cs.follower?.stop();
    cs.follower = null;
    cs.file = file;
    const page = readPage(file, null, DEFAULT_CHAT_LIMIT);
    send(ws, { type: "backlog", page });
    const follower = new Follower(
      file,
      page.end,
      (items: ChatItem[], end: number) => send(ws, { type: "append", items, end }),
      () => {
        if (cs.closed || cs.follower !== follower) return;
        try {
          follow(ws, cs, file);
        } catch {
          // The file vanished between the reset and the re-read: the next transcript change recovers.
        }
      },
    );
    cs.follower = follower;
    follower.start();
  };

  const onTree = (tree: Tree): void => {
    for (const [ws, cs] of sockets) {
      if (cs.closed || cs.file === null) continue;
      const info = tree.sessions.find((s) => s.id === cs.id);
      const next = info?.omp?.transcript ?? null;
      if (next === null || next === cs.file) continue;
      try {
        follow(ws, cs, next);
      } catch {
        // The new transcript is not readable yet: keep following the old one until the next change.
      }
    }
  };

  /** The cached tree may predate a new session: on a miss, scan once more before saying no. */
  const find = async (id: string) => (await d.registry.get(id)) ?? (await d.registry.get(id, 0));

  return {
    routes: [
      {
        method: "GET",
        pattern: "/v1/sessions/:id/chat",
        async handler(req, params, ctx) {
          ctx.session = params.id;
          const info = await find(params.id);
          if (!info) return json({ error: "no such session" }, 404);
          const file = info.omp?.transcript ?? null;
          if (file === null) {
            return json({ items: [], start: 0, end: 0, hasOlder: false, note: NO_TRANSCRIPT_NOTE });
          }
          const q = new URL(req.url).searchParams;
          const before = cursor(q.get("before"));
          const after = cursor(q.get("after"));
          if ((before !== null && Number.isNaN(before)) || (after !== null && Number.isNaN(after))) {
            return json({ error: "cursor must be an integer" }, 400);
          }
          const limit = clampInt(q.get("limit"), 1, MAX_CHAT_LIMIT, DEFAULT_CHAT_LIMIT);
          let page: Page;
          try {
            page = after !== null ? readAfter(file, after) : readPage(file, before, limit);
          } catch (e) {
            return json({ error: "cannot read the transcript: " + (e instanceof Error ? e.message : String(e)) }, 502);
          }
          return json(page);
        },
      },
      {
        method: "GET",
        pattern: "/v1/sessions/:id/screen",
        async handler(req, params, ctx) {
          ctx.session = params.id;
          const info = await find(params.id);
          if (!info) return json({ error: "no such session" }, 404);
          const lines = clampInt(new URL(req.url).searchParams.get("lines"), 1, MAX_SCREEN_LINES, DEFAULT_SCREEN_LINES);
          const where = info.where;
          if (where.kind === "tmux") {
            const r = await capturePane(d.config, where);
            if (!r.ok) return json({ error: r.error }, 502);
            const all = r.text.replace(/\n+$/, "").split("\n");
            const text = all.slice(-lines).join("\n") + "\n";
            return json({ text, source: "tmux", at: new Date().toISOString() });
          }
          const r = await readScreen(d.config, where.pane, lines);
          if (!r.ok) return json({ error: r.error }, 502);
          return json({ text: r.text, source: "herdr", at: new Date().toISOString() });
        },
      },
    ],
    channels: [
      {
        pattern: "/v1/sessions/:id/chat",
        open(ws) {
          const cs: ChatSocket = { id: ws.data.params.id, file: null, follower: null, closed: false };
          sockets.set(ws, cs);
          ws.data.ctx.session = cs.id;
          d.registry.startWatching();
          void (async () => {
            try {
              const info = await find(cs.id);
              if (cs.closed) return;
              if (!info) return fail(ws, "no such session");
              const file = info.omp?.transcript ?? null;
              if (file === null) return fail(ws, "this session has no omp transcript");
              follow(ws, cs, file);
            } catch (e) {
              if (!cs.closed) fail(ws, "cannot read the transcript: " + (e instanceof Error ? e.message : String(e)));
            }
          })();
        },
        message() {
          // The chat socket is server-to-client only; sending goes through POST /v1/sessions/:id/send.
        },
        close(ws) {
          const cs = sockets.get(ws);
          if (!cs) return;
          cs.closed = true;
          cs.follower?.stop();
          cs.follower = null;
          sockets.delete(ws);
          d.registry.stopWatching();
        },
      },
    ],
    async start() {
      unsubscribe = d.registry.onChange(onTree);
    },
    stop() {
      unsubscribe?.();
      unsubscribe = null;
      for (const cs of sockets.values()) {
        cs.follower?.stop();
        cs.follower = null;
      }
    },
  };
};
