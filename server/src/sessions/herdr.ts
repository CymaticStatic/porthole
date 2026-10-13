// herdr 0.9.1 CLI calls (Verified facts 9-10). Only `agent list` is verified on the real herdr;
// read/prompt/send-keys follow herdr's API schema and are proven against the fake herdr.

import type { HostdConfig } from "../config";
import { run, type RunResult } from "../exec";
import { asArray, asRecord, asString } from "../json";

export interface HerdrAgent { workspace: string; tab: string; pane: string; status: string; name: string; agent: string; cwd: string; title: string; focused: boolean }

export function herdrError(r: RunResult): string {
  if (r.timedOut) return "herdr did not answer within 5 s";
  try {
    const msg = asString(asRecord(asRecord(JSON.parse(r.stderr)).error).message);
    if (msg) return msg;
  } catch { /* not JSON: use the raw text */ }
  return r.stderr.trim() || "herdr exited with " + r.code;
}

export async function listAgents(cfg: HostdConfig): Promise<{ ok: true; agents: HerdrAgent[] } | { ok: false; error: string }> {
  const r = await run([cfg.bin.herdr, "agent", "list"]);
  if (r.code !== 0) return { ok: false, error: herdrError(r) };
  let parsed: unknown;
  try { parsed = JSON.parse(r.stdout); } catch { return { ok: false, error: "herdr agent list did not print JSON" }; }
  const agents = asArray(asRecord(asRecord(parsed).result).agents).map((v): HerdrAgent => {
    const a = asRecord(v);
    return {
      workspace: asString(a.workspace_id), tab: asString(a.tab_id), pane: asString(a.pane_id),
      status: asString(a.agent_status) || "unknown", name: asString(a.name), agent: asString(a.agent),
      cwd: asString(a.cwd), title: asString(a.terminal_title_stripped), focused: a.focused === true,
    };
  }).filter((a) => a.pane !== "" && a.workspace !== "");
  return { ok: true, agents };
}

export async function readScreen(cfg: HostdConfig, pane: string, lines: number): Promise<{ ok: boolean; text: string; error: string }> {
  const r = await run([cfg.bin.herdr, "agent", "read", pane, "--source", "recent", "--lines", String(lines), "--format", "text"]);
  if (r.code !== 0) return { ok: false, text: "", error: herdrError(r) };
  try {
    const read = asRecord(asRecord(asRecord(JSON.parse(r.stdout)).result).read);
    if (typeof read.text === "string") return { ok: true, text: read.text, error: "" };
  } catch { /* plain text output */ }
  return { ok: true, text: r.stdout, error: "" };
}

export async function prompt(cfg: HostdConfig, pane: string, text: string): Promise<{ ok: boolean; error: string }> {
  const r = await run([cfg.bin.herdr, "agent", "prompt", "--", pane, text], { timeoutMs: 15_000 });
  return r.code === 0 ? { ok: true, error: "" } : { ok: false, error: herdrError(r) };
}

export async function sendKeys(cfg: HostdConfig, pane: string, keys: string[]): Promise<{ ok: boolean; error: string }> {
  const r = await run([cfg.bin.herdr, "agent", "send-keys", pane, ...keys]);
  return r.code === 0 ? { ok: true, error: "" } : { ok: false, error: herdrError(r) };
}
