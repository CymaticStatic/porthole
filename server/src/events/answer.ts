// Answering an omp question from the app (SPEC 4.3, 4.6): body check, the key steps that press it, and when to refuse.

import type { KeyStep } from "../deliver/keys";
import { liveVoiceBlocks } from "../sessions/guard";
import type { SessionInfo } from "../sessions/registry";
import type { InboxItem } from "./inbox";

export const READ_ONLY = "Answer this in the terminal", AT_DESK = "Answer at the desk", MAX_CHUNK = 32;
const MAX_TEXT = 2000, MAX_INDEXES = 20;
// No control characters: a typed answer must not carry its own Enter, Escape or Tab.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export type Answer = { optionIndexes: number[] } | { text: string };

/** Exactly one of `optionIndexes` (1 to 20 distinct whole numbers, 0 or more; one number unless the question is multi-select) or `text` (1 to 2000 characters, no control characters). */
export function parseAnswer(body: Record<string, unknown>): Answer | { error: string } {
  const hasOptions = body.optionIndexes !== undefined, hasText = body.text !== undefined;
  if (hasOptions === hasText) return { error: "send exactly one of optionIndexes or text" };
  if (hasOptions) {
    const idx = body.optionIndexes;
    if (!Array.isArray(idx) || idx.length < 1 || idx.length > MAX_INDEXES) return { error: "optionIndexes must hold 1 to " + MAX_INDEXES + " numbers" };
    const out: number[] = [];
    for (const n of idx as unknown[]) {
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return { error: "optionIndexes must hold whole numbers, 0 or more" };
      if (out.includes(n)) return { error: "optionIndexes must not repeat a number" };
      out.push(n);
    }
    return { optionIndexes: out };
  }
  const t = body.text;
  if (typeof t !== "string" || t === "") return { error: "text must be a non-empty string" };
  if (t.length > MAX_TEXT) return { error: "text is longer than " + MAX_TEXT + " characters" };
  if (CONTROL.test(t)) return { error: "text must not contain control characters" };
  return { text: t };
}

/** Up to the top first (the cursor may start on the recommended row), down to the row, Enter; typed text uses the "Other" row. */
export function answerSteps(optionCount: number, a: Answer): KeyStep[] {
  const steps: KeyStep[] = [];
  for (let i = 0; i < optionCount + 2; i++) steps.push({ key: "Up" });
  const row = "text" in a ? optionCount : a.optionIndexes[0];
  for (let i = 0; i < row; i++) steps.push({ key: "Down" });
  steps.push({ key: "Enter" });
  if ("text" in a) steps.push({ text: a.text }, { key: "Enter" });
  return steps;
}

/**
 * Multi-select dialog. Seen live (server/test/live/multiselect-once.ts, run 1): one row per option with a [ ] box, then an
 * "Other (type your own)" row, a ">" cursor, Up stops at the first row, and the footer says "Space toggle · Enter submit".
 * NOT yet exercised live: what Space and Enter do with ticks (run 1 pressed Enter on an empty selection by mistake).
 * One group per tick, each going up to the top first and then down to its row, so it does not matter whether Space moves
 * the cursor; the last group is Enter. The caller pauses between groups.
 */
export function multiAnswerGroups(optionCount: number, indexes: readonly number[]): KeyStep[][] {
  const groups: KeyStep[][] = [];
  for (const row of [...indexes].sort((x, y) => x - y)) {
    const g: KeyStep[] = [];
    for (let i = 0; i < optionCount + 2; i++) g.push({ key: "Up" });
    for (let i = 0; i < row; i++) g.push({ key: "Down" });
    g.push({ key: "Space" });
    groups.push(g);
  }
  groups.push([{ key: "Enter" }]);
  return groups;
}

/** Lists of at most `size` steps (P1's key-row limit). */
export function chunks(steps: KeyStep[], size: number = MAX_CHUNK): KeyStep[][] {
  const out: KeyStep[][] = [];
  for (let i = 0; i < steps.length; i += size) out.push(steps.slice(i, i + size));
  return out;
}

/** The reason to refuse, or null. Option answers on live-voice panes are refused later by `Deliverer.keys` with its own reason. */
export function answerRefusal(item: InboxItem, info: SessionInfo | null, a: Answer, answered: ReadonlySet<string>): string | null {
  const q = item.question;
  if (item.archivedAt !== null || q === null || !q.open) return READ_ONLY;
  if (q.count !== 1 || answered.has(q.qid)) return READ_ONLY;
  if (info === null || info.omp?.pid !== q.pid) return READ_ONLY;
  if ("text" in a && q.multi) return READ_ONLY;
  if ("optionIndexes" in a) {
    if (a.optionIndexes.length > 1 && !q.multi) return "pick one option";
    if (a.optionIndexes.some((n) => n >= q.options.length)) return "no such option";
  }
  if ("text" in a && liveVoiceBlocks(info)) return AT_DESK;
  return null;
}
