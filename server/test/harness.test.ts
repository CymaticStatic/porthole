import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import path from "node:path";
import { run } from "../src/exec";
import { Scratch, useTestTimeout, waitFor } from "./helpers/scratch";

useTestTimeout();

let s: Scratch;
beforeEach(() => { s = new Scratch(); });
afterEach(() => s.cleanup());

test("scratch tmux servers live in the scratch folder, never in Ben's /tmp/tmux-<uid>", () => {
  const sock = s.newTmuxServer("one");
  expect(existsSync(path.join(s.socketDir, sock))).toBe(true);
  expect(existsSync(path.join("/tmp", "tmux-" + process.getuid?.(), sock))).toBe(false);
  expect(s.tmux(sock, "list-sessions", "-F", "#{session_name}").trim()).toBe("one");
});

test("fake herdr prints the API envelope and logs every call", async () => {
  s.setHerdrAgents([{ terminal_id: "t1", agent_status: "blocked", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", focused: false, revision: 1, name: "rev" }]);
  const r = await run([path.join(s.fakeBin, "herdr"), "agent", "list"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).result.type).toBe("agent_list");
  expect(JSON.parse(r.stdout).result.agents[0].pane_id).toBe("w1:p1");
  const p = await run([path.join(s.fakeBin, "herdr"), "agent", "prompt", "--", "w1:p1", "hi"]);
  expect(p.code).toBe(1);
  expect(JSON.parse(p.stderr).error.code).toBe("agent_blocked");
  expect(s.fakeCalls("herdr")).toEqual([["agent", "list"], ["agent", "prompt", "--", "w1:p1", "hi"]]);
});

test("fake pactl reports live voice rows with string pids, or fails on demand", async () => {
  s.setLiveVoicePids([4242]);
  const r = await run([path.join(s.fakeBin, "pactl"), "-f", "json", "list", "source-outputs"]);
  expect(JSON.parse(r.stdout)[0].properties["application.process.id"]).toBe("4242");
  s.breakPactl(true);
  expect((await run([path.join(s.fakeBin, "pactl"), "-f", "json", "list", "source-outputs"])).code).toBe(1);
});

test("a fake omp pane has comm 'omp' and holds its transcript open", async () => {
  const t = s.writeTranscript("harness.jsonl", '{"type":"session"}\n');
  const sock = s.newTmuxServer("chat", s.ompCommand(t));
  let pid = 0;
  let targets: string[] = [];
  // comm turns "omp" at exec, before the script's `exec 3<transcript` has run, so wait for the open file itself.
  await waitFor(() => {
    pid = s.panePid(sock, "=chat:0.0");
    if (!existsSync("/proc/" + pid + "/comm") || readFileSync("/proc/" + pid + "/comm", "utf8").trim() !== "omp") return false;
    targets = readdirSync("/proc/" + pid + "/fd").map((fd) => { try { return readlinkSync("/proc/" + pid + "/fd/" + fd); } catch { return ""; } });
    return targets.includes(t);
  });
  expect(targets).toContain(t);
});

test("cleanup stops the scratch servers and removes the folder", () => {
  const sock = s.newTmuxServer("gone");
  const root = s.root;
  s.cleanup();
  expect(existsSync(root)).toBe(false);
  expect(Bun.spawnSync(["/usr/bin/tmux", "-S", path.join(root, "tmux", "tmux-" + process.getuid?.(), sock), "ls"], { timeout: 5000, killSignal: "SIGKILL" }).exitCode).not.toBe(0);
  s = new Scratch();
});
