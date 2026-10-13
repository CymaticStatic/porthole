// The inbox (SPEC 4.3, 4.6, 4.7): omp events and herdr statuses become items, notifications go out with replay,
// and a question is answered through the key row. Stop is not here: the app uses POST /v1/sessions/:id/keys.

import { existsSync } from "node:fs";
import path from "node:path";
import { Deliverer } from "../deliver/deliver";
import { answerRefusal, answerSteps, chunks, parseAnswer } from "../events/answer";
import { InboxStore, type Change } from "../events/inbox";
import { NotifyQueue } from "../events/notify";
import { EventsSocket, type OmpEvent } from "../events/socket";
import { asRecord } from "../json";
import { json, type FeatureFactory } from "../router";

const TICK_MS = 5000;

/**
 * Ends every live omp item whose process is gone (the extension's session_end can be lost when omp exits fast).
 * Items already in "done" are left alone: they archive on their own, and re-ending them would keep them alive.
 */
export function endDeadSessions(store: InboxStore, exists: (pid: number) => boolean = (pid) => existsSync("/proc/" + pid)): Change[] {
  const out: Change[] = [];
  for (const item of store.list()) {
    if (item.kind !== "omp" || item.column === "done") continue;
    const pid = Number(item.key.slice("omp:".length));
    if (!Number.isInteger(pid) || pid <= 0 || exists(pid)) continue;
    const change = store.omp({ type: "session_end", pid, at: new Date().toISOString() }, item.sessionId);
    if (change) out.push(change);
  }
  return out;
}

export const inboxFeature: FeatureFactory = (d) => {
  const store = new InboxStore({ file: path.join(d.config.stateDir, "inbox.json"), machine: d.config.machineName });
  const queue = new NotifyQueue({ file: path.join(d.config.stateDir, "notify.json"), send: (m) => { d.hub.broadcast(m); }, current: (id) => store.get(id) });
  const deliverer = new Deliverer(d.config, d.registry, d.sentLog);
  /** qids whose answer was started; a refusal before any key is sent takes the qid out again. */
  const answered = new Set<string>();
  const unsubscribe: (() => void)[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let chain: Promise<void> = Promise.resolve();

  function apply(change: Change | null): void {
    if (change === null) return;
    if (change.becameNeedsYou || change.turnFinished) queue.notify(change.item);
    d.hub.broadcast({ type: "inbox", items: store.list() });
  }

  async function handle(e: OmpEvent): Promise<void> {
    const info = (await d.registry.current(0)).sessions.find((x) => x.omp?.pid === e.pid);
    apply(store.omp(e, info?.id ?? "omp:" + e.pid));
  }

  const socket = new EventsSocket(path.join(d.config.runtimeDir, "events.sock"), (e) => {
    chain = chain.then(() => handle(e)).catch(() => { /* one failed event must not stop the next */ });
  });

  function deviceOf(ws: { data: { query: URLSearchParams; ctx: { device: string } } }): string {
    return ws.data.query.get("device") || ws.data.ctx.device;
  }

  return {
    routes: [
      { method: "GET", pattern: "/v1/inbox", handler: () => json({ items: store.list() }) },
      { method: "GET", pattern: "/v1/inbox/archive", handler: () => json({ items: store.archived() }) },
      {
        method: "POST",
        pattern: "/v1/inbox/:itemId/archive",
        handler(_req, params) {
          if (!store.archive(params.itemId)) return json({ error: "no such item" }, 404);
          d.hub.broadcast({ type: "inbox", items: store.list() });
          return json({ archived: true });
        },
      },
      {
        method: "POST",
        pattern: "/v1/inbox/:itemId/answer",
        async handler(req, params) {
          const item = store.get(params.itemId);
          if (item === undefined) return json({ error: "no such item" }, 404);
          const a = parseAnswer(asRecord(await req.json().catch(() => null)));
          if ("error" in a) return json({ error: a.error }, 400);
          const info = await d.registry.get(item.sessionId, 0);
          const reason = answerRefusal(item, info, a, answered);
          if (reason !== null || item.question === null) return json({ status: "refused", reason }, 409);
          const qid = item.question.qid;
          answered.add(qid);
          const parts = chunks(answerSteps(item.question.options.length, a));
          for (let i = 0; i < parts.length; i++) {
            const r = await deliverer.keys(item.sessionId, parts[i]);
            if (r.status === "sent") continue;
            // A refusal on the first chunk happens before any key is sent; anything later may have changed the dialog.
            if (r.status === "refused" && i === 0) answered.delete(qid);
            return json(r, r.status === "refused" ? 409 : 502);
          }
          return json({ status: "sent", reason: "" });
        },
      },
    ],
    channels: [],
    async start() {
      await socket.start();
      d.registry.startWatching();
      unsubscribe.push(d.registry.onChange((tree) => {
        for (const s of tree.sessions) {
          if (s.kind === "herdr" && s.herdrStatus !== null) apply(store.herdr(s.id, s.herdrStatus, s.name, s.cwd));
        }
      }));
      unsubscribe.push(d.hub.onOpen((ws) => {
        const device = deviceOf(ws);
        queue.register(device);
        for (const m of queue.pendingFor(device, Number(ws.data.query.get("since") ?? "0") || 0)) d.hub.sendTo(ws, m);
      }));
      unsubscribe.push(d.hub.onMessage((ws, m) => {
        if (m.type === "ack" && typeof m.id === "number" && Number.isInteger(m.id)) queue.ack(deviceOf(ws), m.id);
      }));
      timer = setInterval(() => {
        queue.tick();
        for (const c of endDeadSessions(store)) apply(c);
        if (store.sweep()) d.hub.broadcast({ type: "inbox", items: store.list() });
      }, TICK_MS);
    },
    stop() {
      clearInterval(timer ?? undefined);
      timer = null;
      for (const off of unsubscribe.splice(0)) off();
      d.registry.stopWatching();
      socket.stop();
    },
  };
};
