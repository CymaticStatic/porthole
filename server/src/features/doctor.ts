// GET /v1/doctor (SPEC 4.2, 4.4): read-only checks of the things that most often make Porthole feel broken.
// The doctor never changes anything and never sends anything on the events socket.

import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import type { HostdConfig } from "../config";
import { cleanEnv, run } from "../exec";
import { json, type FeatureFactory } from "../router";
import { listSockets, socketPath } from "../sessions/tmux";

export interface Check { id: string; ok: boolean; detail: string }

const EVENTS_SOCKET_TIMEOUT_MS = 500;
const TMUX_TIMEOUT_MS = 3_000;
const EXTENSIONS = ["porthole-events", "live-inbox"];
// server/src/features -> the repository root, where omp-extension/ holds the copies Ben installs.
const REPO_EXTENSIONS = path.join(import.meta.dir, "..", "..", "..", "omp-extension");

async function tmuxMouse(cfg: HostdConfig, socket: string): Promise<Check> {
  const id = "tmux-mouse:" + socket;
  const r = await run([cfg.bin.tmux, "-S", socketPath(cfg, socket), "show-options", "-gv", "mouse"], { env: cleanEnv(), timeoutMs: TMUX_TIMEOUT_MS });
  if (r.code !== 0) return { id, ok: false, detail: "tmux does not answer on this socket: " + (r.stderr.trim() || "exit " + r.code) };
  if (r.stdout.trim() === "on") return { id, ok: true, detail: "mouse is on" };
  return { id, ok: false, detail: "scrolling needs `set -g mouse on`" };
}

function extension(cfg: HostdConfig, name: string): Check {
  const id = "extension:" + name;
  const installed = path.join(cfg.ompExtensionsDir, name + ".ts");
  const repoCopy = path.join(REPO_EXTENSIONS, name + ".ts");
  if (!existsSync(installed)) return { id, ok: false, detail: "not installed" };
  if (!existsSync(repoCopy)) return { id, ok: false, detail: "installed, but the repo copy " + repoCopy + " is missing, so it cannot be compared" };
  const same = readFileSync(installed).equals(readFileSync(repoCopy));
  return same ? { id, ok: true, detail: "installed, same as the repo copy" } : { id, ok: false, detail: "older than the repo copy" };
}

/** Connects and hangs up at once: nothing is sent. */
function eventsSocket(cfg: HostdConfig): Promise<Check> {
  const id = "events-socket";
  const file = path.join(cfg.runtimeDir, "events.sock");
  const { promise, resolve } = Promise.withResolvers<Check>();
  const conn = createConnection(file);
  const finish = (ok: boolean, detail: string): void => {
    clearTimeout(timer);
    conn.destroy();
    resolve({ id, ok, detail });
  };
  const timer = setTimeout(() => finish(false, "no answer within " + EVENTS_SOCKET_TIMEOUT_MS + " ms"), EVENTS_SOCKET_TIMEOUT_MS);
  conn.once("connect", () => finish(true, "accepts connections"));
  conn.once("error", (err: NodeJS.ErrnoException) => finish(false, "not listening (" + (err.code ?? err.message) + ")"));
  return promise;
}

function binary(id: string, file: string): Check {
  try {
    if (!statSync(file).isFile()) return { id, ok: false, detail: file + " is not a file" };
    accessSync(file, constants.X_OK);
    return { id, ok: true, detail: file };
  } catch {
    return { id, ok: false, detail: file + " is missing or not executable" };
  }
}

function stateDir(cfg: HostdConfig): Check {
  const id = "state-dir";
  try {
    const mode = statSync(cfg.stateDir).mode & 0o777;
    return mode === 0o700 ? { id, ok: true, detail: cfg.stateDir + " is 0700" } : { id, ok: false, detail: cfg.stateDir + " is 0" + mode.toString(8) + ", it should be 0700" };
  } catch {
    return { id, ok: false, detail: cfg.stateDir + " does not exist" };
  }
}

export const doctorFeature: FeatureFactory = (deps) => ({
  routes: [
    {
      method: "GET",
      pattern: "/v1/doctor",
      async handler() {
        const cfg = deps.config;
        const mouse = await Promise.all(listSockets(cfg).map((socket) => tmuxMouse(cfg, socket)));
        const checks: Check[] = [
          ...mouse,
          ...EXTENSIONS.map((name) => extension(cfg, name)),
          await eventsSocket(cfg),
          binary("voxtype", cfg.bin.voxtype),
          binary("git", cfg.bin.git),
          stateDir(cfg),
        ];
        return json({ checks });
      },
    },
  ],
  channels: [],
});
