import { expect, test } from "bun:test";
import { buildSidebar, neighbour } from "../../src/lib/tree.js";
const tm = (socket, session, window, pane) => ({ kind: "tmux", socket, session, window, pane });
const s = (id, name, cwd, status, omp, where = tm("/run/t/default", "main", 0, 0)) => ({ id, kind: where.kind, name, cwd, status, reported: true, questionCount: status === "needs-you" ? 1 : 0, liveVoice: false, pinned: false, where, attached: false, omp: omp ? { pid: 1, transcript: "/t", inbox: true } : null, herdrStatus: null, dirty: null });
const D = "https://testdesk.example.ts.net";
test("omp sessions are chats, needs-you first; machines carry their need-you count", () => {
  const trees = [{ origin: D, state: "up", tree: { machine: "testdesk", scannedAt: "", sources: [], sessions: [s("a", "web", "/p/porthole", "working", true, tm("/run/t/default", "main", 0, 0)), s("b", "api", "/p/porthole", "needs-you", true, tm("/run/t/default", "main", 0, 1)), s("c", "sh", "/p/porthole", "idle", false, tm("/run/t/default", "main", 1, 0))] } }];
  const side = buildSidebar(trees, []);
  expect(side.chats[0].rows.map((r) => r.id)).toEqual(["b", "a"]);
  expect(side.chats[0].label).toBe("testdesk · porthole");
  expect(side.machines).toEqual([{ name: "testdesk", origin: D, state: "up", needYou: 1 }]);
});
test("terminals: tmux is socket → session → window → pane; herdr is workspace → tab → pane", () => {
  const sessions = [
    s("t1", "web", "/p", "working", true, tm("/run/t/default", "main", 0, 0)),
    s("t2", "api", "/p", "needs-you", true, tm("/run/t/default", "main", 0, 1)),
    s("t3", "sh", "/p", "idle", false, tm("/run/t/default", "main", 2, 0)),
    s("t4", "logs", "/p", "idle", false, tm("/run/t/default", "build", 0, 0)),
    s("h1", "fe", "/p", "working", true, { kind: "herdr", workspace: "porthole", tab: "dev", pane: "p1" }),
    s("h2", "be", "/p", "done", true, { kind: "herdr", workspace: "porthole", tab: "dev", pane: "p2" }),
  ];
  const side = buildSidebar([{ origin: D, state: "up", tree: { machine: "testdesk", scannedAt: "", sources: [], sessions } }], []);
  const shape = (n) => (n.kind === "pane" ? `${n.kind}:${n.id}` : { [`${n.kind}:${n.label}:${n.status}`]: n.children.map(shape) });
  expect(side.terminals[0].nodes.map(shape)).toEqual([
    { "socket:default:needs-you": [
      { "session:build:idle": [{ "window:Window 0:idle": ["pane:t4"] }] },
      { "session:main:needs-you": [{ "window:Window 0:needs-you": ["pane:t1", "pane:t2"] }, { "window:Window 2:idle": ["pane:t3"] }] },
    ] },
    { "workspace:porthole:working": [{ "tab:dev:working": ["pane:h1", "pane:h2"] }] },
  ]);
  expect(neighbour(side.terminals, "t1", "pane", 1)).toBe("t2");
  expect(neighbour(side.terminals, "t2", "pane", 1)).toBe("t1");
  expect(neighbour(side.terminals, "t1", "window", 1)).toBe("t3");
  expect(neighbour(side.terminals, "t1", "session", -1)).toBe("t4");
  expect(neighbour(side.terminals, "h1", "session", 1)).toBeNull();
});
test("pane labels: tmux says which pane and session, herdr says the session name", () => {
  const sessions = [s("t1", "web", "/p", "working", true, tm("/run/t/default", "main", 3, 7)), s("h1", "fe", "/p", "idle", true, { kind: "herdr", workspace: "w", tab: "t", pane: "p1" })];
  const side = buildSidebar([{ origin: D, state: "up", tree: { machine: "testdesk", scannedAt: "", sources: [], sessions } }], []);
  const [socket, workspace] = side.terminals[0].nodes;
  expect(socket.children[0].children[0].children[0].label).toBe("Pane 7 · web");
  expect(workspace.children[0].children[0].label).toBe("fe");
});
test("a machine that is down keeps its row and shows no sessions", () => {
  const side = buildSidebar([{ origin: "https://testlaptop.example.ts.net", state: "down", tree: null, name: "testlaptop" }], []);
  expect(side.machines[0]).toEqual({ name: "testlaptop", origin: "https://testlaptop.example.ts.net", state: "down", needYou: 0 });
  expect(side.chats).toEqual([]);
  expect(side.terminals).toEqual([{ machine: "testlaptop", origin: "https://testlaptop.example.ts.net", nodes: [] }]);
});
test("a down machine with no name falls back to the first part of its address", () => {
  const side = buildSidebar([{ origin: "https://testlaptop.example.ts.net", state: "down", tree: null }], []);
  expect(side.machines[0].name).toBe("testlaptop");
});
test("chats are grouped machine then project; active keeps only sessions that still exist", () => {
  const L = "https://testlaptop.example.ts.net";
  const trees = [
    { origin: D, state: "up", tree: { machine: "testdesk", scannedAt: "", sources: [], sessions: [s("a", "web", "/p/zeta", "idle", true), s("b", "api", "/p/alpha", "idle", true, tm("/run/t/default", "main", 0, 1))] } },
    { origin: L, state: "up", tree: { machine: "testlaptop", scannedAt: "", sources: [], sessions: [s("a", "web", "/p/alpha", "working", true)] } },
  ];
  const side = buildSidebar(trees, [{ machine: "testlaptop", sessionId: "a", view: "chat" }, { machine: "testdesk", sessionId: "gone", view: "term" }, { machine: "testdesk", sessionId: "a", view: "term" }]);
  expect(side.chats.map((g) => g.label)).toEqual(["testdesk · alpha", "testdesk · zeta", "testlaptop · alpha"]);
  expect(side.active.map((r) => [r.machine, r.id, r.view])).toEqual([["testlaptop", "a", "chat"], ["testdesk", "a", "term"]]);
});
test("neighbour with a single sibling is null, and unknown ids are null", () => {
  const side = buildSidebar([{ origin: D, state: "up", tree: { machine: "testdesk", scannedAt: "", sources: [], sessions: [s("only", "x", "/p", "idle", false)] } }], []);
  expect(neighbour(side.terminals, "only", "pane", 1)).toBeNull();
  expect(neighbour(side.terminals, "nope", "pane", 1)).toBeNull();
});
