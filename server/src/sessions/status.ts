// Session status from the newest `cymatic.session-status` custom entry (Verified facts 12).

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { asRecord, asString } from "../json";

export type SessionStatus = "working" | "idle" | "needs-you" | "done" | "unknown";
export interface StatusInfo { status: SessionStatus; reported: string | null; questionCount: number; recordedAt: string | null }

export const REPORTED_STATUS: Record<string, SessionStatus> = {
  "awaiting-decision": "needs-you",
  blocked: "needs-you",
  "in-progress": "working",
  interrupted: "idle",
  "no-report": "idle",
  abandoned: "done",
  fulfilled: "done",
};

export const HERDR_STATUS: Record<string, SessionStatus> = {
  idle: "idle",
  working: "working",
  blocked: "needs-you",
  done: "done",
  unknown: "unknown",
};

const UNKNOWN: StatusInfo = { status: "unknown", reported: null, questionCount: 0, recordedAt: null };
const MARKER = '"customType":"cymatic.session-status"';
const CHUNK = 1024 * 1024;
const MAX_BACK = 16 * CHUNK;

function fromLine(line: string): StatusInfo | null {
  let entry: Record<string, unknown>;
  try { entry = asRecord(JSON.parse(line)); } catch { return null; }
  if (entry.type !== "custom" || entry.customType !== "cymatic.session-status") return null;
  const data = asRecord(entry.data);
  const reported = asString(data.status);
  return {
    status: REPORTED_STATUS[reported] ?? "unknown",
    reported: reported || null,
    questionCount: typeof data.questionCount === "number" ? data.questionCount : 0,
    recordedAt: asString(data.recordedAt) || null,
  };
}

/** Reads backwards in 1 MiB steps (at most 16 MiB) for the newest status line. */
export function statusFromTranscript(file: string): StatusInfo {
  let fd: number;
  try { fd = openSync(file, "r"); } catch { return UNKNOWN; }
  try {
    const size = fstatSync(fd).size;
    let end = size;
    let carry = "";
    while (end > 0 && size - end < MAX_BACK) {
      const start = Math.max(0, end - CHUNK);
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      const lines = (buf.toString("utf8") + carry).split("\n");
      carry = start > 0 ? (lines.shift() ?? "") : "";
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes(MARKER)) continue;
        const info = fromLine(lines[i]);
        if (info) return info;
      }
      end = start;
    }
    return UNKNOWN;
  } finally {
    closeSync(fd);
  }
}
