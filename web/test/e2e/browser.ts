// A throwaway headless Chromium for the e2e stack (plan C1): its own --user-data-dir under the scratch folder, a DevTools port
// chosen by Chromium itself, and names mapped to the test proxies. It is stopped by its recorded PID only; the leftover
// check matches that PID and this run's own `--user-data-dir=<dir>` argument, never a process name.
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const CHROMIUM = "/usr/bin/chromium";
const START_TIMEOUT_MS = 20_000;
const TERM_GRACE_MS = 3_000;

export interface Chrome {
  pid: number;
  /** The remote-debugging port Chromium picked. */
  port: number;
  profileDir: string;
  /** SIGTERM to the recorded PID (SIGKILL after 3 s), then waits until nothing carries this profile's argument. Idempotent. */
  stop(): Promise<void>;
}

export interface ChromeOptions {
  /** The scratch folder: the profile lives in `<scratch>/chrome`. */
  scratch: string;
  /** Machine host name (no port) → loopback port of its proxy. HTTPS (443) only. */
  map: Record<string, number>;
}

/** PIDs of every process whose command line carries exactly `arg` (read-only /proc scan). Chromium rewrites its own argv into one space-joined string, so both separators count. */
export function pidsWithArg(arg: string): number[] {
  const out: number[] = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (readFileSync(`/proc/${d}/cmdline`, "utf8").split(/[\0 ]/).includes(arg)) out.push(Number(d));
    } catch { /* the process ended while we looked */ }
  }
  return out;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function startChrome(opts: ChromeOptions): Promise<Chrome> {
  if (!existsSync(CHROMIUM)) throw new Error(CHROMIUM + " is missing: the headless e2e stack needs Chromium");
  const profileDir = path.join(opts.scratch, "chrome");
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  // Anything Chromium wants to write besides the profile goes into the scratch folder too.
  const home = path.join(opts.scratch, "chrome-home");
  for (const d of ["config", "cache"]) mkdirSync(path.join(home, d), { recursive: true, mode: 0o700 });

  const rules = Object.entries(opts.map).map(([host, port]) => `MAP ${host}:443 127.0.0.1:${port}`).join(",");
  const userDataArg = `--user-data-dir=${profileDir}`;
  const child = Bun.spawn([
    CHROMIUM,
    "--headless=new",
    userDataArg,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--ignore-certificate-errors",
    "--disable-gpu",
    "--window-size=1500,1200",
    `--host-resolver-rules=${rules}`,
    "about:blank",
  ], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"), HOME: home },
  });
  const pid = child.pid;

  let stopped: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopped ??= (async () => {
      if (alive(pid)) { try { process.kill(pid, "SIGTERM"); } catch { /* gone already */ } }
      const killTimer = setTimeout(() => { try { process.kill(pid, "SIGKILL"); } catch { /* gone already */ } }, TERM_GRACE_MS);
      await child.exited;
      clearTimeout(killTimer);
      // Chromium's helper processes end a moment after the browser process; wait for them by this profile's own argument.
      const until = Date.now() + TERM_GRACE_MS;
      while (pidsWithArg(userDataArg).length > 0 && Date.now() < until) await Bun.sleep(50);
      for (const left of pidsWithArg(userDataArg)) { try { process.kill(left, "SIGKILL"); } catch { /* gone already */ } }
    })();
    return stopped;
  };

  const portFile = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + START_TIMEOUT_MS;
  let port = 0;
  while (port === 0) {
    if (existsSync(portFile)) port = Number(readFileSync(portFile, "utf8").split("\n")[0]) || 0;
    if (port === 0) {
      if (child.exitCode !== null) throw new Error("Chromium exited with code " + child.exitCode + " before it opened its DevTools port");
      if (Date.now() > deadline) { await stop(); throw new Error("Chromium did not write " + portFile + " within " + START_TIMEOUT_MS + " ms"); }
      await Bun.sleep(50);
    }
  }
  return { pid, port, profileDir, stop };
}
