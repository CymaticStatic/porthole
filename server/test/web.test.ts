import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { webFeature } from "../src/features/web";
import { startTestHostd, type TestHostd } from "./helpers/client";
import { Scratch, useTestTimeout } from "./helpers/scratch";

useTestTimeout();

let s: Scratch;
let h: TestHostd;
let missing: TestHostd;
let localOnly: Record<string, string>;

beforeAll(async () => {
  s = new Scratch();
  const web = path.join(s.root, "web");
  const outside = path.join(s.root, "outside");
  mkdirSync(path.join(web, "src", "lib"), { recursive: true });
  mkdirSync(path.join(web, "test"), { recursive: true });
  mkdirSync(path.join(web, ".git"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(web, "index.html"), "<!doctype html><title>porthole</title>");
  writeFileSync(path.join(web, "src", "app.js"), "export const x = 1;\n");
  writeFileSync(path.join(web, "src", "lib", "my file.css"), "body{}");
  writeFileSync(path.join(web, "src", "icon.svg"), "<svg/>");
  writeFileSync(path.join(web, "notes.md"), "not served");
  writeFileSync(path.join(web, ".env"), "SECRET=1");
  writeFileSync(path.join(web, ".git", "config.json"), "{}");
  writeFileSync(path.join(web, "test", "t.js"), "// page test");
  writeFileSync(path.join(outside, "secret.js"), "leak");
  writeFileSync(path.join(outside, "inner.js"), "inner");
  symlinkSync(path.join(outside, "secret.js"), path.join(web, "link.js"));
  symlinkSync(outside, path.join(web, "outdir"));
  symlinkSync(path.join(web, "src", "app.js"), path.join(web, "alias.js"));
  h = await startTestHostd(s, [webFeature(web)]);
  missing = await startTestHostd(s, [webFeature(path.join(s.root, "no-such-web"))]);
  localOnly = { "X-Porthole-Local": h.localToken };
});
afterAll(async () => {
  await h.stop();
  await missing.stop();
  s.cleanup();
});

const fetchPath = (host: TestHostd, p: string, headers: Record<string, string> = { "X-Porthole-Local": host.localToken }) => fetch(host.url + p, { headers });

test("GET / serves index.html; files carry the security headers and the right content type, with no X-Porthole header", async () => {
  const r = await fetchPath(h, "/", localOnly);
  expect(r.status).toBe(200);
  expect(await r.text()).toContain("<title>porthole</title>");
  expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(r.headers.get("content-security-policy")).toBe(
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https://*.ts.net wss://*.ts.net; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
  );
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  expect(r.headers.get("cache-control")).toBe("no-cache");
  const js = await fetchPath(h, "/src/app.js");
  expect([js.status, js.headers.get("content-type"), await js.text()]).toEqual([200, "text/javascript; charset=utf-8", "export const x = 1;\n"]);
  expect((await fetchPath(h, "/src/icon.svg")).headers.get("content-type")).toBe("image/svg+xml");
  expect((await fetchPath(h, "/index.html")).status).toBe(200);
  expect((await fetchPath(h, "/src/lib/my%20file.css")).headers.get("content-type")).toBe("text/css; charset=utf-8");
});

test("hostd's identity check still applies to the page", async () => {
  expect((await fetch(h.url + "/")).status).toBe(403);
  expect((await fetchPath(h, "/", { "X-Porthole-Local": "wrong" })).status).toBe(403);
});

test("dotfiles, other file types, the page's own tests, and anything outside the folder are never served", async () => {
  for (const p of ["/.env", "/.git/config.json", "/notes.md", "/test/t.js", "/link.js", "/outdir/inner.js", "/outdir/secret.js", "/src/", "/src", "/nope.js"]) {
    expect([p, (await fetchPath(h, p)).status]).toEqual([p, 404]);
  }
  for (const p of ["/../outside/secret.js", "/%2e%2e/outside/secret.js", "/src/..%2f..%2foutside%2fsecret.js", "/src/%2e%2e/%2e%2e/outside/secret.js"]) {
    const r = await fetchPath(h, p);
    expect([p, r.status, (await r.text()).includes("leak")]).toEqual([p, 404, false]);
  }
});

test("a symlink that stays inside the folder is served", async () => {
  const r = await fetchPath(h, "/alias.js");
  expect([r.status, await r.text()]).toEqual([200, "export const x = 1;\n"]);
});

test("a symlink retargeted outside the folder after start is refused", async () => {
  const web = path.join(s.root, "web");
  writeFileSync(path.join(web, "late.js"), "inside");
  const late = await startTestHostd(s, [webFeature(web)]);
  try {
    expect((await fetchPath(late, "/late.js")).status).toBe(200);
    rmSync(path.join(web, "late.js"));
    symlinkSync(path.join(s.root, "outside", "secret.js"), path.join(web, "late.js"));
    const r = await fetchPath(late, "/late.js");
    expect([r.status, (await r.text()).includes("leak")]).toEqual([404, false]);
  } finally {
    await late.stop();
  }
});

test("a missing web folder serves nothing and hostd still starts", async () => {
  expect((await fetchPath(missing, "/")).status).toBe(404);
  expect((await fetchPath(missing, "/index.html")).status).toBe(404);
});
