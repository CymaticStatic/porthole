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

/** The current environment with every inherited GIT_* variable dropped (GIT_DIR, GIT_WORK_TREE, GIT_CONFIG_*, GIT_EXTERNAL_DIFF ... would redirect or arm git), then GIT_ENV. */
export function gitEnv(): Record<string, string> {
  const env = cleanEnv();
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return { ...env, ...GIT_ENV };
}

function git(cfg: HostdConfig, dir: string, extra: string[], args: string[]): Promise<RunResult> {
  return run([cfg.bin.git, "-C", dir, ...GIT_SAFE, ...extra, ...args], { env: gitEnv(), timeoutMs: TIMEOUT_MS });
}

export async function safeGit(cfg: HostdConfig, dir: string, args: string[]): Promise<RunResult> {
  const list = await git(cfg, dir, [], ["config", "--get-regexp", "^filter\\."]);
  // Exit 1 means "no filter configured"; anything else (not a repo) is reported by the real call below.
  return git(cfg, dir, filterOverrides(list.code === 0 ? list.stdout : ""), args);
}

/**
 * Whether a folder's git working tree has changes: true/false, or null (no git repo, git failed, or git still running).
 * Cached per folder; one git run per folder at a time. A stale value is returned at once while a fresh one loads in the
 * background; with nothing cached the caller waits at most `deadlineMs` (the run keeps going and fills the cache).
 */
export class DirtyCache {
  private readonly cache = new Map<string, { value: boolean | null; at: number }>();
  private readonly inflight = new Map<string, Promise<boolean | null>>();

  constructor(private readonly cfg: HostdConfig, private readonly maxAgeMs = 10_000, private readonly deadlineMs = 1500) {}

  async lookup(dir: string): Promise<boolean | null> {
    const hit = this.cache.get(dir);
    if (hit && Date.now() - hit.at < this.maxAgeMs) return hit.value;
    const pending = this.refresh(dir);
    if (hit) return hit.value;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), this.deadlineMs); });
    try { return await Promise.race([pending, late]); } finally { clearTimeout(timer); }
  }

  private refresh(dir: string): Promise<boolean | null> {
    const running = this.inflight.get(dir);
    if (running) return running;
    const p = this.read(dir).then((value) => {
      this.cache.set(dir, { value, at: Date.now() });
      if (this.cache.size > MAX_CACHED_DIRS) this.cache.delete(this.cache.keys().next().value as string);
      return value;
    }).finally(() => { this.inflight.delete(dir); });
    this.inflight.set(dir, p);
    return p;
  }

  private async read(dir: string): Promise<boolean | null> {
    if (!dir) return null;
    try {
      const r = await safeGit(this.cfg, dir, ["status", "--porcelain=v2", "-z", "--untracked-files=normal"]);
      return r.code !== 0 ? null : r.stdout.length > 0;
    } catch {
      return null;
    }
  }
}
