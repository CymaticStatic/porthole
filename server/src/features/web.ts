// webFeature: serves the control-room page (the files under web/) from hostd's own origin.
// The folder is walked once, when the feature is built, and every file becomes one exact GET route (the
// router has no wildcard); a missing folder serves nothing. Dotfiles never get a route, and neither does a
// file whose real path (symlinks resolved) is outside the folder; the check runs again on every request.

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { json, type Feature, type FeatureFactory, type Route } from "../router";

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' https://*.ts.net wss://*.ts.net",
  "style-src 'self'",
  "script-src 'self'",
  "frame-ancestors 'none'",
].join("; ");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const MAX_DEPTH = 12;

function inside(root: string, p: string): boolean {
  return p === root || p.startsWith(root + path.sep);
}

/** The URL path the router will see for these folder segments: the browser's own percent-encoding. */
function urlPath(segments: string[]): string {
  const raw = segments.map((s) => s.replace(/[%#?\\]/g, encodeURIComponent)).join("/");
  return new URL("http://x/" + raw).pathname;
}

interface Found { segments: string[]; file: string }

function walk(root: string): Found[] {
  const found: Found[] = [];
  const seen = new Set<string>([root]);
  const visit = (dir: string, segments: string[]) => {
    if (segments.length >= MAX_DEPTH) return;
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names.sort()) {
      // `:` would be read by the router as a parameter segment; web/test holds the page's own tests.
      if (name.startsWith(".") || name.startsWith(":")) continue;
      if (segments.length === 0 && name === "test") continue;
      let real: string;
      try { real = realpathSync(path.join(dir, name)); } catch { continue; }
      if (!inside(root, real)) continue;
      let isDir: boolean;
      let isFile: boolean;
      try { const st = statSync(real); isDir = st.isDirectory(); isFile = st.isFile(); } catch { continue; }
      if (isDir) {
        if (seen.has(real)) continue;
        seen.add(real);
        visit(real, [...segments, name]);
      } else if (isFile && path.extname(name).toLowerCase() in CONTENT_TYPES) {
        found.push({ segments: [...segments, name], file: real });
      }
    }
  };
  visit(root, []);
  return found;
}

function serve(root: string, file: string, type: string): Response {
  let real: string;
  try { real = realpathSync(file); } catch { return json({ error: "not found" }, 404); }
  if (!inside(root, real) || !statSync(real).isFile()) return json({ error: "not found" }, 404);
  return new Response(Bun.file(real), {
    headers: {
      "Content-Type": type,
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-cache",
    },
  });
}

export function webFeature(dir: string): FeatureFactory {
  return (): Feature => {
    const routes: Route[] = [];
    let root: string | null = null;
    try { root = existsSync(dir) && statSync(dir).isDirectory() ? realpathSync(dir) : null; } catch { root = null; }
    if (root) {
      const base = root;
      for (const f of walk(base)) {
        const type = CONTENT_TYPES[path.extname(f.file).toLowerCase()];
        const handler = () => serve(base, f.file, type);
        routes.push({ method: "GET", pattern: urlPath(f.segments), handler });
        if (f.segments.length === 1 && f.segments[0] === "index.html") routes.push({ method: "GET", pattern: "/", handler });
      }
    }
    return { routes, channels: [] };
  };
}
