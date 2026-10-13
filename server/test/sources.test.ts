import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sessionId, tmuxTarget } from "../src/sessions/ids";
import { capturePane, listClients, listPanes, listSockets, sendKeys, sendText } from "../src/sessions/tmux";
import { listAgents, prompt, readScreen, sendKeys as herdrKeys } from "../src/sessions/herdr";
import { Scratch, waitFor } from "./helpers/scratch";

let s: Scratch;
beforeEach(() => { s = new Scratch(); });
afterEach(() => s.cleanup());

test("ids follow SPEC 5.2 and escape separators", () => {
  expect(sessionId({ kind: "tmux", socket: "default", session: "1", window: 0, pane: 2 })).toBe("tmux:default:1:0.2");
  expect(sessionId({ kind: "tmux", socket: "a:b", session: "x", window: 1, pane: 0 })).toBe("tmux:a%3Ab:x:1.0");
  expect(sessionId({ kind: "herdr", workspace: "w1", tab: "w1:t1", pane: "w1:p3" })).toBe("herdr:w1:t1:p3");
  expect(tmuxTarget({ kind: "tmux", socket: "s", session: "alpha", window: 0, pane: 1 })).toBe("=alpha:0.1");
});

test("lists every socket and pane; a stopped server is reported, not thrown", async () => {
  const a = s.newTmuxServer("alpha");
  const b = s.newTmuxServer("beta");
  writeFileSync(path.join(s.socketDir, "not-a-socket"), "");
  const cfg = s.config();
  expect(listSockets(cfg)).toEqual([a, b]);
  const pa = await listPanes(cfg, a);
  expect(pa.ok && pa.panes.map((p) => [p.session, p.window, p.pane, p.cwd])).toEqual([["alpha", 0, 0, s.root]]);
  s.tmux(b, "kill-server");
  // kill-server returns before the server process has fully exited; tmux says "server exited unexpectedly" in that instant.
  await waitFor(async () => { const r = await listPanes(cfg, b); return !r.ok && r.error.includes("no server running"); });
  const pb = await listPanes(cfg, b);
  expect(pb.ok).toBe(false);
  expect(!pb.ok && pb.error).toContain("no server running");
});

test("sendText types multi-line text literally and presses Enter once; capture shows the pane", async () => {
  const out = path.join(s.root, "typed.txt");
  const sock = s.newTmuxServer("cat", "/bin/sh -c 'cat > " + out + "'");
  const w = { kind: "tmux" as const, socket: sock, session: "cat", window: 0, pane: 0 };
  const r = await sendText(s.config(), w, "hello\nworld");
  expect(r).toEqual({ ok: true, error: "" });
  await waitFor(() => existsSync(out) && readFileSync(out, "utf8") === "hello\nworld\n");
  const cap = await capturePane(s.config(), w);
  expect(cap.ok).toBe(true);
  expect(cap.text).toContain("world");
});

test("sendText splits long text into several send-keys calls without losing a byte", async () => {
  const out = path.join(s.root, "long.txt");
  const sock = s.newTmuxServer("cat", "/bin/sh -c 'cat > " + out + "'");
  const w = { kind: "tmux" as const, socket: sock, session: "cat", window: 0, pane: 0 };
  const text = Array.from({ length: 1500 }, (_, i) => "line " + i + " é").join("\n");
  expect(await sendText(s.config(), w, text)).toEqual({ ok: true, error: "" });
  await waitFor(() => existsSync(out) && readFileSync(out, "utf8") === text + "\n", 15_000);
});

test("sendKeys passes a literal that starts with a dash", async () => {
  const sock = s.newTmuxServer("sh");
  const w = { kind: "tmux" as const, socket: sock, session: "sh", window: 0, pane: 0 };
  await sendKeys(s.config(), w, ["-l", "--", "-v dash-ok"]);
  await waitFor(async () => (await capturePane(s.config(), w)).text.includes("-v dash-ok"));
  expect((await listClients(s.config(), sock)).length).toBe(0);
});

test("herdr: list, read, prompt and keys through the fake; errors are plain words", async () => {
  s.setHerdrAgents([
    { terminal_id: "t1", agent_status: "working", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", focused: true, revision: 3, agent: "omp", name: "reviewer", cwd: "/work" },
    { terminal_id: "t2", agent_status: "blocked", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p2", focused: false, revision: 1 },
  ]);
  s.setHerdrScreen("w1:p1", "screen text\n");
  const cfg = s.config();
  const list = await listAgents(cfg);
  expect(list.ok && list.agents.map((a) => [a.pane, a.status, a.name, a.cwd])).toEqual([["w1:p1", "working", "reviewer", "/work"], ["w1:p2", "blocked", "", ""]]);
  expect(await readScreen(cfg, "w1:p1", 2000)).toEqual({ ok: true, text: "screen text\n", error: "" });
  expect(await prompt(cfg, "w1:p1", "-starts with a dash")).toEqual({ ok: true, error: "" });
  expect(JSON.parse(s.fakeFile("herdr-prompts.log").trim())).toEqual({ target: "w1:p1", text: "-starts with a dash" });
  expect(await prompt(cfg, "w1:p2", "x")).toEqual({ ok: false, error: "agent is showing a question" });
  expect(await herdrKeys(cfg, "w1:p1", ["esc"])).toEqual({ ok: true, error: "" });
  expect(s.fakeCalls("herdr")[1]).toEqual(["agent", "read", "w1:p1", "--source", "recent", "--lines", "2000", "--format", "text"]);
});
