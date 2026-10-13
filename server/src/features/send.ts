// POST /v1/sessions/:id/send, GET /v1/sends/:clientMsgId, POST /v1/sessions/:id/keys (SPEC 5.2).

import { Deliverer } from "../deliver/deliver";
import { CLIENT_MSG_ID, MAX_MESSAGE_BYTES } from "../deliver/inbox";
import { parseSteps } from "../deliver/keys";
import type { SendRecord } from "../deliver/sentlog";
import { asRecord } from "../json";
import { json, type FeatureFactory } from "../router";

/** The record as the client sees it: never the text. */
function publicRecord(r: SendRecord): Omit<SendRecord, "text"> {
  const { text: _text, ...rest } = r;
  return rest;
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? asRecord(body) : null;
  } catch {
    return null;
  }
}

const STATUS_CODE = { delivered: 200, pending: 200, refused: 409, failed: 502, sent: 200 } as const;

export const sendFeature: FeatureFactory = (deps) => {
  const deliverer = new Deliverer(deps.config, deps.registry, deps.sentLog);
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    routes: [
      {
        method: "POST",
        pattern: "/v1/sessions/:id/send",
        async handler(req, params) {
          const body = await readBody(req);
          if (body === null) return json({ error: "the body must be JSON" }, 400);
          const { clientMsgId, text } = body;
          if (typeof clientMsgId !== "string" || !CLIENT_MSG_ID.test(clientMsgId)) return json({ error: "clientMsgId must be 1 to 100 letters, digits, dots, dashes or underscores" }, 400);
          if (typeof text !== "string") return json({ error: "text is required" }, 400);
          if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) return json({ error: "text is longer than " + MAX_MESSAGE_BYTES / 1024 + " KiB" }, 400);
          const rec = await deliverer.send(params.id, clientMsgId, text);
          return json(publicRecord(rec), STATUS_CODE[rec.status]);
        },
      },
      {
        method: "GET",
        pattern: "/v1/sends/:clientMsgId",
        async handler(_req, params) {
          const rec = deliverer.status(params.clientMsgId);
          return rec ? json(publicRecord(rec)) : json({ error: "no such message" }, 404);
        },
      },
      {
        method: "POST",
        pattern: "/v1/sessions/:id/keys",
        async handler(req, params) {
          const body = await readBody(req);
          if (body === null || body.keys === undefined) return json({ error: "keys is required" }, 400);
          const steps = parseSteps(body.keys);
          if ("error" in steps) return json({ error: steps.error }, 400);
          const result = await deliverer.keys(params.id, steps);
          return json(result, STATUS_CODE[result.status]);
        },
      },
    ],
    channels: [],
    async start() {
      await deliverer.reconcilePending();
      timer = setInterval(() => {
        if (deliverer.hasPending()) void deliverer.reconcilePending();
      }, deps.config.scanIntervalMs);
    },
    stop() {
      clearInterval(timer ?? undefined);
      timer = null;
    },
  };
};
