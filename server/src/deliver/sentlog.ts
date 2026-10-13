// ~/.local/state/porthole/sent.jsonl (0600): every status change of every send, with its text (SPEC 4.5).

import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";

export type SendStatus = "delivered" | "pending" | "refused" | "failed";
export type SendRoute = "inbox" | "tmux" | "herdr" | "none";

export interface SendRecord {
  at: string;
  clientMsgId: string;
  sessionId: string;
  status: SendStatus;
  reason: string;
  route: SendRoute;
  text: string;
  pid: number | null;   // omp pid for inbox sends
  file: string | null;  // final inbox file for inbox sends
}

export class SentLog {
  readonly file: string;
  private readonly latestById = new Map<string, SendRecord>();

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.file = path.join(stateDir, "sent.jsonl");
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const r = JSON.parse(line) as SendRecord;
          this.latestById.set(r.clientMsgId, r);
        } catch {
          // A torn last line from a crash: the earlier records still count.
        }
      }
    } else {
      writeFileSync(this.file, "", { mode: 0o600 });
    }
    this.terminateTornLine();
    chmodSync(this.file, 0o600);
  }

  /** A crash mid-append can leave the file without a final newline; the next record would glue onto it. */
  private terminateTornLine(): void {
    const fd = openSync(this.file, "r");
    try {
      const size = fstatSync(fd).size;
      if (size === 0) return;
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] === 0x0a) return;
    } finally {
      closeSync(fd);
    }
    appendFileSync(this.file, "\n");
  }

  latest(id: string): SendRecord | undefined {
    return this.latestById.get(id);
  }

  pending(): SendRecord[] {
    return [...this.latestById.values()].filter((r) => r.status === "pending");
  }

  append(r: Omit<SendRecord, "at">): SendRecord {
    const rec: SendRecord = { at: new Date().toISOString(), ...r };
    appendFileSync(this.file, JSON.stringify(rec) + "\n");
    this.latestById.set(rec.clientMsgId, rec);
    return rec;
  }
}
