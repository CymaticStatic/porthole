// Voice transcription (SPEC 4.12): one WAV at a time through Ben's own `voxtype transcribe`.
// No `--engine` is passed: whatever engine Ben's voxtype is set to decides (plan fact F7).
// Porthole never starts, stops or reconfigures the voxtype daemon. A good transcription deletes its audio;
// a failed one keeps the file (0600) for KEEP_AUDIO_DAYS days so Ben can recover it.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HostdConfig } from "../config";
import { run } from "../exec";

export const MAX_AUDIO = 25 * 1024 * 1024;
export const KEEP_AUDIO_DAYS = 30;
const TRANSCRIBE_TIMEOUT_MS = 120_000;
const ENHANCE_TIMEOUT_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const AUDIO_NAME = /^\d{8}-\d{6}-[0-9a-f]{8}\.wav$/;
// `voxtype transcribe` 1.1.0 prints its own progress and log lines on stdout, ahead of the text (seen on 2026-10-13).
const VOXTYPE_NOISE = /^(Loading audio file: |Audio format: |Processing \d+ samples|\d{4}-\d\d-\d\dT[\d:.]+Z\s+(TRACE|DEBUG|INFO|WARN|ERROR)\b)/;

export type Outcome = { ok: true; text: string } | { ok: false; error: string; kept: string };

export class Transcriber {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly inFlight = new Set<string>();
  private readonly dir: string;

  constructor(private readonly cfg: HostdConfig) {
    this.dir = path.join(cfg.stateDir, "audio");
  }

  /** Queued: only one voxtype run is ever active, however many requests arrive. */
  transcribe(wav: Uint8Array): Promise<Outcome> {
    const job = this.chain.then(() => this.runOne(wav));
    this.chain = job.catch(() => undefined);
    return job;
  }

  private async runOne(wav: Uint8Array): Promise<Outcome> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    const name = stamp + "-" + randomBytes(4).toString("hex") + ".wav";
    const file = path.join(this.dir, name);
    writeFileSync(file, wav, { flag: "wx", mode: 0o600 });
    this.inFlight.add(name);
    try {
      const r = await run([this.cfg.bin.voxtype, "transcribe", file], { timeoutMs: TRANSCRIBE_TIMEOUT_MS });
      let text = r.stdout.split("\n").filter((l) => !VOXTYPE_NOISE.test(l)).join("\n").trim();
      if (r.code !== 0 || text === "") {
        return { ok: false, error: "transcription failed; the audio is kept as " + name, kept: name };
      }
      if (this.cfg.voiceEnhance) {
        // voxflow enhance cleans the text; any failure returns the raw text (F10).
        const e = await run([this.cfg.bin.voxflow, "enhance"], { input: text, timeoutMs: ENHANCE_TIMEOUT_MS });
        const cleaned = e.stdout.trim();
        if (e.code === 0 && cleaned !== "") text = cleaned;
      }
      unlinkSync(file);
      return { ok: true, text };
    } finally {
      this.inFlight.delete(name);
    }
  }

  private keptFiles(): { name: string; size: number; mtimeMs: number }[] {
    let names: string[];
    try { names = readdirSync(this.dir); } catch { return []; }
    const rows: { name: string; size: number; mtimeMs: number }[] = [];
    for (const name of names) {
      if (!AUDIO_NAME.test(name) || this.inFlight.has(name)) continue;
      try {
        const st = statSync(path.join(this.dir, name));
        if (st.isFile()) rows.push({ name, size: st.size, mtimeMs: st.mtimeMs });
      } catch { /* removed between listing and stat */ }
    }
    return rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  kept(): { name: string; size: number; keptAt: string }[] {
    return this.keptFiles().map((f) => ({ name: f.name, size: f.size, keptAt: new Date(f.mtimeMs).toISOString() }));
  }

  /** Deletes kept files older than KEEP_AUDIO_DAYS; returns how many. */
  sweep(nowMs: number): number {
    let n = 0;
    for (const f of this.keptFiles()) {
      if (nowMs - f.mtimeMs <= KEEP_AUDIO_DAYS * DAY_MS) continue;
      try { unlinkSync(path.join(this.dir, f.name)); n++; } catch { /* already gone */ }
    }
    return n;
  }
}
