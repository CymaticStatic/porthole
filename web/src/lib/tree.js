/** Sidebar model (SPEC 4.2): machines, active sessions, chats, terminal trees. Pure. */
import { basename } from "./format.js";

/**
 * @typedef {{kind: "tmux", socket: string, session: string, window: number, pane: number}
 *   | {kind: "herdr", workspace: string, tab: string, pane: string}} Where
 */
/**
 * The SessionInfo fields used here (hostd sends more).
 * @typedef {object} SessionLike
 * @property {string} id
 * @property {string} name
 * @property {string} cwd
 * @property {string} status "needs-you" | "working" | "done" | "idle" | "unknown"
 * @property {number} questionCount
 * @property {boolean | null} liveVoice
 * @property {Where} where
 * @property {{pid: number, transcript: string | null, inbox: boolean} | null} omp
 */
/** @typedef {{machine: string, scannedAt: string, sessions: SessionLike[]}} TreeLike */
/**
 * One machine as the fleet reports it. `name` is used when there is no tree yet (a machine that is down).
 * @typedef {{origin: string, state: string, tree: TreeLike | null, name?: string}} MachineTree
 */
/**
 * One entry of the "open on this device" list (`porthole:open`): what was opened on which machine.
 * @typedef {{machine: string, sessionId: string, view: "chat" | "term"}} OpenEntry
 */
/**
 * @typedef {object} Row
 * @property {string} id session id
 * @property {string} machine
 * @property {string} origin
 * @property {string} name
 * @property {string} project basename of the working folder
 * @property {string} status
 * @property {"tmux" | "herdr"} kind
 * @property {boolean} liveVoice
 * @property {number} questionCount
 * @property {boolean} chat true when an agent (omp) runs in it, so it has a chat
 */
/** @typedef {{machine: string, origin: string, project: string, label: string, rows: Row[]}} Group */
/** @typedef {{key: string, kind: string, label: string, status: string, children: Node[]} | {key: string, kind: "pane", label: string, status: string, id: string}} Node */
/** @typedef {{machine: string, origin: string, nodes: Node[]}} TermMachine */

/** Most urgent first. */
const URGENCY = ["needs-you", "working", "done", "idle", "unknown"];
/** @param {string} s */
const rank = (s) => {
  const i = URGENCY.indexOf(s);
  return i === -1 ? URGENCY.length - 1 : i;
};
/** @param {string} a @param {string} b */
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** Natural order so "p2" comes before "p10". @param {string} a @param {string} b */
const byNatural = (a, b) => a.localeCompare(b, "en", { numeric: true });

/** @param {string} origin */
function hostOf(origin) {
  try {
    return new URL(origin).hostname.split(".")[0];
  } catch {
    return origin;
  }
}

/** @param {SessionLike[]} sessions */
const needYouCount = (sessions) => sessions.filter((s) => s.status === "needs-you").length;

/** @param {SessionLike} s @param {string} machine @param {string} origin @returns {Row} */
function toRow(s, machine, origin) {
  return {
    id: s.id,
    machine,
    origin,
    name: s.name,
    project: basename(s.cwd),
    status: s.status,
    kind: s.where.kind,
    liveVoice: s.liveVoice === true,
    questionCount: s.questionCount,
    chat: s.omp !== null,
  };
}

/** @param {Row} a @param {Row} b */
function chatOrder(a, b) {
  const ra = a.status === "needs-you" ? 0 : a.status === "working" ? 1 : 2;
  const rb = b.status === "needs-you" ? 0 : b.status === "working" ? 1 : 2;
  return ra - rb || byText(a.name, b.name) || byText(a.id, b.id);
}

/** The most urgent status among nodes. @param {Node[]} children */
function worst(children) {
  let best = "unknown";
  for (const c of children) if (rank(c.status) < rank(best)) best = c.status;
  return best;
}

/** @param {string} key @param {string} kind @param {string} label @param {Node[]} children @returns {Node} */
function group(key, kind, label, children) {
  return { key, kind, label, status: worst(children), children };
}

/** @param {string} machine @param {SessionLike[]} sessions @returns {Node[]} */
function terminalNodes(machine, sessions) {
  const k = (/** @type {string[]} */ ...parts) => [machine, ...parts].join("|");
  /** @param {SessionLike} s @param {string} label @returns {Node} */
  const pane = (s, label) => ({ key: k("pane", s.id), kind: "pane", label, status: s.status, id: s.id });

  /** @type {Map<string, Map<string, Map<number, {n: number, s: SessionLike}[]>>>} */
  const sockets = new Map();
  /** @type {Map<string, Map<string, SessionLike[]>>} */
  const workspaces = new Map();
  for (const s of sessions) {
    const w = s.where;
    if (w.kind === "tmux") {
      const sess = sockets.get(w.socket) ?? new Map();
      sockets.set(w.socket, sess);
      const wins = sess.get(w.session) ?? new Map();
      sess.set(w.session, wins);
      const panes = wins.get(w.window) ?? [];
      wins.set(w.window, panes);
      panes.push({ n: w.pane, s });
    } else {
      const tabs = workspaces.get(w.workspace) ?? new Map();
      workspaces.set(w.workspace, tabs);
      const panes = tabs.get(w.tab) ?? [];
      tabs.set(w.tab, panes);
      panes.push(s);
    }
  }

  /** @type {Node[]} */
  const nodes = [];
  const socketPaths = [...sockets.keys()].sort((a, b) => byText(basename(a), basename(b)) || byText(a, b));
  for (const socket of socketPaths) {
    const sess = /** @type {Map<string, Map<number, {n: number, s: SessionLike}[]>>} */ (sockets.get(socket));
    const sessionNodes = [...sess.keys()].sort(byText).map((name) => {
      const wins = /** @type {Map<number, {n: number, s: SessionLike}[]>} */ (sess.get(name));
      const windowNodes = [...wins.keys()].sort((a, b) => a - b).map((num) => {
        const panes = /** @type {{n: number, s: SessionLike}[]} */ (wins.get(num)).slice().sort((a, b) => a.n - b.n);
        return group(k("window", socket, name, String(num)), "window", `Window ${num}`, panes.map((p) => pane(p.s, `Pane ${p.n} · ${p.s.name}`)));
      });
      return group(k("session", socket, name), "session", name, windowNodes);
    });
    nodes.push(group(k("socket", socket), "socket", basename(socket), sessionNodes));
  }
  for (const ws of [...workspaces.keys()].sort(byNatural)) {
    const tabs = /** @type {Map<string, SessionLike[]>} */ (workspaces.get(ws));
    const tabNodes = [...tabs.keys()].sort(byNatural).map((tab) => {
      const panes = /** @type {SessionLike[]} */ (tabs.get(tab)).slice().sort((a, b) => {
        const pa = a.where.kind === "herdr" ? a.where.pane : "";
        const pb = b.where.kind === "herdr" ? b.where.pane : "";
        return byNatural(pa, pb) || byText(a.id, b.id);
      });
      return group(k("tab", ws, tab), "tab", tab, panes.map((s) => pane(s, s.name)));
    });
    nodes.push(group(k("workspace", ws), "workspace", ws, tabNodes));
  }
  return nodes;
}

/**
 * @param {MachineTree[]} trees one entry per machine in the device's list, in list order
 * @param {OpenEntry[]} openList the "open on this device" list; entries whose session is gone are dropped
 * @returns {{machines: {name: string, origin: string, state: string, needYou: number}[], active: (Row & {view: "chat" | "term"})[], chats: Group[], terminals: TermMachine[]}}
 */
export function buildSidebar(trees, openList) {
  /** @type {{name: string, origin: string, state: string, needYou: number}[]} */
  const machines = [];
  /** @type {Group[]} */
  const chats = [];
  /** @type {TermMachine[]} */
  const terminals = [];
  /** @type {Map<string, Row>} key: machine + "\n" + session id */
  const rows = new Map();

  for (const m of trees) {
    const sessions = m.tree ? m.tree.sessions : [];
    const name = m.tree ? m.tree.machine : (m.name ?? hostOf(m.origin));
    machines.push({ name, origin: m.origin, state: m.state, needYou: needYouCount(sessions) });
    terminals.push({ machine: name, origin: m.origin, nodes: terminalNodes(name, sessions) });

    /** @type {Map<string, Row[]>} */
    const byProject = new Map();
    for (const s of sessions) {
      const row = toRow(s, name, m.origin);
      rows.set(name + "\n" + s.id, row);
      if (!row.chat) continue;
      const list = byProject.get(row.project) ?? [];
      byProject.set(row.project, list);
      list.push(row);
    }
    for (const project of [...byProject.keys()].sort(byText)) {
      const list = /** @type {Row[]} */ (byProject.get(project)).sort(chatOrder);
      chats.push({ machine: name, origin: m.origin, project, label: `${name} · ${project}`, rows: list });
    }
  }

  /** @type {(Row & {view: "chat" | "term"})[]} */
  const active = [];
  for (const e of openList) {
    const row = rows.get(e.machine + "\n" + e.sessionId);
    if (row && (e.view !== "chat" || row.chat)) active.push({ ...row, view: e.view });
  }
  return { machines, active, chats, terminals };
}

/** @param {Node} n @returns {string} id of the first pane at or below n */
function firstPane(n) {
  return "id" in n ? n.id : firstPane(n.children[0]);
}

/** @param {Node[]} list @param {string} id @param {Node[][]} path sibling lists from the top down @returns {Node[][] | null} */
function pathTo(list, id, path = []) {
  for (const n of list) {
    if ("id" in n) {
      if (n.id === id) return [...path, list];
      continue;
    }
    const found = pathTo(n.children, id, [...path, list]);
    if (found) return found;
  }
  return null;
}

const LEVEL_KINDS = { session: ["session", "workspace"], window: ["window", "tab"], pane: ["pane"] };

/**
 * The id of the first pane of the next (dir = 1) or previous (dir = -1) group at `level` inside the same parent,
 * wrapping round; null when that parent holds only one. "session" = tmux session or herdr workspace,
 * "window" = tmux window or herdr tab, "pane" = a pane.
 * @param {TermMachine[]} terminals @param {string} sessionId @param {"session" | "window" | "pane"} level @param {1 | -1} dir
 * @returns {string | null}
 */
export function neighbour(terminals, sessionId, level, dir) {
  const kinds = LEVEL_KINDS[level];
  for (const t of terminals) {
    const path = pathTo(t.nodes, sessionId);
    if (!path) continue;
    for (const siblings of path) {
      const mine = siblings.find((n) => kinds.includes(n.kind) && containsPane(n, sessionId));
      if (!mine) continue;
      const same = siblings.filter((n) => n.kind === mine.kind);
      if (same.length < 2) return null;
      const i = same.indexOf(mine);
      return firstPane(same[(i + dir + same.length) % same.length]);
    }
    return null;
  }
  return null;
}

/** @param {Node} n @param {string} id @returns {boolean} */
function containsPane(n, id) {
  return "id" in n ? n.id === id : n.children.some((c) => containsPane(c, id));
}
