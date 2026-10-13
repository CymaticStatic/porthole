// Live check of how omp's multi-select ask dialog is driven by keys (SPEC 4.6). Needs Ben's OK for each run (SPEC 7: one
// throwaway omp run, never a loop). Exit 0 = every line printed ok, 1 = something failed (report, do not loop), 2 = could not start.
// RUN 1 (2026-10-13, spent): the dialog footer read "Space toggle · Enter submit · Up/Down move · Tab/Left/Right question · Esc
// cancel", rows were "[ ] red, [ ] green, [ ] blue, [ ] yellow, [ ] Other (type your own)" with a ">" cursor, and Up x6 stayed
// on the first row (no wrap). That run's phase 1 pressed Enter expecting it to tick (an older reading of omp's code), so it sent
// the empty selection and the question ended "Cancelled". Space and Enter-with-ticks were therefore never exercised; this file
// is the corrected script for a second run.
// Phase 1 presses keys one by one (never Enter) and prints the dialog rows: Space ticks and unticks, and whether the cursor
// moves. Phase 2 answers the same dialog through hostd (POST /v1/inbox/:id/answer with two option indexes), so the
// product's own key sequence is what gets verified. Phase 1 leaves nothing ticked.
// Everything runs in a scratch tmux server and a scratch hostd; Ben's real tmux, hostd and state are never touched.
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { InboxItem } from "../../src/events/inbox";
import { inboxFeature } from "../../src/features/inbox";
import { sendFeature } from "../../src/features/send";
import { sessionsFeature } from "../../src/features/sessions";
import { createHostd, type Hostd } from "../../src/hostd";
import { sessionId } from "../../src/sessions/ids";
import { get, post } from "../helpers/client";
import { Scratch } from "../helpers/scratch";

const OMP = "/home/cymatic/.local/share/mise/installs/github-can1357-oh-my-pi/latest/omp";
const REPO = path.join(import.meta.dir, "..", "..", "..");
const SESSION = "multi";
const TARGET = "=" + SESSION + ":0.0";
const START_WAIT_MS = 60_000;
const INBOX_WAIT_MS = 120_000;
const CLOSE_WAIT_MS = 30_000;
const REPLY_WAIT_MS = 60_000;
const STILL_MS = 2_000;
const STEP_MS = 500;
const KEY_PAUSE_MS = 800;
const ASK_PROMPT = "Use the ask tool exactly once to ask me a multi-select question: id colors, question Which colors?, multi true, options red, green, blue, yellow. After my answer, reply with only the colors I picked, in lowercase, separated by commas.";
const OPTIONS = JSON.stringify(["red", "green", "blue", "yellow"]);

const s = new Scratch();
let h: Hostd | undefined;
let ok = true;
let socket = "";

function fail(line: string): void {
  ok = false;
  console.log(line);
}

function capture(): string {
  return s.tmux(socket, "capture-pane", "-p", "-t", TARGET);
}

/** The last lines of the pane, without trailing blank lines: the dialog sits at the bottom. */
function dialog(): string {
  const lines = capture().split("\n").map((l) => l.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-18).join("\n");
}

function typeLine(text: string): void {
  s.tmux(socket, "send-keys", "-t", TARGET, "-l", text);
  s.tmux(socket, "send-keys", "-t", TARGET, "Enter");
}

async function until<T>(ms: number, check: () => Promise<T | null> | T | null): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v !== null) return v;
    if (Date.now() > deadline) return null;
    await Bun.sleep(STEP_MS);
  }
}

async function waitStill(ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  let last = capture();
  let since = Date.now();
  while (Date.now() < deadline) {
    await Bun.sleep(STEP_MS);
    const now = capture();
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (last.trim() !== "" && Date.now() - since >= STILL_MS) return true;
  }
  return false;
}

async function inbox(host: Hostd): Promise<InboxItem[]> {
  const body: unknown = await (await get(host, "/v1/inbox")).json();
  if (typeof body !== "object" || body === null || !("items" in body) || !Array.isArray(body.items)) throw new Error("GET /v1/inbox: unexpected body " + JSON.stringify(body));
  const items: InboxItem[] = body.items;
  return items;
}

/** Presses one tmux key `times` times, one process per press like hostd, then prints the dialog. */
async function press(label: string, key: string, times = 1): Promise<string> {
  for (let i = 0; i < times; i++) s.tmux(socket, "send-keys", "-t", TARGET, key);
  await Bun.sleep(KEY_PAUSE_MS);
  const rows = dialog();
  console.log("AFTER " + label + ":\n" + rows + "\nEND");
  return rows;
}

const UNTICKED = /\[ \]\s+green/;

try {
  if (!existsSync(OMP)) {
    console.log("CANNOT RUN: omp binary not found at " + OMP);
    process.exitCode = 2;
    throw new Error("no omp binary");
  }
  const events = path.join(s.runtimeDir, "events.sock");
  const host = await createHostd(s.config(), [sessionsFeature, sendFeature, inboxFeature]);
  h = host;
  const work = path.join(s.root, "work");
  mkdirSync(work, { recursive: true });
  const cmd = "env PORTHOLE_EVENTS_SOCKET='" + events + "' '" + OMP + "' --no-extensions -e '" + path.join(REPO, "omp-extension", "porthole-events.ts") + "' --no-session --model haiku";
  socket = s.newTmuxServer(SESSION, cmd, work);
  s.tmux(socket, "resize-window", "-t", TARGET, "-x", "160", "-y", "50");
  const id = sessionId({ kind: "tmux", socket, session: SESSION, window: 0, pane: 0 });

  if (!(await waitStill(START_WAIT_MS))) {
    console.log("CANNOT RUN: omp's input box never settled in " + START_WAIT_MS / 1000 + " s. Pane:\n" + capture());
    process.exitCode = 2;
    throw new Error("omp did not start");
  }
  typeLine(ASK_PROMPT);

  const item = await until(INBOX_WAIT_MS, async () => {
    const found = (await inbox(host)).find((i) => i.sessionId === id && i.question !== null && i.question.open && JSON.stringify(i.question.options) === OPTIONS);
    return found ?? null;
  });
  if (item === null || item.question === null) {
    fail("INBOX: FAIL no open item with options red/green/blue/yellow for session " + id + " within " + INBOX_WAIT_MS / 1000 + " s; items: " + JSON.stringify(await inbox(host)));
    throw new Error("no question, cannot drive the dialog");
  }
  console.log("INBOX: " + (item.question.multi && item.question.count === 1 ? "ok" : "FAIL") + " (item " + item.id + ", options " + JSON.stringify(item.question.options) + ", multi " + item.question.multi + ", count " + item.question.count + ")");
  if (!item.question.multi || item.question.count !== 1) {
    fail("INBOX: the model did not ask one multi-select question; stopping before any key press");
    throw new Error("not a multi-select question");
  }

  await Bun.sleep(1000);
  console.log("DIALOG BEFORE any key:\n" + dialog() + "\nEND");

  // Phase 1: keys by hand, never Enter. Stop at the first surprise, before anything can be sent.
  const top = await press("Up x6 (to the top)", "Up", 6);
  const moved = await press("Down x1", "Down");
  if (!UNTICKED.test(moved) || !/>\s+\[ \]\s+green/.test(moved)) {
    fail("MOVE: FAIL the cursor is not on an unticked 'green' row after Up x6, Down x1; stopping, dialog cannot be driven safely");
    throw new Error("cursor not understood");
  }
  const ticked = await press("Space on green (tick)", "Space");
  if (UNTICKED.test(ticked)) {
    fail("TICK: FAIL Space did not tick green; stopping, dialog cannot be driven safely");
    throw new Error("tick not understood");
  }
  const cursorLine = ticked.split("\n").find((l) => /^\|\s*>/.test(l)) ?? "";
  console.log("CURSOR AFTER TICK: " + JSON.stringify(cursorLine.trim()) + " (stays on green: " + /green/.test(cursorLine) + ")");
  const unticked = await press("Space again on the same row (untick)", "Space");
  if (!UNTICKED.test(unticked)) {
    fail("UNTICK: FAIL a second Space did not untick green; stopping, dialog cannot be driven safely");
    throw new Error("untick not understood");
  }
  console.log("PHASE 1: ok (Up reaches the top: " + (top !== moved) + "; Space ticks, a second Space unticks)");

  // Phase 2: the product's own sequence through hostd.
  const r = await post(host, "/v1/inbox/" + item.id + "/answer", { optionIndexes: [1, 3] });
  const body = await r.text();
  console.log("ANSWER: status " + r.status + " " + body);
  if (r.status !== 200) fail("ANSWER: FAIL status " + r.status);
  const closed = await until(CLOSE_WAIT_MS, async () => ((await inbox(host)).find((i) => i.id === item.id)?.question?.open === false ? true : null));
  const closedItem = (await inbox(host)).find((i) => i.id === item.id);
  console.log("QUESTION CLOSED: " + (closed !== null) + " outcome=" + closedItem?.question?.outcome);
  const reply = await until(REPLY_WAIT_MS, () => {
    const t = capture();
    return /green\W+yellow/i.test(t) ? t : null;
  });
  console.log("PANE AFTER ANSWER:\n" + dialog() + "\nEND");
  if (r.status === 200 && closed !== null && closedItem?.question?.outcome === "answered" && reply !== null) {
    console.log("VERIFIED SEQUENCE: Up x(options+2) to the top then Down to the option's row and Space, once per chosen option; then Enter to send. Rows: options, then Other.");
    console.log("ANSWER: ok (green and yellow were picked: the pane shows them)");
  } else {
    fail("ANSWER: FAIL closed " + (closed !== null) + " outcome " + closedItem?.question?.outcome + " pane showed 'green, yellow' " + (reply !== null));
  }

  const again = await post(host, "/v1/inbox/" + item.id + "/answer", { optionIndexes: [1, 3] });
  const againBody = await again.text();
  if (again.status === 409 && againBody.includes("Answer this in the terminal")) console.log("CLOSED-READ-ONLY: ok (409 " + againBody + ")");
  else fail("CLOSED-READ-ONLY: FAIL status " + again.status + " " + againBody);
} catch (e) {
  fail("FAIL: " + (e instanceof Error ? e.message : String(e)) + " (do not rerun, report to Ben)");
} finally {
  if (h !== undefined) await h.stop().catch(() => undefined);
  s.cleanup(); // kills only the scratch tmux server it started (by its recorded pid) and deletes the scratch folder
}
console.log(ok ? "PASS" : "FAIL: do not rerun, report to Ben");
process.exit(ok ? 0 : process.exitCode === 2 ? 2 : 1);
