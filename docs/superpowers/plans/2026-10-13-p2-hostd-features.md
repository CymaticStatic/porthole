# Porthole P2: hostd features (desktop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add phase P2 to `porthole-hostd` on the desktop: the `porthole-events.ts` omp extension and its events socket, the inbox with answers, `notify` messages on `/v1/events` with ack and replay, uploads, diff, the preview proxy, usage, voice, shortcuts, config, and doctor, exactly as `docs/SPEC.md` section 8 P2 items 1-11 define (sections 4.4, 4.6-4.12, 5.2, 5.4).

**Architecture:** P1 (plan `2026-10-13-p1-hostd-core.md`, branch `feat/p1-hostd`) is fixed: one Bun process, one `FeatureFactory` per module under `server/src/features/`, composed in `server/src/main.ts`. P2 adds new feature files plus small helpers under `server/src/events/`, `server/src/uploads/`, `server/src/diff/`, `server/src/preview/`, `server/src/voice/`. The few P1 contracts P2 cannot work without (listed under **P1 contract gaps**) are added in Task 1 only, as additive changes, after P1 is merged; no other P2 task edits a P1 file except Task 12 (`main.ts`, README). The omp extension talks to hostd over a newline-JSON Unix socket; everything else is HTTP/WebSocket on the existing API listener, except the preview proxy, which is its own loopback listener started by the preview feature.

**Tech Stack:** TypeScript on Bun 1.4.2, `bun test`, tmux 3.7c, git 2.56.0, `ss` (iproute2), voxtype 1.1.0, nvidia-smi, omp 18.10.3 (`omp usage`), ffmpeg (test-time WAV conversion only). No npm dependencies.

## Global Constraints

Copied verbatim from `docs/SPEC.md` (v2, commit e484a25), as in the P1 plan. Every task's requirements include these.

- **hostd** (`server/`): TypeScript on Bun (`/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun`, 1.4.2 on 2026-10-12). It binds **127.0.0.1 only** (or owner-only Unix sockets, 5.4): port 8797 for the app/API and 8798 for the preview proxy.
- hostd config (`~/.config/porthole/hostd.json`) sets: the tmux socket folder, the `tmux` and `herdr` binaries plus `pactl` (absolute paths, because a systemd user service has a thin PATH, Moshi's most common support failure), and the folders it watches for omp transcripts. Tests point these at scratch sockets and a fake `herdr`, so a test hostd never sees Ben's real sessions.
- Every `/v1` HTTP request carries the `X-Porthole: 1` header (WebSockets cannot, and rely on the exact `Origin`, 5.4; CORS preflight `OPTIONS` requests are exempt from the header but still need an allowed exact `Origin`).
- Session ids are stable strings, e.g. `tmux:<socket>:<session>:<window>.<pane>` and `herdr:<workspace>:<tab>:<pane>`.
- `sent.jsonl` lives at `~/.local/state/porthole/sent.jsonl` (mode 0600) and holds the text of delivered messages, so nothing is lost even if the phone is.
- Each request's device and action is logged to `~/.local/state/porthole/access.log` (0600). Message text is never logged there.
- **Never type into, attach to, resize, detach or restart Thalamus (believed to be tmux session `1` today: **GUESS**, it was the only attached session on 2026-10-12), any herdr helper, or any other real session while testing.** Use scratch tmux servers (`tmux -L porthole-test`) with fake panes, like the crash-routing and question-watch tests in `/home/cortex/00-system/thalamus/repo/tools/`. Use a fake `herdr` on PATH for herdr tests.
- Never start omp live voice to test anything (it uses the desk microphone and a paid realtime connection). Test talk mode with a pre-recorded WAV.
- One real omp test run is allowed per omp extension: a throwaway `omp --no-extensions -e <extension.ts> --no-session --model haiku` session in a temp folder (this is how live-inbox was proven, about 9 cents).
- Every test hostd runs with config overrides (4.1): a scratch tmux socket folder, a fake `herdr`, a fake `pactl`, fixture transcript folders, and a test port. A test hostd must never list Ben's real sessions. The one exception is P1.5: it runs against the installed hostd behind `tailscale serve`, and calls only `/v1/machine` and the auth checks.
- Never restart `tailscaled` and never remove or change existing `tailscale serve` entries. Porthole only adds its own two entries, after reading `tailscale serve status`.
- `porthole-events.ts` and `live-inbox.ts` load into **every** new omp session once installed to `~/.omp/agent/extensions/` (Thalamus included, next time it starts). Install each only after its throwaway-omp test passes, and tell Ben in that turn's report.
- Kill only exact PIDs you started. No `pkill`/`killall`.
- No secrets in the repo. Commit and push your own branch after each checked step to the private remote `origin` (https://github.com/CymaticStatic/porthole, approved by Ben 2026-10-12, created 2026-10-12). Never change the repo's visibility. Merge into `main` only when Ben asks, after a conflict check.
- From `.omp/WATCHDOG.md` (project traps, also binding): "The omp extension dependency rewriter has rejected template literals: none in `live-inbox.ts` or `porthole-events.ts`." and "`tmux attach` from Porthole resizes the session for every viewer; detach only Porthole's client."

Also binding from SPEC section 7 for P2: "P2.1 and P2.9 share one run" (the single real omp run, Task 12), "No adb or phone screenshot loops", and "Test talk mode with a pre-recorded WAV".

Code rules for every task (same as P1): no `any`; static imports only; `import type` for type-only imports; `Record` tables for static key mappings; never `pkill`/`killall`; tests never use `rm -r` from a shell (the scratch harness removes its own folder with `rmSync`); every timer a feature starts is cleared in its `stop()`.

Command prefix used below: every `bun` command is the absolute path `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun`, run from the repo root `/home/cortex/00-system/porthole/repo` (or the task's worktree).

---

## Verified facts

Established read-only on 2026-10-13 by the planning agent. No omp session was run, no real tmux session or herdr pane was probed, nothing was installed.

| # | Fact | Command | Output (short) |
|---|---|---|---|
| F1 | omp binary and version | `command -v omp`; `omp --version` | `/home/cymatic/.local/share/mise/installs/github-can1357-oh-my-pi/latest/omp`; `18.10.3` |
| F2 | omp flags needed by the one run | `omp --help` | has `--model` (fuzzy, e.g. `haiku`), `--no-session`, `-e/--extension`, `--no-extensions`. No flag that lists models was found, so the model name can only be pre-checked by help text, not by a free call. |
| F3 | Usage source exists | `omp usage --help` | "Show provider usage limits for every authenticated account"; flags `-j/--json`, `-p/--provider=<id>` (e.g. `anthropic`), `-r/--redact`, `--history`. It uses omp's stored Claude login (no new secret). Strings inside the omp binary map Claude's `five_hour` to `anthropic:5h` and `seven_day` to `anthropic:7d` (plus `7d:opus`/`7d:sonnet`); each limit carries `usedFraction?`, `remainingFraction?`, `resetsAt?`, `windowLabel?`, `status` (`ok`/`warning`/`exhausted`/`unknown`). It also records an hourly snapshot in omp's own database. |
| F4 | `omp usage --json` output shape | not run | **could not verify** (running it was outside this planner's limits). Task 1 step 1 runs it once and records the shape; Task 9 builds from that record. |
| F5 | Claude Code credentials | `ls -l ~/.claude/.credentials.json` | exists, `-rw-------`. Not read, and rejected as a source: hostd would have to read a secret file itself, while `omp usage` already reports the numbers. |
| F6 | voxtype version and transcribe | `voxtype --version`; `voxtype transcribe --help` | `voxtype 1.1.0` (`/usr/bin/voxtype`); "Transcribe an audio file (WAV, 16kHz, mono)", usage `voxtype transcribe [OPTIONS] <FILE>`, own option `--engine` only; global options `-c`, `--model`, `--engine`, `--language`, `--threads`, `--gpu-isolation`, `--gpu-device`, `--on-demand-loading`. **There is no `--cpu` option.** |
| F7 | voxtype engine on this machine | `grep engine ~/.config/voxtype/config.toml` | `engine = "sensevoice"`; the `[whisper]` block has `model = "small.en"`, `gpu_isolation = true`. Differs from SPEC 4.12 "local Whisper". Ben chose "local voxtype only", and SenseVoice is the engine his voxtype runs (recorded fact). Without `--engine`, `voxtype transcribe` uses SenseVoice [INFERENCE from the config; not run]. |
| F8 | voxtype daemon running | `pgrep -a voxtype` (read only) | daemon pid 44472 (on 2026-10-13). The systemd user unit name is **not recorded**: Task 10 step 5 finds it with `systemctl --user list-units 'voxtype*'` before its live script runs. |
| F9 | Graphics card memory | `nvidia-smi --query-gpu=memory.used,memory.total --format=csv` | `4607 MiB, 8192 MiB` |
| F10 | voxflow enhance contract | `voxflow --help`; read `~/.config/voxflow/config.toml` and `/home/cymatic/.local/bin/voxflow` | `voxflow enhance` reads stdin and writes stdout, **but** it also copies to the Wayland clipboard (`wl-copy`), consumes `~/.local/state/voxflow/mode.json`, asks `hyprctl` for the active window, appends to its `history.jsonl`, and calls ollama `qwen2.5:3b` with a 6000 ms timeout. Running it from hostd would overwrite Ben's clipboard. So `voiceEnhance` defaults to **off** (Needs Ben 1). |
| F11 | `ss` listener shape | `ss -ltnpH` (`/usr/bin/ss`) | one line per socket, e.g. `LISTEN 0 512 127.0.0.1:9224 0.0.0.0:* users:(("omp",pid=2043501,fd=14))`. Without root, `users:(...)` appears only for Ben's own processes; other users' sockets have no `users:` field. IPv6 addresses print as `[::1]:3000`, wildcard as `*:3000` or `0.0.0.0:3000`. |
| F12 | git | `git --version` (`/usr/bin/git`) | `git version 2.56.0` |
| F13 | Test audio | `ls /usr/share/sounds/alsa/Front_Center.wav`; `ffmpeg -version` | file exists (48 kHz mono); `/usr/bin/ffmpeg` present. Tests convert it to 16 kHz mono at test time (`ffmpeg -y -i ... -ar 16000 -ac 1 out.wav`); the converted file is never committed. The words it says ("Front Center") are [INFERENCE] from the file name. |
| F14 | omp extension API (local docs `omp://extensions.md`) | read only | events `session_start`, `session_shutdown` (2 s budget), `agent_start`/`agent_end` (notification only), `turn_start`/`turn_end`, `tool_execution_start {toolCallId, toolName, args, intent}`, `tool_execution_end {toolCallId, toolName, result, isError}`. Handlers get `ctx` with `ctx.hasUI`, `ctx.cwd`, `ctx.sessionManager.getSessionFile()`. Raw timers and unhandled throws in an extension kill the omp session. |
| F15 | Extension module shape | `omp-extension/live-inbox.ts` (P1 Task 7) | `export default function liveInbox(pi: ExtensionApi) { pi.on("session_start", (_event, ctx) => { try { ... } catch {} }) }`; imports only `node:fs` and `node:path`; uses `process.pid`. |
| F16 | `ask` tool arguments | omp tool schema (local docs) | `{questions: [{id, question, options: [{label}], multi?, recommended?}]}`. The dialog cursor starts on `recommended` (else row 0); Up/Down stop at the ends. Rows after the options ("Other…", "Chat about this") and their order are **GUESS**; Task 12 reads them from the real pane. |
| F17 | P1 code on disk (branch `feat/p1-hostd`, being built) | read `server/src/*` | `FeatureDeps {config, registry, localToken, sentLog, hub}`; `EventsHub` has only `add`/`remove`/`broadcast`/`size`; `sessionsFeature` owns the `/v1/events` channel and its `message()` ignores input; `Auth.check(req)` does origin, header, local token and identity in one method (identity part lines 38-51); `Deliverer.keys(sessionId, KeyStep[])` returns `{status: "sent"|"refused"|"failed", reason}` and refuses live-voice panes with "live voice is on; keys would mix with it" or "cannot tell if live voice is on, so keys are off"; `parseSteps(string[])` accepts at most 32 entries (`Tab Enter Esc Space BSpace Up Down Left Right Home End PageUp PageDown`, `C-a`..`C-z`, a single character, `text:...`); `HERDR_STATUS` maps `idle/working/blocked/done/unknown`; the fake `omp` is a shell script named `omp` that holds its transcript open and sleeps; `liveVoiceBlocks(info)` in `sessions/guard.ts`. |
| F18 | omp context-left source | not found | **could not verify** that an extension can read how much of the context window is left. Task 2 step 1 searches the local extension docs; without a documented source, `contextLeft` stays `null` (the app hides the ring). |

### Facts that contradict the SPEC

1. SPEC 4.12 says voxtype is "local Whisper"; this machine's voxtype config uses `engine = "sensevoice"` (F7). Ben chose "local voxtype only", and SenseVoice is what his voxtype runs, so Porthole passes no `--engine` and follows his voxtype setting. Recorded as a fact, not a question.
2. SPEC 4.12 says "uses voxtype's CPU mode" if a second model loads on the graphics card; voxtype 1.1.0 has no CPU option (F6). If Task 10's check finds a second model, the task stops and asks Ben.
3. SPEC 4.12 says `voxflow enhance` cleans text via stdin/stdout; it does, but it also overwrites the clipboard and changes voxflow's own mode file (F10). Off by default.
4. SPEC 4.11 says the usage source is "not yet verified"; `omp usage` is a real candidate (F3), JSON shape not yet seen (F4).

### Recorded as intended (not questions)

- **Closed outcomes collapse to two.** omp's `question_closed` outcome is stored as `answered` or `cancelled` only (SPEC 4.6). Which of omp's results counts as `cancelled` (Task 2 uses `tool_execution_end.isError`) is a **GUESS**, confirmed by Task 12's real run (Needs Ben 5).
- **A device that never connected gets no replay.** Notifications sent before a device first opened `/v1/events?device=…` are not queued for it: `queue.register(device)` starts its queue at that moment, so the first connection of a new phone or watch sees only what happens afterwards.

## P1 contract gaps

P1's interfaces are fixed while P1 is built. P2 needs these additions; Task 1 makes all of them, additively, on top of the merged P1 (no P1 behaviour changes; all P1 tests must still pass, with one allowed test change: P1's `server/test/config.test.ts` compares `bin` with `toEqual`, so its two `expect(c.bin)` lines become `toMatchObject`, Task 1 step 5).

1. **`HostdConfig` has no P2 fields.** Added: `previewPort` (8798; 0 in tests), `previewRanges` (`"3000-3999,4000-4999,5000-5999,8000-8999"`), `usageCollection` (true), `voiceEnhance` (false), `ompExtensionsDir` (`~/.omp/agent/extensions`), and `bin.git`, `bin.voxtype`, `bin.voxflow`, `bin.ss`, `bin.nvidiaSmi`, `bin.omp` (absolute paths, F1/F6/F10/F11/F12). `Scratch.config()` sets `previewPort: 0` and points the new binaries at fakes (git stays real: tests use scratch repos).
2. **`EventsHub` has no per-socket hooks**, and `sessionsFeature`'s `/v1/events` `message()` drops input. P2 needs: run code when a socket opens (replay unacked notifications for `?device=`), receive `{type:"ack", id}`, and send to one socket. Added: `hub.onOpen(fn)`, `hub.onMessage(fn)`, `hub.receive(ws, text)`, `hub.sendTo(ws, msg)`; `sessionsFeature`'s channel `message()` calls `hub.receive`, and `add()` fires `onOpen` listeners.
3. **`FeatureDeps` has no shared inbox or auth.** Answers, notifications and the events socket therefore live in one feature (`inboxFeature`), and the preview feature builds its own `Auth` + `Whois` from the config. `Auth` gains `identify(req)` (the identity part of `check`, lines 38-51, moved into its own method that `check` calls) so the preview proxy can check the Tailscale identity without the `X-Porthole`/`Origin` rules that preview pages cannot meet.
4. **`SessionInfo` has no `dirty`** (SPEC 5.2). Added `dirty: boolean | null` (null: no git repo or git failed), computed in `Registry.scan()` through a 10-second per-folder cache in the new `server/src/diff/git.ts`.
5. **`main.ts` `FEATURES` is a fixed list.** Task 12 adds the P2 factories, including `configFeature(configPath(process.env))` (the config feature needs the file path, which `FeatureDeps` does not carry).
6. **Not fixed in P2, recorded:** `Auth` copies `origin` + `peers` at construction, so a `peers` change through `PUT /v1/config` takes effect only after a restart (the response says `restartNeeded: true`). The inbox's answers use their own `Deliverer`, separate from `sendFeature`'s, so a key press from the inbox and one from `/keys` on the same pane are not serialised against each other [INFERENCE: harmless in practice, both are short key bursts].
7. **`FeatureDeps` does not carry the API listener's bound port**, so the preview feature cannot tell a test hostd's port from a dev server by itself. Added: every hostd writes a pid file `PIDS_DIR/<process.pid>` when it starts and removes it when it stops (`createHostd` in `server/src/hostd.ts`, helpers in the new `server/src/pids.ts`, both owned by Task 1). Task 8's scan reads that folder and keeps only pids whose `/proc/<pid>` exists, so a crashed hostd's stale file is ignored.

## File Structure

```
omp-extension/porthole-events.ts         Task 2   omp extension: events over the Unix socket; no template literals; never blocks
omp-extension/README.md                  Task 12  modify: porthole-events section, install line
server/src/config.ts                     Task 1   modify: P2 fields and binaries (gap 1)
server/src/events/hub.ts                 Task 1   modify: onOpen / onMessage / receive / sendTo (gap 2)
server/src/features/sessions.ts          Task 1   modify: /v1/events message() -> hub.receive (gap 2)
server/src/auth/auth.ts                  Task 1   modify: identify() extracted from check() (gap 3)
server/src/sessions/registry.ts          Task 1   modify: SessionInfo.dirty (gap 4)
server/src/diff/git.ts                   Task 1   create: safeGit() runner (lock-free, no programs, filters off) + DirtyCache
server/src/hostd.ts                      Task 1   modify: writes/removes its pid file on start/stop (gap 7)
server/src/pids.ts                       Task 1   create: PIDS_DIR, registerPid(), unregisterPid() (gap 7)
server/test/helpers/scratch.ts           Task 1   modify: P2 config defaults, public writeFake(), ompEchoCommand()
server/test/p2-foundation.test.ts        Task 1
server/test/porthole-events.test.ts      Task 2
server/src/events/socket.ts              Task 3   events Unix socket server (0600 in 0700), newline JSON, size limits
server/src/events/inbox.ts               Task 3   InboxStore: items, columns, lifetimes, archive, persistence (injected clock)
server/test/events-socket.test.ts        Task 3
server/test/inbox-store.test.ts          Task 3
server/src/events/notify.ts              Task 4   NotifyQueue: ids, per-device unacked (100, 24 h), 60/min hold (injected clock)
server/test/notify.test.ts               Task 4
server/src/events/answer.ts              Task 5   answer guard + key steps for an option / typed answer
server/src/features/inbox.ts             Task 5   inboxFeature: socket + store + notify + herdr states + /v1/inbox routes + hub hooks
server/test/inbox.test.ts                Task 5
server/src/uploads/names.ts              Task 6   safeName(), uniquePath(), insideDir()
server/src/features/uploads.ts           Task 6   POST /v1/uploads, 30-day cleanup
server/test/uploads.test.ts              Task 6
server/src/diff/diff.ts                  Task 7   status/diff/untracked parsing into staged/unstaged/untracked
server/src/features/diff.ts              Task 7   GET /v1/sessions/:id/diff
server/test/diff.test.ts                 Task 7
server/src/preview/scan.ts               Task 8   ss parse, ranges, refused list, HTTP probe, hostdPids() reader of the pid files
server/src/preview/proxy.ts              Task 8   preview listener: cookie selection, HTTP + WebSocket proxying
server/src/features/preview.ts           Task 8   GET /v1/previews; starts/stops the proxy listener
server/test/fixtures/preview-upstream.ts Task 8   child-process HTTP + WebSocket echo server for tests
server/test/preview.test.ts              Task 8
server/src/features/usage.ts             Task 9   GET /v1/usage from `omp usage --json`, 60 s cache
server/test/fixtures/omp-usage.json      Task 9   redacted copy of the real output recorded in Task 1 step 1
server/test/usage.test.ts                Task 9
server/src/voice/transcribe.ts           Task 10  one-at-a-time voxtype runner, kept audio, cleanup
server/src/features/voice.ts             Task 10  POST /v1/voice, GET /v1/voice/kept
server/test/voice.test.ts                Task 10
server/test/live/voice-once.ts           Task 10  VRAM check (P2.11) then one real transcription (P2.8)
server/src/features/shortcuts.ts         Task 11  GET|PUT /v1/shortcuts, step validation with parseSteps
server/src/features/config.ts            Task 11  configFeature(file): GET|PUT /v1/config
server/src/features/doctor.ts            Task 11  GET /v1/doctor
server/test/shortcuts.test.ts            Task 11
server/test/config-feature.test.ts       Task 11
server/test/doctor.test.ts               Task 11
server/src/main.ts                       Task 12  modify: P2 factories in FEATURES
server/test/live/events-once.ts          Task 12  the one real omp run (P2.1 + P2.9)
README.md                                Task 12  modify: P2 endpoints, uploads/audio folders, preview proxy, doctor
```

State files (all under `cfg.stateDir`, files 0600, folders 0700): `inbox.json`, `notify.json`, `shortcuts.json`, `uploads/<YYYY-MM-DD>/`, `audio/`. Runtime files (under `cfg.runtimeDir`, folder 0700): `events.sock` (0600).

## Parallel groups and file ownership

| Group | Tasks (run in parallel inside a group) | Needs |
|---|---|---|
| A | Task 1 | P1 merged into `feat/p1-hostd` and green |
| B | Tasks 2, 3, 4, 6, 7, 8, 9, 10, 11 | Group A merged |
| C | Task 5 | Tasks 3 and 4 merged |
| D | Task 12 | everything above merged |

Every file in the File Structure belongs to exactly one task. Group B tasks touch no shared file: each adds its own feature file and test; none edits `main.ts` (Task 12 does). Task 10's live script and Task 12's live script are the only steps that touch real programs (voxtype + nvidia-smi; omp), and each runs exactly once.

---
### Task 1: P2 foundation on top of P1 (the contract gaps)

**Files (owned):**
- Modify: `server/src/config.ts`, `server/src/events/hub.ts`, `server/src/features/sessions.ts`, `server/src/auth/auth.ts`, `server/src/sessions/registry.ts`, `server/src/hostd.ts`, `server/test/helpers/scratch.ts`, `server/test/config.test.ts` (P1's own test: the one allowed P1 test change, Step 5: its two `expect(c.bin).toEqual(...)` lines become `toMatchObject`)
- Create: `server/src/diff/git.ts`, `server/src/pids.ts`, `server/test/p2-foundation.test.ts`

**Interfaces produced (used by every later task):**

```ts
// config.ts
export interface Binaries { tmux: string; herdr: string; pactl: string; tailscale: string; git: string; voxtype: string; voxflow: string; ss: string; nvidiaSmi: string; omp: string }
// HostdConfig gains:
//   previewPort: number;        // 8798; 0 in tests
//   previewRanges: string;      // "3000-3999,4000-4999,5000-5999,8000-8999" or "none"
//   usageCollection: boolean;   // true
//   voiceEnhance: boolean;      // false (Verified facts F10)
//   ompExtensionsDir: string;   // ~/.omp/agent/extensions
export function parseRanges(text: string): { ranges: [number, number][] } | { error: string };

// events/hub.ts (EventsHub gains)
onOpen(fn: (ws: ServerWebSocket<WsData>) => void): () => void;
onMessage(fn: (ws: ServerWebSocket<WsData>, msg: Record<string, unknown>) => void): () => void;
receive(ws: ServerWebSocket<WsData>, text: string): void;   // JSON object with a string `type`, else ignored; max 4096 chars
sendTo(ws: ServerWebSocket<WsData>, msg: object): boolean;

// auth/auth.ts (Auth gains)
identify(req: Request): Promise<Verdict>;   // local token or Tailscale identity only (old check() lines 38-51)

// diff/git.ts
export const GIT_ENV: Record<string, string>;            // { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }
export const GIT_SAFE: string[];                         // ["-c","core.fsmonitor=false","-c","diff.external=","-c","color.ui=false","-c","diff.noprefix=false","-c","diff.mnemonicPrefix=false"]
export const DIFF_SAFE: string[];                        // ["--no-ext-diff","--no-textconv","--no-color","--src-prefix=a/","--dst-prefix=b/"]
export function filterOverrides(configList: string): string[];   // from `config --get-regexp ^filter\.` output
export async function safeGit(cfg: HostdConfig, dir: string, args: string[]): Promise<RunResult>;
export class DirtyCache { constructor(cfg: HostdConfig, maxAgeMs?: number); lookup(dir: string): Promise<boolean | null> }

// sessions/registry.ts: SessionInfo gains `dirty: boolean | null`
// test/helpers/scratch.ts: writeFake(name: string, body: string): string; ompEchoCommand(transcript: string): string
```

- [ ] **Step 1: Record the unverified usage fact (F4).** Run once, read-only (it uses omp's stored Claude login; it writes nothing but omp's own hourly snapshot):

```bash
/home/cymatic/.local/share/mise/installs/github-can1357-oh-my-pi/latest/omp usage --json -p anthropic -r > /home/cortex/00-system/porthole/files/scratch/omp-usage-shape.json; echo "exit $?"
```

Record in the task report: the exit code, the top-level keys, and for each limit its id/label, `usedFraction`, `resetsAt` and `status` field names (not the account names). Check that `-r` left no e-mail address, key or token in the file: `grep -c -E '@|sk-ant|eyJ|token' /home/cortex/00-system/porthole/files/scratch/omp-usage-shape.json` must print 0 (a field *named* `token…` that holds only a number, such as a token count, is fine: report the name and check by eye that no value is a string credential). If the command fails, or there is no 5-hour and no 7-day Claude window in it, write "USAGE SOURCE NOT CONFIRMED" in the report, **delete the scratch file at once** (`rm /home/cortex/00-system/porthole/files/scratch/omp-usage-shape.json`), and Task 9 then stops and asks Ben (SPEC 4.11). Otherwise keep the file only until Task 9 has built `server/test/fixtures/omp-usage.json` from it, and Task 9 deletes it (its step 1). Do not run the command a second time.

- [ ] **Step 2: Write the failing tests** `server/test/p2-foundation.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Auth } from "../src/auth/auth";
import { Whois } from "../src/auth/identity";
import { defaultConfig, parseRanges } from "../src/config";
import { DIFF_SAFE, DirtyCache, filterOverrides, safeGit } from "../src/diff/git";
import { PIDS_DIR } from "../src/pids";
import { sessionsFeature } from "../src/features/sessions";
import type { FeatureFactory } from "../src/router";
import { Registry } from "../src/sessions/registry";
import { openWs, startTestHostd } from "./helpers/client";
import { Scratch, waitFor } from "./helpers/scratch";

let s: Scratch;
beforeAll(() => { s = new Scratch(); });
afterAll(() => s.cleanup());

function repo(name: string): string {
  const dir = path.join(s.root, name);
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => Bun.spawnSync(["/usr/bin/git", "-C", dir, ...a], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-qm", "init");
  return dir;
}

test("P2 config defaults and port ranges", () => {
  const c = defaultConfig();
  expect([c.previewPort, c.previewRanges, c.usageCollection, c.voiceEnhance]).toEqual([8798, "3000-3999,4000-4999,5000-5999,8000-8999", true, false]);
  for (const b of [c.bin.git, c.bin.voxtype, c.bin.voxflow, c.bin.ss, c.bin.nvidiaSmi, c.bin.omp]) expect(path.isAbsolute(b)).toBe(true);
  expect(parseRanges("3000-3001, 8080")).toEqual({ ranges: [[3000, 3001], [8080, 8080]] });
  expect(parseRanges("none")).toEqual({ ranges: [] });
  for (const bad of ["", "0-10", "5-4", "70000", "abc", "1-2-3"]) expect("error" in parseRanges(bad)).toBe(true);
});

test("hub: onOpen on connect, ack-shaped messages reach onMessage, junk is ignored", async () => {
  const got: Record<string, unknown>[] = [];
  let opened = 0;
  const probe: FeatureFactory = (d) => {
    d.hub.onOpen((ws) => { opened += 1; d.hub.sendTo(ws, { type: "hello" }); });
    d.hub.onMessage((_ws, m) => { got.push(m); });
    return { routes: [], channels: [] };
  };
  const h = await startTestHostd(s, [sessionsFeature, probe]);
  try {
    const ws = await openWs(h, "/v1/events?device=bencell");
    expect((await ws.next("hello", 3000)).type).toBe("hello");
    ws.send("not json");
    ws.send(JSON.stringify([1, 2]));
    ws.send(JSON.stringify({ type: "ack", id: 3 }));
    await waitFor(() => got.length === 1, 3000);
    expect(got).toEqual([{ type: "ack", id: 3 }]);
    expect(opened).toBe(1);
    ws.close();
  } finally {
    await h.stop();
  }
});

test("identify(): local token or Tailscale identity, without the X-Porthole and Origin rules", async () => {
  const cfg = s.config();
  s.setWhois({ "100.64.0.5": { node: "bencell", login: cfg.allowedLogin } });
  const auth = new Auth(cfg, new Whois(cfg.bin.tailscale), "tok");
  const req = (h: Record<string, string>) => new Request("http://127.0.0.1/__porthole/preview?port=3000", { headers: h });
  expect((await auth.identify(req({}))).ok).toBe(false);
  expect(await auth.identify(req({ "x-porthole-local": "tok" }))).toEqual({ ok: true, device: "local", via: "local" });
  expect(await auth.identify(req({ "tailscale-user-login": cfg.allowedLogin, "x-forwarded-for": "100.64.0.5" }))).toEqual({ ok: true, device: "bencell", via: "tailscale" });
  expect((await auth.identify(req({ "tailscale-user-login": "someone@else", "x-forwarded-for": "100.64.0.5" }))).ok).toBe(false);
});

test("filterOverrides switches every configured filter driver off", () => {
  const list = "filter.lfs.clean git-lfs clean -- %f\nfilter.lfs.smudge git-lfs smudge -- %f\nfilter.a.b.process x\n";
  expect(filterOverrides(list)).toEqual([
    "-c", "filter.lfs.process=", "-c", "filter.lfs.clean=", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.required=false",
    "-c", "filter.a.b.process=", "-c", "filter.a.b.clean=", "-c", "filter.a.b.smudge=", "-c", "filter.a.b.required=false",
  ]);
});

test("safeGit runs no repo-configured program and takes no lock", async () => {
  const dir = repo("evil");
  const marker = path.join(s.root, "evil-ran");
  const prog = s.writeFake("evil-prog", "#!/bin/sh\ntouch '" + marker + "'\ncat\n");
  const cfgGit = (...a: string[]) => Bun.spawnSync(["/usr/bin/git", "-C", dir, "config", ...a]);
  cfgGit("core.fsmonitor", prog);
  cfgGit("diff.external", prog);
  cfgGit("filter.evil.clean", prog);
  cfgGit("filter.evil.process", prog);
  cfgGit("filter.evil.required", "true");
  cfgGit("diff.evil.textconv", prog);
  writeFileSync(path.join(dir, ".gitattributes"), "*.txt filter=evil diff=evil\n");
  writeFileSync(path.join(dir, "a.txt"), "two\n");
  const indexBefore = statSync(path.join(dir, ".git", "index")).mtimeMs;
  const cfg = s.config();
  for (const args of [["status", "--porcelain=v2"], ["diff"], ["diff", "--cached"], ["ls-files", "--others", "--exclude-standard"]]) {
    const r = await safeGit(cfg, dir, args);
    expect(r.code).toBe(0);
  }
  expect(existsSync(marker)).toBe(false);
  expect(statSync(path.join(dir, ".git", "index")).mtimeMs).toBe(indexBefore);
  expect(existsSync(path.join(dir, ".git", "index.lock"))).toBe(false);
});

test("a pid file marks every running hostd (Task 8 reads it) and goes away on stop", async () => {
  const file = path.join(PIDS_DIR, String(process.pid));
  const first = await startTestHostd(s, [sessionsFeature]);
  expect(existsSync(file)).toBe(true);
  expect(statSync(PIDS_DIR).mode & 0o777).toBe(0o700);
  const second = await startTestHostd(s, [sessionsFeature]);
  await second.stop();
  expect(existsSync(file)).toBe(true);   // both hostds share this process: the first one still runs
  await first.stop();
  expect(existsSync(file)).toBe(false);
});

test("a start() failure, then stop() twice, never unregisters a pid this hostd did not register", async () => {
  const file = path.join(PIDS_DIR, String(process.pid));
  const keeper = await startTestHostd(s, [sessionsFeature]);
  const boom: FeatureFactory = () => ({ routes: [], channels: [], start() { throw new Error("start failed"); } });
  // createHostd calls its own stop() when a start() throws; startTestHostd rejects with the same error
  await expect(startTestHostd(s, [sessionsFeature, boom])).rejects.toThrow("start failed");
  expect(existsSync(file)).toBe(true);   // the failed hostd never registered, so the keeper's pid file stays
  const extra = await startTestHostd(s, [sessionsFeature]);
  await extra.stop();
  await extra.stop();                      // a second stop() must not unregister again
  expect(existsSync(file)).toBe(true);
  await keeper.stop();
  expect(existsSync(file)).toBe(false);
});

test("Ben's own git settings (colour always, no prefixes) cannot change the diff format", async () => {
  const dir = repo("hostile");
  writeFileSync(path.join(dir, "a.txt"), "two\n");
  const hostile = path.join(s.root, "hostile-gitconfig");
  writeFileSync(hostile, "[color]\n\tui = always\n[diff]\n\tnoprefix = true\n\tmnemonicPrefix = true\n");
  const before = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = hostile;
  try {
    const r = await safeGit(s.config(), dir, ["diff", ...DIFF_SAFE, "--patch"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("\u001b");
    expect(r.stdout).toContain("diff --git a/a.txt b/a.txt");
    expect(r.stdout).toContain("--- a/a.txt");
    expect(r.stdout).toContain("+++ b/a.txt");
  } finally {
    if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = before;
  }
});

test("sessions carry dirty: true, false, or null outside a repo", async () => {
  const cfg = s.config();
  const clean = repo("clean");
  const dirty = repo("dirty");
  writeFileSync(path.join(dirty, "new.txt"), "untracked\n");
  const plain = path.join(s.root, "plain");
  mkdirSync(plain, { recursive: true });
  const sock = s.newTmuxServer("c", "/bin/sh");
  s.tmux(sock, "kill-session", "-t", "=c");
  s.tmux(sock, "new-session", "-d", "-s", "c", "-c", clean, "/bin/sh");
  s.tmux(sock, "new-session", "-d", "-s", "d", "-c", dirty, "/bin/sh");
  s.tmux(sock, "new-session", "-d", "-s", "p", "-c", plain, "/bin/sh");
  const r = new Registry(cfg);
  let byName: Record<string, boolean | null> = {};
  await waitFor(async () => {
    byName = Object.fromEntries((await r.scan()).sessions.map((x) => [x.name, x.dirty]));
    return "c" in byName && "d" in byName && "p" in byName;
  }, 5000);
  expect([byName.c, byName.d, byName.p]).toEqual([false, true, null]);
  const cache = new DirtyCache(cfg, 60_000);
  expect(await cache.lookup(dirty)).toBe(true);
});
```

Note for the builder: `SessionInfo.name` is whatever P1's registry uses as the display name; if it is not the tmux session name, key the map by the `where.session` field instead. `newTmuxServer(name, command)` already creates session `name`; the test kills and recreates it only to set its folder with `-c`.

- [ ] **Step 3: Run and watch it fail**

```bash
/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/p2-foundation.test.ts
```

Expected: FAIL (`parseRanges`, `identify`, `safeGit`, `writeFake`, `dirty` do not exist yet).

- [ ] **Step 4: Implement.**

`server/src/config.ts`: add the five fields and six binaries above to `HostdConfig`, `Binaries` and `defaultConfig()` (`git: "/usr/bin/git"`, `voxtype: "/usr/bin/voxtype"`, `voxflow: path.join(home, ".local", "bin", "voxflow")`, `ss: "/usr/bin/ss"`, `nvidiaSmi: "/usr/bin/nvidia-smi"`, `omp: path.join(home, ".local", "share", "mise", "installs", "github-can1357-oh-my-pi", "latest", "omp")`, `ompExtensionsDir: path.join(home, ".omp", "agent", "extensions")`). Make sure `loadConfig` merges the new `bin` keys the same way as the P1 ones. `validateConfig` adds: `previewPort` is an integer 0-65535 and differs from `apiPort` when both are non-zero; `parseRanges(previewRanges)` has no error. Add:

```ts
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
```

`server/src/events/hub.ts`: add two listener sets; `add(ws)` adds the socket and then calls each `onOpen` listener inside `try/catch` (one listener's throw must not stop the others); `receive(ws, text)` ignores text longer than 4096 characters or anything that does not parse to a plain object with a string `type`, else calls each `onMessage` listener inside `try/catch`; `sendTo(ws, msg)` sends `JSON.stringify(msg)` with the same "accepted" test `broadcast` uses. `onOpen`/`onMessage` return their unsubscribe function.

`server/src/features/sessions.ts`: in the `/v1/events` channel, `message(ws, data)` becomes `d.hub.receive(ws, typeof data === "string" ? data : data.toString("utf8"))`. Nothing else changes.

`server/src/auth/auth.ts`: move lines 38-51 of `check` into `async identify(req: Request): Promise<Verdict>` unchanged, and end `check` with `return this.identify(req);`.

`server/src/diff/git.ts`:

```ts
// Runs git so that it can neither take locks nor run anything the repository configures (SPEC 4.9).
import type { HostdConfig } from "../config";
import { cleanEnv, run } from "../exec";
import type { RunResult } from "../exec";

export const GIT_ENV: Record<string, string> = { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
export const GIT_SAFE = ["-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "color.ui=false", "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false"];
export const DIFF_SAFE = ["--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"];
const TIMEOUT_MS = 10_000;

export function filterOverrides(configList: string): string[] {
  const names: string[] = [];
  for (const line of configList.split("\n")) {
    const key = line.split(/\s/, 1)[0] ?? "";
    const m = /^filter\.(.+)\.[^.]+$/.exec(key);
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names.flatMap((n) => ["-c", "filter." + n + ".process=", "-c", "filter." + n + ".clean=", "-c", "filter." + n + ".smudge=", "-c", "filter." + n + ".required=false"]);
}

async function git(cfg: HostdConfig, dir: string, extra: string[], args: string[]): Promise<RunResult> {
  return run([cfg.bin.git, "-C", dir, ...GIT_SAFE, ...extra, ...args], { env: cleanEnv(GIT_ENV), timeoutMs: TIMEOUT_MS });
}

export async function safeGit(cfg: HostdConfig, dir: string, args: string[]): Promise<RunResult> {
  const list = await git(cfg, dir, [], ["config", "--get-regexp", "^filter\\."]);
  // Exit 1 means "no filter configured"; anything else (not a repo) is reported by the real call below.
  return git(cfg, dir, filterOverrides(list.code === 0 ? list.stdout : ""), args);
}

export class DirtyCache {
  private readonly cache = new Map<string, { value: boolean | null; at: number }>();
  constructor(private readonly cfg: HostdConfig, private readonly maxAgeMs = 10_000) {}

  async lookup(dir: string): Promise<boolean | null> {
    const hit = this.cache.get(dir);
    if (hit && Date.now() - hit.at < this.maxAgeMs) return hit.value;
    const r = dir ? await safeGit(this.cfg, dir, ["status", "--porcelain=v2", "-z", "--untracked-files=normal"]) : null;
    const value = r === null || r.code !== 0 ? null : r.stdout.length > 0;
    this.cache.set(dir, { value, at: Date.now() });
    if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value as string);
    return value;
  }
}
```

`server/src/sessions/registry.ts`: add `dirty: boolean | null` to `SessionInfo`; the `Registry` owns one `DirtyCache(cfg)`; at the end of `scan()`, look up each distinct `cwd` once with `Promise.all` and set `dirty` on every session (herdr panes too, using their cwd).

`server/src/pids.ts` (new): every hostd marks itself so Task 8's preview scan can tell a hostd's own port from a dev server (gap 7).

```ts
// A hostd lists itself in PIDS_DIR while it runs; Task 8 reads the folder. Pids are refcounted because tests start several hostds in one process.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PIDS_DIR = path.join(process.env.XDG_RUNTIME_DIR ?? os.tmpdir(), "porthole-hostd-pids");
const running = new Map<string, number>();   // file -> hostds in this process using it

export function registerPid(dir = PIDS_DIR): void {
  const file = path.join(dir, String(process.pid));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, "", { mode: 0o600 });
  running.set(file, (running.get(file) ?? 0) + 1);
}

export function unregisterPid(dir = PIDS_DIR): void {
  const file = path.join(dir, String(process.pid));
  const left = (running.get(file) ?? 1) - 1;
  if (left > 0) { running.set(file, left); return; }
  running.delete(file);
  rmSync(file, { force: true });
}
```

`server/src/hostd.ts` (Task 1 owns it for this change): `createHostd` keeps a per-hostd flag `let registered = false`. It calls `registerPid()` once the listener is bound and the features have started (just before it returns) and sets `registered = true`; `stop()` runs `if (registered) { registered = false; unregisterPid(); }` after `server.stop(true)`. The flag matters because `createHostd` calls `hostd.stop()` when a feature's `start()` throws, before any `registerPid()`: an unconditional `unregisterPid()` there (and again on a second `stop()`) would lower another hostd's count in the same process, or delete the pid file under a running hostd. A crashed hostd leaves its file behind; Task 8 keeps only pids whose `/proc/<pid>` exists, so a stale file is harmless.

`server/test/helpers/scratch.ts`: make the fake-program writer public as `writeFake(name, body)` (returns the path; the private `writeExec` stays the implementation). In `config()`, set `previewPort: 0`, `previewRanges: "none"`, `usageCollection: true`, `voiceEnhance: false`, `ompExtensionsDir: path.join(this.root, "extensions")`, `bin.git: "/usr/bin/git"`, and point `voxtype`, `voxflow`, `ss`, `nvidiaSmi` at `fakeBin/<name>` and `omp` at `fakeBin/omp-cli` (not `omp`: that name is the session fake). The constructor writes each of those five as `#!/bin/sh\necho "<name>: not faked in this test" >&2\nexit 1\n`. Change the session fake `omp` body to `#!/bin/sh\nexec 3<"$1"\nif [ "$2" = "--echo" ]; then cat -v; fi\nwhile :; do sleep 1; done\n` and add `ompEchoCommand(t)` returning `ompCommand(t) + " --echo"` (the shell stays the process named `omp`, so `findOmp` still finds it, and its `cat -v` child shows every key the pane receives).

- [ ] **Step 5: Make the one allowed P1 test change, then run the new test and the whole P1 suite (the gaps must not change P1 behaviour)**

Gap 1 adds six keys to `bin`, so P1's `server/test/config.test.ts` lines 17 and 32, which compare `c.bin` with `toEqual` against exactly the four P1 keys, can no longer pass. That is the **one allowed change to a P1 test file**, and Task 1 owns `server/test/config.test.ts` for it alone. Change those two lines, nothing else in the file:

```ts
// server/test/config.test.ts line 17
-  expect(c.bin).toEqual({ tmux: "/usr/bin/tmux", herdr: "/usr/bin/herdr", pactl: "/usr/bin/pactl", tailscale: "/usr/bin/tailscale" });
+  expect(c.bin).toMatchObject({ tmux: "/usr/bin/tmux", herdr: "/usr/bin/herdr", pactl: "/usr/bin/pactl", tailscale: "/usr/bin/tailscale" });
// server/test/config.test.ts line 32
-  expect(c.bin).toEqual({ tmux: "/usr/bin/tmux", herdr: "/opt/herdr", pactl: "/x/pactl", tailscale: "/usr/bin/tailscale" });
+  expect(c.bin).toMatchObject({ tmux: "/usr/bin/tmux", herdr: "/opt/herdr", pactl: "/x/pactl", tailscale: "/usr/bin/tailscale" });
```

The P1 keys are still checked exactly (`toMatchObject` fails on a wrong or missing value); only the extra P2 keys are allowed. No other P1 test is changed.

```bash
/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/p2-foundation.test.ts
/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test
```

Expected: all PASS. If any other P1 test fails, fix the Task 1 change, never that P1 test.

- [ ] **Step 6: Commit and push** (files by name)

```bash
git add server/src/config.ts server/src/events/hub.ts server/src/features/sessions.ts server/src/auth/auth.ts server/src/sessions/registry.ts server/src/diff/git.ts server/src/hostd.ts server/src/pids.ts server/test/helpers/scratch.ts server/test/p2-foundation.test.ts server/test/config.test.ts
git commit -m "P2 foundation: config fields, hub hooks, identify(), safe git, dirty"
git push
```

---

### Task 2: `porthole-events.ts` omp extension

**Files (owned):**
- Create: `omp-extension/porthole-events.ts`, `server/test/porthole-events.test.ts`

**Event protocol (consumed by Task 3):** one JSON object per line, one short connection per event, to `$PORTHOLE_EVENTS_SOCKET` or else `$XDG_RUNTIME_DIR/porthole/events.sock`. Every event has `v: 1`, `pid` (omp's `process.pid`), `at` (ISO time) and `type`:

| `type` | extra fields | sent on |
|---|---|---|
| `session_start` | `cwd`, `sessionFile` (string or null), `tmux` (`$TMUX` or null), `pane` (`$TMUX_PANE` or null) | `session_start`, only when `ctx.hasUI` |
| `question_open` | `qid` (the `ask` call's `toolCallId`), `questions: [{id, question, options: string[], multi}]` | `tool_execution_start` with `toolName === "ask"` |
| `question_closed` | `qid`, `outcome: "answered" \| "cancelled"` (`cancelled` when `isError`; **GUESS** that omp reports a cancelled ask as an error) | `tool_execution_end` with `toolName === "ask"` |
| `working` | none | `agent_start` |
| `turn_finished` | none | `agent_end` |
| `session_end` | none | `session_shutdown` |

Text is cut to 2000 characters, options to 20 per question and 200 characters each. Nothing is sent before a `session_start` with a UI (subagent omps stay silent).

- [ ] **Step 1: Check F18 (context left).** Search the local omp extension docs once, read-only:

```bash
/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun -e "const t = await Bun.file(process.argv[1]).text().catch(() => ''); for (const w of ['contextUsage','getContextUsage','contextWindow','tokensLeft']) console.log(w, t.includes(w))" "$(dirname "$(readlink -f /home/cymatic/.local/share/mise/installs/github-can1357-oh-my-pi/latest/omp)")/docs/extensions.md"
```

If the path does not exist, read `omp://extensions.md` with the `read` tool instead. If a documented call returns the context used and the window size, add `contextLeft` (a number 0-1) to `working` and `turn_finished`, plus one assertion in test 1; report which call. If none is documented, report "context left: no extension source" and change nothing (Task 3 keeps `contextLeft: null`).

- [ ] **Step 2: Write the failing test** `server/test/porthole-events.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import portholeEvents from "../../omp-extension/porthole-events";
import { Scratch, waitFor } from "./helpers/scratch";

type Handler = (event: unknown, ctx: unknown) => unknown;
let s: Scratch;
let sock: string;
let server: net.Server;
const lines: Record<string, unknown>[] = [];

beforeAll(async () => {
  s = new Scratch();
  sock = path.join(s.root, "ev.sock");
  process.env.PORTHOLE_EVENTS_SOCKET = sock;
  server = net.createServer((c) => {
    let buf = "";
    c.on("data", (d) => { buf += d.toString("utf8"); });
    c.on("end", () => { for (const l of buf.split("\n").filter(Boolean)) lines.push(JSON.parse(l)); });
  });
  await new Promise<void>((r) => server.listen(sock, () => r()));
});
afterAll(() => { server.close(); s.cleanup(); });

function load(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  portholeEvents({ on: (name: string, fn: Handler) => { handlers.set(name, fn); } });
  return handlers;
}
const ui = { hasUI: true, cwd: "/work/repo", sessionManager: { getSessionFile: () => "/t/s.jsonl" } };

test("reports session start, question open/closed, working, turn finished, session end", async () => {
  lines.length = 0;
  const h = load();
  h.get("session_start")?.({}, ui);
  h.get("agent_start")?.({}, ui);
  h.get("tool_execution_start")?.({ toolCallId: "call-1", toolName: "ask", args: { questions: [{ id: "color", question: "Which color?", options: [{ label: "red" }, { label: "green" }, { label: "blue" }] }] } }, ui);
  h.get("tool_execution_start")?.({ toolCallId: "call-2", toolName: "bash", args: { command: "ls" } }, ui);
  h.get("tool_execution_end")?.({ toolCallId: "call-1", toolName: "ask", result: {}, isError: false }, ui);
  h.get("agent_end")?.({}, ui);
  h.get("session_shutdown")?.({}, ui);
  await waitFor(() => lines.length === 6, 3000);
  const byType = (t: string) => lines.find((l) => l.type === t) as Record<string, unknown>;
  expect(lines.map((l) => l.type).sort()).toEqual(["question_closed", "question_open", "session_end", "session_start", "turn_finished", "working"]);
  expect(byType("session_start")).toMatchObject({ v: 1, pid: process.pid, cwd: "/work/repo", sessionFile: "/t/s.jsonl" });
  expect(byType("question_open")).toMatchObject({ qid: "call-1", questions: [{ id: "color", question: "Which color?", options: ["red", "green", "blue"], multi: false }] });
  expect(byType("question_closed")).toMatchObject({ qid: "call-1", outcome: "answered" });
});

test("a session without a UI (a subagent) sends nothing", async () => {
  lines.length = 0;
  const h = load();
  h.get("session_start")?.({}, { hasUI: false, cwd: "/x" });
  h.get("agent_end")?.({}, { hasUI: false });
  await Bun.sleep(300);
  expect(lines).toEqual([]);
});

test("never blocks or throws when hostd is down or stuck", async () => {
  const h = load();
  process.env.PORTHOLE_EVENTS_SOCKET = path.join(s.root, "missing.sock");
  h.get("session_start")?.({}, ui); // makes the extension active, so every call below really tries to connect
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) h.get("agent_end")?.({}, ui);
  expect(performance.now() - t0).toBeLessThan(50);
  const stuckPath = path.join(s.root, "stuck.sock");
  const stuck = net.createServer(() => { /* accepts, never reads */ });
  await new Promise<void>((r) => stuck.listen(stuckPath, () => r()));
  process.env.PORTHOLE_EVENTS_SOCKET = stuckPath;
  const t1 = performance.now();
  h.get("agent_end")?.({}, ui);
  expect(performance.now() - t1).toBeLessThan(20);
  await Bun.sleep(700); // past the 500 ms socket timeout: the connection is gone, no error escaped
  stuck.close();
  process.env.PORTHOLE_EVENTS_SOCKET = sock;
});

test("source rules: no template literals, only node:net and node:path imports", () => {
  const src = readFileSync(path.join(import.meta.dir, "..", "..", "omp-extension", "porthole-events.ts"), "utf8");
  expect(src.includes(String.fromCharCode(96))).toBe(false);
  const imports = src.split("\n").filter((l) => l.startsWith("import "));
  expect(imports.every((l) => /from "node:(net|path)";$/.test(l))).toBe(true);
  expect(/setTimeout\(|setInterval\(/.test(src.replace(/\.setTimeout\(/g, ""))).toBe(false);
});
```

- [ ] **Step 3: Run and watch it fail**

```bash
/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/porthole-events.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 4: Implement** `omp-extension/porthole-events.ts` (string concatenation only; no backticks anywhere, comments included):

```ts
// porthole-events: tells Porthole's hostd what this omp session is doing (SPEC 4.6).
// One short Unix-socket connection per event. If hostd is down or slow the event is
// dropped: nothing here may block, slow or crash omp. No template literals (the omp
// extension dependency rewriter rejects them) and no raw timers.
import net from "node:net";
import path from "node:path";

const TIMEOUT_MS = 500;
const MAX_TEXT = 2000;
const MAX_OPTIONS = 20;
const MAX_OPTION = 200;

interface Ctx { hasUI?: boolean; cwd?: string; sessionManager?: { getSessionFile?: () => string | undefined } }
interface ExtensionApi { on(event: string, handler: (event: unknown, ctx: Ctx) => unknown): void }

function socketPath(): string {
  if (process.env.PORTHOLE_EVENTS_SOCKET) return process.env.PORTHOLE_EVENTS_SOCKET;
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  return path.join(process.env.XDG_RUNTIME_DIR || "/run/user/" + uid, "porthole", "events.sock");
}

function cut(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function post(body: Record<string, unknown>): void {
  try {
    const line = JSON.stringify(Object.assign({ v: 1, pid: process.pid, at: new Date().toISOString() }, body)) + "\n";
    const sock = net.createConnection(socketPath());
    sock.on("error", () => sock.destroy());
    sock.setTimeout(TIMEOUT_MS, () => sock.destroy());
    sock.unref();
    sock.end(line);
  } catch {
    // hostd unreachable: drop the event, omp carries on.
  }
}

function questions(args: unknown): Record<string, unknown>[] {
  const list = rec(args).questions;
  if (!Array.isArray(list)) return [];
  return list.slice(0, 10).map((q) => {
    const r = rec(q);
    const opts = Array.isArray(r.options) ? r.options : [];
    return {
      id: cut(r.id, 100),
      question: cut(r.question, MAX_TEXT),
      options: opts.slice(0, MAX_OPTIONS).map((o) => cut(rec(o).label, MAX_OPTION)),
      multi: r.multi === true,
    };
  });
}

export default function portholeEvents(pi: ExtensionApi) {
  let active = false;

  pi.on("session_start", (_event, ctx) => {
    try {
      if (!ctx || !ctx.hasUI) return;
      active = true;
      const file = ctx.sessionManager && ctx.sessionManager.getSessionFile ? ctx.sessionManager.getSessionFile() : undefined;
      post({ type: "session_start", cwd: ctx.cwd || process.cwd(), sessionFile: file || null, tmux: process.env.TMUX || null, pane: process.env.TMUX_PANE || null });
    } catch {
      // never let Porthole break omp
    }
  });

  pi.on("tool_execution_start", (event) => {
    try {
      const e = rec(event);
      if (!active || e.toolName !== "ask") return;
      post({ type: "question_open", qid: cut(e.toolCallId, 200), questions: questions(e.args) });
    } catch {
      // never let Porthole break omp
    }
  });

  pi.on("tool_execution_end", (event) => {
    try {
      const e = rec(event);
      if (!active || e.toolName !== "ask") return;
      post({ type: "question_closed", qid: cut(e.toolCallId, 200), outcome: e.isError === true ? "cancelled" : "answered" });
    } catch {
      // never let Porthole break omp
    }
  });

  pi.on("agent_start", () => {
    try { if (active) post({ type: "working" }); } catch { /* ignore */ }
  });
  pi.on("agent_end", () => {
    try { if (active) post({ type: "turn_finished" }); } catch { /* ignore */ }
  });
  pi.on("session_shutdown", () => {
    try { if (active) post({ type: "session_end" }); } catch { /* ignore */ }
    active = false;
  });
}
```

- [ ] **Step 5: Run the test**

```bash
/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/porthole-events.test.ts
```

Expected: PASS. Do **not** install the extension here: it is installed only in Task 12, after the one real omp run passes.

- [ ] **Step 6: Commit and push**

```bash
git add omp-extension/porthole-events.ts server/test/porthole-events.test.ts
git commit -m "porthole-events omp extension (not installed yet)"
git push
```

---

### Task 3: Events socket and inbox store

**Files (owned):**
- Create: `server/src/events/socket.ts`, `server/src/events/inbox.ts`, `server/test/events-socket.test.ts`, `server/test/inbox-store.test.ts`

**Interfaces produced (used by Task 5):**

```ts
// events/socket.ts
export type OmpEvent =
  | { type: "session_start"; pid: number; at: string; cwd: string; sessionFile: string | null; tmux: string | null; pane: string | null }
  | { type: "question_open"; pid: number; at: string; qid: string; questions: { id: string; question: string; options: string[]; multi: boolean }[] }
  | { type: "question_closed"; pid: number; at: string; qid: string; outcome: "answered" | "cancelled" }
  | { type: "working" | "turn_finished" | "session_end"; pid: number; at: string };
export function parseEvent(line: string): OmpEvent | null;
export class EventsSocket {
  constructor(file: string, onEvent: (e: OmpEvent) => void);
  start(): Promise<void>;   // folder 0700, socket 0600; refuses if another process already answers on it
  stop(): void;             // closes and removes the socket file
}

// events/inbox.ts
export type Column = "needs-you" | "working" | "done";
export interface Question { qid: string; pid: number; text: string; options: string[]; multi: boolean; count: number; open: boolean; outcome: "answered" | "cancelled" | "ended" | null }
export interface InboxItem {
  id: string; key: string; sessionId: string; machine: string; project: string; kind: "omp" | "herdr";
  column: Column; title: string; body: string; question: Question | null; contextLeft: number | null;
  createdAt: number; updatedAt: number; doneAt: number | null; archivedAt: number | null;
}
export interface Change { item: InboxItem; becameNeedsYou: boolean; turnFinished: boolean }
export const DONE_ARCHIVE_MS = 10 * 60_000, ANY_ARCHIVE_MS = 6 * 3_600_000, ARCHIVE_KEEP_MS = 7 * 86_400_000;
export class InboxStore {
  constructor(opts: { file: string; machine: string; now?: () => number });
  omp(e: OmpEvent, sessionId: string): Change | null;   // key "omp:<pid>"
  herdr(sessionId: string, herdrStatus: string, name: string, cwd: string): Change | null;   // key = sessionId
  list(): InboxItem[];        // sweeps first; live items, newest first
  archived(): InboxItem[];    // sweeps first; last 7 days
  get(id: string): InboxItem | undefined;
  archive(id: string): boolean;
  sweep(): boolean;           // true when something moved
}
```

Rules (SPEC 4.6), with two choices recorded: each session key has at most one live item, and new events update it; `question_open` → `needs-you` (first question's text and options; `count` = number of questions); `question_closed` → `working`, `open: false`; `working` keeps `needs-you` while a question is open, else `working`; `turn_finished` → `done` (`doneAt`); `session_end` → `done`, an open question becomes `open: false, outcome: "ended"`. A `done` item is archived 10 minutes after `doneAt`; **any** item is archived 6 hours after its last update (choice: "last update", so a question asked 5 hours into a long session is not archived an hour later); archived items stay 7 days. herdr: `blocked` → `needs-you`, `working` → `working`, `done` → `done`, `idle` → `done` only if the item was `working` (choice: an idle herdr pane that never worked makes no item). `title` is the project folder's last name (cut to 80), `body` the question text or "Turn finished" / "Working" (cut to 200). `contextLeft` stays `null` unless Task 2 step 1 found a source (then Task 2's field is copied). The store writes `{nextId, items}` to its file (0600, write-then-rename) after each change, and reads it back on construction.

- [ ] **Step 1: Write the failing tests** `server/test/inbox-store.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import path from "node:path";
import { ANY_ARCHIVE_MS, ARCHIVE_KEEP_MS, DONE_ARCHIVE_MS, InboxStore } from "../src/events/inbox";
import type { OmpEvent } from "../src/events/socket";
import { Scratch } from "./helpers/scratch";

let s: Scratch;
beforeAll(() => { s = new Scratch(); });
afterAll(() => s.cleanup());

let clock = 1_000_000;
let n = 0;
function store(): InboxStore {
  n += 1;
  return new InboxStore({ file: path.join(s.stateDir, "inbox-" + n + ".json"), machine: "bendesk-omarchy", now: () => clock });
}
const at = "2026-10-13T00:00:00Z";
const ask = (pid: number, qid: string): OmpEvent => ({ type: "question_open", pid, at, qid, questions: [{ id: "c", question: "Which color?", options: ["red", "green", "blue"], multi: false }] });

test("a question makes one needs-you item; closing it moves it to working", () => {
  const st = store();
  st.omp({ type: "session_start", pid: 10, at, cwd: "/work/porthole", sessionFile: null, tmux: null, pane: null }, "tmux:a:s:0.0");
  const c = st.omp(ask(10, "q1"), "tmux:a:s:0.0");
  expect(c?.becameNeedsYou).toBe(true);
  expect(c?.item).toMatchObject({ column: "needs-you", title: "porthole", project: "/work/porthole", sessionId: "tmux:a:s:0.0", question: { qid: "q1", options: ["red", "green", "blue"], open: true, count: 1 } });
  expect(st.omp(ask(10, "q2"), "tmux:a:s:0.0")?.item.id).toBe(c?.item.id);
  st.omp({ type: "question_closed", pid: 10, at, qid: "q2", outcome: "answered" }, "tmux:a:s:0.0");
  expect(st.list()).toHaveLength(1);
  expect(st.list()[0]).toMatchObject({ column: "working", question: { open: false, outcome: "answered" } });
});

test("P2.2: a done item is archived after 10 min, any item after 6 h, archive kept 7 days", () => {
  const st = store();
  st.omp({ type: "turn_finished", pid: 20, at }, "omp:20");
  st.omp({ type: "working", pid: 21, at }, "omp:21");
  st.omp(ask(22, "q"), "omp:22");
  clock += DONE_ARCHIVE_MS - 1;
  expect(st.list().map((i) => i.key).sort()).toEqual(["omp:20", "omp:21", "omp:22"]);
  clock += 1;
  expect(st.list().map((i) => i.key).sort()).toEqual(["omp:21", "omp:22"]);
  expect(st.archived().map((i) => i.key)).toEqual(["omp:20"]);
  clock += ANY_ARCHIVE_MS - DONE_ARCHIVE_MS;
  expect(st.list()).toEqual([]);
  expect(st.archived().map((i) => i.key).sort()).toEqual(["omp:20", "omp:21", "omp:22"]);
  clock += ARCHIVE_KEEP_MS;
  expect(st.archived()).toEqual([]);
});

test("manual archive; the next event starts a new item; session end closes an open question", () => {
  const st = store();
  const first = st.omp({ type: "working", pid: 30, at }, "omp:30")?.item.id ?? "";
  expect(st.archive(first)).toBe(true);
  expect(st.list()).toEqual([]);
  const second = st.omp(ask(30, "q"), "omp:30")?.item;
  expect(second?.id).not.toBe(first);
  st.omp({ type: "session_end", pid: 30, at }, "omp:30");
  expect(st.get(second?.id ?? "")).toMatchObject({ column: "done", question: { open: false, outcome: "ended" } });
});

test("items survive a restart", () => {
  const file = path.join(s.stateDir, "inbox-restart.json");
  const a = new InboxStore({ file, machine: "m", now: () => clock });
  const id = a.omp(ask(40, "q"), "omp:40")?.item.id;
  const b = new InboxStore({ file, machine: "m", now: () => clock });
  expect(b.get(id ?? "")?.question?.open).toBe(true);
  expect(b.omp({ type: "working", pid: 41, at }, "omp:41")?.item.id).not.toBe(id);
});

test("herdr states: blocked needs you, working, done", () => {
  const st = store();
  expect(st.herdr("herdr:w:t:p", "idle", "agent", "/w")).toBeNull();
  expect(st.herdr("herdr:w:t:p", "blocked", "agent", "/w")?.becameNeedsYou).toBe(true);
  expect(st.herdr("herdr:w:t:p", "working", "agent", "/w")?.item.column).toBe("working");
  expect(st.herdr("herdr:w:t:p", "done", "agent", "/w")?.turnFinished).toBe(true);
  expect(st.list()[0]).toMatchObject({ kind: "herdr", column: "done", question: null });
});
```

`server/test/events-socket.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { EventsSocket, parseEvent } from "../src/events/socket";
import type { OmpEvent } from "../src/events/socket";
import { Scratch, waitFor } from "./helpers/scratch";

let s: Scratch;
beforeAll(() => { s = new Scratch(); });
afterAll(() => s.cleanup());

function sendRaw(file: string, text: string): Promise<void> {
  return new Promise((resolve) => {
    const c = net.createConnection(file);
    c.on("error", () => resolve());
    c.on("close", () => resolve());
    c.end(text);
  });
}

test("parseEvent accepts the extension's events and rejects junk", () => {
  expect(parseEvent('{"v":1,"pid":5,"at":"x","type":"working"}')).toEqual({ type: "working", pid: 5, at: "x" });
  expect(parseEvent('{"v":1,"pid":5,"at":"x","type":"question_open","qid":"q","questions":[{"id":"a","question":"Q?","options":["x","y"],"multi":false}]}')?.type).toBe("question_open");
  for (const bad of ["", "nope", "[]", '{"v":2,"pid":5,"type":"working"}', '{"v":1,"pid":-1,"type":"working"}', '{"v":1,"pid":5,"type":"rm -rf"}', '{"v":1,"pid":5,"type":"question_open","qid":"q","questions":"x"}']) {
    expect(parseEvent(bad)).toBeNull();
  }
});

test("owner-only socket, events delivered, oversized connection dropped, stale file replaced, removed on stop", async () => {
  const dir = path.join(s.runtimeDir, "ev");
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const file = path.join(dir, "events.sock");
  writeFileSync(file, "stale");
  const got: OmpEvent[] = [];
  const sock = new EventsSocket(file, (e) => got.push(e));
  await sock.start();
  try {
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await sendRaw(file, '{"v":1,"pid":7,"at":"x","type":"working"}\n{"v":1,"pid":7,"at":"x","type":"turn_finished"}\n');
    await sendRaw(file, "garbage\n");
    await sendRaw(file, "x".repeat(70_000));
    await waitFor(() => got.length === 2, 3000);
    expect(got.map((e) => e.type)).toEqual(["working", "turn_finished"]);
    const again = new EventsSocket(file, () => undefined);
    expect(again.start()).rejects.toThrow("another hostd");
  } finally {
    sock.stop();
  }
  expect(existsSync(file)).toBe(false);
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/inbox-store.test.ts server/test/events-socket.test.ts
```

Expected: FAIL (modules not found).

- [ ] **Step 3: Implement `server/src/events/socket.ts`.** `parseEvent`: `JSON.parse` inside `try`; require `v === 1`, an integer `pid > 0`, `type` in a `Record<string, true>` table of the six types, and per type the fields in the protocol table of Task 2 (strings cut to the same limits, `questions` an array of objects whose `options` is a string array); missing optional strings become `null`; anything else returns `null`. `EventsSocket.start()`: `mkdirSync(dir, { recursive: true, mode: 0o700 })` then `chmodSync(dir, 0o700)`; if the file exists, try `net.createConnection(file)` for at most 300 ms: if it connects, throw `new Error("another hostd already listens on " + file)`, else `unlinkSync(file)`; then

```ts
this.listener = Bun.listen<{ buf: string }>({
  unix: this.file,
  socket: {
    open(sock) { sock.data = { buf: "" }; },
    data: (sock, chunk) => {
      sock.data.buf += chunk.toString("utf8");
      if (sock.data.buf.length > MAX_CONNECTION_BYTES) { sock.data.buf = ""; sock.end(); return; }
      let i = sock.data.buf.indexOf("\n");
      while (i >= 0) {
        const e = parseEvent(sock.data.buf.slice(0, i));
        sock.data.buf = sock.data.buf.slice(i + 1);
        if (e) { try { this.onEvent(e); } catch { /* one bad handler call must not kill the listener */ } }
        i = sock.data.buf.indexOf("\n");
      }
    },
  },
});
chmodSync(this.file, 0o600);
```

with `MAX_CONNECTION_BYTES = 64 * 1024`. `stop()`: `this.listener?.stop(true)` and `rmSync(this.file, { force: true })`.

- [ ] **Step 4: Implement `server/src/events/inbox.ts`** per the interface and rules above. Implementation notes: keep `items: InboxItem[]` (live and archived, `archivedAt` set when archived); `liveFor(key)` finds the one item with that key and `archivedAt === null`; `sweep()` sets `archivedAt = now` for `done` items with `now - doneAt >= DONE_ARCHIVE_MS` and for any item with `now - updatedAt >= ANY_ARCHIVE_MS`, and drops archived items with `now - archivedAt >= ARCHIVE_KEEP_MS`; `list()` and `archived()` call `sweep()` (and save when it returns true). `becameNeedsYou` is true only when the column changes into `needs-you` (or a new question id opens on an item already in it); `turnFinished` only on `turn_finished` (omp) or a change into `done` (herdr). Ids are `"i" + nextId` (counter persisted). Save with `writeFileSync(tmp, json, { mode: 0o600 })` + `renameSync(tmp, file)`; folder created 0700.

- [ ] **Step 5: Run the tests**

```bash
/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/inbox-store.test.ts server/test/events-socket.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit and push**

```bash
git add server/src/events/socket.ts server/src/events/inbox.ts server/test/events-socket.test.ts server/test/inbox-store.test.ts
git commit -m "events socket and inbox store with lifetimes"
git push
```

---

### Task 4: Notification queue (ids, per-device replay, 60 per minute)

**Files (owned):**
- Create: `server/src/events/notify.ts`, `server/test/notify.test.ts`

**Interface produced (used by Task 5):**

```ts
import type { InboxItem } from "./inbox";   // type-only: Task 3 lands in the same group, the type is fixed above
export interface NotifyMsg { type: "notify"; id: number; itemId: string; title: string; body: string; options: { index: number; label: string }[]; at: string }
export const MAX_PER_DEVICE = 100, KEEP_MS = 24 * 3_600_000, PER_MINUTE = 60;
export function buildNotify(item: InboxItem, id: number, at: string): NotifyMsg;
export class NotifyQueue {
  constructor(opts: { file: string; now?: () => number; send: (msg: NotifyMsg) => void });
  register(device: string): void;                          // a device that connected with ?device=
  notify(item: InboxItem): NotifyMsg | null;               // null = held back by the 60/min limit
  tick(): NotifyMsg[];                                     // releases held messages the limit now allows
  pendingFor(device: string, since: number): NotifyMsg[];  // unacked, id > since, oldest first
  ack(device: string, id: number): void;
}
```

Rules (SPEC 4.7): title is the item title cut to 80 characters, body the item body cut to 200; `options` holds the first two options only when the item has one open single-select question with 2 or 3 options, else `[]`. Ids are assigned when a message is released (so ids stay in send order), start at 1 and never repeat (persisted). Every released message is queued for every registered device (at most 100 per device, oldest dropped; entries older than 24 h dropped) and passed to `send`. At most 60 messages are released in any 60-second window; the rest wait in order for `tick()`. Unacked queues and `nextId` are saved to the file (0600) after each change.

Because Task 3 and Task 4 run in parallel, this task's test builds `InboxItem` objects by hand from the interface in Task 3; it imports only the type.

- [ ] **Step 1: Write the failing test** `server/test/notify.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import path from "node:path";
import type { InboxItem } from "../src/events/inbox";
import { KEEP_MS, MAX_PER_DEVICE, NotifyQueue, buildNotify } from "../src/events/notify";
import type { NotifyMsg } from "../src/events/notify";
import { Scratch } from "./helpers/scratch";

let s: Scratch;
beforeAll(() => { s = new Scratch(); });
afterAll(() => s.cleanup());

let clock = 5_000_000;
function item(id: string, options: string[], multi = false): InboxItem {
  return {
    id, key: "omp:1", sessionId: "omp:1", machine: "m", project: "/w/p", kind: "omp", column: "needs-you",
    title: "t".repeat(90), body: "b".repeat(250), contextLeft: null, createdAt: clock, updatedAt: clock, doneAt: null, archivedAt: null,
    question: { qid: "q", pid: 1, text: "Q?", options, multi, count: 1, open: true, outcome: null },
  };
}
function queue(name: string, sent: NotifyMsg[]): NotifyQueue {
  return new NotifyQueue({ file: path.join(s.stateDir, name + ".json"), now: () => clock, send: (m) => sent.push(m) });
}

test("summary limits and answer buttons only for 2-3 option single questions", () => {
  const m = buildNotify(item("i1", ["red", "green", "blue"]), 7, "now");
  expect([m.title.length, m.body.length, m.itemId, m.id]).toEqual([80, 200, "i1", 7]);
  expect(m.options).toEqual([{ index: 0, label: "red" }, { index: 1, label: "green" }]);
  expect(buildNotify(item("i2", ["a", "b", "c", "d"]), 1, "now").options).toEqual([]);
  expect(buildNotify(item("i3", ["a", "b"], true), 1, "now").options).toEqual([]);
});

test("unacked messages replay per device; acked ones never come back", () => {
  const sent: NotifyMsg[] = [];
  const q = queue("replay", sent);
  q.register("bencell");
  const a = q.notify(item("i1", ["x", "y"]));
  const b = q.notify(item("i2", ["x", "y"]));
  expect(sent.map((m) => m.id)).toEqual([a?.id, b?.id]);
  expect(q.pendingFor("bencell", 0).map((m) => m.itemId)).toEqual(["i1", "i2"]);
  q.ack("bencell", a?.id ?? 0);
  expect(q.pendingFor("bencell", 0).map((m) => m.itemId)).toEqual(["i2"]);
  expect(q.pendingFor("bencell", b?.id ?? 0)).toEqual([]);
  const again = queue("replay", []);
  expect(again.pendingFor("bencell", 0).map((m) => m.itemId)).toEqual(["i2"]);
  expect(again.notify(item("i3", []))?.id).toBe((b?.id ?? 0) + 1);
});

test("at most 100 per device, kept 24 h", () => {
  const q = queue("cap", []);
  q.register("bencell");
  for (let i = 0; i < MAX_PER_DEVICE + 5; i++) { q.notify(item("i" + i, [])); clock += 1_001; }
  const left = q.pendingFor("bencell", 0);
  expect(left).toHaveLength(MAX_PER_DEVICE);
  expect(left[0].itemId).toBe("i5");
  clock += KEEP_MS;
  expect(q.pendingFor("bencell", 0)).toEqual([]);
});

test("P2.3: the 61st notification in a minute is held back, then released", () => {
  const sent: NotifyMsg[] = [];
  const q = queue("rate", sent);
  for (let i = 0; i < 60; i++) expect(q.notify(item("i" + i, []))).not.toBeNull();
  expect(q.notify(item("late", []))).toBeNull();
  expect(sent).toHaveLength(60);
  clock += 30_000;
  expect(q.tick()).toEqual([]);
  clock += 30_000;
  const released = q.tick();
  expect(released.map((m) => m.itemId)).toEqual(["late"]);
  expect(released[0].id).toBe(61);
  expect(sent).toHaveLength(61);
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/notify.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement `server/src/events/notify.ts`** per the rules above. Keep `sentAt: number[]` (release times inside the last 60 s), `held: InboxItem[]`, `devices: Record<string, NotifyMsg[]>` and `nextId`; `release(item)` assigns the id, builds the message with `buildNotify`, appends it to every device queue (trim to the newest 100), saves, calls `send`; `notify(item)` releases at once when `sentAt` (after dropping entries older than 60 s) has fewer than 60 entries and nothing is already held, else appends to `held` and returns `null`; `tick()` releases held items while the window allows. `pendingFor` drops entries older than `KEEP_MS` (by the message's release time, kept as a number next to it in the saved file) before filtering `id > since`.

- [ ] **Step 4: Run the test**

```bash
/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/notify.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit and push**

```bash
git add server/src/events/notify.ts server/test/notify.test.ts
git commit -m "notification queue: ids, per-device replay, 60 per minute"
git push
```

---

### Task 5: Answers and `inboxFeature` (socket + store + notifications + routes)

**Depends on:** Tasks 1, 3, 4 merged into this branch.

**Files (owned):**
- Create: `server/src/events/answer.ts`, `server/src/features/inbox.ts`, `server/test/inbox.test.ts`

**Interfaces produced (used by Task 12):**

```ts
// events/answer.ts
import type { KeyStep } from "../deliver/keys";
export const READ_ONLY = "Answer this in the terminal", AT_DESK = "Answer at the desk", MAX_CHUNK = 32;
export type Answer = { optionIndexes: number[] } | { text: string };
export function parseAnswer(body: Record<string, unknown>): Answer | { error: string };
export function answerSteps(optionCount: number, a: Answer): KeyStep[];
export function chunks(steps: KeyStep[], size?: number): KeyStep[][];
export function answerRefusal(item: InboxItem, info: SessionInfo | null, a: Answer, answered: ReadonlySet<string>): string | null;

// features/inbox.ts
export const inboxFeature: FeatureFactory;
```

**Answer rules (SPEC 4.3, 4.6):**
- `parseAnswer`: exactly one of `optionIndexes` (an array of exactly one integer ≥ 0; more than one is refused in P2, see Needs Ben 3) or `text` (a non-empty string of at most 2000 characters with no control characters, so it cannot carry its own Enter or Escape) else `{error}` (400).
- `answerSteps(n, a)`: the cursor is moved to the top first because it may start on the `recommended` row (F16): `Up` × (n + 2), then for an option `Down` × index, `Enter`; for typed text `Down` × n (the "Other" row, **GUESS** F16, confirmed in Task 12), `Enter`, `{text}`, `Enter`.
- `chunks` splits into lists of at most 32 steps (P1's `parseSteps` limit); each chunk goes through `Deliverer.keys`, so P1's live-voice refusal is re-checked before every chunk.
- `answerRefusal` returns the reason to refuse, or `null`, in this order: no open question, `question.count !== 1`, `question.multi`, the question's qid already in `answered`, `info === null`, `info.omp?.pid !== question.pid` → `READ_ONLY`; option index ≥ options length → `"no such option"`; typed text while `liveVoiceBlocks(info)` → `AT_DESK`. Option answers on live-voice panes are left to `Deliverer.keys`, which refuses with P1's own reason.
- HTTP: refusals are 409 `{status:"refused", reason}`, 404 for an unknown item, 400 for a bad body; a `Deliverer.keys` result maps like P1's `send.ts` (`sent` 200, `refused` 409, `failed` 502). A qid goes into `answered` before the first chunk is sent, so a second tap while keys are still going is refused; it comes out again **only** when the result is `refused` (a refusal always happens before any key is sent), and stays in on `failed` (some keys may already be in the dialog, so the question is read-only from then on).

**Feature wiring (`inboxFeature(d)`):**
- `store = new InboxStore({ file: stateDir/inbox.json, machine: d.config.machineName })`; `queue = new NotifyQueue({ file: stateDir/notify.json, send: (m) => d.hub.broadcast(m) })`; `deliverer = new Deliverer(d.config, d.registry, d.sentLog)`; `socket = new EventsSocket(path.join(d.config.runtimeDir, "events.sock"), onEvent)`.
- `onEvent(e)`: `info = (await d.registry.current(0)).sessions.find((x) => x.omp?.pid === e.pid)`; `sessionId = info?.id ?? "omp:" + e.pid`; `change = store.omp(e, sessionId)`; then `apply(change)`. Events are handled one at a time through a promise chain (`chain = chain.then(...)`), so a slow registry scan never reorders them.
- `apply(change)`: if `change.becameNeedsYou || change.turnFinished`, `queue.notify(change.item)`; then `d.hub.broadcast({ type: "inbox", items: store.list() })`.
- `start()`: `await socket.start()`; `d.registry.startWatching()`; subscribe `d.registry.onChange((tree) => …)` calling `store.herdr(s.id, s.herdrStatus, s.name, s.cwd)` for every `kind === "herdr"` session with a non-null `herdrStatus` and `apply` on each change; `d.hub.onOpen((ws) => …)`: `device = ws.data.query.get("device") || ws.data.ctx.device`, `queue.register(device)`, then `d.hub.sendTo(ws, m)` for each `queue.pendingFor(device, Number(ws.data.query.get("since") ?? "0") || 0)`; `d.hub.onMessage((ws, m) => …)`: on `m.type === "ack"` with an integer `m.id`, `queue.ack(device, m.id)`; one 5-second interval running `queue.tick()` and, when `store.sweep()` returns true, the `inbox` broadcast.
- `stop()`: clear the interval, unsubscribe the three listeners, `d.registry.stopWatching()`, `socket.stop()`.
- Routes: `GET /v1/inbox` → `{items: store.list()}`; `GET /v1/inbox/archive` → `{items: store.archived()}`; `POST /v1/inbox/:itemId/answer`; `POST /v1/inbox/:itemId/archive` → 200 `{archived: true}` or 404. Bodies are read as `asRecord(await req.json().catch(() => null))` (`server/src/json.ts`), the same check P1's private `readBody` in `send.ts` does.
- **Stop** is not an inbox route: the app sends `Esc` through P1's `POST /v1/sessions/:id/keys` (SPEC 4.3), which already refuses live-voice panes. The test below checks that, for acceptance item 10.

- [ ] **Step 1: Write the failing test** `server/test/inbox.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { inboxDir } from "../src/deliver/inbox";
import { answerSteps, chunks, parseAnswer } from "../src/events/answer";
import { inboxFeature } from "../src/features/inbox";
import { sendFeature } from "../src/features/send";
import { sessionsFeature } from "../src/features/sessions";
import { get, openWs, pane, post, startTestHostd } from "./helpers/client";
import type { TestHostd } from "./helpers/client";
import { Scratch, waitFor } from "./helpers/scratch";
import type { HerdrAgentFixture } from "./helpers/scratch";

let s: Scratch;
let h: TestHostd;
let FAIL_SEND = "";
const HERDR_FIXTURE: HerdrAgentFixture = { terminal_id: "t1", agent_status: "idle", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", focused: false, revision: 1, name: "rev" };
beforeAll(async () => {
  s = new Scratch();
  // a tmux wrapper that fails every send-keys while FAIL_SEND exists and runs the real tmux otherwise (listing and capture are unaffected)
  FAIL_SEND = path.join(s.root, "fail-send-keys");
  const flaky = s.writeFake("tmux-flaky", "#!/bin/sh\nif [ -e '" + FAIL_SEND + "' ]; then for a in \"$@\"; do [ \"$a\" = send-keys ] && exit 1; done; fi\nexec /usr/bin/tmux \"$@\"\n");
  h = await startTestHostd(s, [sessionsFeature, sendFeature, inboxFeature], { bin: { tmux: flaky } });
});
afterAll(async () => { await h.stop(); s.cleanup(); });

function emit(e: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(path.join(h.config.runtimeDir, "events.sock"), () => {
      c.end(JSON.stringify({ v: 1, at: new Date().toISOString(), ...e }) + "\n", () => resolve());
    });
    c.on("error", reject);
  });
}
type Item = { id: string; sessionId: string; column: string; question: { qid: string; options: string[]; open: boolean } | null };
async function items(): Promise<Item[]> { return ((await (await get(h, "/v1/inbox")).json()) as { items: Item[] }).items; }
async function itemFor(qid: string): Promise<Item> {
  let found: Item | undefined;
  await waitFor(async () => { found = (await items()).find((i) => i.question?.qid === qid); return found !== undefined; });
  return found as Item;
}
/** A scratch pane whose fake omp echoes every key it receives (Task 1), plus that omp's pid as the registry sees it. */
async function echoPane(name: string): Promise<{ socket: string; id: string; pid: number }> {
  const p = await pane(s, name, s.ompEchoCommand(s.transcript("chat-basic.jsonl")));
  let pid = 0;
  await waitFor(async () => {
    const tree = (await (await get(h, "/v1/sessions")).json()) as { sessions: { id: string; omp: { pid: number } | null }[] };
    pid = tree.sessions.find((x) => x.id === p.id)?.omp?.pid ?? 0;
    return pid > 0;
  });
  return { socket: p.socket, id: p.id, pid };
}
function screen(p: { socket: string }, name: string): string {
  return s.tmux(p.socket, "capture-pane", "-p", "-J", "-t", "=" + name + ":0.0");
}
const UP = "^[[A", DOWN = "^[[B";
const ask = (pid: number, qid: string, extra: Record<string, unknown> = {}) =>
  emit({ pid, type: "question_open", qid, questions: [{ id: "c", question: "Which color?", options: ["red", "green", "blue"], multi: false, ...extra }] });

test("key steps: to the top, down to the row, Enter; typed text goes through the Other row", () => {
  expect(answerSteps(3, { optionIndexes: [1] })).toEqual([...Array(5).fill({ key: "Up" }), { key: "Down" }, { key: "Enter" }]);
  expect(answerSteps(2, { text: "teal" })).toEqual([...Array(4).fill({ key: "Up" }), { key: "Down" }, { key: "Down" }, { key: "Enter" }, { text: "teal" }, { key: "Enter" }]);
  expect(chunks(answerSteps(20, { optionIndexes: [19] })).map((c) => c.length)).toEqual([32, 10]);
  expect(parseAnswer({ optionIndexes: [0, 1] })).toHaveProperty("error");
  expect(parseAnswer({})).toHaveProperty("error");
});

test("P2.1/P2.3: an open question becomes a needs-you item with exactly one notify; option 2 presses the right keys; closed is read-only", async () => {
  const p = await echoPane("ask");
  const ws = await openWs(h, "/v1/events?device=bencell");
  await emit({ pid: p.pid, type: "session_start", cwd: s.root, sessionFile: null, tmux: null, pane: null });
  await ask(p.pid, "q1");
  const item = await itemFor("q1");
  expect(item).toMatchObject({ sessionId: p.id, column: "needs-you", question: { options: ["red", "green", "blue"], open: true } });
  const n = await ws.next("notify", 3000);
  expect(n).toMatchObject({ itemId: item.id, options: [{ index: 0, label: "red" }, { index: 1, label: "green" }] });
  await Bun.sleep(300);
  expect(ws.seen.filter((m) => m.type === "notify")).toHaveLength(1);

  const r = await post(h, "/v1/inbox/" + item.id + "/answer", { optionIndexes: [1] });
  expect(r.status).toBe(200);
  await waitFor(() => screen(p, "ask").includes(UP.repeat(5) + DOWN), 3000);
  const again = await post(h, "/v1/inbox/" + item.id + "/answer", { optionIndexes: [0] });
  expect([again.status, (await again.json()).reason]).toEqual([409, "Answer this in the terminal"]);

  await emit({ pid: p.pid, type: "question_closed", qid: "q1", outcome: "answered" });
  await waitFor(async () => (await items()).find((i) => i.id === item.id)?.question?.open === false);
  expect((await post(h, "/v1/inbox/" + item.id + "/answer", { optionIndexes: [0] })).status).toBe(409);
  ws.close();
});

test("typed answer goes through the Other row; multi-select, unknown omp and bad index are refused", async () => {
  const p = await echoPane("typed");
  await ask(p.pid, "q2");
  const item = await itemFor("q2");
  expect((await post(h, "/v1/inbox/" + item.id + "/answer", { optionIndexes: [7] })).status).toBe(409);
  expect((await post(h, "/v1/inbox/" + item.id + "/answer", { text: "teal" })).status).toBe(200);
  await waitFor(() => screen(p, "typed").includes(UP.repeat(5) + DOWN.repeat(3)) && screen(p, "typed").includes("teal"), 3000);

  await ask(p.pid, "q3", { multi: true });
  const multi = await itemFor("q3");
  expect((await (await post(h, "/v1/inbox/" + multi.id + "/answer", { optionIndexes: [0] })).json()).reason).toBe("Answer this in the terminal");

  await ask(4_000_000, "q4");
  const stranger = await itemFor("q4");
  expect(stranger.sessionId).toBe("omp:4000000");
  expect((await (await post(h, "/v1/inbox/" + stranger.id + "/answer", { optionIndexes: [0] })).json()).reason).toBe("Answer this in the terminal");
});

test("P2.10: live voice refuses option answers, typed answers and Stop with a plain reason", async () => {
  const p = await echoPane("voice");
  await ask(p.pid, "q5");
  const item = await itemFor("q5");
  s.setLiveVoicePids([p.pid]);
  try {
    const opt = await post(h, "/v1/inbox/" + item.id + "/answer", { optionIndexes: [0] });
    expect([opt.status, (await opt.json()).reason]).toEqual([409, "live voice is on; keys would mix with it"]);
    const typed = await post(h, "/v1/inbox/" + item.id + "/answer", { text: "teal" });
    expect([typed.status, (await typed.json()).reason]).toEqual([409, "Answer at the desk"]);
    const stop = await post(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/keys", { keys: ["Esc"] });
    expect([stop.status, (await stop.json()).reason]).toEqual([409, "live voice is on; keys would mix with it"]);
    expect(screen(p, "voice")).not.toContain(UP);
    // The refused option answer must not have used the question up: with voice off it goes through (200).
    s.setLiveVoicePids([]);
    const after = await post(h, "/v1/inbox/" + item.id + "/answer", { optionIndexes: [0] });
    expect(after.status).toBe(200);
  } finally {
    s.setLiveVoicePids([]);
  }
});

test("a failed key send leaves the question read-only (keys may already be in the dialog)", async () => {
  const p = await echoPane("flaky");
  await ask(p.pid, "q7");
  const item = await itemFor("q7");
  writeFileSync(FAIL_SEND, "");
  try {
    const r = await post(h, "/v1/inbox/" + item.id + "/answer", { optionIndexes: [0] });
    expect([r.status, (await r.json()).status]).toEqual([502, "failed"]);
  } finally {
    rmSync(FAIL_SEND, { force: true });
  }
  // tmux works again, but the dialog state is unknown, so the retry is refused and no key is sent
  const again = await post(h, "/v1/inbox/" + item.id + "/answer", { optionIndexes: [0] });
  expect([again.status, (await again.json()).reason]).toEqual([409, "Answer this in the terminal"]);
  await Bun.sleep(200);
  expect(screen(p, "flaky")).not.toContain(UP);
});

test("P2.10: omp with a live inbox is reachable under live voice: the message goes through the inbox, not the keys", async () => {
  const p = await echoPane("voiceinbox");
  mkdirSync(inboxDir(h.config.inboxRoot, p.pid), { recursive: true });
  await waitFor(async () => {
    const tree = (await (await get(h, "/v1/sessions")).json()) as { sessions: { id: string; omp: { inbox: boolean } | null }[] };
    return tree.sessions.find((x) => x.id === p.id)?.omp?.inbox === true;
  }, 5000);
  // Stand in for omp's live-inbox extension: take (delete) every *.msg the moment it appears.
  const dir = inboxDir(h.config.inboxRoot, p.pid);
  const seen: string[] = [];
  const watcher = setInterval(() => {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".msg")) continue;
      seen.push(f);
      rmSync(path.join(dir, f), { force: true });
    }
  }, 20);
  s.setLiveVoicePids([p.pid]);
  try {
    const r = await post(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/send", { clientMsgId: "p2-10-inbox", text: "typed while voice is live" });
    const body = (await r.json()) as { status: string; route: string };
    expect([r.status, body.status, body.route]).toEqual([200, "delivered", "inbox"]);
    await Bun.sleep(100);
    expect(seen).toEqual(["p2-10-inbox.msg"]);
    expect(screen(p, "voiceinbox")).not.toContain("typed while voice is live");
  } finally {
    clearInterval(watcher);
    s.setLiveVoicePids([]);
  }
});

test("P2.3: unacked notify is replayed on reconnect; acked is not", async () => {
  const p = await echoPane("replay");
  const first = await openWs(h, "/v1/events?device=watch");
  await ask(p.pid, "q6");
  const n = await first.next("notify", 3000);
  first.close();
  const second = await openWs(h, "/v1/events?device=watch");
  const replayed = await second.next("notify", 3000);
  expect(replayed.id).toBe(n.id);
  second.send(JSON.stringify({ type: "ack", id: n.id }));
  await Bun.sleep(200);
  second.close();
  const third = await openWs(h, "/v1/events?device=watch");
  await Bun.sleep(500);
  expect(third.seen.filter((m) => m.type === "notify" && m.id === n.id)).toEqual([]);
  third.close();
});

test("a blocked herdr agent becomes a needs-you item", async () => {
  // Copy the fixture shape P1's registry test passes to setHerdrAgents; only the status matters here.
  s.setHerdrAgents([{ ...HERDR_FIXTURE, agent_status: "blocked" }]);
  await waitFor(async () => (await items()).some((i) => i.sessionId.startsWith("herdr:") && i.column === "needs-you"), 5000);
  s.setHerdrAgents([]);
});
```

`HERDR_FIXTURE`: define it at the top of the file as `const HERDR_FIXTURE: HerdrAgentFixture = { terminal_id: "t1", agent_status: "idle", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", focused: false, revision: 1, name: "rev" };` (`HerdrAgentFixture` is the exported type in `test/helpers/scratch.ts`; the status field is `agent_status`, as in P1's `registry.test.ts`). If `next()` in `openWs` returns messages typed as `WsMessage` without `id`, read `id` as `(n as { id: number }).id`.

- [ ] **Step 2: Run and watch it fail**

```bash
/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/inbox.test.ts
```

Expected: FAIL (modules not found).

- [ ] **Step 3: Implement `server/src/events/answer.ts` and `server/src/features/inbox.ts`** per the rules and wiring above. `answerSteps`:

```ts
export function answerSteps(optionCount: number, a: Answer): KeyStep[] {
  const steps: KeyStep[] = [];
  for (let i = 0; i < optionCount + 2; i++) steps.push({ key: "Up" });
  const row = "text" in a ? optionCount : a.optionIndexes[0];
  for (let i = 0; i < row; i++) steps.push({ key: "Down" });
  steps.push({ key: "Enter" });
  if ("text" in a) steps.push({ text: a.text }, { key: "Enter" });
  return steps;
}
```

The answer handler: `item = store.get(id)` (404 when missing); `a = parseAnswer(body)` (400); `info = await d.registry.get(item.sessionId, 0)`; `reason = answerRefusal(item, info, a, answered)` (409); `answered.add(qid)` before the first chunk (so a second tap while keys are still going is refused); for each chunk `r = await deliverer.keys(item.sessionId, chunk)`. `answered.delete(qid)` runs **only** when `r.status === "refused"` on the **first** chunk: `Deliverer.keys` returns a refusal (live voice, no such session) before it sends any key (`deliver.ts` lines 190, 204, 219, 222), so nothing reached the dialog and the item can be answered again once the cause is gone. A `failed` result never deletes the qid: `Deliverer.tmuxKeys` sends one step at a time and returns `failed` at the first step that fails, after the earlier keys are already in (for a typed answer the first Enter may already have opened the "Other" box, and a retry would type Up/Down into the text field), so the dialog state is unknown and the question stays read-only (409 "Answer this in the terminal" on every later tap). A refusal or failure on a **later** chunk also leaves the qid in, because the earlier chunks' keys are already in. Return the result with its status code (`refused` 409, `failed` 502). All chunks sent → 200 `{status: "sent"}`.

- [ ] **Step 4: Run the test and the P1 suite**

```bash
/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/inbox.test.ts
/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test
```

Expected: all PASS.

- [ ] **Step 5: Commit and push**

```bash
git add server/src/events/answer.ts server/src/features/inbox.ts server/test/inbox.test.ts
git commit -m "inbox feature: events socket, answers, notifications with replay"
git push
```

---

### Task 6: Uploads

**Files (owned):** Create `server/src/uploads/names.ts`, `server/src/features/uploads.ts`, `server/test/uploads.test.ts`.

**Interfaces produced:**

```ts
// uploads/names.ts
export const MAX_UPLOAD = 50 * 1024 * 1024, KEEP_DAYS = 30;
export function safeName(original: string, now: Date): string;          // "HHMMSS-" + cleaned name (SPEC 4.8)
export function dayFolder(root: string, now: Date): string;             // root/YYYY-MM-DD (local date)
export function writeUnique(dir: string, name: string, data: Uint8Array): string;   // flag "wx", 0600; clash -> -2, -3 … before the extension
export function insideDir(dir: string, file: string): boolean;          // path.relative does not start with ".." and is not absolute
export function sweepOld(root: string, nowMs: number): number;          // deletes files older than 30 days (mtime), then empty day folders; returns count
// features/uploads.ts
export const uploadsFeature: FeatureFactory;   // POST /v1/uploads (multipart, field "file") -> {path}
```

Rules: `safeName` replaces every character outside `[A-Za-z0-9._-]` with `_`, strips leading dots, cuts to 100 characters, uses `upload` when nothing is left, and prefixes `HHMMSS-` from the local time. `writeUnique` tries `name`, then `stem-2.ext`, `stem-3.ext` … (up to 999) with `writeFileSync(..., { flag: "wx", mode: 0o600 })`, so two uploads can never overwrite each other; it checks `insideDir` before each write. Upload root is `path.join(cfg.stateDir, "uploads")`, folders created with mode 0700. The route refuses with 413 when `Content-Length` is above `MAX_UPLOAD + 1 MiB` (multipart overhead) before reading the body, and again when the file part is larger than `MAX_UPLOAD`; 400 when there is no `file` part. `start()` runs `sweepOld` once and every 6 hours (interval cleared in `stop()`).

- [ ] **Step 1: Write the failing test** `server/test/uploads.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MAX_UPLOAD, safeName, sweepOld, writeUnique } from "../src/uploads/names";
import { uploadsFeature } from "../src/features/uploads";
import { localHeaders, startTestHostd } from "./helpers/client";
import type { TestHostd } from "./helpers/client";
import { Scratch } from "./helpers/scratch";

let s: Scratch;
let h: TestHostd;
beforeAll(async () => { s = new Scratch(); h = await startTestHostd(s, [uploadsFeature]); });
afterAll(async () => { await h.stop(); s.cleanup(); });

function upload(name: string, bytes: Uint8Array): Promise<Response> {
  const form = new FormData();
  form.append("file", new Blob([bytes]), name);
  return fetch(h.url + "/v1/uploads", { method: "POST", headers: { ...localHeaders(h), Origin: h.config.origin }, body: form });
}

test("safe names", () => {
  const t = new Date(2026, 9, 13, 12, 3, 4);
  expect(safeName("My photo (1).png", t)).toBe("120304-My_photo__1_.png");
  expect(safeName("...", t)).toBe("120304-upload");
  expect(safeName("../../etc/passwd", t)).toBe("120304-_.._etc_passwd");
  expect(safeName("x".repeat(300), t)).toHaveLength(7 + 100);
});

test("a clash gets -2 and never overwrites", () => {
  const dir = path.join(s.root, "clash");
  mkdirSync(dir, { recursive: true });
  const a = writeUnique(dir, "a.png", new Uint8Array([1]));
  const b = writeUnique(dir, "a.png", new Uint8Array([2]));
  expect([path.basename(a), path.basename(b)]).toEqual(["a.png", "a-2.png"]);
  expect([...readFileSync(a)]).toEqual([1]);
});

test("P2.4: an upload lands under uploads/<date>/ with mode 0600 and its path is returned", async () => {
  const r = await upload("shot.png", new Uint8Array([9, 8, 7]));
  expect(r.status).toBe(200);
  const p = ((await r.json()) as { path: string }).path;
  expect(p.startsWith(path.join(h.config.stateDir, "uploads") + "/")).toBe(true);
  expect(path.basename(path.dirname(p))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(path.basename(p)).toMatch(/^\d{6}-shot\.png$/);
  expect(statSync(p).mode & 0o777).toBe(0o600);
  expect(statSync(path.dirname(p)).mode & 0o777).toBe(0o700);
  expect([...readFileSync(p)]).toEqual([9, 8, 7]);
});

test("P2.4: 51 MB is refused and nothing is written", async () => {
  const r = await upload("big.bin", new Uint8Array(51 * 1024 * 1024));
  expect(r.status).toBe(413);
  const day = path.join(h.config.stateDir, "uploads");
  const all = existsSync(day) ? Bun.spawnSync(["/usr/bin/find", day, "-name", "*big.bin"]).stdout.toString() : "";
  expect(all).toBe("");
  expect(MAX_UPLOAD).toBe(50 * 1024 * 1024);
});

test("files older than 30 days are deleted, newer ones kept", () => {
  const root = path.join(s.root, "sweep");
  mkdirSync(path.join(root, "2026-09-01"), { recursive: true });
  const old = path.join(root, "2026-09-01", "old.png");
  const fresh = path.join(root, "2026-09-01", "fresh.png");
  writeFileSync(old, "o");
  writeFileSync(fresh, "f");
  const now = Date.now();
  utimesSync(old, (now - 31 * 86_400_000) / 1000, (now - 31 * 86_400_000) / 1000);
  utimesSync(fresh, (now - 29 * 86_400_000) / 1000, (now - 29 * 86_400_000) / 1000);
  expect(sweepOld(root, now)).toBe(1);
  expect([existsSync(old), existsSync(fresh)]).toEqual([false, true]);
});
```

- [ ] **Step 2: Run, watch it fail; Step 3: implement per the rules above; Step 4: run again**

```bash
/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/uploads.test.ts
```

Expected: FAIL (modules not found) before step 3, PASS after. If Bun refuses the 51 MB body itself before the handler runs (status other than 413, e.g. connection reset), check P1's `Bun.serve` options in `server/src/hostd.ts` for `maxRequestBodySize`; report it rather than changing `hostd.ts` (P1 file, Task 12 owns any change to it).

- [ ] **Step 5: Commit and push**

```bash
git add server/src/uploads/names.ts server/src/features/uploads.ts server/test/uploads.test.ts
git commit -m "uploads: safe names, 0600 files, 50 MB limit, 30-day cleanup"
git push
```

---

### Task 7: Diff viewer data

**Files (owned):** Create `server/src/diff/diff.ts`, `server/src/features/diff.ts`, `server/test/diff.test.ts`.

**Interfaces produced:**

```ts
// diff/diff.ts
export interface ChangedFile { path: string; from: string | null; status: string; binary: boolean; patch: string }
export type Changes = { repo: true; root: string; staged: ChangedFile[]; unstaged: ChangedFile[]; untracked: { path: string }[] } | { repo: false; reason: string };
export function parsePorcelainV2(z: string): { staged: { path: string; from: string | null; status: string }[]; unstaged: { path: string; from: string | null; status: string }[]; untracked: string[] };
export async function changes(cfg: HostdConfig, dir: string): Promise<Changes>;
// features/diff.ts
export const diffFeature: FeatureFactory;   // GET /v1/sessions/:id/diff
```

Rules (SPEC 4.9): every git call goes through Task 1's `safeGit(cfg, dir, args)` (lock-free env, `-c core.fsmonitor=false -c diff.external=`, filter overrides, and the output-format overrides that keep colour off and the `a/`/`b/` prefixes on whatever Ben's own git config says). Calls: `rev-parse --show-toplevel` (non-zero exit → `{repo: false, reason: "No git repo here"}`; one exception: when its stderr contains `dubious ownership` (git's refusal to read a folder owned by another user), the answer is `{repo: false, reason: "git will not read this folder because it belongs to another user (git's dubious ownership check)"}`; Porthole never adds `safe.directory` or changes any other git setting of Ben's), `status --porcelain=v2 -z --untracked-files=all`, and per side (unstaged, then staged with `--cached`) two calls: `diff <DIFF_SAFE> --numstat -z` (binary files show `-` for both counts) and `diff <DIFF_SAFE> --patch`. Patches are split per file on `^diff --git ` lines and matched to the file by its `b/` path; binary files get `binary: true, patch: ""`. Each patch is cut at 200 000 characters (the cut is marked by a final line `… (cut)`). The folder is the session's `cwd` from `d.registry.get(id, 0)` (404 when the session is unknown). Response: the `Changes` object.

`parsePorcelainV2`: records are NUL-separated; `1 XY …` and `2 XY …` (rename/copy, followed by one extra NUL-separated record holding the original path) give staged when `X !== "."` and unstaged when `Y !== "."`; `? path` is untracked; `u …` (unmerged) goes to unstaged with status `U`; `!` lines are ignored.

- [ ] **Step 1: Write the failing test** `server/test/diff.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { changes, parsePorcelainV2 } from "../src/diff/diff";
import { diffFeature } from "../src/features/diff";
import { get, pane, startTestHostd } from "./helpers/client";
import type { TestHostd } from "./helpers/client";
import { Scratch } from "./helpers/scratch";

let s: Scratch;
let h: TestHostd;
let repo: string;
const git = (...a: string[]) => {
  const r = Bun.spawnSync(["/usr/bin/git", "-C", repo, ...a], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};
beforeAll(async () => {
  s = new Scratch();
  repo = path.join(s.root, "repo");
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "one\n");
  writeFileSync(path.join(repo, "b.txt"), "two\n");
  writeFileSync(path.join(repo, "img.bin"), new Uint8Array([0, 1, 2, 0]));
  git("add", ".");
  git("commit", "-q", "-m", "init");
  writeFileSync(path.join(repo, "a.txt"), "one changed\n");       // unstaged
  writeFileSync(path.join(repo, "b.txt"), "two staged\n");
  git("add", "b.txt");                                                // staged
  writeFileSync(path.join(repo, "img.bin"), new Uint8Array([0, 9, 9, 0]));
  git("add", "img.bin");                                              // staged binary
  writeFileSync(path.join(repo, "new.txt"), "fresh\n");              // untracked
  h = await startTestHostd(s, [diffFeature]);
});
afterAll(async () => { await h.stop(); s.cleanup(); });

test("parses porcelain v2 including renames", () => {
  const z = ["1 .M N... 100644 100644 100644 aaa bbb a.txt", "2 R. N... 100644 100644 100644 aaa bbb R100 new-name.txt", "old-name.txt", "? fresh.txt", ""].join("\0");
  expect(parsePorcelainV2(z)).toEqual({
    staged: [{ path: "new-name.txt", from: "old-name.txt", status: "R" }],
    unstaged: [{ path: "a.txt", from: null, status: "M" }],
    untracked: ["fresh.txt"],
  });
});

test("P2.5: staged, unstaged and untracked are listed separately; binary is flagged", async () => {
  const c = await changes(h.config, repo);
  if (!c.repo) throw new Error("expected a repo");
  expect(c.staged.map((f) => [f.path, f.binary])).toEqual([["b.txt", false], ["img.bin", true]]);
  expect(c.staged[0].patch).toContain("+two staged");
  expect(c.unstaged.map((f) => f.path)).toEqual(["a.txt"]);
  expect(c.unstaged[0].patch).toContain("+one changed");
  expect(c.untracked).toEqual([{ path: "new.txt" }]);
});

test("P2.5: a non-repo says so, through the route", async () => {
  const plain = path.join(s.root, "plain");
  mkdirSync(plain);
  expect(await changes(h.config, plain)).toEqual({ repo: false, reason: "No git repo here" });
  const p = await pane(s, "plain", "/bin/sh");
  s.tmux(p.socket, "send-keys", "-t", "=plain:0.0", "cd '" + plain + "'", "Enter");
  await Bun.sleep(500);
  const r = await get(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/diff");
  expect(await r.json()).toEqual({ repo: false, reason: "No git repo here" });
  expect((await get(h, "/v1/sessions/" + encodeURIComponent("tmux:nope:x:0.0") + "/diff")).status).toBe(404);
});

test("P2.5: git's dubious-ownership refusal gets its own plain reason", async () => {
  // a fake git that refuses every call the way git does for a folder owned by another user
  const fake = s.writeFake("git-dubious", "#!/bin/sh\necho \"fatal: detected dubious ownership in repository at '/somewhere'\" >&2\nexit 128\n");
  const cfg = { ...h.config, bin: { ...h.config.bin, git: fake } };
  expect(await changes(cfg, repo)).toEqual({ repo: false, reason: "git will not read this folder because it belongs to another user (git's dubious ownership check)" });
});
```

The route test leans on the registry reading `#{pane_current_path}`; if P1's registry caches the tree for 2 s, pass `maxAgeMs = 0` (`d.registry.get(id, 0)`) in the route, as the inbox does. The dubious-ownership test uses a fake git binary rather than a real foreign-owned folder, because a test cannot create files owned by another user without sudo; it proves the stderr-to-reason mapping only.

- [ ] **Step 2: Run, watch it fail; Step 3: implement per the rules above; Step 4: run again**

```bash
/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/diff.test.ts
```

Expected: FAIL (modules not found) before step 3, PASS after.

- [ ] **Step 5: Commit and push**

```bash
git add server/src/diff/diff.ts server/src/features/diff.ts server/test/diff.test.ts
git commit -m "diff: staged, unstaged, untracked via lock-free safe git"
git push
```

---

### Task 8: Preview scan and preview proxy

**Files (owned):** Create `server/src/preview/scan.ts`, `server/src/preview/proxy.ts`, `server/src/features/preview.ts`, `server/test/fixtures/preview-upstream.ts`, `server/test/preview.test.ts`.

**Interfaces produced:**

```ts
// preview/scan.ts
export interface Listener { port: number; pid: number | null; process: string | null }
export interface Preview { port: number; pid: number | null; process: string | null; url: string }
export function parseSs(text: string): Listener[];              // `ss -ltnpH` lines (F11), one entry per port, loopback/wildcard only
export function refusedReason(port: number, cfg: HostdConfig, hostdPids: ReadonlySet<number>, owner: number | null): string | null;
export function hostdPids(dir: string): Set<number>;           // reads the pid files in PIDS_DIR (server/src/pids.ts, written by every createHostd, Task 1): keeps pids whose /proc/<pid> exists, plus process.pid
export async function scan(cfg: HostdConfig, pids: ReadonlySet<number>): Promise<Preview[]>;
// preview/proxy.ts
export class PreviewProxy {
  constructor(cfg: HostdConfig, auth: Auth, allowed: (port: number) => boolean);
  start(): void; stop(): void; get port(): number;
}
// features/preview.ts
export const previewFeature: FeatureFactory;   // GET /v1/previews -> {proxy: {port}, previews: Preview[]}
```

Rules (SPEC 4.10):
- `parseSs`: take the local address column (4th field), split host and port at the last `:`, keep `127.0.0.1`, `[::1]`, `0.0.0.0`, `*`, `[::]`; pid and process from `users:(("name",pid=N,…` when present (F11), else `null`.
- `refusedReason`, checked before any probe (so a refused port is never contacted): `< 1024` → "ports below 1024 are never previewed"; 8443, 8795, 8796, 9222-9225, `cfg.apiPort`, `cfg.previewPort`, 8797, 8798 → "port N is never previewed"; `owner` in `hostdPids` → "port N belongs to a Porthole hostd". Ports outside `parseRanges(cfg.previewRanges)` (read from `cfg` on every scan, so a `PUT /v1/config` change applies at once) are skipped, not listed.
- Test hostd ports: `FeatureDeps` does not carry the bound API port (gap 7), so every hostd marks itself: `createHostd` (Task 1, `server/src/hostd.ts`, helpers in `server/src/pids.ts`) writes `PIDS_DIR/<process.pid>` (empty file, folder 0700) when it starts and removes it when it stops. This feature writes nothing: `previewFeature` and `scan` call `hostdPids(PIDS_DIR)` (`PIDS_DIR` imported from `../pids`), which keeps only pids whose `/proc/<pid>` exists (a crashed hostd's stale file is ignored) and adds `process.pid`. A port whose listener pid is in that set is refused, so a preview never points at any hostd, including one that was built without `previewFeature`.
- `scan`: run `cfg.bin.ss -ltnpH` (5 s timeout), parse, drop refused and out-of-range ports, then `fetch("http://127.0.0.1:" + port + "/", { method: "HEAD", signal: AbortSignal.timeout(1000), redirect: "manual" })`; any HTTP answer (any status) keeps the port; errors drop it. `url` = `cfg.origin + ":8443/__porthole/preview?port=" + port`.
- `PreviewProxy` is `Bun.serve({ hostname: "127.0.0.1", port: cfg.previewPort })` with:
  - every request first passes `auth.identify(req)` (403 with the reason otherwise);
  - `GET /__porthole/preview?port=N`: `allowed(N)` must be true (the latest scan found it and it is not refused; 404 "port N was not found by the latest scan" or 403 with the refusal reason); a random 32-byte hex token maps to `{device, port}`; any older token of the same device is deleted (one preview per device); answer 302 to `/` with `Set-Cookie: porthole_preview=<token>; Path=/; HttpOnly; Secure; SameSite=Lax`;
  - any other request needs a known `porthole_preview` cookie whose device matches the verdict's device (403 "open the preview from Porthole first"); WebSocket upgrades and non-GET/HEAD requests also need `Origin` exactly `cfg.origin + ":8443"` (403);
  - HTTP is forwarded with `fetch("http://127.0.0.1:" + port + path + query, { method, headers, body, redirect: "manual" })`, after removing `accept-encoding`, `cookie`'s `porthole_preview` pair, `x-porthole-local`, every `x-forwarded-*` header and every `tailscale-*` header, and after setting `Host` to exactly `127.0.0.1:<port>` (the dev server must see its own address, not the Tailscale name or the proxy's port, or its host checks and absolute redirects break); the answer is returned as-is (status, headers, body stream) **except** a `Location` header that starts with `http://127.0.0.1:<port>` or `http://localhost:<port>` (the upstream's own `<port>`; a framework builds absolute redirects from the `Host` it was given): that prefix is cut off so the phone gets just the path and query (`http://127.0.0.1:3000/target` becomes `/target`). Any other `Location` (another port, another host) is returned untouched. The fixture's `/redir` returns an absolute `Location` and the test asserts the proxy sends `/target`;
  - WebSockets: connect upstream first with `new WebSocket("ws://127.0.0.1:" + port + path + query, { protocols, headers })` (path **and query**, the same URL the HTTP side builds; dev-server HMR sockets carry tokens in the query) where `headers` holds the client's `cookie` header minus the `porthole_preview` pair (omitted when nothing is left, so the app's own session cookies still reach the upstream) and `Origin: http://127.0.0.1:<port>` (the upstream's own address, as for HTTP's `Host`); upgrade the client only after upstream `open` (502 if it fails within 5 s), then pipe messages both ways and close each side when the other closes. Bun's `WebSocket` constructor accepts `headers` in its options object; if the installed Bun rejects it, report that rather than dropping the cookie or Origin. The fixture's `/ws` echoes the query, cookie and origin it saw and the test asserts them.
- `previewFeature`: builds `new Auth(d.config, new Whois(d.config.bin.tailscale), d.localToken)` (same constructor P1's `hostd.ts` uses; `bin.tailscale` per P1 config, check the name), keeps the latest scan, rescans on each `GET /v1/previews` (and at most every 10 s for `allowed()`), starts the proxy in `start()` and stops it in `stop()`.

**`server/test/fixtures/preview-upstream.ts`** (run as a child process so its port has another pid than the test hostd):

```ts
type WsData = { search: string; cookie: string; origin: string };
const server = Bun.serve<WsData>({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, srv) {
    const u = new URL(req.url);
    if (u.pathname === "/ws" && srv.upgrade(req, { data: { search: u.search, cookie: req.headers.get("cookie") ?? "none", origin: req.headers.get("origin") ?? "none" } })) return undefined;
    // absolute Location built from this server's own address, the way a framework does from the Host it sees
    if (u.pathname === "/redir") return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1:" + server.port + "/target" } });
    return new Response("upstream " + u.pathname + u.search + " enc=" + (req.headers.get("accept-encoding") ?? "none") + " host=" + (req.headers.get("host") ?? "none") + " xff=" + (req.headers.get("x-forwarded-for") ?? "none"));
  },
  websocket: { message(ws, m) { ws.send("echo " + String(m) + " q=" + ws.data.search + " cookie=" + ws.data.cookie + " origin=" + ws.data.origin); } },
});
console.log(String(server.port));
```

- [ ] **Step 1: Write the failing test** `server/test/preview.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import path from "node:path";
import { parseSs, refusedReason } from "../src/preview/scan";
import { previewFeature } from "../src/features/preview";
import { get, localHeaders, rawUpgrade, startTestHostd } from "./helpers/client";
import type { TestHostd } from "./helpers/client";
import { Scratch } from "./helpers/scratch";

let s: Scratch;
let h: TestHostd;
let up: ReturnType<typeof Bun.spawn>;
let P = 0;
let proxyPort = 0;
beforeAll(async () => {
  s = new Scratch();
  up = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "preview-upstream.ts")], { stdout: "pipe" });
  const reader = up.stdout.getReader();
  P = Number(new TextDecoder().decode((await reader.read()).value).trim());
  const lines = [
    "LISTEN 0 512 127.0.0.1:" + P + " 0.0.0.0:* users:((\"bun\",pid=" + up.pid + ",fd=5))",
    "LISTEN 0 512 127.0.0.1:8795 0.0.0.0:* users:((\"bun\",pid=" + up.pid + ",fd=6))",
    "LISTEN 0 512 127.0.0.1:9224 0.0.0.0:* users:((\"chrome\",pid=1,fd=7))",
  ];
  s.writeFake("ss", "#!/bin/sh\ncat <<'EOF'\n" + lines.join("\n") + "\nEOF\n");
  h = await startTestHostd(s, [previewFeature], { previewRanges: "1024-65535" });
  const list = (await (await get(h, "/v1/previews")).json()) as { proxy: { port: number } };
  proxyPort = list.proxy.port;
});
afterAll(async () => { await h.stop(); up.kill(); s.cleanup(); });

const proxy = (p: string, headers: Record<string, string> = {}) =>
  fetch("http://127.0.0.1:" + proxyPort + p, { headers: { "X-Porthole-Local": h.localToken, ...headers }, redirect: "manual" });
async function open(port: number): Promise<Response> { return proxy("/__porthole/preview?port=" + port); }

test("ss parsing and the always-refused list", () => {
  expect(parseSs("LISTEN 0 4096 [::1]:3000 [::]:* users:((\"node\",pid=42,fd=3))\nLISTEN 0 5 *:5000 *:*")).toEqual([
    { port: 3000, pid: 42, process: "node" },
    { port: 5000, pid: null, process: null },
  ]);
  for (const p of [80, 8443, 8795, 8796, 9222, 9224, 9225, 8797, 8798]) expect(refusedReason(p, h.config, new Set(), null)).not.toBeNull();
  expect(refusedReason(4321, h.config, new Set([77]), 77)).toBe("port 4321 belongs to a Porthole hostd");
});

test("P2.6: a scratch server on a listed port is listed with its open URL", async () => {
  const list = (await (await get(h, "/v1/previews")).json()) as { previews: { port: number; pid: number; process: string; url: string }[] };
  expect(list.previews).toEqual([{ port: P, pid: up.pid, process: "bun", url: h.config.origin + ":8443/__porthole/preview?port=" + P }]);
});

test("P2.6: reachable through the proxy over HTTP and WebSocket", async () => {
  const r = await open(P);
  expect(r.status).toBe(302);
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  expect(cookie).toMatch(/^porthole_preview=[0-9a-f]{64}$/);
  const page = await proxy("/hello?x=1", { Cookie: cookie, "Accept-Encoding": "gzip", "X-Forwarded-For": "100.64.0.9" });
  // the request reaches the proxy as host 127.0.0.1:<proxyPort>; the upstream must see its own port, and no forwarded-for
  expect(await page.text()).toBe("upstream /hello?x=1 enc=none host=127.0.0.1:" + P + " xff=none");

  // the upstream builds an absolute Location from the Host it saw; the proxy must hand the phone a path, not 127.0.0.1:<port>
  const redir = await proxy("/redir", { Cookie: cookie });
  expect([redir.status, redir.headers.get("location")]).toEqual([302, "/target"]);

  // query kept; the porthole_preview cookie pair removed but the app's own cookie forwarded; Origin is the upstream's own address
  const ws = new WebSocket("ws://127.0.0.1:" + proxyPort + "/ws?token=abc", { headers: { Cookie: cookie + "; app=1", Origin: h.config.origin + ":8443", "X-Porthole-Local": h.localToken } } as unknown as string[]);
  const echoed = await new Promise<string>((resolve, reject) => {
    ws.onopen = () => ws.send("ping");
    ws.onmessage = (e) => resolve(String(e.data));
    ws.onerror = () => reject(new Error("ws error"));
  });
  expect(echoed).toBe("echo ping q=?token=abc cookie=app=1 origin=http://127.0.0.1:" + P);
  ws.close();

  expect(await rawUpgrade(proxyPort, "/ws", { Cookie: cookie, Origin: h.config.origin, "X-Porthole-Local": h.localToken })).toBe(403);
  expect((await proxy("/hello", { Cookie: cookie, "X-Porthole-Local": "wrong" })).status).toBe(403);
  expect((await fetch("http://127.0.0.1:" + proxyPort + "/hello", { headers: { Cookie: cookie } })).status).toBe(403);
});

test("P2.6: ports 8795 and 9224, and a port the scan did not find, are refused", async () => {
  expect((await open(8795)).status).toBe(403);
  expect((await open(9224)).status).toBe(403);
  const missing = await open(65000);
  expect(missing.status).toBe(404);
  expect(await missing.text()).toContain("not found by the latest scan");
  expect((await proxy("/hello")).status).toBe(403);   // no cookie
});
```

`localHeaders` is imported for builders who prefer it over the inline header; drop the import if unused. If Bun's client `WebSocket` does not accept the `headers` option in this form, use `BunWebSocket` the way `test/helpers/client.ts` `openWs` does.

- [ ] **Step 2: Run, watch it fail; Step 3: implement per the rules above; Step 4: run again**

```bash
/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/preview.test.ts
```

Expected: FAIL (modules not found) before step 3, PASS after.

- [ ] **Step 5: Commit and push**

```bash
git add server/src/preview/scan.ts server/src/preview/proxy.ts server/src/features/preview.ts server/test/fixtures/preview-upstream.ts server/test/preview.test.ts
git commit -m "preview: scan with refused ports, cookie-selected proxy with WebSockets"
git push
```

---

### Task 9: Usage (`omp usage`)

**Gate:** read Task 1's report. If it says **USAGE SOURCE NOT CONFIRMED**, do not build this task: report "usage source not confirmed, asking Ben" (SPEC 4.11, acceptance P2.7) and stop. Never show an estimated number.

**Files (owned):** Create `server/src/features/usage.ts`, `server/test/fixtures/omp-usage.json`, `server/test/usage.test.ts`.

**Interface produced:**

```ts
export interface UsageWindow { id: "5h" | "7d"; usedPercent: number; resetsAt: string | null; status: string }
export interface Usage { windows: UsageWindow[]; readAt: string }
export function parseOmpUsage(json: unknown): UsageWindow[];   // Claude 5-hour and 7-day windows only
export const usageFeature: FeatureFactory;                      // GET /v1/usage
```

Rules: run `cfg.bin.omp usage --json -p anthropic -r` (15 s timeout; never another provider, never without `-r`). `parseOmpUsage` reads the limits whose id is `anthropic:5h` / `anthropic:7d` (F3) using the field names recorded in Task 1 step 1; `usedPercent = Math.round(usedFraction * 1000) / 10`; a window without `usedFraction` is left out (never estimated from `remainingFraction` unless the recorded output shows they always sum to 1). When several accounts are present, report the highest `usedPercent` per window. Results are cached 60 s (`?refresh=1` forces a re-read, at most once per 10 s). `usageCollection` false → 404 `{error: "usage collection is off"}` and no `omp` call. A failed call → 502 `{error: "omp usage failed: <first stderr line>"}`; the last good numbers are not shown as current.

`server/test/fixtures/omp-usage.json`: the Task 1 step 1 file with account names and e-mails replaced by `account-1`, … and nothing else changed. Before committing, `grep -c -E '@|sk-ant|eyJ|token'` on the fixture must print 0. If `token` matches only a JSON key name (for example a token-count field), list those key names in the report, confirm their values are plain numbers, and keep the key; any other match (a value that looks like a key, a JWT, or an address) means stop, redact it, and check again. Once the fixture is made and the check passes, delete the raw scratch file (Task 1 step 1 wrote it; nothing else needs it):

```bash
rm /home/cortex/00-system/porthole/files/scratch/omp-usage-shape.json
```

- [ ] **Step 1: Write the failing test** `server/test/usage.test.ts`. The fake `omp-cli` prints the fixture and logs each call:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseOmpUsage, usageFeature } from "../src/features/usage";
import { get, startTestHostd } from "./helpers/client";
import type { TestHostd } from "./helpers/client";
import { Scratch } from "./helpers/scratch";

const fixture = path.join(import.meta.dir, "fixtures", "omp-usage.json");
let s: Scratch;
let h: TestHostd;
let calls: string;
beforeAll(async () => {
  s = new Scratch();
  calls = path.join(s.root, "omp-cli-calls");
  s.writeFake("omp-cli", "#!/bin/sh\necho \"$*\" >> '" + calls + "'\ncat '" + fixture + "'\n");
  h = await startTestHostd(s, [usageFeature]);
});
afterAll(async () => { await h.stop(); s.cleanup(); });

test("parses the recorded omp output into the two Claude windows", () => {
  const w = parseOmpUsage(JSON.parse(readFileSync(fixture, "utf8")));
  expect(w.map((x) => x.id).sort()).toEqual(["5h", "7d"]);
  for (const x of w) expect(x.usedPercent).toBeGreaterThanOrEqual(0);
});

test("P2.7: /v1/usage returns the numbers, cached for a minute, with the exact flags", async () => {
  const a = (await (await get(h, "/v1/usage")).json()) as { windows: unknown[]; readAt: string };
  const b = (await (await get(h, "/v1/usage")).json()) as { readAt: string };
  expect(a.windows).toHaveLength(2);
  expect(b.readAt).toBe(a.readAt);
  expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(["usage --json -p anthropic -r"]);
});

test("hidden when usage collection is off", async () => {
  const off = await startTestHostd(s, [usageFeature], { usageCollection: false });
  try {
    expect((await get(off, "/v1/usage")).status).toBe(404);
  } finally { await off.stop(); }
});
```

Also add one assertion to the parse test with the exact numbers of the fixture (read them from the file when writing the test), so the test checks real values, not just shape.

- [ ] **Step 2: Run, watch it fail; Step 3: implement; Step 4: run again**

```bash
/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/usage.test.ts
```

Expected: FAIL before step 3, PASS after. Acceptance P2.7's "real numbers from the verified source" is closed in Task 12 step 4 against the installed hostd.

- [ ] **Step 5: Commit and push**

```bash
git add server/src/features/usage.ts server/test/fixtures/omp-usage.json server/test/usage.test.ts
git commit -m "usage: Claude 5h/7d windows from omp usage, 60 s cache"
git push
```

---

### Task 10: Voice (transcription, kept audio, VRAM check)

**Files (owned):** Create `server/src/voice/transcribe.ts`, `server/src/features/voice.ts`, `server/test/voice.test.ts`, `server/test/live/voice-once.ts`.

**Interfaces produced:**

```ts
// voice/transcribe.ts
export const MAX_AUDIO = 25 * 1024 * 1024, KEEP_AUDIO_DAYS = 30;
export type Outcome = { ok: true; text: string } | { ok: false; error: string; kept: string };
export class Transcriber {
  constructor(cfg: HostdConfig);
  transcribe(wav: Uint8Array): Promise<Outcome>;   // queued: one at a time
  kept(): { name: string; size: number; keptAt: string }[];
  sweep(nowMs: number): number;                    // deletes kept files older than 30 days
}
// features/voice.ts
export const voiceFeature: FeatureFactory;         // POST /v1/voice (audio/wav) -> {text}; GET /v1/voice/kept -> {files}
```

Rules (SPEC 4.12, facts F6, F7, F10): the body must be at most 25 MB (413 from `Content-Length` before reading, and again after) and start with `RIFF....WAVE` (400 "send a 16 kHz mono WAV"). The audio is written to `stateDir/audio/<YYYYMMDD-HHMMSS>-<8 hex>.wav` (folder 0700, file 0600, flag `wx`). Then `cfg.bin.voxtype transcribe <file>` runs with no `--engine` (Ben's voxtype setting decides, F7) and a 120 s timeout. Exit 0 with non-empty trimmed stdout: delete the file, answer 200 `{text}`. Anything else: keep the file, answer 502 `{error: "transcription failed; the audio is kept as <name>", kept: <name>}`. When `cfg.voiceEnhance` is true (off by default, F10), pass the text through `cfg.bin.voxflow enhance` on stdin/stdout with a 10 s timeout; if that fails, return the raw text. Transcriptions run one at a time through a promise chain. `start()` runs `sweep` once and every 6 hours. Porthole never starts, stops or reconfigures the voxtype daemon.

- [ ] **Step 1: Write the failing test** `server/test/voice.test.ts` (fake `voxtype` only; no real transcription here):

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { voiceFeature } from "../src/features/voice";
import { get, localHeaders, startTestHostd } from "./helpers/client";
import type { TestHostd } from "./helpers/client";
import { Scratch } from "./helpers/scratch";

let s: Scratch;
let h: TestHostd;
let log: string;
const audioDir = () => path.join(h.config.stateDir, "audio");
function wav(extra = 16): Uint8Array {
  const b = new Uint8Array(44 + extra);
  b.set(new TextEncoder().encode("RIFF"), 0);
  b.set(new TextEncoder().encode("WAVE"), 8);
  return b;
}
const send = (body: Uint8Array) =>
  fetch(h.url + "/v1/voice", { method: "POST", headers: { ...localHeaders(h), Origin: h.config.origin, "Content-Type": "audio/wav" }, body });

beforeAll(async () => {
  s = new Scratch();
  log = path.join(s.root, "voxtype.log");
  // Succeeds unless the file is larger than 100 bytes; logs start/end so overlap is visible.
  s.writeFake("voxtype", "#!/bin/sh\necho \"start $*\" >> '" + log + "'\nsleep 0.3\necho end >> '" + log + "'\n[ $(stat -c %s \"$2\") -gt 100 ] && exit 1\necho '  hello world  '\n");
  h = await startTestHostd(s, [voiceFeature]);
});
afterAll(async () => { await h.stop(); s.cleanup(); });

test("a good transcription returns the text and deletes the audio", async () => {
  const r = await send(wav());
  expect([r.status, (await r.json()).text]).toEqual([200, "hello world"]);
  expect(readFileSync(log, "utf8")).toMatch(/^start transcribe \S+\.wav\n/);
  expect(existsSync(audioDir()) ? readdirSync(audioDir()) : []).toEqual([]);
});

test("P2.8: a failed transcription keeps the audio (0600) and lists it", async () => {
  const r = await send(wav(200));
  expect(r.status).toBe(502);
  const kept = ((await r.json()) as { kept: string }).kept;
  expect(statSync(path.join(audioDir(), kept)).mode & 0o777).toBe(0o600);
  const list = (await (await get(h, "/v1/voice/kept")).json()) as { files: { name: string }[] };
  expect(list.files.map((f) => f.name)).toContain(kept);
});

test("transcriptions run one at a time; bad and oversized bodies are refused", async () => {
  await Bun.write(log, "");
  await Promise.all([send(wav()), send(wav())]);
  expect(readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.split(" ")[0])).toEqual(["start", "end", "start", "end"]);
  expect((await send(new Uint8Array(60))).status).toBe(400);
  expect((await send(new Uint8Array(25 * 1024 * 1024 + 1))).status).toBe(413);
});
```

- [ ] **Step 2: Run, watch it fail; Step 3: implement; Step 4: run again**

```bash
/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/voice.test.ts
```

Expected: FAIL before step 3, PASS after.

- [ ] **Step 5: Find the voxtype daemon's unit name on this machine.** F8 recorded only a process id, so the unit name is not known yet and the plan does not guess it. Run once, read-only:

```bash
systemctl --user list-units --all --no-legend 'voxtype*'
```

Record the unit name (the `voxtype*.service` row) in the task report and in Verified facts F8, and use it as `const VOXTYPE_UNIT` in `voice-once.ts`. If no row appears, voxtype is not a user service on this machine: write "VOXTYPE UNIT NOT FOUND" in the report and stop (Needs Ben).

- [ ] **Step 6: Write `server/test/live/voice-once.ts`** (acceptance P2.11 then P2.8; run exactly once, by hand). It:
  1. Checks the daemon first: `/usr/bin/systemctl --user is-active <VOXTYPE_UNIT>` and prints `VOXTYPE DAEMON: <its output>`. If the output is not exactly `active`, it prints `VOXTYPE DAEMON: not running (<output>); nothing measured, nothing transcribed. Tell Ben.` and exits 2. No graphics-memory reading and no transcription happen in that case, and the script never starts the daemon.
  2. Converts the test audio into the scratch folder: `/usr/bin/ffmpeg -y -loglevel error -i /usr/share/sounds/alsa/Front_Center.wav -ar 16000 -ac 1 <scratch>/front-center-16k.wav` (F13; never committed).
  3. Reads graphics-card memory: `/usr/bin/nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits`. If less than 1500 MiB is free, prints "VRAM CHECK: only N MiB free; not transcribing. Ask Ben." and exits 2 (voxtype's daemon has crashed from running out of graphics memory before).
  4. Starts a test hostd (`createHostd` with `Scratch.config({ bin: { voxtype: "/usr/bin/voxtype" } })` and `[voiceFeature]`), samples `nvidia-smi` every 200 ms while it POSTs the WAV to `/v1/voice`, and stops sampling when the answer arrives.
  5. Prints one report line: `VRAM CHECK: before <a> MiB, peak <b> MiB, delta <b-a> MiB -> <"no second model" if delta <= 200, else "SECOND MODEL LOADED: stop and ask Ben">` and `TEXT: <the text or the error>`.
  6. Exits 0 only when the delta is at most 200 MiB and the text contains both "front" and "center" (case-insensitive; [INFERENCE] from the file name, F13). Otherwise exits 1 with the report.

- [ ] **Step 7: Run it once, then report its lines word for word**

```bash
/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun run server/test/live/voice-once.ts
```

If it prints "VOXTYPE DAEMON: not running", do not start the daemon and do not run it again: report it under Needs Ben. If it prints "SECOND MODEL LOADED", do not run it again and do not change voxtype settings: report it under Needs Ben (voxtype 1.1.0 has no CPU option, F6; the remaining choices are Ben's). If the text is wrong but not empty, report the text as heard; do not loop.

- [ ] **Step 8: Commit and push**

```bash
git add server/src/voice/transcribe.ts server/src/features/voice.ts server/test/voice.test.ts server/test/live/voice-once.ts
git commit -m "voice: one-at-a-time voxtype transcription, kept audio, VRAM check script"
git push
```

---

### Task 11: Shortcuts, config, doctor

**Files (owned):** Create `server/src/features/shortcuts.ts`, `server/src/features/config.ts`, `server/src/features/doctor.ts`, `server/test/shortcuts.test.ts`, `server/test/config-feature.test.ts`, `server/test/doctor.test.ts`. (`server/test/config.test.ts` is P1's config test, owned by Task 1 for its one allowed change; never create or overwrite it here.)

**Interfaces produced:**

```ts
export interface Shortcut { label: string; steps: string }   // steps as Ben types them: "C-b, n"
export function splitSteps(text: string): string[];            // splits on commas not directly preceded by "\"; "\," becomes "," inside a step
export const shortcutsFeature: FeatureFactory;                // GET|PUT /v1/shortcuts  {shortcuts: Shortcut[]}
export function configFeature(file: string): FeatureFactory;  // GET|PUT /v1/config
export interface Check { id: string; ok: boolean; detail: string }
export const doctorFeature: FeatureFactory;                   // GET /v1/doctor -> {checks: Check[]}
```

Rules:
- **Shortcuts** (SPEC 4.4): stored in `stateDir/shortcuts.json` (missing file = `[]`). `PUT` takes `{shortcuts}`: at most 50, each `label` 1-40 characters and unique, each `steps` split by `splitSteps`, each part trimmed, empty parts refused, and the list must pass P1's `parseSteps` (so the same key names and the 32-step limit apply). Errors: 400 `{error: "shortcut \"<label>\": <reason>"}`. Saved by writing `shortcuts.json.tmp` (0600) and renaming. Shortcuts are only stored here; the app sends them through P1's `/keys`, which keeps the live-voice refusal in one place.
  - **Commas.** `splitSteps` splits on every comma that is not directly preceded by a backslash; `\,` becomes a literal `,` inside that step, and any other backslash stays as typed. So a `text:` step cannot hold a bare comma: `text:hello, world` is two steps (`text:hello` and `world`) and the second is refused; the way to type a comma is `text:hello\, world`. The stored `steps` string keeps the backslash exactly as typed. The app applies the same rule (split on unescaped commas, unescape `\,`) before it calls `/keys`. Two limits follow and are written into the README (Task 12 step 6): there is **no `\\` escape**, so a step cannot end in a literal backslash directly before a separator (a backslash followed by a comma is always a literal comma); and because each part is trimmed, **trailing (and leading) spaces inside a `text:` step are dropped** (`text:ls ` sends `ls`).
- **Config** (SPEC 4.2 item 6, 5.x): `GET` → `{previewRanges, usageCollection, peers, voiceEnhance, restartNeeded: false}`. `PUT` takes any subset of `previewRanges` (must pass `parseRanges`), `usageCollection` (boolean), `peers` (each must pass the same origin check `validateConfig` applies), `voiceEnhance` (boolean). It reads the config file as JSON (missing = `{}`), merges, runs `validateConfig` on the merged effective config, writes `<file>.tmp` (0600) and renames, then updates `d.config` in place for `previewRanges`, `usageCollection` and `voiceEnhance` (features read these per request). A changed `peers` returns `restartNeeded: true` (gap 6). Unknown keys → 400.
- **Doctor** (SPEC 4.2, 4.4): checks, each `{id, ok, detail}` in this order: `tmux-mouse:<socket>` for every socket in `cfg.tmuxSocketDir` (`tmux -S <socket> show-options -gv mouse` equals `on`; detail "scrolling needs `set -g mouse on`" otherwise; read-only); `extension:porthole-events` and `extension:live-inbox` (the file in `cfg.ompExtensionsDir` exists and has the same bytes as the repo copy in `omp-extension/`; detail "not installed" / "older than the repo copy"); `events-socket` (`runtimeDir/events.sock` accepts a connection within 500 ms; the doctor sends nothing on it); `voxtype` and `git` (the configured binary exists and is executable); `state-dir` (`stateDir` mode is 0700). The doctor never changes anything.

- [ ] **Step 1: Write the failing tests.** Each file starts its own test hostd from a fresh `Scratch` with only the feature it tests. `inboxFeature` (Task 5) is not merged while Task 11 runs, so the doctor test opens its own listener with `net.createServer().listen(path.join(h.config.runtimeDir, "events.sock"))` (folder created 0700 first) and closes it in `afterAll`. Cases:

`server/test/shortcuts.test.ts`:
```ts
test("shortcuts round-trip and are checked with P1's step rules", async () => {
  expect(await (await get(h, "/v1/shortcuts")).json()).toEqual({ shortcuts: [] });
  const good = [{ label: "next window", steps: "C-b, n" }, { label: "clear", steps: "text:/clear, Enter" }];
  expect((await put(h, "/v1/shortcuts", { shortcuts: good })).status).toBe(200);
  expect(await (await get(h, "/v1/shortcuts")).json()).toEqual({ shortcuts: good });
  expect(statSync(path.join(h.config.stateDir, "shortcuts.json")).mode & 0o777).toBe(0o600);
  const bad = await put(h, "/v1/shortcuts", { shortcuts: [{ label: "x", steps: "C-b, Bogus" }] });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toStartWith("shortcut \"x\": ");
  expect((await put(h, "/v1/shortcuts", { shortcuts: [{ label: "a", steps: "Esc" }, { label: "a", steps: "Tab" }] })).status).toBe(400);
  expect(await (await get(h, "/v1/shortcuts")).json()).toEqual({ shortcuts: good });
});

// second test in the same file; the import goes with the file's other imports
import { splitSteps } from "../src/features/shortcuts";

test("a text: step holds a comma only when it is written \\,", async () => {
  expect(splitSteps("text:a\\, b, Enter")).toEqual(["text:a, b", "Enter"]);
  const ok = await put(h, "/v1/shortcuts", { shortcuts: [{ label: "comma", steps: "text:a\\, b, Enter" }] });
  expect(ok.status).toBe(200);
  expect(await (await get(h, "/v1/shortcuts")).json()).toEqual({ shortcuts: [{ label: "comma", steps: "text:a\\, b, Enter" }] });
  const split = await put(h, "/v1/shortcuts", { shortcuts: [{ label: "bad", steps: "text:hello, world" }] });
  expect(split.status).toBe(400);
  expect((await split.json()).error).toStartWith("shortcut \"bad\": ");
});
```

`server/test/config-feature.test.ts` (a new file; P1's own `server/test/config.test.ts` is never touched by this task; the hostd gets `configFeature(file)` with `file` a scratch JSON written first with `{ "machineName": "testbox", "origin": "<h.config.origin>", "peers": [] }`):
```ts
test("config changes apply at once; peers need a restart; bad values are refused", async () => {
  expect(await (await get(h, "/v1/config")).json()).toMatchObject({ previewRanges: "none", usageCollection: true, peers: [], restartNeeded: false });
  const r = await put(h, "/v1/config", { previewRanges: "3000-3999", usageCollection: false });
  expect(await r.json()).toMatchObject({ previewRanges: "3000-3999", usageCollection: false, restartNeeded: false });
  expect(h.config.previewRanges).toBe("3000-3999");
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ machineName: "testbox", previewRanges: "3000-3999", usageCollection: false });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(await (await put(h, "/v1/config", { peers: ["https://benacer-omarchy.tailafe04c.ts.net"] })).json()).toMatchObject({ restartNeeded: true });
  expect((await put(h, "/v1/config", { previewRanges: "9-x" })).status).toBe(400);
  expect((await put(h, "/v1/config", { peers: ["http://evil.example"] })).status).toBe(400);
  expect((await put(h, "/v1/config", { apiPort: 1 })).status).toBe(400);
});
```

`server/test/doctor.test.ts`:
```ts
test("doctor reports tmux mouse, extensions, events socket and binaries", async () => {
  const p = await pane(s, "mouse", "/bin/sh");
  s.tmux(p.socket, "set-option", "-g", "mouse", "off");
  mkdirSync(h.config.ompExtensionsDir, { recursive: true });
  copyFileSync(path.join(import.meta.dir, "..", "..", "omp-extension", "live-inbox.ts"), path.join(h.config.ompExtensionsDir, "live-inbox.ts"));
  const checks = ((await (await get(h, "/v1/doctor")).json()) as { checks: { id: string; ok: boolean }[] }).checks;
  const by = (id: string) => checks.find((c) => c.id === id)?.ok;
  expect(by("tmux-mouse:" + p.socket)).toBe(false);
  expect(by("extension:live-inbox")).toBe(true);
  expect(by("extension:porthole-events")).toBe(false);
  expect(by("events-socket")).toBe(true);
  expect(by("git")).toBe(true);
  s.tmux(p.socket, "set-option", "-g", "mouse", "on");
  const again = ((await (await get(h, "/v1/doctor")).json()) as { checks: { id: string; ok: boolean }[] }).checks;
  expect(again.find((c) => c.id === "tmux-mouse:" + p.socket)?.ok).toBe(true);
});
```

Shared test glue for these three files: the usual `Scratch`/`startTestHostd` `beforeAll`/`afterAll`, and a local `put(h, p, body)` built like `post` in `test/helpers/client.ts` with `method: "PUT"`. If `pane()` returns a socket path outside `cfg.tmuxSocketDir`, the doctor check id uses whatever socket path the registry's `listSockets` returns; adjust the expected id to that.

The installed case uses P1's `omp-extension/live-inbox.ts` (it exists once P1 is merged), not `porthole-events.ts`: Task 2 creates that file in the same group, so Task 11 cannot depend on it, and the test expects `extension:porthole-events` to be `false` because nothing installs it into the scratch `ompExtensionsDir`. Task 11 therefore stays in Group B.

- [ ] **Step 2: Run, watch them fail; Step 3: implement per the rules; Step 4: run again**

```bash
/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/shortcuts.test.ts server/test/config-feature.test.ts server/test/doctor.test.ts
```

Expected: FAIL before step 3, PASS after.

- [ ] **Step 5: Commit and push**

```bash
git add server/src/features/shortcuts.ts server/src/features/config.ts server/src/features/doctor.ts server/test/shortcuts.test.ts server/test/config-feature.test.ts server/test/doctor.test.ts
git commit -m "shortcuts, config and doctor endpoints"
git push
```

---

### Task 12: Wire up, the one real omp run, install the extension, README

**Depends on:** Tasks 1-11 merged into this branch, and **P1 Task 12 merged** (`docs/superpowers/plans/2026-10-13-p1-hostd-core.md`, Task 12): it creates `server/src/main.ts` (the `FEATURES` list and `configPath(env)`), which this task modifies and imports. If `server/src/main.ts` or `configPath` is missing, stop and report; do not create them here.

**Files (owned):** Modify `server/src/main.ts`, `README.md`. Create `server/test/live/events-once.ts`.

- [ ] **Step 1: Add the P2 features to `FEATURES` in `server/src/main.ts`**, after P1's five, in this order: `inboxFeature, uploadsFeature, diffFeature, previewFeature, usageFeature, voiceFeature, shortcutsFeature, configFeature(configPath(process.env)), doctorFeature` (each imported from its `features/<name>.ts`). Nothing else in `main.ts` changes.

- [ ] **Step 2: Run the whole suite**

```bash
/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test
```

Expected: all PASS (P1 and P2 tests). A failure here is fixed in the task that owns the file, never by editing a test to pass.

- [ ] **Step 3: Write `server/test/live/events-once.ts`** (acceptance P2.1 and P2.9 in one real run; SPEC 7 allows exactly one real omp run per extension). It uses only a scratch tmux server and a test hostd:
  1. `s = new Scratch()`; `tmpdir = path.join(s.root, "tmux")` (mode 0700). Every tmux call runs with `TMUX_TMPDIR=<tmpdir>` and `-L porthole-test`, so the socket is `<tmpdir>/tmux-<uid>/porthole-test` and Ben's real tmux servers are never listed or touched.
  2. Start a test hostd: `createHostd(s.config({ tmuxSocketDir: path.join(tmpdir, "tmux-" + uid) }), [sessionsFeature, sendFeature, inboxFeature])`. Its events socket is `cfg.runtimeDir/events.sock`.
  3. Make a scratch work folder `s.root/work` and start the pane: `tmux -L porthole-test new-session -d -s ask -x 160 -y 50 -c <work> "env PORTHOLE_EVENTS_SOCKET=<events.sock> /home/cymatic/.local/share/mise/installs/github-can1357-oh-my-pi/latest/omp --no-extensions -e <repo>/omp-extension/porthole-events.ts --no-session --model haiku"`.
  4. Wait up to 60 s for omp's input box (capture-pane changes and stays still for 2 s). Type the prompt with `send-keys -l` then `Enter`: "Use the ask tool exactly once to ask me: Which color? Options: red, green, blue. After my answer, reply with only the color I picked, in lowercase."
  5. Wait up to 120 s for an item in `GET /v1/inbox` whose question has options `["red","green","blue"]`, `open: true`, and `sessionId` equal to the scratch pane's id (the registry found the real omp pid). Print `INBOX: ok` or the reason.
  6. Print the pane's dialog rows exactly as captured (`capture-pane -p`), so the rows after the options (F16 **GUESS**: "Other…" row at index 3) are on record. If the row right after "blue" is not a free-text row, print `ROWS DIFFER` (Task 5's typed-answer steps must then be corrected; option answers are unaffected because they first move to the top).
  7. `POST /v1/inbox/<id>/answer {optionIndexes: [1]}` → expect 200. Wait up to 30 s for the item's question to show `open: false` (the extension's `question_closed`) and up to 60 s for the pane to show `green` after the dialog. Print `ANSWER: ok` or what was seen.
  8. Answer again → expect 409 "Answer this in the terminal". Print `CLOSED-READ-ONLY: ok`.
  9. P2.9: `await h.stop()` (the events socket disappears). Type "Reply with the single word pong" + `Enter`; wait up to 60 s for a new line `pong`. Print `OMP-WITHOUT-HOSTD: ok in <seconds> s` or the failure.
  10. Always (in `finally`): `TMUX_TMPDIR=<tmpdir> tmux -L porthole-test kill-server` (the scratch server only), `h.stop()` if still running, `s.cleanup()`. Exit 0 only when every line above printed `ok`.

- [ ] **Step 4: Run it once, and record the usage source on real numbers (P2.7)**

```bash
/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun run server/test/live/events-once.ts
```

Report every printed line word for word, including the captured dialog rows. Cost: one short haiku session, about 10 cents **GUESS** (SPEC 7 figure, not measured). SPEC section 7 allows one throwaway omp run per extension, and this is that run, so it needs no extra approval from Ben. It is never rerun: if it fails, report what failed and stop; a second run is a new decision for Ben.

For P2.7, one real read through a test hostd (no service restart needed): a throwaway script `/home/cortex/00-system/porthole/files/scratch/usage-once.ts` starts `startTestHostd(s, [usageFeature], { bin: { ...s.config().bin, omp: "/home/cymatic/.local/share/mise/installs/github-can1357-oh-my-pi/latest/omp" } })` with a fresh `Scratch` (so only the omp binary is real), calls `get(h, "/v1/usage")` once, prints the two windows (percent and reset time), stops the hostd, cleans the scratch folder; then delete the script. If it fails or returns no windows, P2 stops on that item with a question to Ben (SPEC 4.11), and never shows an estimate.

- [ ] **Step 5: Install the extension (only after step 4 printed all `ok`)**

```bash
install -D -m 0644 /home/cortex/00-system/porthole/repo/omp-extension/porthole-events.ts /home/cymatic/.omp/agent/extensions/porthole-events.ts
```

New omp sessions load it from their next start; running sessions are unchanged. Tell Ben this in the report (Needs Ben 4). The doctor's `extension:porthole-events` check turns `ok` once the running hostd has P2 code.

- [ ] **Step 6: README.** Add a "P2" section: the new endpoints (SPEC 5.3 list), where files go (`~/.local/state/porthole/uploads/<date>/`, `audio/`, `inbox.json`, `notify.json`, `shortcuts.json`; `$XDG_RUNTIME_DIR/porthole/events.sock`), the preview proxy (127.0.0.1:8798, published by `tailscale serve` on 8443; publishing it is P1's `deploy/serve.ts` job, P2 changes no Tailscale setting), how to read the doctor, that `voiceEnhance` is off by default and why (F10), and the shortcut-step rules: steps are comma-separated, so a `text:` step cannot contain a comma unless it is written `\,` (for example `text:ls\, -la` sends `ls, -la`); there is no `\\` escape, so a step cannot end in a literal backslash directly before a separator (`\,` is always a literal comma); and each step is trimmed, so trailing (and leading) spaces inside a `text:` step are dropped (`text:ls ` sends `ls`).

- [ ] **Step 7: Commit and push** (files by name)

```bash
git add server/src/main.ts server/test/live/events-once.ts README.md
git commit -m "P2: wire features, one real omp events run, README"
git push
```

Running the P2 code in the installed `porthole.service` needs a merge to `main` and a service restart: both wait for Ben's OK (repo rule, commit-and-push §3).

---

## Needs Ben (carried into the P2 run report)

1. **`voiceEnhance` stays off.** voxflow works through the clipboard and pastes into the focused window (F10), so running it from hostd could change what Ben has copied. Options: leave it off (recommended), or build a clipboard-free cleanup later.
2. **How often usage is read.** `omp usage --json -p anthropic -r` uses omp's stored Claude login and may update omp's own usage snapshot each time (F3; F4 output not yet seen). The plan runs it only when the app asks, at most once a minute (60 s cache, Task 9). Options: keep that (recommended), or turn `usageCollection` off so it never runs.
3. **Multi-select questions are read-only in P2.** SPEC asks for a Submit button, but the key sequence for omp's multi-select dialog is not verified. Options: answer them at the desk for now (planned), or spend one more throwaway omp run (about 10 cents **GUESS**) to record the keys.
4. **Installing `porthole-events.ts`.** Once installed (Task 12 step 5), it loads into every new omp session, Thalamus included at its next start. It never blocks omp (P2.9), but Ben should know it is there.
5. **Cancelled questions.** The plan treats an `ask` call that ends with `isError` as "cancelled" (**GUESS**: F14 shows `tool_execution_end` carries `isError`, but that omp marks a cancelled ask that way is not verified; see Task 2's event table). A wrong guess only mislabels the closed item; it never presses keys.

Settled, so not asked again: Ben chose "local voxtype only" for the voice engine, and the engine his voxtype runs is SenseVoice (F7), so Porthole passes no `--engine` (Task 10). The cost of the one real omp run is covered by SPEC section 7 (Task 12 step 4).

## Self-review

- **SPEC P2 coverage:** P2.1 extension events (T2 unit, T5 scratch-pane keys and read-only refusal, T12 real run); P2.2 lifetimes with a fake clock (T3); P2.3 one notify, replay until ack, 61st held (T4, T5); P2.4 upload path, 0600, 51 MB refused (T6); P2.5 staged/unstaged/untracked and non-repo (T7); P2.6 preview list, proxy, WebSocket, 8795/9224/unscanned refused (T8); P2.7 real numbers or stop (T1 step 1 gate, T9, T12 step 4); P2.8 WAV to text, failed audio kept (T10); P2.9 omp never slowed (T2 timing test, T12 step 3.9); P2.10 option/typed/Stop refused under live voice (T5) and a live-voice pane with an inbox folder still takes a message through the inbox route (T5 test "P2.10 live inbox"); P2.11 VRAM check before transcribing, after checking that the voxtype daemon is running (T10 live script).
- **Names checked across tasks:** `HostdConfig` P2 fields (`previewPort`, `previewRanges`, `usageCollection`, `voiceEnhance`, `ompExtensionsDir`, `bin.git/voxtype/voxflow/ss/nvidiaSmi/omp`), `parseRanges`, `safeGit`, `EventsHub.onOpen/onMessage/receive/sendTo`, `Auth.identify`, `SessionInfo.dirty`, `inboxFeature`, `uploadsFeature`, `diffFeature`, `previewFeature`, `usageFeature`, `voiceFeature`, `shortcutsFeature`, `configFeature(file)`, `doctorFeature`, `Answer`/`parseAnswer`/`answerSteps`/`chunks`, `READ_ONLY`/`AT_DESK`, `PORTHOLE_EVENTS_SOCKET` are spelled the same in every task that uses them.
- **Could not verify (each has a first check):** F4 `omp usage --json` shape (Task 1 step 1); F16 dialog rows after the options and the cancelled-ask marker (Task 12 step 3.6, printed rows); voxtype's text for the test WAV (Task 10 live script prints it); the voxtype daemon's unit name (Task 10 step 5); `--model haiku` resolving to a real model (Task 12 step 3; only help text was read, F2).
- **Honest gap:** Tasks 6-11 give interfaces, rules and the key tests, not every line of implementation, to keep this plan within its budget; the rules are specific enough to build from, and each task's tests are the acceptance.

## Execution handoff

Run after P1 is merged into `feat/p1-hostd` (all twelve P1 tasks, above all P1 Task 12, which creates `server/src/main.ts` and `configPath` for P2 Task 12) and its suite is green. Work on a new branch `feat/p2-hostd` from that point, in its own worktree (`omp-worktree new p2-hostd`). Order: Group A (Task 1), then Group B in parallel (Tasks 2, 3, 4, 6, 7, 8, 9, 10, 11; each owns only its listed files), then Group C (Task 5), then Group D (Task 12). Each task ends with its own commit and push of its named files. Merging to `main` and restarting `porthole.service` wait for Ben's OK. Recommended executor skill: `skill://sp-subagent-driven-development`.
