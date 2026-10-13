// web/test/unit/security.test.ts (plan E1 step 2): the security greps as tests. They read the files directly, so they run with `bun run test:web`.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const WEB = path.join(import.meta.dir, "..", "..");

/** Every file under `dir` (skipping vendored code and anything under test/), as absolute paths. */
function files(dir: string, keep: (p: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "vendor" && name !== "test" && name !== "node_modules") out.push(...files(p, keep)); }
    else if (keep(p)) out.push(p);
  }
  return out;
}

function hits(paths: string[], re: RegExp): string[] {
  const found: string[] = [];
  for (const p of paths) {
    readFileSync(p, "utf8").split("\n").forEach((line, i) => { if (re.test(line)) found.push(`${path.relative(WEB, p)}:${i + 1}: ${line.trim()}`); });
  }
  return found;
}

test("security: no HTML-string sinks, eval, or inline event attributes in web/src and index.html", () => {
  const src = [...files(path.join(WEB, "src"), (p) => p.endsWith(".js")), path.join(WEB, "index.html")];
  expect(hits(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|[\s"'<]on[a-z]+\s*=/)).toEqual([]);
  expect(hits([path.join(WEB, "index.html")], /<script(?![^>]*\bsrc=)[^>]*>/)).toEqual([]);
});

test("security: nothing is loaded from a CDN or an external font host", () => {
  const all = files(WEB, (p) => /\.(js|mjs|css|html)$/.test(p));
  expect(hits(all, /https?:\/\/(cdn|unpkg|jsdelivr|esm\.sh|fonts\.)/)).toEqual([]);
  // no external URL of any kind in what the page itself loads (the test folder and vendored code are skipped by files())
  const external = hits([...files(path.join(WEB, "src"), (p) => p.endsWith(".js")), ...files(path.join(WEB, "styles"), (p) => p.endsWith(".css")), path.join(WEB, "index.html")],
    /(src|href)=["']https?:|url\(\s*["']?https?:|@import\s+(url\()?["']https?:|\bimport\(["']https?:|from\s+["']https?:/);
  expect(external).toEqual([]);
});

test("security: no literal on-screen text outside copy.js in the views and main.js", () => {
  const views = [...files(path.join(WEB, "src", "views"), (p) => p.endsWith(".js")), path.join(WEB, "src", "main.js")];
  expect(hits(views, /(textContent|innerText|title|placeholder|aria-label)\s*[=:]\s*["'`][A-Za-z]/)).toEqual([]);
});
