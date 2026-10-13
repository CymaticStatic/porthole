// hostd configuration (SPEC 4.1): ~/.config/porthole/hostd.json over built-in defaults.
// Tests pass overrides that point every path at a scratch folder and every binary at a fake.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { asRecord, asString } from "./json";
import { run } from "./exec";

export interface Binaries {
  tmux: string;
  herdr: string;
  pactl: string;
  tailscale: string;
  git: string;
  voxtype: string;
  voxflow: string;
  ss: string;
  nvidiaSmi: string;
  omp: string;
}

export interface HostdConfig {
  machineName: string;      // first DNS label, e.g. "bendesk-omarchy"
  origin: string;           // exact control-room origin, e.g. "https://bendesk-omarchy.tailafe04c.ts.net"
  peers: string[];          // other machines' exact origins (SPEC 4.15)
  host: "127.0.0.1";        // 127.0.0.1 mode (plan Verified facts 5)
  apiPort: number;          // 8797; 0 in tests (any free port)
  tmuxSocketDir: string;    // "/tmp/tmux-<uid>"
  bin: Binaries;
  transcriptDirs: string[]; // folders holding <project>/<session>.jsonl
  inboxRoot: string;        // "$XDG_RUNTIME_DIR/omp-inbox"
  runtimeDir: string;       // "$XDG_RUNTIME_DIR/porthole" (local-token)
  stateDir: string;         // "~/.local/state/porthole" (sent.jsonl, access.log)
  allowedLogin: string;
  allowedNodes: string[];
  thalamusDir: string;
  pendingAfterMs: number;   // SPEC 4.5: 30 s, then `pending`
  scanIntervalMs: number;
  singleForwardedFor: boolean; // false until Task 12 L3 proves `tailscale serve` writes one X-Forwarded-For entry
  previewPort: number;      // 8798; 0 in tests
  previewRanges: string;    // "3000-3999,4000-4999,5000-5999,8000-8999" or "none"
  usageCollection: boolean; // true
  voiceEnhance: boolean;    // false: voxflow enhance overwrites the clipboard
  ompExtensionsDir: string; // "~/.omp/agent/extensions"
}

export type ConfigOverrides = Omit<Partial<HostdConfig>, "bin"> & { bin?: Partial<Binaries> };

function uid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 1000;
}

export function defaultConfig(): HostdConfig {
  const home = homedir();
  const runtime = process.env.XDG_RUNTIME_DIR || "/run/user/" + uid();
  return {
    machineName: "",
    origin: "",
    peers: [],
    host: "127.0.0.1",
    apiPort: 8797,
    tmuxSocketDir: "/tmp/tmux-" + uid(),
    bin: {
      tmux: "/usr/bin/tmux",
      herdr: "/usr/bin/herdr",
      pactl: "/usr/bin/pactl",
      tailscale: "/usr/bin/tailscale",
      git: "/usr/bin/git",
      voxtype: "/usr/bin/voxtype",
      voxflow: path.join(home, ".local", "bin", "voxflow"),
      ss: "/usr/bin/ss",
      nvidiaSmi: "/usr/bin/nvidia-smi",
      omp: path.join(home, ".local", "share", "mise", "installs", "github-can1357-oh-my-pi", "latest", "omp"),
    },
    transcriptDirs: [path.join(home, ".omp", "agent", "sessions")],
    inboxRoot: path.join(runtime, "omp-inbox"),
    runtimeDir: path.join(runtime, "porthole"),
    stateDir: path.join(home, ".local", "state", "porthole"),
    allowedLogin: "bengovernale@gmail.com",
    allowedNodes: ["bencell", "benacer-omarchy", "bendesk-omarchy"],
    thalamusDir: "/home/cortex/00-system/thalamus",
    pendingAfterMs: 30_000,
    scanIntervalMs: 2_000,
    singleForwardedFor: false,
    previewPort: 8798,
    previewRanges: "3000-3999,4000-4999,5000-5999,8000-8999",
    usageCollection: true,
    voiceEnhance: false,
    ompExtensionsDir: path.join(home, ".omp", "agent", "extensions"),
  };
}

export function parseRanges(text: string): { ranges: [number, number][] } | { error: string } {
  const t = text.trim();
  if (t === "none") return { ranges: [] };
  const ranges: [number, number][] = [];
  for (const part of t.split(",").map((p) => p.trim())) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part);
    if (!m) return { error: "port range \"" + part + "\" must look like 3000-3999 or 8080" };
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (lo < 1 || hi > 65535 || lo > hi) return { error: "port range \"" + part + "\" must stay within 1-65535, low to high" };
    ranges.push([lo, hi]);
  }
  return { ranges };
}

const ORIGIN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function validateConfig(c: HostdConfig): string[] {
  const problems: string[] = [];
  if (!/^[a-z0-9-]+$/.test(c.machineName)) problems.push("machineName must be this machine's first DNS label (run `main.ts init-config`)");
  if (!ORIGIN.test(c.origin)) problems.push("origin must look like https://<machine>.<tailnet>.ts.net with no port and no trailing slash");
  for (const p of c.peers) if (!ORIGIN.test(p)) problems.push("peer origin " + JSON.stringify(p) + " must look like https://<machine>.<tailnet>.ts.net");
  if (c.host !== "127.0.0.1") problems.push("host must be 127.0.0.1");
  if (!Number.isInteger(c.apiPort) || c.apiPort < 0 || c.apiPort > 65535) problems.push("apiPort must be 0-65535");
  for (const [name, file] of Object.entries(c.bin)) if (!path.isAbsolute(file)) problems.push("bin." + name + " must be an absolute path");
  if (!c.transcriptDirs.length || !c.transcriptDirs.every((d) => path.isAbsolute(d))) problems.push("transcriptDirs must be absolute folders");
  for (const key of ["tmuxSocketDir", "inboxRoot", "runtimeDir", "stateDir", "thalamusDir"] as const) {
    if (!path.isAbsolute(c[key])) problems.push(key + " must be an absolute path");
  }
  if (!c.allowedLogin.includes("@")) problems.push("allowedLogin must be a Tailscale login");
  if (typeof c.singleForwardedFor !== "boolean") problems.push("singleForwardedFor must be true or false");
  if (!Number.isInteger(c.previewPort) || c.previewPort < 0 || c.previewPort > 65535) problems.push("previewPort must be 0-65535");
  else if (c.previewPort !== 0 && c.previewPort === c.apiPort) problems.push("previewPort must differ from apiPort");
  const ranges = parseRanges(c.previewRanges);
  if ("error" in ranges) problems.push("previewRanges: " + ranges.error);
  if (typeof c.usageCollection !== "boolean") problems.push("usageCollection must be true or false");
  if (typeof c.voiceEnhance !== "boolean") problems.push("voiceEnhance must be true or false");
  if (!path.isAbsolute(c.ompExtensionsDir)) problems.push("ompExtensionsDir must be an absolute path");
  return problems;
}

export function loadConfig(file: string | null, overrides: ConfigOverrides = {}): HostdConfig {
  const base = defaultConfig();
  const fromFile: ConfigOverrides = file && existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ConfigOverrides) : {};
  const merged: HostdConfig = {
    ...base,
    ...fromFile,
    ...overrides,
    bin: { ...base.bin, ...fromFile.bin, ...overrides.bin },
  };
  const problems = validateConfig(merged);
  if (problems.length) throw new Error("hostd config problems:\n- " + problems.join("\n- "));
  return merged;
}

/** This machine's MagicDNS name, read from tailscale (SPEC 3: never guessed). */
export async function selfFromTailscale(bin: string): Promise<{ machineName: string; origin: string }> {
  const r = await run([bin, "status", "--json"]);
  if (r.code !== 0) throw new Error("tailscale status failed: " + r.stderr.trim());
  const dns = asString(asRecord(asRecord(JSON.parse(r.stdout)).Self).DNSName).replace(/\.$/, "");
  if (!dns.includes(".")) throw new Error("tailscale status shows no DNS name for this machine");
  return { machineName: dns.split(".")[0], origin: "https://" + dns };
}

/** First-run config: machine name and origin from tailscale; an existing file is never overwritten. */
export async function writeInitialConfig(file: string, tailscaleBin: string): Promise<string> {
  if (existsSync(file)) return "kept existing " + file;
  const self = await selfFromTailscale(tailscaleBin);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ machineName: self.machineName, origin: self.origin, peers: [] }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return "wrote " + file + " for " + self.origin;
}
