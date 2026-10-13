// GET|PUT /v1/config (SPEC 4.2 item 6): the few settings the app may change. The file is the one hostd was
// started with; a change is checked, written (tmp + rename, 0600) and applied to the running config at once,
// except `peers`, which Auth copies at start-up and so needs a restart.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validateConfig, type HostdConfig } from "../config";
import { asRecord } from "../json";
import { json, type FeatureFactory } from "../router";

const EDITABLE = ["previewRanges", "usageCollection", "peers", "voiceEnhance"];

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The config file as JSON (missing = {}); null when it exists but is not a JSON object. */
function readFile(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? asRecord(raw) : null;
  } catch {
    return null;
  }
}

/** `peers` is what is saved (what will apply after a restart); `restartNeeded` says it differs from the running list. */
function view(config: HostdConfig, saved: Record<string, unknown>): Record<string, unknown> {
  const savedPeers = Array.isArray(saved.peers) && saved.peers.every((p) => typeof p === "string") ? (saved.peers as string[]) : config.peers;
  return {
    previewRanges: config.previewRanges,
    usageCollection: config.usageCollection,
    peers: savedPeers,
    voiceEnhance: config.voiceEnhance,
    restartNeeded: !sameList(savedPeers, config.peers),
  };
}

export function configFeature(file: string): FeatureFactory {
  return (deps) => ({
    routes: [
      {
        method: "GET",
        pattern: "/v1/config",
        handler() {
          const saved = readFile(file);
          return saved === null ? json({ error: "the config file cannot be read" }, 500) : json(view(deps.config, saved));
        },
      },
      {
        method: "PUT",
        pattern: "/v1/config",
        async handler(req) {
          let body: Record<string, unknown>;
          try {
            const parsed: unknown = await req.json();
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return json({ error: "the body must be a JSON object" }, 400);
            body = asRecord(parsed);
          } catch {
            return json({ error: "the body must be JSON" }, 400);
          }
          const unknown = Object.keys(body).filter((k) => !EDITABLE.includes(k));
          if (unknown.length) return json({ error: "cannot change " + unknown.map((k) => JSON.stringify(k)).join(", ") + "; allowed: " + EDITABLE.join(", ") }, 400);
          const { previewRanges, usageCollection, peers, voiceEnhance } = body;
          if (previewRanges !== undefined && typeof previewRanges !== "string") return json({ error: "previewRanges must be text such as \"3000-3999\" or \"none\"" }, 400);
          if (usageCollection !== undefined && typeof usageCollection !== "boolean") return json({ error: "usageCollection must be true or false" }, 400);
          if (voiceEnhance !== undefined && typeof voiceEnhance !== "boolean") return json({ error: "voiceEnhance must be true or false" }, 400);
          if (peers !== undefined && (!Array.isArray(peers) || !peers.every((p) => typeof p === "string"))) return json({ error: "peers must be a list of origins" }, 400);

          const changes: Partial<Pick<HostdConfig, "previewRanges" | "usageCollection" | "peers" | "voiceEnhance">> = {};
          if (previewRanges !== undefined) changes.previewRanges = previewRanges;
          if (usageCollection !== undefined) changes.usageCollection = usageCollection;
          if (voiceEnhance !== undefined) changes.voiceEnhance = voiceEnhance;
          if (peers !== undefined) changes.peers = peers as string[];

          const problems = validateConfig({ ...deps.config, ...changes });
          if (problems.length) return json({ error: problems.join("; ") }, 400);

          const saved = readFile(file);
          if (saved === null) return json({ error: "the config file cannot be read, so nothing was changed" }, 500);
          const next = { ...saved, ...changes };
          mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
          const tmp = file + ".tmp";
          writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
          chmodSync(tmp, 0o600);
          renameSync(tmp, file);

          // Features read these three per request; `peers` is copied by Auth at start-up and waits for a restart.
          if (changes.previewRanges !== undefined) deps.config.previewRanges = changes.previewRanges;
          if (changes.usageCollection !== undefined) deps.config.usageCollection = changes.usageCollection;
          if (changes.voiceEnhance !== undefined) deps.config.voiceEnhance = changes.voiceEnhance;
          return json(view(deps.config, next));
        },
      },
    ],
    channels: [],
  });
}
