// One live check of voice transcription against the real voxtype (P2.11, then P2.8). Run once, by hand; never rerun.
// Exit 0 = pass, 1 = fail (report, do not loop), 2 = could not run (daemon not active, or too little graphics memory).
// Porthole never starts, stops or reconfigures the voxtype daemon; this script only reads its state.
import path from "node:path";
import { run } from "../../src/exec";
import { voiceFeature } from "../../src/features/voice";
import { createHostd, type Hostd } from "../../src/hostd";
import { localHeaders } from "../helpers/client";
import { Scratch } from "../helpers/scratch";

const VOXTYPE_UNIT = "voxtype.service"; // found with `systemctl --user list-units --all 'voxtype*'` (plan step 5)
const SYSTEMCTL = "/usr/bin/systemctl";
const FFMPEG = "/usr/bin/ffmpeg";
const NVIDIA_SMI = "/usr/bin/nvidia-smi";
const SOURCE_WAV = "/usr/share/sounds/alsa/Front_Center.wav";
const MIN_FREE_MIB = 1500;
const MAX_DELTA_MIB = 200;
const SAMPLE_MS = 200;

async function daemonState(): Promise<string> {
  const r = await run([SYSTEMCTL, "--user", "is-active", VOXTYPE_UNIT]);
  return r.stdout.trim() || r.stderr.trim() || "unknown (exit " + r.code + ")";
}

async function vram(): Promise<{ used: number; total: number }> {
  const r = await run([NVIDIA_SMI, "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"]);
  const [used, total] = r.stdout.trim().split(",").map((x) => Number(x.trim()));
  if (r.code !== 0 || !Number.isFinite(used) || !Number.isFinite(total)) throw new Error("nvidia-smi failed: " + (r.stderr.trim() || r.stdout.trim()));
  return { used, total };
}

const state = await daemonState();
console.log("VOXTYPE DAEMON: " + state);
if (state !== "active") {
  console.log("VOXTYPE DAEMON: not running (" + state + "); nothing measured, nothing transcribed. Tell Ben.");
  process.exit(2);
}

const s = new Scratch();
let code = 1;
let h: Hostd | undefined;
try {
  const wav = path.join(s.root, "front-center-16k.wav");
  const ff = await run([FFMPEG, "-y", "-loglevel", "error", "-i", SOURCE_WAV, "-ar", "16000", "-ac", "1", wav], { timeoutMs: 30_000 });
  if (ff.code !== 0) throw new Error("ffmpeg failed: " + ff.stderr.trim());

  const before = await vram();
  const free = before.total - before.used;
  if (free < MIN_FREE_MIB) {
    console.log("VRAM CHECK: only " + free + " MiB free; not transcribing. Ask Ben.");
    code = 2;
  } else {
    h = await createHostd(s.config({ bin: { voxtype: "/usr/bin/voxtype" } }), [voiceFeature]);
    let peak = before.used;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        try { peak = Math.max(peak, (await vram()).used); } catch { /* one missed sample is fine */ }
        await Bun.sleep(SAMPLE_MS);
      }
    })();
    let text = "";
    try {
      const res = await fetch(h.url + "/v1/voice", {
        method: "POST",
        headers: { ...localHeaders(h), Origin: h.config.origin, "Content-Type": "audio/wav" },
        body: Bun.file(wav),
      });
      const body = (await res.json()) as { text?: string; error?: string };
      text = res.status === 200 ? (body.text ?? "") : "ERROR " + res.status + ": " + (body.error ?? "");
    } finally {
      sampling = false;
      await sampler;
    }
    const after = await vram();
    const delta = peak - before.used;
    const verdict = delta <= MAX_DELTA_MIB ? "no second model" : "SECOND MODEL LOADED: stop and ask Ben";
    console.log("VRAM CHECK: before " + before.used + " MiB, peak " + peak + " MiB, delta " + delta + " MiB -> " + verdict);
    console.log("VRAM AFTER: " + after.used + " MiB of " + after.total + " MiB");
    console.log("TEXT: " + text);
    const lower = text.toLowerCase();
    code = delta <= MAX_DELTA_MIB && lower.includes("front") && lower.includes("center") ? 0 : 1;
    console.log(code === 0 ? "PASS" : "FAIL: do not rerun, report to Ben");
  }
} catch (e) {
  console.log("FAIL: " + (e instanceof Error ? e.message : String(e)) + " (do not rerun, report to Ben)");
} finally {
  await h?.stop();
  s.cleanup();
}
console.log("VOXTYPE DAEMON AFTER: " + (await daemonState()));
process.exit(code);
