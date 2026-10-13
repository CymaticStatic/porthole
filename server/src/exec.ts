// One way to run a helper program: argv only (no shell), a timeout, captured output.

export interface RunResult { code: number; stdout: string; stderr: string; timedOut: boolean }
export interface RunOptions { timeoutMs?: number; env?: Record<string, string>; input?: string }

/** The current environment without TMUX/TMUX_PANE, so tmux never thinks it runs nested. */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "TMUX" && k !== "TMUX_PANE") env[k] = v;
  }
  return { ...env, ...extra };
}

/** Exit code reported when the child had to be killed because it outlived `timeoutMs` (the same code as coreutils `timeout`). */
export const TIMEOUT_CODE = 124;
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Runs `argv`. If the child is still running after `timeoutMs` (default 10 s) it is SIGKILLed (only this child, by its handle) and
 * the result is `{ code: 124, timedOut: true, stderr: "timed out after N ms" }`. A killed child's pipes are not awaited: a
 * grandchild that inherited them must not be able to keep this call hanging.
 */
export async function run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  try {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const proc = Bun.spawn(argv, {
      stdin: opts.input === undefined ? "ignore" : new Blob([opts.input]),
      stdout: "pipe",
      stderr: "pipe",
      env: opts.env ?? cleanEnv(),
    });
    const expired = Promise.withResolvers<"timeout">();
    const timer = setTimeout(() => expired.resolve("timeout"), timeoutMs);
    const finished = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const outcome = await Promise.race([finished, expired.promise]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      finished.catch(() => undefined);
      proc.kill("SIGKILL");
      await proc.exited;
      return { code: TIMEOUT_CODE, stdout: "", stderr: "timed out after " + timeoutMs + " ms", timedOut: true };
    }
    const [stdout, stderr, code] = outcome;
    return { code, stdout, stderr, timedOut: false };
  } catch (err) {
    return { code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err), timedOut: false };
  }
}
