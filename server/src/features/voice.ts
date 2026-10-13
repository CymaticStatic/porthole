// POST /v1/voice (audio/wav) -> {text}; GET /v1/voice/kept -> {files} (SPEC 4.12).

import { json, type FeatureFactory } from "../router";
import { MAX_AUDIO, Transcriber } from "../voice/transcribe";

const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;
const TOO_BIG = "the audio is larger than 25 MB";

/** The whole body, or null as soon as it passes MAX_AUDIO (never buffers more than the cap plus one chunk). */
async function readCapped(req: Request): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of req.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > MAX_AUDIO) return null;
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

const text4 = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

export const voiceFeature: FeatureFactory = (d) => {
  const transcriber = new Transcriber(d.config);
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    routes: [
      {
        method: "POST",
        pattern: "/v1/voice",
        async handler(req) {
          const declared = Number(req.headers.get("content-length") ?? "0");
          if (declared > MAX_AUDIO) return json({ error: TOO_BIG }, 413);
          const body = await readCapped(req);
          if (body === null) return json({ error: TOO_BIG }, 413);
          if (body.byteLength < 12 || text4(body, 0) !== "RIFF" || text4(body, 8) !== "WAVE") {
            return json({ error: "send a 16 kHz mono WAV" }, 400);
          }
          const out = await transcriber.transcribe(body);
          if (!out.ok) return json({ error: out.error, kept: out.kept }, 502);
          return json({ text: out.text });
        },
      },
      {
        method: "GET",
        pattern: "/v1/voice/kept",
        handler() {
          return json({ files: transcriber.kept() });
        },
      },
    ],
    channels: [],
    async start() {
      transcriber.sweep(Date.now());
      timer = setInterval(() => transcriber.sweep(Date.now()), SWEEP_EVERY_MS);
    },
    stop() {
      clearInterval(timer);
    },
  };
};
