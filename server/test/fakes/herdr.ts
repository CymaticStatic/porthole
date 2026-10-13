// Fake herdr 0.9.1 for tests (shapes from herdr's API schema, plan Verified facts 10).
// State in $FAKE_DIR: herdr-agents.json (AgentInfo[]), herdr-screen-<pane with ":"→"_">.txt,
// herdr-fail-prompt (exists → `agent prompt` fails). Logs: herdr-calls.log (argv per line),
// herdr-prompts.log and herdr-keys.log (one JSON line per delivered prompt / key batch).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

interface FakeAgent { pane_id: string; workspace_id: string; tab_id: string; agent_status: string }

const dir = process.env.FAKE_DIR ?? "";
const argv = process.argv.slice(2);
appendFileSync(path.join(dir, "herdr-calls.log"), JSON.stringify(argv) + "\n");

function ok(result: Record<string, unknown>): never {
  process.stdout.write(JSON.stringify({ id: "fake", result }) + "\n");
  process.exit(0);
}
function fail(code: string, message: string): never {
  process.stderr.write(JSON.stringify({ id: "fake", error: { code, message } }) + "\n");
  process.exit(1);
}
function agents(): FakeAgent[] {
  const f = path.join(dir, "herdr-agents.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as FakeAgent[]) : [];
}
function find(target: string | undefined): FakeAgent {
  return agents().find((a) => a.pane_id === target) ?? fail("agent_not_found", "no agent " + String(target));
}

const [group, cmd, ...rest] = argv;
const args = rest[0] === "--" ? rest.slice(1) : rest;
if (group !== "agent") fail("unsupported", "fake herdr supports only agent commands");
if (cmd === "list") ok({ type: "agent_list", agents: agents() });
if (cmd === "read") {
  const a = find(args[0]);
  const f = path.join(dir, "herdr-screen-" + a.pane_id.replace(/:/g, "_") + ".txt");
  ok({ type: "pane_read", read: { pane_id: a.pane_id, workspace_id: a.workspace_id, tab_id: a.tab_id, source: "recent", format: "text", text: existsSync(f) ? readFileSync(f, "utf8") : "", revision: 1, truncated: false } });
}
if (cmd === "prompt") {
  const a = find(args[0]);
  if (existsSync(path.join(dir, "herdr-fail-prompt"))) fail("internal", "fake failure");
  if (a.agent_status === "blocked") fail("agent_blocked", "agent is showing a question");
  appendFileSync(path.join(dir, "herdr-prompts.log"), JSON.stringify({ target: args[0], text: args[1] }) + "\n");
  ok({ type: "agent_prompted", agent: a });
}
if (cmd === "send-keys") {
  find(args[0]);
  appendFileSync(path.join(dir, "herdr-keys.log"), JSON.stringify({ target: args[0], keys: args.slice(1) }) + "\n");
  ok({ type: "keys_sent" });
}
fail("unsupported", "fake herdr: agent " + String(cmd));
