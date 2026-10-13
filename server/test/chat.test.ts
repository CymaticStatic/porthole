import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, truncateSync } from "node:fs";
import { chatFeature } from "../src/features/chat";
import { sessionId } from "../src/sessions/ids";
import { get, ompPane, openWs, pane, startTestHostd, type TestHostd } from "./helpers/client";
import { Scratch, waitFor } from "./helpers/scratch";

let s: Scratch;
let h: TestHostd;
beforeEach(async () => {
  s = new Scratch();
  h = await startTestHostd(s, [chatFeature]);
});
afterEach(async () => {
  await h.stop();
  s.cleanup();
});

type Item = { cursor: number; text: string };
type PageBody = { items: Item[]; start: number; end: number; hasOlder: boolean; note?: string };
const userLine = (id: string, text: string) =>
  JSON.stringify({ type: "message", id, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
const chatPath = (id: string) => "/v1/sessions/" + encodeURIComponent(id) + "/chat";

test("pages over HTTP", async () => {
  const p = await ompPane(s, "omp", s.transcript("chat-basic.jsonl"));
  const last = (await (await get(h, chatPath(p.id) + "?limit=1")).json()) as PageBody;
  expect(last.items.map((i) => i.text)).toEqual(["Also check the tests"]);
  expect(last.hasOlder).toBe(true);
  const older = (await (await get(h, chatPath(p.id) + "?before=" + last.start + "&limit=50")).json()) as PageBody;
  expect(older.items.length).toBeGreaterThan(0);
  expect(older.items.every((i) => i.cursor < last.start)).toBe(true);
  const after = (await (await get(h, chatPath(p.id) + "?after=" + older.items[0].cursor)).json()) as PageBody;
  expect(after.items.at(-1)?.text).toBe("Also check the tests");
});

test("WebSocket backlog, then append, then a new backlog after the file shrinks", async () => {
  const file = s.transcript("chat-basic.jsonl", "live.jsonl");
  const p = await ompPane(s, "omp", file);
  const ws = await openWs(h, chatPath(p.id));
  const first = await ws.next("backlog", 3000);
  expect((first.page as PageBody).items.at(-1)?.text).toBe("Also check the tests");
  appendFileSync(file, userLine("u90", "new from the test"));
  const add = await ws.next("append", 3000);
  expect((add.items as Item[]).map((i) => i.text)).toEqual(["new from the test"]);
  truncateSync(file, 0);
  const again = await ws.next("backlog", 3000);
  expect((again.page as PageBody).items).toEqual([]);
  ws.close();
});

test("a different transcript in the same pane (omp /new) restarts the follower on the new file", async () => {
  const fileA = s.transcript("chat-basic.jsonl", "a.jsonl");
  const fileB = s.writeTranscript("b.jsonl", userLine("b1", "from file B"));
  const p = await ompPane(s, "omp", fileA);
  const ws = await openWs(h, chatPath(p.id));
  await ws.next("backlog", 3000);
  s.tmux(p.socket, "respawn-pane", "-k", "-t", "=omp:0.0", s.ompCommand(fileB));
  const moved = await ws.next("backlog", 5000);
  expect((moved.page as PageBody).items.map((i) => i.text)).toEqual(["from file B"]);
  appendFileSync(fileA, userLine("a99", "old file, ignored"));
  appendFileSync(fileB, userLine("b2", "B again"));
  const add = await ws.next("append", 3000);
  expect((add.items as Item[]).map((i) => i.text)).toEqual(["B again"]);
  await Bun.sleep(500);
  expect(JSON.stringify(ws.seen)).not.toContain("old file, ignored");
  ws.close();
});

test("no transcript: HTTP note and a WebSocket error", async () => {
  const p = await pane(s, "plain", "/bin/sh");
  const r = await get(h, chatPath(p.id));
  expect(r.status).toBe(200);
  expect(((await r.json()) as PageBody).note).toBe("this session has no omp transcript; use Terminal or Screen");
  const ws = await openWs(h, chatPath(p.id));
  expect((await ws.next("error", 3000)).error).toBe("this session has no omp transcript");
  expect(await ws.closed).toBe(1000);
});

test("screen shows the tmux pane and the herdr screen", async () => {
  const p = await pane(s, "plain", "/bin/sh");
  s.tmux(p.socket, "send-keys", "-t", "=plain:0.0", "printf 'marker-%s\\n' 42", "Enter");
  await waitFor(async () => (((await (await get(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/screen")).json()) as { text: string }).text.includes("marker-42")));
  const tm = (await (await get(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/screen")).json()) as { source: string };
  expect(tm.source).toBe("tmux");
  s.setHerdrAgents([{ terminal_id: "t1", agent_status: "idle", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", focused: false, revision: 1 }]);
  s.setHerdrScreen("w1:p1", "hello herdr\n");
  const hid = sessionId({ kind: "herdr", workspace: "w1", tab: "w1:t1", pane: "w1:p1" });
  const hr = (await (await get(h, "/v1/sessions/" + encodeURIComponent(hid) + "/screen")).json()) as { text: string; source: string };
  expect([hr.source, hr.text.includes("hello herdr")]).toEqual(["herdr", true]);
});

test("unknown session: 404 on chat and screen, error on the channel", async () => {
  const id = "tmux:nope:nope:0.0";
  expect((await get(h, chatPath(id))).status).toBe(404);
  expect((await get(h, "/v1/sessions/" + encodeURIComponent(id) + "/screen")).status).toBe(404);
  const ws = await openWs(h, chatPath(id));
  expect((await ws.next("error", 3000)).error).toBe("no such session");
  expect(await ws.closed).toBe(1000);
});
