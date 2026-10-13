// GET /v1/previews: the local ports Porthole can open as previews, and the preview listener's own port.
// The listener (PreviewProxy) starts and stops with the feature. Nothing here touches `tailscale serve`.

import { Auth } from "../auth/auth";
import { Whois } from "../auth/identity";
import { parseRanges } from "../config";
import { pidsDir } from "../pids";
import { PreviewProxy } from "../preview/proxy";
import { hostdPids, scan, type Preview } from "../preview/scan";
import { json, type FeatureFactory } from "../router";

const ALLOWED_SCAN_MAX_AGE_MS = 10_000;

export const previewFeature: FeatureFactory = (d) => {
  let latest: Preview[] = [];
  let scannedAt = 0;
  let inflight: Promise<Preview[]> | null = null;

  // Concurrent callers share one scan.
  const refresh = (): Promise<Preview[]> => {
    inflight ??= scan(d.config, hostdPids(pidsDir(d.config.runtimeDir)))
      .then((found) => {
        latest = found;
        scannedAt = Date.now();
        return found;
      })
      .finally(() => { inflight = null; });
    return inflight;
  };

  // A port is previewable only inside the ranges as configured right now (PUT /v1/config can narrow them at any time).
  const inRanges = (port: number): boolean => {
    const parsed = parseRanges(d.config.previewRanges);
    return !("error" in parsed) && parsed.ranges.some(([lo, hi]) => port >= lo && port <= hi);
  };

  // allowed() is synchronous: it answers from the latest scan and, when that is older than 10 s, starts a rescan for the next call.
  const proxy = new PreviewProxy(
    d.config,
    new Auth(d.config, new Whois(d.config.bin.tailscale), d.localToken),
    (port) => {
      if (Date.now() - scannedAt > ALLOWED_SCAN_MAX_AGE_MS) void refresh();
      return inRanges(port) && latest.some((p) => p.port === port);
    },
    (port) => latest.find((p) => p.port === port)?.pid ?? null,
  );

  return {
    routes: [
      {
        method: "GET",
        pattern: "/v1/previews",
        async handler() {
          return json({ proxy: { port: proxy.port }, previews: await refresh() });
        },
      },
    ],
    channels: [],
    async start() {
      proxy.start();
      void refresh();
    },
    stop() {
      proxy.stop();
    },
  };
};
