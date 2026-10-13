// The inbox (SPEC 4.6): one live item per session key, three columns, lifetimes driven by an injected clock.
// Persisted to one JSON file (0600, write-then-rename) after every change.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { OmpEvent } from "./socket";

export type Column = "needs-you" | "working" | "done";
export interface Question { qid: string; pid: number; text: string; options: string[]; multi: boolean; count: number; open: boolean; outcome: "answered" | "cancelled" | "ended" | null }
export interface InboxItem {
  id: string; key: string; sessionId: string; machine: string; project: string; kind: "omp" | "herdr";
  column: Column; title: string; body: string; question: Question | null; contextLeft: number | null;
  createdAt: number; updatedAt: number; doneAt: number | null; archivedAt: number | null;
}
export interface Change { item: InboxItem; becameNeedsYou: boolean; turnFinished: boolean }

export const DONE_ARCHIVE_MS = 10 * 60_000, ANY_ARCHIVE_MS = 6 * 3_600_000, ARCHIVE_KEEP_MS = 7 * 86_400_000;

const MAX_TITLE = 80;
const MAX_BODY = 200;

function snapshot(item: InboxItem): InboxItem {
  return { ...item, question: item.question ? { ...item.question, options: [...item.question.options] } : null };
}

function isItem(v: unknown): v is InboxItem {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.key === "string" && typeof o.sessionId === "string"
    && typeof o.column === "string" && typeof o.createdAt === "number" && typeof o.updatedAt === "number";
}

export class InboxStore {
  private readonly file: string;
  private readonly machine: string;
  private readonly now: () => number;
  private items: InboxItem[] = [];
  private nextId = 1;
  /** Last herdr status seen per session key (memory only): an archived item is not recreated by an unchanged status. */
  private readonly herdrSeen = new Map<string, string>();

  constructor(opts: { file: string; machine: string; now?: () => number }) {
    this.file = opts.file;
    this.machine = opts.machine;
    this.now = opts.now ?? Date.now;
    this.load();
  }

  /** Applies one omp extension event to the item for `omp:<pid>`; null when the event changes nothing. */
  omp(e: OmpEvent, sessionId: string): Change | null {
    const key = "omp:" + e.pid;
    const now = this.now();
    const live = this.liveFor(key);
    switch (e.type) {
      case "session_start": {
        if (live) {
          live.sessionId = sessionId;
          live.project = e.cwd;
          live.title = this.titleFor(e.cwd, live.title);
          live.updatedAt = now;
          return this.finish(live, false, false);
        }
        // A session that just started has not begun a turn: it sits in "done" (archived 10 minutes later) until its first event.
        const item = this.create(key, sessionId, "omp", e.cwd, "done", "Session started");
        return this.finish(item, false, false);
      }
      case "question_open": {
        const item = live ?? this.create(key, sessionId, "omp", "", "needs-you", "");
        const wasNeedsYou = live !== undefined && item.column === "needs-you" && item.question?.open === true && item.question.qid === e.qid;
        const first = e.questions[0];
        item.sessionId = sessionId;
        item.column = "needs-you";
        item.doneAt = null;
        item.question = { qid: e.qid, pid: e.pid, text: first?.question ?? "", options: first ? [...first.options] : [], multi: first?.multi ?? false, count: e.questions.length, open: true, outcome: null };
        item.body = (first?.question || "A question is waiting").slice(0, MAX_BODY);
        item.updatedAt = now;
        return this.finish(item, !wasNeedsYou, false);
      }
      case "question_closed": {
        if (!live?.question || !live.question.open || live.question.qid !== e.qid) return null;
        live.sessionId = sessionId;
        live.question.open = false;
        live.question.outcome = e.outcome;
        live.column = "working";
        live.doneAt = null;
        live.body = "Working";
        live.updatedAt = now;
        return this.finish(live, false, false);
      }
      case "working": {
        const item = live ?? this.create(key, sessionId, "omp", "", "working", "Working");
        item.sessionId = sessionId;
        item.updatedAt = now;
        if (!(item.column === "needs-you" && item.question?.open === true)) {
          item.column = "working";
          item.doneAt = null;
          item.body = "Working";
        }
        return this.finish(item, false, false);
      }
      case "turn_finished": {
        const item = live ?? this.create(key, sessionId, "omp", "", "done", "Turn finished");
        item.sessionId = sessionId;
        // A finished turn cannot still be waiting on a dialog.
        if (item.question?.open) { item.question.open = false; item.question.outcome = "cancelled"; }
        item.column = "done";
        item.doneAt = now;
        item.body = "Turn finished";
        item.updatedAt = now;
        return this.finish(item, false, true);
      }
      case "session_end": {
        if (!live) return null;
        live.sessionId = sessionId;
        if (live.question?.open) { live.question.open = false; live.question.outcome = "ended"; }
        live.column = "done";
        live.doneAt = now;
        live.body = "Session ended";
        live.updatedAt = now;
        return this.finish(live, false, false);
      }
    }
  }

  /** Applies one herdr pane status (blocked / working / done / idle) to the item keyed by the session id. */
  herdr(sessionId: string, herdrStatus: string, name: string, cwd: string): Change | null {
    const now = this.now();
    const live = this.liveFor(sessionId);
    const unchanged = this.herdrSeen.get(sessionId) === herdrStatus;
    this.herdrSeen.set(sessionId, herdrStatus);
    let column: Column | null;
    let body = "";
    if (herdrStatus === "blocked") { column = "needs-you"; body = "Waiting for you"; }
    else if (herdrStatus === "working") { column = "working"; body = "Working"; }
    // done / idle end a run, so they only move an item that exists (idle: only one that was working).
    else if (herdrStatus === "done") { column = live ? "done" : null; body = "Turn finished"; }
    else if (herdrStatus === "idle") { column = live?.column === "working" ? "done" : null; body = "Turn finished"; }
    else column = null;
    if (column === null) return null;
    if (live && (unchanged || live.column === column)) {
      live.updatedAt = now; // still in this state: keep the item from aging out (memory only)
      return null;
    }
    if (!live && unchanged) return null;
    const item = live ?? this.create(sessionId, sessionId, "herdr", cwd, column, body);
    item.column = column;
    item.body = body;
    item.project = cwd;
    item.title = this.titleFor(cwd, name);
    item.doneAt = column === "done" ? now : null;
    item.updatedAt = now;
    return this.finish(item, column === "needs-you", column === "done");
  }

  /** Live items, newest first (sweeps first). */
  list(): InboxItem[] {
    this.sweep();
    return this.items.filter((i) => i.archivedAt === null).map(snapshot).reverse().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Archived items of the last 7 days, most recently archived first (sweeps first). */
  archived(): InboxItem[] {
    this.sweep();
    return this.items.filter((i) => i.archivedAt !== null).map(snapshot).reverse().sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
  }

  /** Any item still kept, live or archived (sweeps first). */
  get(id: string): InboxItem | undefined {
    this.sweep();
    const item = this.items.find((i) => i.id === id);
    return item ? snapshot(item) : undefined;
  }

  /** Archives a live item now; false when there is no live item with that id. */
  archive(id: string): boolean {
    const item = this.items.find((i) => i.id === id && i.archivedAt === null);
    if (!item) return false;
    item.archivedAt = this.now();
    this.save();
    return true;
  }

  /** Applies the lifetimes; true when an item was archived or dropped. */
  sweep(): boolean {
    const now = this.now();
    let moved = false;
    for (const i of this.items) {
      if (i.archivedAt !== null) continue;
      if ((i.column === "done" && i.doneAt !== null && now - i.doneAt >= DONE_ARCHIVE_MS) || now - i.updatedAt >= ANY_ARCHIVE_MS) {
        i.archivedAt = now;
        moved = true;
      }
    }
    const kept = this.items.filter((i) => i.archivedAt === null || now - i.archivedAt < ARCHIVE_KEEP_MS);
    if (kept.length !== this.items.length) { this.items = kept; moved = true; }
    if (moved) this.save();
    return moved;
  }

  private liveFor(key: string): InboxItem | undefined {
    return this.items.find((i) => i.key === key && i.archivedAt === null);
  }

  private titleFor(project: string, fallback: string): string {
    return (path.basename(project) || fallback).slice(0, MAX_TITLE);
  }

  private create(key: string, sessionId: string, kind: "omp" | "herdr", project: string, column: Column, body: string): InboxItem {
    const now = this.now();
    const item: InboxItem = {
      id: "i" + this.nextId, key, sessionId, machine: this.machine, project, kind, column,
      title: this.titleFor(project, kind === "omp" ? key.replace(":", " ") : key),
      body: body.slice(0, MAX_BODY), question: null, contextLeft: null,
      createdAt: now, updatedAt: now, doneAt: column === "done" ? now : null, archivedAt: null,
    };
    this.nextId += 1;
    this.items.push(item);
    return item;
  }

  private finish(item: InboxItem, becameNeedsYou: boolean, turnFinished: boolean): Change {
    this.save();
    return { item: snapshot(item), becameNeedsYou, turnFinished };
  }

  private load(): void {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(this.file, "utf8")); } catch { return; }
    if (typeof parsed !== "object" || parsed === null) return;
    const o = parsed as Record<string, unknown>;
    if (Array.isArray(o.items)) this.items = o.items.filter(isItem);
    if (typeof o.nextId === "number" && Number.isInteger(o.nextId) && o.nextId >= 1) this.nextId = o.nextId;
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify({ nextId: this.nextId, items: this.items }), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
