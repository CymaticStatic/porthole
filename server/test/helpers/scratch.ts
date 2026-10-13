// Scratch world for one test: its own tmux socket folder (TMUX_TMPDIR), fake herdr/pactl/tailscale,
// fake omp, transcript/inbox/state folders. Ben's /tmp/tmux-<uid> is never touched.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, type ConfigOverrides, type HostdConfig } from "../../src/config";
import { cleanEnv } from "../../src/exec";

const TMUX = "/usr/bin/tmux";
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

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000, stepMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met within " + timeoutMs + " ms");
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
  private sockets = new Set<string>();
  private serial = 0;

  constructor() {
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
    this.sockets.add(socket);
    this.tmux(socket, "new-session", "-d", "-s", session, "-x", "120", "-y", "40", "-c", cwd, command);
    return socket;
  }

  tmux(socket: string, ...args: string[]): string {
    const r = Bun.spawnSync([TMUX, "-L", socket, "-f", "/dev/null", ...args], { env: cleanEnv({ TMUX_TMPDIR: this.tmuxTmp }), stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error("tmux " + args.join(" ") + ": " + r.stderr.toString());
    return r.stdout.toString();
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

  cleanup(): void {
    for (const socket of this.sockets) {
      Bun.spawnSync([TMUX, "-L", socket, "kill-server"], { env: cleanEnv({ TMUX_TMPDIR: this.tmuxTmp }), stdout: "ignore", stderr: "ignore" });
    }
    this.sockets.clear();
    rmSync(this.root, { recursive: true, force: true });
  }
}
