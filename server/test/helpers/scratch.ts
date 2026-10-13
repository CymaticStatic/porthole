// Scratch world for one test: its own tmux socket folder (TMUX_TMPDIR), fake herdr/pactl/tailscale,
// fake omp, transcript/inbox/state folders. Ben's /tmp/tmux-<uid> is never touched.
import { setDefaultTimeout } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, type ConfigOverrides, type HostdConfig } from "../../src/config";
import { cleanEnv } from "../../src/exec";

const TMUX = "/usr/bin/tmux";
const TMUX_CALL_TIMEOUT_MS = 5000;
const TMUX_CALL_RETRIES = 2;
const TMUX_CALL_RETRY_PAUSE_MS = 200;
const FAKES = path.join(import.meta.dir, "..", "fakes");
export const FIXTURES = path.join(import.meta.dir, "..", "fixtures");

export interface HerdrAgentFixture {
  terminal_id: string;
  agent_status: "idle" | "working" | "blocked" | "done" | "unknown";
  workspace_id: string;
  tab_id: string;
  pane_id: string;
  focused: boolean;
  revision: number;
  agent?: string;
  name?: string;
  cwd?: string;
  terminal_title_stripped?: string;
}

/** Bun's per-test timeout, applied by `useTestTimeout`. Each test body must end by itself (see TEST_BUDGET_MS) before it fires. */
export const TEST_TIMEOUT_MS = 30_000;

/** Call once at the top of every test file: Bun applies `setDefaultTimeout` per file (a preload only reaches the first one). */
export function useTestTimeout(): void {
  setDefaultTimeout(TEST_TIMEOUT_MS);
}

/** Longest a single wait may take. Real tmux/bun child processes need many seconds under machine load. */
export const DEFAULT_WAIT_MS = 15_000;
// A test body must end by itself (pass or throw) before Bun's timer does: Bun cannot cancel a running async body, so a
// body that outlives its timeout keeps running while Bun moves on to the next test, and then types into the next test's
// folders and (via the module-level `s`) into its scratch. Every Scratch therefore starts a budget that is shorter than the
// timeout, and every wait is clamped to it.
const TEST_BUDGET_MS = TEST_TIMEOUT_MS - 5_000;
let budgetEnd = Number.POSITIVE_INFINITY;

/** `ms`, cut down to what is left of the current test's budget. */
export function boundedMs(ms: number): number {
  return Math.max(0, Math.min(ms, budgetEnd - Date.now()));
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = DEFAULT_WAIT_MS, stepMs = 50): Promise<void> {
  const deadline = Date.now() + boundedMs(timeoutMs);
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met within " + timeoutMs + " ms (or the test's " + TEST_BUDGET_MS + " ms budget)");
    await Bun.sleep(stepMs);
  }
}

export class Scratch {
  readonly root = mkdtempSync(path.join(tmpdir(), "porthole-test-"));
  readonly tmuxTmp = path.join(this.root, "tmux");
  readonly socketDir = path.join(this.tmuxTmp, "tmux-" + (typeof process.getuid === "function" ? process.getuid() : 1000));
  readonly fakeBin = path.join(this.root, "bin");
  readonly transcripts = path.join(this.root, "transcripts");
  readonly inboxRoot = path.join(this.root, "omp-inbox");
  readonly runtimeDir = path.join(this.root, "run");
  readonly stateDir = path.join(this.root, "state");
  readonly thalamusDir = path.join(this.root, "thalamus");
  private servers = new Map<string, number>();
  private serial = 0;
  private closed = false;

  constructor() {
    budgetEnd = Date.now() + TEST_BUDGET_MS;
    for (const d of [this.tmuxTmp, this.fakeBin, this.transcripts, this.inboxRoot, this.stateDir, this.thalamusDir]) {
      mkdirSync(d, { recursive: true, mode: 0o700 });
    }
    for (const name of ["herdr", "pactl", "tailscale"]) {
      this.writeExec(name, "#!/bin/sh\nFAKE_DIR='" + this.fakeBin + "' exec '" + process.execPath + "' '" + path.join(FAKES, name + ".ts") + "' \"$@\"\n");
    }
    this.writeExec("omp", "#!/bin/sh\n# Fake omp: holds its transcript open like the real one, then idles.\nexec 3<\"$1\"\nwhile :; do sleep 1; done\n");
  }

  private writeExec(name: string, body: string): void {
    const f = path.join(this.fakeBin, name);
    writeFileSync(f, body);
    chmodSync(f, 0o700);
  }

  config(o: ConfigOverrides = {}): HostdConfig {
    return loadConfig(null, {
      machineName: "testhost",
      origin: "https://testhost.example.ts.net",
      peers: ["https://peer.example.ts.net"],
      apiPort: 0,
      tmuxSocketDir: this.socketDir,
      transcriptDirs: [this.transcripts],
      inboxRoot: this.inboxRoot,
      runtimeDir: this.runtimeDir,
      stateDir: this.stateDir,
      thalamusDir: this.thalamusDir,
      pendingAfterMs: 1500,
      scanIntervalMs: 200,
      ...o,
      bin: { tmux: TMUX, herdr: path.join(this.fakeBin, "herdr"), pactl: path.join(this.fakeBin, "pactl"), tailscale: path.join(this.fakeBin, "tailscale"), ...o.bin },
    });
  }

  /** `tmux -L porthole-test-<n>` inside this scratch folder; returns the socket name. */
  newTmuxServer(session: string, command = "/bin/sh", cwd = this.root): string {
    this.serial += 1;
    const socket = "porthole-test-" + this.serial;
    this.servers.set(socket, 0);
    this.tmux(socket, "new-session", "-d", "-s", session, "-x", "120", "-y", "40", "-c", cwd, command);
    this.servers.set(socket, Number(this.tmux(socket, "display-message", "-p", "#{pid}").trim()));
    return socket;
  }

  /** Runs one tmux client call and returns its stdout. Throws (naming the command) if tmux fails or keeps hanging. */
  tmux(socket: string, ...args: string[]): string {
    if (this.closed) throw new Error("scratch folder " + this.root + " was already cleaned up (a test body outlived its test)");
    return this.tmuxClient(socket, args);
  }

  /**
   * A tmux client call that cannot hang the test: each try is killed after TMUX_CALL_TIMEOUT_MS. A try that timed out, or that
   * failed with nothing on stderr (the client was killed or died without saying why), is repeated up to TMUX_CALL_RETRIES more times.
   * A failure with a message on stderr is real and thrown at once.
   */
  private tmuxClient(socket: string, args: string[]): string {
    const command = "tmux -L " + socket + " " + args.join(" ");
    for (let attempt = 0; ; attempt++) {
      const r = Bun.spawnSync([TMUX, "-L", socket, "-f", "/dev/null", ...args], {
        env: cleanEnv({ TMUX_TMPDIR: this.tmuxTmp }),
        stdout: "pipe",
        stderr: "pipe",
        timeout: TMUX_CALL_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
      if (r.exitCode === 0) return r.stdout.toString();
      const timedOut = r.exitedDueToTimeout === true;
      const stderr = r.stderr.toString();
      if (!timedOut && stderr.trim() !== "") throw new Error(command + ": " + stderr);
      if (attempt >= TMUX_CALL_RETRIES) {
        throw new Error(command + (timedOut ? ": timed out after " + TMUX_CALL_TIMEOUT_MS + " ms" : ": exited with " + r.exitCode + " and no message") + " (tried " + (attempt + 1) + " times)");
      }
      Bun.sleepSync(TMUX_CALL_RETRY_PAUSE_MS);
    }
  }

  /** Copy fixtures/<fixture> to <transcripts>/--fixture--/<name> (the omp folder layout). */
  transcript(fixture: string, name = fixture): string {
    const dir = path.join(this.transcripts, "--fixture--");
    mkdirSync(dir, { recursive: true });
    const f = path.join(dir, name);
    copyFileSync(path.join(FIXTURES, fixture), f);
    return f;
  }

  writeTranscript(name: string, text: string): string {
    const dir = path.join(this.transcripts, "--fixture--");
    mkdirSync(dir, { recursive: true });
    const f = path.join(dir, name);
    writeFileSync(f, text);
    return f;
  }

  ompCommand(transcriptPath: string): string {
    return "'" + path.join(this.fakeBin, "omp") + "' '" + transcriptPath + "'";
  }

  panePid(socket: string, target: string): number {
    return Number(this.tmux(socket, "display-message", "-p", "-t", target, "#{pane_pid}").trim());
  }

  setHerdrAgents(agents: HerdrAgentFixture[]): void {
    writeFileSync(path.join(this.fakeBin, "herdr-agents.json"), JSON.stringify(agents));
  }

  setHerdrScreen(paneId: string, text: string): void {
    writeFileSync(path.join(this.fakeBin, "herdr-screen-" + paneId.replace(/:/g, "_") + ".txt"), text);
  }

  failHerdrPrompt(on: boolean): void {
    const f = path.join(this.fakeBin, "herdr-fail-prompt");
    if (on) writeFileSync(f, "");
    else rmSync(f, { force: true });
  }

  setLiveVoicePids(pids: number[]): void {
    const rows = pids.map((pid, i) => ({ index: 100 + i, mute: false, corked: false, properties: { "application.name": "omp", "media.name": "voice", "application.process.id": String(pid) } }));
    writeFileSync(path.join(this.fakeBin, "pactl-source-outputs.json"), JSON.stringify(rows));
  }

  breakPactl(on: boolean): void {
    const f = path.join(this.fakeBin, "pactl-fail");
    if (on) writeFileSync(f, "");
    else rmSync(f, { force: true });
  }

  setWhois(map: Record<string, { node: string; login: string }>): void {
    writeFileSync(path.join(this.fakeBin, "tailscale-whois.json"), JSON.stringify(map));
  }

  fakeCalls(name: "herdr" | "pactl" | "tailscale"): string[][] {
    return this.fakeFile(name + "-calls.log").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
  }

  fakeFile(name: string): string {
    const f = path.join(this.fakeBin, name);
    return existsSync(f) ? readFileSync(f, "utf8") : "";
  }

  /** Stops this scratch's own tmux servers (by their recorded pids) and deletes the folder. Safe to call twice. */
  cleanup(): void {
    this.closed = true;
    for (const [socket, pid] of this.servers) {
      try { this.tmuxClient(socket, ["kill-server"]); } catch { /* server already gone or unreachable: reap() below deals with the pid */ }
      if (pid > 0) this.reap(pid);
    }
    this.servers.clear();
    rmSync(this.root, { recursive: true, force: true });
  }

  /** kill-server returns before the server process has exited; wait for that exact pid, then SIGKILL it if it lingers. */
  private reap(pid: number): void {
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      try { process.kill(pid, 0); } catch { return; }
      Bun.sleepSync(20);
    }
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}
