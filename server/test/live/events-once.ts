// One live check of the omp events extension against a real, throwaway omp (P2.1 and P2.9 in one run).
// Run ONCE, by hand; never rerun, whether it passes or fails (SPEC 7: one throwaway omp run per extension).
// Exit 0 = every line printed ok, 1 = something failed (report, do not loop), 2 = could not start.
// Everything runs in a scratch tmux server and a scratch hostd; Ben's real tmux, hostd and state are never touched.
import { mkdirSync } from "node:fs";
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
const SESSION = "ask";
const TARGET = "=" + SESSION + ":0.0";
const START_WAIT_MS = 60_000;
const INBOX_WAIT_MS = 120_000;
const CLOSE_WAIT_MS = 30_000;
const ANSWER_WAIT_MS = 60_000;
const PONG_WAIT_MS = 60_000;
const STILL_MS = 2_000;
const STEP_MS = 500;
const ASK_PROMPT = "Use the ask tool exactly once to ask me: Which color? Options: red, green, blue. After my answer, reply with only the color I picked, in lowercase.";
const PONG_PROMPT = "Reply with the single word pong";
const OPTIONS = JSON.stringify(["red", "green", "blue"]);

const s = new Scratch();
let h: Hostd | undefined;
let hostdStopped = false;
let ok = true;
let socket = "";

function fail(line: string): void {
  ok = false;
  console.log(line);
}

function capture(): string {
  return s.tmux(socket, "capture-pane", "-p", "-t", TARGET);
}

function typeLine(text: string): void {
  s.tmux(socket, "send-keys", "-t", TARGET, "-l", text);
  s.tmux(socket, "send-keys", "-t", TARGET, "Enter");
}

/** Polls `check` every STEP_MS until it returns a value other than null, or `ms` pass (then null). */
async function until<T>(ms: number, check: () => Promise<T | null> | T | null): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v !== null) return v;
    if (Date.now() > deadline) return null;
    await Bun.sleep(STEP_MS);
  }
}

/** True once the pane has text and it has not changed for STILL_MS. */
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

/** The inbox's items as hostd returns them (the elements are hostd's own shape, not re-validated here). */
async function inbox(host: Hostd): Promise<InboxItem[]> {
  const body: unknown = await (await get(host, "/v1/inbox")).json();
  if (typeof body !== "object" || body === null || !("items" in body) || !Array.isArray(body.items)) throw new Error("GET /v1/inbox: unexpected body " + JSON.stringify(body));
  const items: InboxItem[] = body.items;
  return items;
}

/** True when a whole pane line is just `word` (ignoring punctuation and bullets around it). */
function hasLine(text: string, word: string): boolean {
  const re = new RegExp("^\\W*" + word + "\\W*$", "i");
  return text.split("\n").some((l) => re.test(l.trim()));
}

try {
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
  console.log("OMP STARTED, pane before the prompt:\n" + capture());
  typeLine(ASK_PROMPT);

  // P2.1: the question reaches the inbox with its options.
  const item = await until(INBOX_WAIT_MS, async () => {
    const found = (await inbox(host)).find((i) => i.sessionId === id && i.question !== null && i.question.open && JSON.stringify(i.question.options) === OPTIONS);
    return found ?? null;
  });
  if (item === null) {
    fail("INBOX: FAIL no open item with options red/green/blue for session " + id + " within " + INBOX_WAIT_MS / 1000 + " s; items: " + JSON.stringify(await inbox(host)));
  } else {
    console.log("INBOX: ok (item " + item.id + ", question \"" + item.question?.text + "\", options " + JSON.stringify(item.question?.options) + ", multi " + item.question?.multi + ", count " + item.question?.count + ")");
  }

  // Dialog rows exactly as captured (F16 GUESS: a free-text row right after the last option).
  await Bun.sleep(1000);
  const rows = capture();
  console.log("DIALOG ROWS (capture-pane -p):\n" + rows + "\nEND DIALOG ROWS");
  const lines = rows.split("\n").map((l) => l.trimEnd());
  const blue = lines.map((l, i) => ({ l, i })).filter((x) => /\bblue\W*$/i.test(x.l.trim()) && !/red/i.test(x.l)).pop();
  const after = blue === undefined ? "" : (lines.slice(blue.i + 1).find((l) => l.trim() !== "") ?? "");
  console.log("ROW AFTER blue: " + JSON.stringify(after));
  if (blue === undefined || !/other|type|custom|free|write|own/i.test(after)) console.log("ROWS DIFFER");

  if (item !== null) {
    const r = await post(host, "/v1/inbox/" + item.id + "/answer", { optionIndexes: [1] });
    const body = await r.text();
    if (r.status !== 200) fail("ANSWER: FAIL status " + r.status + " " + body);
    const closed = await until(CLOSE_WAIT_MS, async () => ((await inbox(host)).find((i) => i.id === item.id)?.question?.open === false ? true : null));
    const closedItem = (await inbox(host)).find((i) => i.id === item.id);
    const green = await until(ANSWER_WAIT_MS, () => (hasLine(capture(), "green") ? true : null));
    if (r.status === 200 && closed !== null && green !== null) console.log("ANSWER: ok (200 " + body + "; question open=false outcome=" + closedItem?.question?.outcome + "; pane shows green)");
    else fail("ANSWER: FAIL status " + r.status + ", question closed " + (closed !== null) + " (outcome " + closedItem?.question?.outcome + "), pane shows green " + (green !== null) + "\n" + capture());

    const again = await post(host, "/v1/inbox/" + item.id + "/answer", { optionIndexes: [1] });
    const againBody = await again.text();
    if (again.status === 409 && againBody.includes("Answer this in the terminal")) console.log("CLOSED-READ-ONLY: ok (409 " + againBody + ")");
    else fail("CLOSED-READ-ONLY: FAIL status " + again.status + " " + againBody);
  } else {
    fail("ANSWER: skipped (no inbox item)");
  }

  // P2.9: with hostd gone, the extension must not hurt omp.
  await host.stop();
  hostdStopped = true;
  console.log("HOSTD STOPPED: events socket gone");
  if (hasLine(capture(), "pong")) fail("OMP-WITHOUT-HOSTD: FAIL pane already had a pong line before the prompt");
  const t0 = Date.now();
  typeLine(PONG_PROMPT);
  const pong = await until(PONG_WAIT_MS, () => (hasLine(capture(), "pong") ? true : null));
  if (pong !== null) console.log("OMP-WITHOUT-HOSTD: ok in " + ((Date.now() - t0) / 1000).toFixed(1) + " s");
  else fail("OMP-WITHOUT-HOSTD: FAIL no pong line within " + PONG_WAIT_MS / 1000 + " s\n" + capture());
  console.log("FINAL PANE:\n" + capture());
} catch (e) {
  fail("FAIL: " + (e instanceof Error ? e.message : String(e)) + " (do not rerun, report to Ben)");
} finally {
  if (h !== undefined && !hostdStopped) await h.stop().catch(() => undefined);
  s.cleanup(); // kills only the scratch tmux server it started (by its recorded pid) and deletes the scratch folder
}
console.log(ok ? "PASS" : "FAIL: do not rerun, report to Ben");
process.exit(ok ? 0 : process.exitCode === 2 ? 2 : 1);
