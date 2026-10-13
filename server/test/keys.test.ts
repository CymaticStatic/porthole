import { afterEach, beforeEach, expect, test } from "bun:test";
import { Deliverer } from "../src/deliver/deliver";
import { parseSteps } from "../src/deliver/keys";
import { SentLog } from "../src/deliver/sentlog";
import { sessionId } from "../src/sessions/ids";
import { Registry } from "../src/sessions/registry";
import { ompPane, pane } from "./helpers/client";
import { type HerdrAgentFixture, Scratch, useTestTimeout, waitFor } from "./helpers/scratch";

useTestTimeout();

let s: Scratch;
let d: Deliverer;
beforeEach(() => {
  s = new Scratch();
  const cfg = s.config();
  d = new Deliverer(cfg, new Registry(cfg), new SentLog(cfg.stateDir));
});
afterEach(() => s.cleanup());

const HERDR_ID = sessionId({ kind: "herdr", workspace: "w1", tab: "w1:t1", pane: "w1:p1" });
function herdrAgent(status: HerdrAgentFixture["agent_status"]): void {
  s.setHerdrAgents([{ terminal_id: "t1", agent_status: status, workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", focused: false, revision: 1, name: "rev" }]);
}

test("parseSteps accepts the key row and refuses anything else", () => {
  expect(parseSteps(["Esc", "C-c", "y", "text:hello"])).toEqual([{ key: "Esc" }, { key: "C-c" }, { key: "y" }, { text: "hello" }]);
  expect("error" in (parseSteps(["Hyper"]) as object)).toBe(true);
  expect("error" in (parseSteps([]) as object)).toBe(true);
  expect("error" in (parseSteps(Array(33).fill("Tab")) as object)).toBe(true);
  expect("error" in (parseSteps("Esc") as object)).toBe(true);
});

test("tmux keys reach a scratch pane", async () => {
  const p = await pane(s, "work", "cat -v");
  const r = await d.keys(p.id, parseSteps(["text:abc", "C-a", "Enter"]) as never);
  expect(r).toEqual({ status: "sent", reason: "" });
  await waitFor(() => s.tmux(p.socket, "capture-pane", "-p", "-t", "=work:0.0").includes("abc^A"));
});

test("herdr keys appear in the fake's log, even while the agent asks a question", async () => {
  herdrAgent("blocked");
  expect(await d.keys(HERDR_ID, [{ key: "Esc" }])).toEqual({ status: "sent", reason: "" });
  const last = s.fakeFile("herdr-keys.log").trim().split("\n").pop() ?? "";
  expect(JSON.parse(last)).toEqual({ target: "w1:p1", keys: ["esc"] });
  expect((await d.keys(HERDR_ID, [{ text: "hi" }])).reason).toBe("text steps work on tmux panes only; use Send for herdr");
});

test("keys are refused while live voice is on or unknown", async () => {
  const p = await ompPane(s, "omp", s.transcript("chat-basic.jsonl"));
  s.setLiveVoicePids([p.pid]);
  expect(await d.keys(p.id, [{ key: "Esc" }])).toEqual({ status: "refused", reason: "live voice is on; keys would mix with it" });
  herdrAgent("idle");
  expect((await d.keys(HERDR_ID, [{ key: "Esc" }])).status).toBe("sent");
  s.setLiveVoicePids([99999]);
  expect(await d.keys(HERDR_ID, [{ key: "Esc" }])).toEqual({ status: "refused", reason: "cannot tell if live voice is on, so keys are off" });
  s.setLiveVoicePids([]);
  s.breakPactl(true);
  expect((await d.keys(HERDR_ID, [{ key: "Esc" }])).status).toBe("refused");
  expect((await d.keys(p.id, [{ key: "Esc" }])).status).toBe("refused");
});
