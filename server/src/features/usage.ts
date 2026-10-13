// GET /v1/usage: Claude's 5-hour and 7-day usage windows, read from `omp usage` (SPEC 4.11).
// omp already holds the Claude login; hostd never reads a credential. Numbers come only from omp's own
// `usedFraction`: nothing is estimated, and after a failed read the last good numbers are not shown as current.

import { run } from "../exec";
import { asArray, asRecord, asString } from "../json";
import { json, type FeatureFactory } from "../router";

export interface UsageWindow { id: "5h" | "7d"; usedPercent: number; resetsAt: string | null; status: string }
export interface Usage { windows: UsageWindow[]; readAt: string }

const WINDOW_IDS = ["5h", "7d"] as const;
const OMP_TIMEOUT_MS = 15_000;
export const CACHE_MS = 60_000;
export const REFRESH_MIN_MS = 10_000;
export const FAILURE_BACKOFF_MS = 30_000;

function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * The Claude 5-hour and 7-day windows of `omp usage --json -p anthropic -r` (limit ids `anthropic:5h` and `anthropic:7d`;
 * the per-model `anthropic:7d:<tier>` limits are not these). A limit without `amount.usedFraction` is left out. With several
 * accounts the highest used percentage per window is reported, with that account's reset time and status.
 * `fetchedAt` is the oldest `fetchedAt` (ms) among the reports the reported windows came from; null when none carried one.
 */
export function parseOmpUsageAt(input: unknown): { windows: UsageWindow[]; fetchedAt: number | null } {
  const best = new Map<string, { window: UsageWindow; fetchedAt: number | null }>();
  for (const report of asArray(asRecord(input).reports)) {
    const fetchedAt = finiteNumber(asRecord(report).fetchedAt);
    for (const limit of asArray(asRecord(report).limits)) {
      const l = asRecord(limit);
      const id = asString(l.id);
      const win = WINDOW_IDS.find((w) => id === "anthropic:" + w);
      if (win === undefined) continue;
      const fraction = finiteNumber(asRecord(l.amount).usedFraction);
      if (fraction === null || fraction < 0) continue;
      const usedPercent = Math.round(fraction * 1000) / 10;
      const prev = best.get(win);
      if (prev !== undefined && prev.window.usedPercent >= usedPercent) continue;
      const resetsMs = finiteNumber(asRecord(l.window).resetsAt);
      const resetDate = resetsMs === null ? null : new Date(resetsMs);
      best.set(win, {
        window: {
          id: win,
          usedPercent,
          resetsAt: resetDate !== null && !Number.isNaN(resetDate.getTime()) ? resetDate.toISOString() : null,
          status: asString(l.status) || "unknown",
        },
        fetchedAt,
      });
    }
  }
  const used = WINDOW_IDS.flatMap((w) => best.get(w) ?? []);
  const times = used.flatMap((u) => u.fetchedAt ?? []);
  return { windows: used.map((u) => u.window), fetchedAt: times.length > 0 ? Math.min(...times) : null };
}

export function parseOmpUsage(input: unknown): UsageWindow[] {
  return parseOmpUsageAt(input).windows;
}

type Read = { ok: true; usage: Usage } | { ok: false; error: string };

export const usageFeature: FeatureFactory = (d) => {
  let cached: { usage: Usage; atMs: number } | null = null;
  let failure: { error: string; atMs: number } | null = null;
  let lastAttemptMs = 0;
  let inflight: Promise<Read> | null = null;

  async function readOmp(): Promise<Read> {
    const r = await run([d.config.bin.omp, "usage", "--json", "-p", "anthropic", "-r"], { timeoutMs: OMP_TIMEOUT_MS });
    if (r.code !== 0) {
      const line = r.stderr.split("\n").map((s) => s.trim()).find((s) => s !== "");
      return { ok: false, error: "omp usage failed: " + (line !== undefined ? line.slice(0, 200) : "exit code " + r.code) };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      return { ok: false, error: "omp usage failed: output was not JSON" };
    }
    const { windows, fetchedAt } = parseOmpUsageAt(parsed);
    if (windows.length === 0) return { ok: false, error: "no Claude usage reported" };
    // omp may serve a snapshot it fetched a while ago: readAt is when the numbers were read from Claude, not when hostd asked omp.
    const readAt = new Date(fetchedAt ?? Date.now()).toISOString();
    return { ok: true, usage: { windows, readAt } };
  }

  function read(): Promise<Read> {
    if (inflight !== null) return inflight;
    lastAttemptMs = Date.now();
    const p = readOmp().then((res) => {
      cached = res.ok ? { usage: res.usage, atMs: Date.now() } : null;
      failure = res.ok ? null : { error: res.error, atMs: Date.now() };
      return res;
    }).finally(() => { inflight = null; });
    inflight = p;
    return p;
  }

  return {
    routes: [
      {
        method: "GET",
        pattern: "/v1/usage",
        async handler(req) {
          if (!d.config.usageCollection) return json({ error: "usage collection is off" }, 404);
          const now = Date.now();
          const refresh = new URL(req.url).searchParams.get("refresh") === "1";
          const fresh = cached !== null && now - cached.atMs < CACHE_MS;
          const refreshAllowed = now - lastAttemptMs >= REFRESH_MIN_MS;
          if (cached !== null && fresh && !(refresh && refreshAllowed)) return json(cached.usage);
          // After a failure omp is not asked again for FAILURE_BACKOFF_MS, whoever asks and however they ask.
          if (inflight === null && failure !== null && now - failure.atMs < FAILURE_BACKOFF_MS) return json({ error: failure.error }, 502);
          const res = await read();
          return res.ok ? json(res.usage) : json({ error: res.error }, 502);
        },
      },
    ],
    channels: [],
  };
};
