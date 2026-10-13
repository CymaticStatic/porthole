// POST /v1/uploads (multipart, field "file") -> {path} (SPEC 4.8). Files land in
// <stateDir>/uploads/<YYYY-MM-DD>/ (files 0600, folders 0700); hostd deletes them after 30 days.

import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { json, type FeatureFactory } from "../router";
import { dayFolder, MAX_UPLOAD, safeName, sweepOld, writeUnique } from "../uploads/names";

const MULTIPART_OVERHEAD = 1024 * 1024;
const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export const uploadsFeature: FeatureFactory = (d) => {
  const root = path.join(d.config.stateDir, "uploads");
  let timer: NodeJS.Timeout | undefined;

  const sweep = (): void => {
    try { sweepOld(root, Date.now()); } catch { /* a failed sweep is retried in 6 hours */ }
  };

  return {
    routes: [
      {
        method: "POST",
        pattern: "/v1/uploads",
        async handler(req) {
          const length = Number(req.headers.get("content-length"));
          if (Number.isFinite(length) && length > MAX_UPLOAD + MULTIPART_OVERHEAD) return json({ error: "file is over 50 MB" }, 413);
          let form: FormData;
          try { form = await req.formData(); } catch { return json({ error: "expected multipart/form-data" }, 400); }
          const file = form.get("file");
          if (typeof file === "string" || file === null) return json({ error: 'missing "file" part' }, 400);
          if (file.size > MAX_UPLOAD) return json({ error: "file is over 50 MB" }, 413);
          const now = new Date();
          const dir = dayFolder(root, now);
          ensureDir(root);
          ensureDir(dir);
          const saved = writeUnique(dir, safeName(file.name, now), new Uint8Array(await file.arrayBuffer()));
          return json({ path: saved });
        },
      },
    ],
    channels: [],
    async start() {
      ensureDir(root);
      sweep();
      timer = setInterval(sweep, SWEEP_EVERY_MS);
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
};
