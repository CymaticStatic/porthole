// Live voice = a PipeWire source-output with application.name omp (or oh-my-pi), media.name voice
// (same contract as ~/.local/bin/omp-voice; Verified facts 11, 14).

import { run } from "../exec";
import { asArray, asRecord, asString } from "../json";

const VOICE_APPS = new Set(["omp", "oh-my-pi"]);

export async function liveVoicePids(pactl: string): Promise<{ ok: true; pids: Set<number> } | { ok: false; error: string }> {
  const r = await run([pactl, "-f", "json", "list", "source-outputs"]);
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() || "pactl exited with " + r.code };
  let rows: unknown[];
  try { rows = asArray(JSON.parse(r.stdout)); } catch { return { ok: false, error: "pactl did not print JSON" }; }
  const pids = new Set<number>();
  for (const row of rows) {
    const p = asRecord(asRecord(row).properties);
    const pid = Number(asString(p["application.process.id"]));
    if (VOICE_APPS.has(asString(p["application.name"])) && asString(p["media.name"]) === "voice" && pid > 0) pids.add(pid);
  }
  return { ok: true, pids };
}
