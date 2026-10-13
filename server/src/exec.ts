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

export async function run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  try {
    const proc = Bun.spawn(argv, {
      stdin: opts.input === undefined ? "ignore" : new Blob([opts.input]),
      stdout: "pipe",
      stderr: "pipe",
      env: opts.env ?? cleanEnv(),
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, opts.timeoutMs ?? 5000);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { code, stdout, stderr, timedOut };
  } catch (err) {
    return { code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err), timedOut: false };
  }
}
