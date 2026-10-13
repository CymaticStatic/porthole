import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { liveVoicePids } from "../src/sessions/livevoice";
import { findOmp, hasInbox, ompAlive, readProcTable, transcriptOf } from "../src/sessions/procs";
import { HERDR_STATUS, statusFromTranscript } from "../src/sessions/status";
import { FIXTURES, Scratch, useTestTimeout, waitFor } from "./helpers/scratch";

useTestTimeout();

let s: Scratch;
beforeEach(() => { s = new Scratch(); });
afterEach(() => s.cleanup());

test("finds the omp in a pane, its open transcript and its inbox", async () => {
  const t = s.transcript("status-needs-you.jsonl");
  const sock = s.newTmuxServer("chat", s.ompCommand(t));
  const panePid = s.panePid(sock, "=chat:0.0");
  let omp = null as number | null;
  await waitFor(() => { omp = findOmp(readProcTable(), panePid); return omp !== null && transcriptOf(omp, [s.transcripts]) === t; });
  expect(omp).toBe(panePid);
  expect(ompAlive(panePid)).toBe(true);
  expect(transcriptOf(panePid, [path.join(s.root, "elsewhere")])).toBeNull();
  expect(hasInbox(s.inboxRoot, panePid)).toBe(false);
  mkdirSync(path.join(s.inboxRoot, String(panePid)));
  expect(hasInbox(s.inboxRoot, panePid)).toBe(true);
  expect(findOmp(readProcTable(), process.pid)).toBeNull();
});

test("live voice pids come from pactl source-outputs, failures are explicit", async () => {
  s.setLiveVoicePids([4242, 77]);
  const r = await liveVoicePids(path.join(s.fakeBin, "pactl"));
  expect(r.ok && [...r.pids].sort()).toEqual([4242, 77].sort());
  s.breakPactl(true);
  const bad = await liveVoicePids(path.join(s.fakeBin, "pactl"));
  expect(bad.ok).toBe(false);
});

test("newest cymatic.session-status entry decides the status", () => {
  expect(statusFromTranscript(path.join(FIXTURES, "status-needs-you.jsonl"))).toEqual({ status: "needs-you", reported: "awaiting-decision", questionCount: 1, recordedAt: "2026-10-13T10:00:03.000Z" });
  expect(statusFromTranscript(path.join(FIXTURES, "status-working.jsonl")).status).toBe("working");
  expect(statusFromTranscript(path.join(FIXTURES, "status-done.jsonl")).status).toBe("done");
  const plain = s.writeTranscript("plain.jsonl", '{"type":"session","version":3,"id":"x","timestamp":"t","cwd":"/"}\n');
  expect(statusFromTranscript(plain)).toEqual({ status: "unknown", reported: null, questionCount: 0, recordedAt: null });
  expect(statusFromTranscript(path.join(s.root, "missing.jsonl")).status).toBe("unknown");
  expect(HERDR_STATUS.blocked).toBe("needs-you");
});
