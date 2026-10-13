// Byte-offset paging over a growing .jsonl, and a follower for appended lines.

import { closeSync, fstatSync, openSync, readSync, statSync, watch, type FSWatcher } from "node:fs";
import { parseLine, type ChatItem } from "./parse";

export interface Page { items: ChatItem[]; start: number; end: number; hasOlder: boolean }

const CHUNK = 256 * 1024;

function readRange(fd: number, from: number, to: number): Buffer {
  const buf = Buffer.alloc(Math.max(0, to - from));
  if (buf.length) readSync(fd, buf, 0, buf.length, from);
  return buf;
}

/** Offset just after the last "\n" at or before `limit` (a line boundary). */
function lastBoundary(fd: number, limit: number): number {
  let end = limit;
  while (end > 0) {
    const from = Math.max(0, end - CHUNK);
    const nl = readRange(fd, from, end).lastIndexOf(0x0a);
    if (nl >= 0) return from + nl + 1;
    end = from;
  }
  return 0;
}

/** Visit complete lines ending at or before `end` (a boundary), newest first, until visit returns false. */
function scanBackward(fd: number, end: number, visit: (line: string, start: number) => boolean): void {
  let pos = end;
  let tail = Buffer.alloc(0);
  while (pos > 0) {
    const from = Math.max(0, pos - CHUNK);
    const buf = Buffer.concat([readRange(fd, from, pos), tail]);
    let stop = buf.length;
    for (let i = buf.length - 2; i >= -1; i--) {
      const isStart = i === -1 ? from === 0 : buf[i] === 0x0a;
      if (!isStart) continue;
      if (!visit(buf.subarray(i + 1, stop - 1).toString("utf8"), from + i + 1)) return;
      stop = i + 1;
    }
    tail = buf.subarray(0, stop);
    pos = from;
  }
}

export function readPage(file: string, before: number | null, limit: number): Page {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const end = lastBoundary(fd, before === null ? size : Math.min(before, size));
    const lines: ChatItem[][] = [];
    let count = 0;
    let start = end;
    scanBackward(fd, end, (line, lineStart) => {
      const items = parseLine(line, lineStart);
      start = lineStart;
      if (items.length) { lines.push(items); count += items.length; }
      return count < limit;
    });
    return { items: lines.reverse().flat(), start, end, hasOlder: start > 0 };
  } finally {
    closeSync(fd);
  }
}

function forward(fd: number, from: number, to: number): { items: ChatItem[]; end: number } {
  const items: ChatItem[] = [];
  let pos = from;
  let carry = Buffer.alloc(0);
  let carryStart = from;
  while (pos < to) {
    const buf = Buffer.concat([carry, readRange(fd, pos, Math.min(to, pos + CHUNK))]);
    const base = carryStart;
    let lineStart = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 0x0a) continue;
      items.push(...parseLine(buf.subarray(lineStart, i).toString("utf8"), base + lineStart));
      lineStart = i + 1;
    }
    carry = buf.subarray(lineStart);
    carryStart = base + lineStart;
    pos = Math.min(to, pos + CHUNK);
  }
  return { items, end: carryStart };
}

export function readAfter(file: string, after: number): Page {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    // Skip the line that starts at `after` (the client already has it).
    let from = 0;
    if (after >= 0) {
      const nl = readRange(fd, after, Math.min(size, after + CHUNK)).indexOf(0x0a);
      from = nl >= 0 ? after + nl + 1 : size;
    }
    const { items, end } = forward(fd, from, lastBoundary(fd, size));
    return { items, start: from, end, hasOlder: from > 0 };
  } finally {
    closeSync(fd);
  }
}

export class Follower {
  private pos: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private watcher: FSWatcher | null = null;
  private busy = false;

  constructor(
    private readonly file: string,
    from: number,
    private readonly onItems: (items: ChatItem[], end: number) => void,
    private readonly onReset: () => void,
    private readonly pollMs = 500,
  ) {
    this.pos = from;
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), this.pollMs);
    try { this.watcher = watch(this.file, () => this.tick()); } catch { this.watcher = null; }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.watcher?.close();
    this.timer = null;
    this.watcher = null;
  }

  /** Called by the chat channel after it resent a backlog. */
  moveTo(pos: number): void {
    this.pos = pos;
  }

  private tick(): void {
    if (this.busy) return;
    this.busy = true;
    try {
      const size = statSync(this.file).size;
      if (size < this.pos) {
        this.pos = 0;
        this.onReset();
        return;
      }
      if (size === this.pos) return;
      const fd = openSync(this.file, "r");
      try {
        const { items, end } = forward(fd, this.pos, lastBoundary(fd, size));
        if (end > this.pos) {
          this.pos = end;
          if (items.length) this.onItems(items, end);
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      // File briefly missing or unreadable: try again on the next tick.
    } finally {
      this.busy = false;
    }
  }
}
