// Notification queue (SPEC 4.7): ids, per-device replay until acked, 60 releases per minute.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { InboxItem } from "./inbox";

export interface NotifyMsg { type: "notify"; id: number; itemId: string; title: string; body: string; options: { index: number; label: string }[]; at: string }
export const MAX_PER_DEVICE = 100, KEEP_MS = 24 * 3_600_000, PER_MINUTE = 60;

const WINDOW_MS = 60_000;

interface Entry { msg: NotifyMsg; at: number }
interface Saved { nextId: number; devices: Record<string, Entry[]> }

export function buildNotify(item: InboxItem, id: number, at: string): NotifyMsg {
  const q = item.question;
  const buttons = q !== null && q.open && !q.multi && (q.options.length === 2 || q.options.length === 3);
  return {
    type: "notify",
    id,
    itemId: item.id,
    title: item.title.slice(0, 80),
    body: item.body.slice(0, 200),
    options: buttons && q ? q.options.slice(0, 2).map((label, index) => ({ index, label })) : [],
    at,
  };
}

function isEntry(e: unknown): e is Entry {
  if (typeof e !== "object" || e === null) return false;
  const { msg, at } = e as { msg?: Record<string, unknown>; at?: unknown };
  return typeof at === "number" && typeof msg === "object" && msg !== null && msg.type === "notify" && typeof msg.id === "number";
}

export class NotifyQueue {
  private readonly file: string;
  private readonly now: () => number;
  private readonly send: (msg: NotifyMsg) => void;
  private nextId = 1;
  private devices: Record<string, Entry[]> = {};
  private sentAt: number[] = [];
  private held: InboxItem[] = [];

  constructor(opts: { file: string; now?: () => number; send: (msg: NotifyMsg) => void }) {
    this.file = opts.file;
    this.now = opts.now ?? Date.now;
    this.send = opts.send;
    this.load();
  }

  register(device: string): void {
    if (this.devices[device]) return;
    this.devices[device] = [];
    this.save();
  }

  notify(item: InboxItem): NotifyMsg | null {
    this.trimWindow();
    if (this.held.length === 0 && this.sentAt.length < PER_MINUTE) return this.release(item);
    this.held.push(item);
    return null;
  }

  tick(): NotifyMsg[] {
    this.trimWindow();
    const out: NotifyMsg[] = [];
    while (this.held.length > 0 && this.sentAt.length < PER_MINUTE) {
      const item = this.held.shift();
      if (item) out.push(this.release(item));
    }
    return out;
  }

  pendingFor(device: string, since: number): NotifyMsg[] {
    const list = this.devices[device];
    if (!list) return [];
    const now = this.now();
    const fresh = list.filter((e) => now - e.at < KEEP_MS);
    if (fresh.length !== list.length) {
      this.devices[device] = fresh;
      this.save();
    }
    return fresh.filter((e) => e.msg.id > since).map((e) => e.msg);
  }

  ack(device: string, id: number): void {
    const list = this.devices[device];
    if (!list) return;
    const left = list.filter((e) => e.msg.id !== id);
    if (left.length === list.length) return;
    this.devices[device] = left;
    this.save();
  }

  private trimWindow(): void {
    const now = this.now();
    this.sentAt = this.sentAt.filter((t) => now - t < WINDOW_MS);
  }

  private release(item: InboxItem): NotifyMsg {
    const now = this.now();
    const msg = buildNotify(item, this.nextId++, new Date(now).toISOString());
    this.sentAt.push(now);
    for (const device of Object.keys(this.devices)) {
      const list = (this.devices[device] ?? []).filter((e) => now - e.at < KEEP_MS);
      list.push({ msg, at: now });
      this.devices[device] = list.length > MAX_PER_DEVICE ? list.slice(list.length - MAX_PER_DEVICE) : list;
    }
    this.save();
    this.send(msg);
    return msg;
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Saved>;
      if (typeof raw.nextId === "number" && raw.nextId >= 1) this.nextId = Math.floor(raw.nextId);
      for (const [device, list] of Object.entries(raw.devices ?? {})) {
        this.devices[device] = Array.isArray(list) ? list.filter(isEntry) : [];
      }
    } catch {
      // An unreadable file starts a fresh queue; ids restart only if the file is truly lost.
    }
  }

  private save(): void {
    const body: Saved = { nextId: this.nextId, devices: this.devices };
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + ".part";
    writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}
