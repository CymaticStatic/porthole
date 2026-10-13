import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { changes, parsePorcelainV2 } from "../src/diff/diff";
import { diffFeature } from "../src/features/diff";
import { get, pane, startTestHostd } from "./helpers/client";
import type { TestHostd } from "./helpers/client";
import { Scratch } from "./helpers/scratch";

let s: Scratch;
let h: TestHostd;
let repo: string;
const git = (...a: string[]) => {
  const r = Bun.spawnSync(["/usr/bin/git", "-C", repo, ...a], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};
beforeAll(async () => {
  s = new Scratch();
  repo = path.join(s.root, "repo");
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "one\n");
  writeFileSync(path.join(repo, "b.txt"), "two\n");
  writeFileSync(path.join(repo, "img.bin"), new Uint8Array([0, 1, 2, 0]));
  git("add", ".");
  git("commit", "-q", "-m", "init");
  writeFileSync(path.join(repo, "a.txt"), "one changed\n");       // unstaged
  writeFileSync(path.join(repo, "b.txt"), "two staged\n");
  git("add", "b.txt");                                                // staged
  writeFileSync(path.join(repo, "img.bin"), new Uint8Array([0, 9, 9, 0]));
  git("add", "img.bin");                                              // staged binary
  writeFileSync(path.join(repo, "new.txt"), "fresh\n");              // untracked
  h = await startTestHostd(s, [diffFeature]);
});
afterAll(async () => { await h.stop(); s.cleanup(); });

test("parses porcelain v2 including renames", () => {
  const z = ["1 .M N... 100644 100644 100644 aaa bbb a.txt", "2 R. N... 100644 100644 100644 aaa bbb R100 new-name.txt", "old-name.txt", "? fresh.txt", ""].join("\0");
  expect(parsePorcelainV2(z)).toEqual({
    staged: [{ path: "new-name.txt", from: "old-name.txt", status: "R" }],
    unstaged: [{ path: "a.txt", from: null, status: "M" }],
    untracked: ["fresh.txt"],
  });
});

test("P2.5: staged, unstaged and untracked are listed separately; binary is flagged", async () => {
  const c = await changes(h.config, repo);
  if (!c.repo) throw new Error("expected a repo");
  expect(c.staged.map((f) => [f.path, f.binary])).toEqual([["b.txt", false], ["img.bin", true]]);
  expect(c.staged[0].patch).toContain("+two staged");
  expect(c.unstaged.map((f) => f.path)).toEqual(["a.txt"]);
  expect(c.unstaged[0].patch).toContain("+one changed");
  expect(c.untracked).toEqual([{ path: "new.txt" }]);
});

test("P2.5: a non-repo says so, through the route", async () => {
  const plain = path.join(s.root, "plain");
  mkdirSync(plain);
  expect(await changes(h.config, plain)).toEqual({ repo: false, reason: "No git repo here" });
  const p = await pane(s, "plain", "/bin/sh");
  s.tmux(p.socket, "send-keys", "-t", "=plain:0.0", "cd '" + plain + "'", "Enter");
  for (let i = 0; i < 50 && s.tmux(p.socket, "display-message", "-p", "-t", "=plain:0.0", "#{pane_current_path}").trim() !== plain; i++) await Bun.sleep(100); // waits for the shell's cd to land: a real tmux pane has no event for it
  const r = await get(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/diff");
  expect(await r.json()).toEqual({ repo: false, reason: "No git repo here" });
  expect((await get(h, "/v1/sessions/" + encodeURIComponent("tmux:nope:x:0.0") + "/diff")).status).toBe(404);
});

test("P2.5: git's dubious-ownership refusal gets its own plain reason", async () => {
  // a fake git that refuses every call the way git does for a folder owned by another user
  const fake = s.writeFake("git-dubious", "#!/bin/sh\necho \"fatal: detected dubious ownership in repository at '/somewhere'\" >&2\nexit 128\n");
  const cfg = { ...h.config, bin: { ...h.config.bin, git: fake } };
  expect(await changes(cfg, repo)).toEqual({ repo: false, reason: "git will not read this folder because it belongs to another user (git's dubious ownership check)" });
});
