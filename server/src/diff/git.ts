// Runs git so that it can neither take locks nor run anything the repository configures (SPEC 4.9).

import type { HostdConfig } from "../config";
import { cleanEnv, run, type RunResult } from "../exec";

export const GIT_ENV: Record<string, string> = { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
export const GIT_SAFE = ["-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "color.ui=false", "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false"];
export const DIFF_SAFE = ["--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"];
const TIMEOUT_MS = 10_000;
const MAX_CACHED_DIRS = 256;

/** `-c` overrides that switch off every filter driver named in `config --get-regexp ^filter\.` output. */
export function filterOverrides(configList: string): string[] {
  const names: string[] = [];
  for (const line of configList.split("\n")) {
    const key = line.split(/\s/, 1)[0] ?? "";
    const m = /^filter\.(.+)\.[^.]+$/.exec(key);
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names.flatMap((n) => ["-c", "filter." + n + ".process=", "-c", "filter." + n + ".clean=", "-c", "filter." + n + ".smudge=", "-c", "filter." + n + ".required=false"]);
}

function git(cfg: HostdConfig, dir: string, extra: string[], args: string[]): Promise<RunResult> {
  return run([cfg.bin.git, "-C", dir, ...GIT_SAFE, ...extra, ...args], { env: cleanEnv(GIT_ENV), timeoutMs: TIMEOUT_MS });
}

export async function safeGit(cfg: HostdConfig, dir: string, args: string[]): Promise<RunResult> {
  const list = await git(cfg, dir, [], ["config", "--get-regexp", "^filter\\."]);
  // Exit 1 means "no filter configured"; anything else (not a repo) is reported by the real call below.
  return git(cfg, dir, filterOverrides(list.code === 0 ? list.stdout : ""), args);
}

/** Whether a folder's git working tree has changes: true/false, or null (no git repo, or git failed). Cached per folder. */
export class DirtyCache {
  private readonly cache = new Map<string, { value: boolean | null; at: number }>();

  constructor(private readonly cfg: HostdConfig, private readonly maxAgeMs = 10_000) {}

  async lookup(dir: string): Promise<boolean | null> {
    const hit = this.cache.get(dir);
    if (hit && Date.now() - hit.at < this.maxAgeMs) return hit.value;
    const r = dir ? await safeGit(this.cfg, dir, ["status", "--porcelain=v2", "-z", "--untracked-files=normal"]) : null;
    const value = r === null || r.code !== 0 ? null : r.stdout.length > 0;
    this.cache.set(dir, { value, at: Date.now() });
    if (this.cache.size > MAX_CACHED_DIRS) this.cache.delete(this.cache.keys().next().value as string);
    return value;
  }
}
