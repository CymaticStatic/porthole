import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Auth } from "../src/auth/auth";
import { Whois } from "../src/auth/identity";
import { defaultConfig, parseRanges } from "../src/config";
import { DIFF_SAFE, DirtyCache, filterOverrides, safeGit } from "../src/diff/git";
import { PIDS_DIR } from "../src/pids";
import { sessionsFeature } from "../src/features/sessions";
import type { FeatureFactory } from "../src/router";
import { Registry } from "../src/sessions/registry";
import { openWs, startTestHostd } from "./helpers/client";
import { Scratch, useTestTimeout, waitFor } from "./helpers/scratch";

useTestTimeout();

let s: Scratch;
beforeEach(() => { s = new Scratch(); });
afterEach(() => s.cleanup());

function repo(name: string): string {
  const dir = path.join(s.root, name);
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => Bun.spawnSync(["/usr/bin/git", "-C", dir, ...a], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-qm", "init");
  return dir;
}

test("P2 config defaults and port ranges", () => {
  const c = defaultConfig();
  expect([c.previewPort, c.previewRanges, c.usageCollection, c.voiceEnhance]).toEqual([8798, "3000-3999,4000-4999,5000-5999,8000-8999", true, false]);
  for (const b of [c.bin.git, c.bin.voxtype, c.bin.voxflow, c.bin.ss, c.bin.nvidiaSmi, c.bin.omp]) expect(path.isAbsolute(b)).toBe(true);
  expect(parseRanges("3000-3001, 8080")).toEqual({ ranges: [[3000, 3001], [8080, 8080]] });
  expect(parseRanges("none")).toEqual({ ranges: [] });
  for (const bad of ["", "0-10", "5-4", "70000", "abc", "1-2-3"]) expect("error" in parseRanges(bad)).toBe(true);
});

test("hub: onOpen on connect, ack-shaped messages reach onMessage, junk is ignored", async () => {
  const got: Record<string, unknown>[] = [];
  let opened = 0;
  const probe: FeatureFactory = (d) => {
    d.hub.onOpen((ws) => { opened += 1; d.hub.sendTo(ws, { type: "hello" }); });
    d.hub.onMessage((_ws, m) => { got.push(m); });
    return { routes: [], channels: [] };
  };
  const h = await startTestHostd(s, [sessionsFeature, probe]);
  try {
    const ws = await openWs(h, "/v1/events?device=bencell");
    expect((await ws.next("hello", 3000)).type).toBe("hello");
    ws.send("not json");
    ws.send(JSON.stringify([1, 2]));
    ws.send(JSON.stringify({ type: "ack", id: 3 }));
    await waitFor(() => got.length === 1, 3000);
    expect(got).toEqual([{ type: "ack", id: 3 }]);
    expect(opened).toBe(1);
    ws.close();
  } finally {
    await h.stop();
  }
});

test("identify(): local token or Tailscale identity, without the X-Porthole and Origin rules", async () => {
  const cfg = s.config();
  s.setWhois({ "100.64.0.5": { node: "bencell", login: cfg.allowedLogin } });
  const auth = new Auth(cfg, new Whois(cfg.bin.tailscale), "tok");
  const req = (h: Record<string, string>) => new Request("http://127.0.0.1/__porthole/preview?port=3000", { headers: h });
  expect((await auth.identify(req({}))).ok).toBe(false);
  expect(await auth.identify(req({ "x-porthole-local": "tok" }))).toEqual({ ok: true, device: "local", via: "local" });
  expect(await auth.identify(req({ "tailscale-user-login": cfg.allowedLogin, "x-forwarded-for": "100.64.0.5" }))).toEqual({ ok: true, device: "bencell", via: "tailscale" });
  expect((await auth.identify(req({ "tailscale-user-login": "someone@else", "x-forwarded-for": "100.64.0.5" }))).ok).toBe(false);
});

test("filterOverrides switches every configured filter driver off", () => {
  const list = "filter.lfs.clean git-lfs clean -- %f\nfilter.lfs.smudge git-lfs smudge -- %f\nfilter.a.b.process x\n";
  expect(filterOverrides(list)).toEqual([
    "-c", "filter.lfs.process=", "-c", "filter.lfs.clean=", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.required=false",
    "-c", "filter.a.b.process=", "-c", "filter.a.b.clean=", "-c", "filter.a.b.smudge=", "-c", "filter.a.b.required=false",
  ]);
});

test("safeGit runs no repo-configured program and takes no lock", async () => {
  const dir = repo("evil");
  const marker = path.join(s.root, "evil-ran");
  const prog = s.writeFake("evil-prog", "#!/bin/sh\ntouch '" + marker + "'\ncat\n");
  const cfgGit = (...a: string[]) => Bun.spawnSync(["/usr/bin/git", "-C", dir, "config", ...a]);
  cfgGit("core.fsmonitor", prog);
  cfgGit("diff.external", prog);
  cfgGit("filter.evil.clean", prog);
  cfgGit("filter.evil.process", prog);
  cfgGit("filter.evil.required", "true");
  cfgGit("diff.evil.textconv", prog);
  writeFileSync(path.join(dir, ".gitattributes"), "*.txt filter=evil diff=evil\n");
  writeFileSync(path.join(dir, "a.txt"), "two\n");
  const indexBefore = statSync(path.join(dir, ".git", "index")).mtimeMs;
  const cfg = s.config();
  // `diff.external=` in GIT_SAFE makes a bare `git diff` try to run "": diff callers always add DIFF_SAFE (--no-ext-diff), as Task 7 does.
  for (const args of [["status", "--porcelain=v2"], ["diff", ...DIFF_SAFE], ["diff", "--cached", ...DIFF_SAFE], ["ls-files", "--others", "--exclude-standard"]]) {
    const r = await safeGit(cfg, dir, args);
    expect([args.join(" "), r.code, r.stderr]).toEqual([args.join(" "), 0, ""]);
  }
  expect(existsSync(marker)).toBe(false);
  expect(statSync(path.join(dir, ".git", "index")).mtimeMs).toBe(indexBefore);
  expect(existsSync(path.join(dir, ".git", "index.lock"))).toBe(false);
});

test("a pid file marks every running hostd (Task 8 reads it) and goes away on stop", async () => {
  const file = path.join(PIDS_DIR, String(process.pid));
  const first = await startTestHostd(s, [sessionsFeature]);
  expect(existsSync(file)).toBe(true);
  expect(statSync(PIDS_DIR).mode & 0o777).toBe(0o700);
  const second = await startTestHostd(s, [sessionsFeature]);
  await second.stop();
  expect(existsSync(file)).toBe(true); // both hostds share this process: the first one still runs
  await first.stop();
  expect(existsSync(file)).toBe(false);
});

test("a start() failure, then stop() twice, never unregisters a pid this hostd did not register", async () => {
  const file = path.join(PIDS_DIR, String(process.pid));
  const keeper = await startTestHostd(s, [sessionsFeature]);
  const boom: FeatureFactory = () => ({ routes: [], channels: [], async start() { throw new Error("start failed"); } });
  // createHostd calls its own stop() when a start() throws; startTestHostd rejects with the same error
  await expect(startTestHostd(s, [sessionsFeature, boom])).rejects.toThrow("start failed");
  expect(existsSync(file)).toBe(true); // the failed hostd never registered, so the keeper's pid file stays
  const extra = await startTestHostd(s, [sessionsFeature]);
  await extra.stop();
  await extra.stop(); // a second stop() must not unregister again
  expect(existsSync(file)).toBe(true);
  await keeper.stop();
  expect(existsSync(file)).toBe(false);
});

test("Ben's own git settings (colour always, no prefixes) cannot change the diff format", async () => {
  const dir = repo("hostile");
  writeFileSync(path.join(dir, "a.txt"), "two\n");
  const hostile = path.join(s.root, "hostile-gitconfig");
  writeFileSync(hostile, "[color]\n\tui = always\n[diff]\n\tnoprefix = true\n\tmnemonicPrefix = true\n");
  const before = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = hostile;
  try {
    const r = await safeGit(s.config(), dir, ["diff", ...DIFF_SAFE, "--patch"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("\u001b");
    expect(r.stdout).toContain("diff --git a/a.txt b/a.txt");
    expect(r.stdout).toContain("--- a/a.txt");
    expect(r.stdout).toContain("+++ b/a.txt");
  } finally {
    if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = before;
  }
});

test("sessions carry dirty: true, false, or null outside a repo", async () => {
  const cfg = s.config();
  const clean = repo("clean");
  const dirty = repo("dirty");
  writeFileSync(path.join(dirty, "new.txt"), "untracked\n");
  const plain = path.join(s.root, "plain");
  mkdirSync(plain, { recursive: true });
  const sock = s.newTmuxServer("c", "/bin/sh", clean);
  s.tmux(sock, "new-session", "-d", "-s", "d", "-c", dirty, "/bin/sh");
  s.tmux(sock, "new-session", "-d", "-s", "p", "-c", plain, "/bin/sh");
  const r = new Registry(cfg);
  let byName: Record<string, boolean | null> = {};
  await waitFor(async () => {
    byName = Object.fromEntries((await r.scan()).sessions.map((x) => [x.where.kind === "tmux" ? x.where.session : x.name, x.dirty]));
    return "c" in byName && "d" in byName && "p" in byName;
  }, 5000);
  expect([byName.c, byName.d, byName.p]).toEqual([false, true, null]);
  const cache = new DirtyCache(cfg, 60_000);
  expect(await cache.lookup(dirty)).toBe(true);
});
