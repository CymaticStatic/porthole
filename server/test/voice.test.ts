import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { voiceFeature } from "../src/features/voice";
import { Transcriber } from "../src/voice/transcribe";
import { get, localHeaders, startTestHostd } from "./helpers/client";
import type { TestHostd } from "./helpers/client";
import { Scratch, useTestTimeout } from "./helpers/scratch";

useTestTimeout();

let s: Scratch;
let h: TestHostd;
let log: string;
const audioDir = () => path.join(h.config.stateDir, "audio");
function wav(extra = 16): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(44 + extra);
  b.set(new TextEncoder().encode("RIFF"), 0);
  b.set(new TextEncoder().encode("WAVE"), 8);
  return b;
}
const send = (body: Uint8Array<ArrayBuffer>) =>
  fetch(h.url + "/v1/voice", { method: "POST", headers: { ...localHeaders(h), Origin: h.config.origin, "Content-Type": "audio/wav" }, body });

beforeAll(async () => {
  s = new Scratch();
  log = path.join(s.root, "voxtype.log");
  // Succeeds unless the file is larger than 100 bytes; logs start/end so overlap is visible.
  s.writeFake("voxtype", "#!/bin/sh\necho \"start $*\" >> '" + log + "'\nsleep 0.3\necho end >> '" + log + "'\n[ $(stat -c %s \"$2\") -gt 100 ] && exit 1\necho '  hello world  '\n");
  h = await startTestHostd(s, [voiceFeature]);
});
afterAll(async () => { await h.stop(); s.cleanup(); });

test("a good transcription returns the text and deletes the audio", async () => {
  const r = await send(wav());
  expect([r.status, ((await r.json()) as { text: string }).text]).toEqual([200, "hello world"]);
  expect(readFileSync(log, "utf8")).toMatch(/^start transcribe \S+\.wav\n/);
  expect(existsSync(audioDir()) ? readdirSync(audioDir()) : []).toEqual([]);
});

test("P2.8: a failed transcription keeps the audio (0600) and lists it", async () => {
  const r = await send(wav(200));
  expect(r.status).toBe(502);
  const kept = ((await r.json()) as { kept: string }).kept;
  expect(statSync(path.join(audioDir(), kept)).mode & 0o777).toBe(0o600);
  expect(statSync(audioDir()).mode & 0o777).toBe(0o700);
  const list = (await (await get(h, "/v1/voice/kept")).json()) as { files: { name: string }[] };
  expect(list.files.map((f) => f.name)).toContain(kept);
});

test("transcriptions run one at a time; bad and oversized bodies are refused", async () => {
  await Bun.write(log, "");
  await Promise.all([send(wav()), send(wav())]);
  expect(readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.split(" ")[0])).toEqual(["start", "end", "start", "end"]);
  expect((await send(new Uint8Array(60))).status).toBe(400);
  expect((await send(new Uint8Array(25 * 1024 * 1024 + 1))).status).toBe(413);
});

test("sweep deletes kept audio older than 30 days and nothing newer", async () => {
  const r = await send(wav(200));
  const kept = ((await r.json()) as { kept: string }).kept;
  const t = new Transcriber(h.config);
  expect(t.sweep(Date.now() + 29 * 86_400_000)).toBe(0);
  expect(existsSync(path.join(audioDir(), kept))).toBe(true);
  expect(t.sweep(Date.now() + 31 * 86_400_000)).toBeGreaterThanOrEqual(1);
  expect(existsSync(path.join(audioDir(), kept))).toBe(false);
});

test("voiceEnhance is off by default; when on, voxflow cleans the text and a voxflow failure returns the raw text", async () => {
  const s2 = new Scratch();
  s2.writeFake("voxtype", "#!/bin/sh\necho 'raw text'\n");
  s2.writeFake("voxflow", "#!/bin/sh\ntr a-z A-Z\n");
  try {
    const on = new Transcriber(s2.config({ voiceEnhance: true }));
    expect(await on.transcribe(wav())).toEqual({ ok: true, text: "RAW TEXT" });
    s2.writeFake("voxflow", "#!/bin/sh\nexit 1\n");
    expect(await on.transcribe(wav())).toEqual({ ok: true, text: "raw text" });
    s2.writeFake("voxflow", "#!/bin/sh\ntr a-z A-Z\n");
    expect(await new Transcriber(s2.config()).transcribe(wav())).toEqual({ ok: true, text: "raw text" });
  } finally {
    s2.cleanup();
  }
});

test("voxtype's own progress and log lines on stdout are not part of the text", async () => {
  const s3 = new Scratch();
  const noisy = [
    "Loading audio file: \"/x/a.wav\"",
    "Audio format: 16000 Hz, 1 channel(s), Int",
    "Processing 22848 samples (1.43s)...",
    "2026-10-13T15:46:27.495719Z  INFO SenseVoice model loaded in 4.34s (language=auto, use_itn=true)",
    "2026-10-13T15:46:27.676792Z  INFO SenseVoice transcription completed in 0.18s: \"Front, center.\"",
    "",
    "Front, center.",
  ];
  s3.writeFake("voxtype", "#!/bin/sh\ncat <<'EOT'\n" + noisy.join("\n") + "\nEOT\n");
  try {
    expect(await new Transcriber(s3.config()).transcribe(wav())).toEqual({ ok: true, text: "Front, center." });
  } finally {
    s3.cleanup();
  }
});
