/** Inbox grouping (SPEC 4.6): column → project folder → machine, newest first. Pure. */
import { basename } from "./format.js";

/**
 * @typedef {object} InboxQuestion
 * @property {string} qid
 * @property {number} pid
 * @property {string} text
 * @property {string[]} options
 * @property {boolean} multi
 * @property {number} count
 * @property {boolean} open
 * @property {string | null} outcome
 */
/**
 * The fields this module reads; hostd's InboxItem carries more, and all of it is passed through.
 * @typedef {object} InboxItemLike
 * @property {string} id
 * @property {string} column "needs-you" | "working" | "done"
 * @property {number} updatedAt ms since epoch
 * @property {string} project
 * @property {number | null} contextLeft 0..1, or null when hostd has no number
 * @property {InboxQuestion | null} question
 */
/** @typedef {InboxItemLike & {machine: string}} Item */
/** @typedef {{project: string, machines: {machine: string, items: Item[]}[]}} Group */

const COLUMNS = /** @type {const} */ ({ "needs-you": "needsYou", working: "working", done: "done" });

/**
 * @param {Record<string, InboxItemLike[]>} itemsByMachine machine name → that machine's items
 * @returns {{needsYou: Group[], working: Group[], done: Group[]}}
 */
export function groupInbox(itemsByMachine) {
  /** @type {{needsYou: Group[], working: Group[], done: Group[]}} */
  const out = { needsYou: [], working: [], done: [] };
  /** @type {Record<"needsYou" | "working" | "done", Map<string, Map<string, Item[]>>>} */
  const cols = { needsYou: new Map(), working: new Map(), done: new Map() };
  for (const [machine, items] of Object.entries(itemsByMachine)) {
    for (const raw of items) {
      const col = Object.hasOwn(COLUMNS, raw.column) ? COLUMNS[/** @type {keyof typeof COLUMNS} */ (raw.column)] : null;
      if (col === null) continue;
      const project = basename(raw.project);
      const byMachine = cols[col].get(project) ?? new Map();
      cols[col].set(project, byMachine);
      const list = byMachine.get(machine) ?? [];
      byMachine.set(machine, list);
      list.push({ ...raw, machine });
    }
  }
  /** @param {Item[]} items */
  const newest = (items) => items.reduce((m, i) => Math.max(m, i.updatedAt), -Infinity);
  for (const col of /** @type {const} */ (["needsYou", "working", "done"])) {
    const groups = [...cols[col]].map(([project, byMachine]) => {
      const machines = [...byMachine].map(([machine, items]) => ({ machine, items: items.slice().sort((a, b) => b.updatedAt - a.updatedAt) }));
      machines.sort((a, b) => newest(b.items) - newest(a.items));
      return { project, machines };
    });
    /** @param {Group} g */
    const groupNewest = (g) => Math.max(...g.machines.map((m) => newest(m.items)));
    groups.sort((a, b) => groupNewest(b) - groupNewest(a));
    out[col] = groups;
  }
  return out;
}

/**
 * P2 answers one option for one question (gap G2), so multi-select or several questions are answered in the terminal.
 * @param {{question: InboxQuestion | null}} item @returns {"buttons" | "terminal"}
 */
export function answerMode(item) {
  const q = item.question;
  return q !== null && (q.multi || q.count > 1) ? "terminal" : "buttons";
}

/** Context-left ring (SPEC 4.6): none without a number, warning below 15 %. @param {{contextLeft: number | null}} item */
export function contextRing(item) {
  const left = item.contextLeft;
  if (left === null || left === undefined) return null;
  return { percent: Math.round(left * 100), warn: left < 0.15 };
}
