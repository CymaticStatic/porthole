# Porthole P1: hostd core (desktop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `porthole-hostd` phase P1 on the desktop: session discovery with status, chat stream, screen, send (live inbox / tmux / herdr, exactly once), keys, PTY, auth, access log, systemd unit, `tailscale serve`, and `live-inbox.ts` moved into this repo and installed, exactly as `docs/SPEC.md` section 8 P1 items 1-6 define.

**Architecture:** One Bun process (`server/src/main.ts`) bound to 127.0.0.1:8797. Each spec module (5.1) is its own file under `server/src/features/` and exports a `FeatureFactory` (routes, channels, optional start/stop); `server/src/hostd.ts` (`createHostd`) runs auth and the access log in front of every route and channel, and `main.ts` composes the features. P2 modules (`events` socket, `push`, `uploads`, `diff`, `preview`, `usage`, `voice`, `shortcuts`, `doctor`) are added later as new files plus one entry each in `main.ts`; no P1 file moves. Every test runs an in-process hostd whose config points at a scratch tmux socket folder, fake `herdr` / `pactl` / `tailscale` programs and fixture transcripts.

**Tech Stack:** TypeScript on Bun 1.4.2 (no npm dependencies; Bun runs `.ts` directly), `bun test`, tmux 3.7c, herdr 0.9.1 CLI, pactl 17.0, tailscale 1.102.4, systemd user units.

## Global Constraints

Copied verbatim from `docs/SPEC.md` (v2, commit e484a25). Every task's requirements include these.

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

Code rules for every task: no `any`; static imports only; `import type` for type-only imports; `Record` tables for static key mappings; never `pkill`/`killall`; tests never use `rm -r` from a shell (the scratch harness removes its own folder with `rmSync`).

Command prefix used below: every `bun` command is the absolute path `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun`, run from the repo root `/home/cortex/00-system/porthole/repo`.

---

## Verified facts

Established read-only on 2026-10-13 by the planning agent before writing this plan. Throwaway probes live in `/home/cortex/00-system/porthole/files/scratch/`. Every scratch tmux server was started inside a scratch folder and stopped with `kill-server` on its own name.

1. **`tailscale serve` can forward to a Unix socket.** `tailscale version` → `1.102.4`. `tailscale serve --help` line 15: `On Unix-like systems, you can also specify a Unix domain socket (e.g., unix:/tmp/myservice.sock).`, example line 28: `$ tailscale serve unix:/var/run/myservice.sock`. Flags present: `--bg`, `--https value`, `--set-path value`, `--tcp value`, `--tls-terminated-tcp value`, `--yes`; subcommands `status [--json]`, `reset`.
2. **Current serve config is empty.** `tailscale serve status` → `No serve config`; `tailscale serve status --json` → `{}`. `tailscale debug prefs` shows `"OperatorUser": "cymatic"`, so `tailscale serve --bg` should not need sudo ([INFERENCE]; Task 12 stops and hands Ben the command if it does).
3. **Machine names.** `tailscale whois --json 100.78.36.107` → `.Node.Name` `bendesk-omarchy.tailafe04c.ts.net.`, `.UserProfile.LoginName` `bengovernale@gmail.com`. `tailscale status --json` peers: `bencell.tailafe04c.ts.net.` (HostName `Pixel 7 Pro`, 100.120.182.107), `benacer-omarchy.tailafe04c.ts.net.` (100.124.43.2), and a **different** Windows node `benacer.tailafe04c.ts.net.` (HostName `LAPTOP-ILGLMDAS`, 100.121.87.19). The node allowlist therefore compares the exact first DNS label.
4. **Identity headers.** A string search of the `tailscaled` binary (earlier in this session) found `Tailscale-User-Login`, `Tailscale-User-Name`, `Tailscale-User-Profile-Pic`, `Tailscale-App-Capabilities`, `Tailscale-Headers-Info` and `X-Forwarded-For`, and **no node-name header**. So hostd takes the device address from `X-Forwarded-For` and asks `tailscale whois --json <ip>` for the node. **Could not verify** (needs Porthole's own serve entry, which only Task 12 adds): that `tailscale serve` really sets these headers on requests from this machine itself, and whether a client-supplied `X-Forwarded-For` is kept in front of the real address. hostd uses the **last** `X-Forwarded-For` entry, and Task 12 live step L3 checks both points through the real serve entry (and switches on `singleForwardedFor` when serve writes a single entry).
5. **Bun.** `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun --version` → `1.4.2`. Probe `scratch/probe-unix.ts`: `Bun.serve({ unix })` answers (`fetch` status 200), `server.requestIP(req)` is `null` on a Unix socket, the socket file is created mode 755, and no API exposes the peer's uid. Probes `scratch/probe-peercred-ffi.ts` / `probe-peercred-ffi2.ts`: only a raw `Bun.listen` socket exposes an undocumented `fd`, where `bun:ffi` `getsockopt(fd, SOL_SOCKET=1, SO_PEERCRED=17)` returned uid 1000; `Bun.serve` and `node:http` give no fd. **Result: SO_PEERCRED is not available for the HTTP server, so hostd runs in 127.0.0.1 mode** (SPEC 5.4 fallback, decision 10.13) and the README states the limit.
6. **Bun PTY works.** Probe `scratch/probe-pty.ts` against `tmux -L porthole-plancheck` (tmux 3.7c, server started with `new-session -d -s probe -x 120 -y 40 /bin/sh`, then `tmux -L porthole-plancheck kill-server`): `typeof Bun.Terminal` → `function`; `Bun.spawn([tmux,"-L","porthole-plancheck","attach","-t","=probe"], { terminal: { cols, rows, data(term, chunk) } })` gave `proc.terminal` with `write`/`resize`/`close`. Output: `clients while attached: "2751060 /dev/pts/52 90x25\n2751068 /dev/pts/53 100x30"`, `write returned: 21`, `pane shows typed text: true`, `pane text: "sh-5.3$ echo porthole-pty-ok|porthole-pty-ok|sh-5.3$"`, `after resize: "2751060 90x25\n2751068 80x24"`, `our client line: "2751068 /dev/pts/53"`, after `detach-client -t /dev/pts/53`: `child exit code: 0`, `clients after: "2751060 /dev/pts/52"` (the other client stayed). The tmux client pid equals the spawned child's pid. Two earlier runs reported `pane shows typed text: false` because they captured with target `=probe` after 800 ms; the target `=probe:0.0` works. Prior art for comparison: mission-control slice 1 uses Rust `portable-pty` 0.9 with `@xterm/xterm` 6.0 and `@xterm/addon-fit` 0.11, binary WebSocket frames for raw bytes both ways and text frames `{"type":"resize","cols","rows"}`; `skill://embed-omp-pty-terminal-in-local-app` uses a Python PTY. P1 keeps the same wire protocol with `Bun.spawn({ terminal })`.
7. **tmux details.** `which tmux` → `/usr/bin/tmux`, `tmux -V` → `tmux 3.7c`. `TMUX_TMPDIR=<dir> tmux -L porthole-test-1 new-session -d -s s1 /bin/sh` creates `<dir>/tmux-1000/porthole-test-1`; `tmux -S <dir>/tmux-1000/porthole-test-1 list-sessions` sees it. After `kill-server` the socket file **stays**, and listing it prints `no server running on <path>` with exit 1. `list-panes -a -F` with `\x1f` separators prints the separator raw (od: `m y   s 037 0 037 0 037 342 240 213 ...`), and a pane title keeps omp's Braille spinner (`⠋ omp: title`). The default `pane_title` is the hostname (`bendesk-omarchy`). `send-keys -t '=s:0.0' -l -- '-v dash-ok'` typed the text (the `--` stops `-v` being read as a flag). Ben's real socket folder `/tmp/tmux-1000` held `default` and a Thalamus test socket on 2026-10-13: tests must never create sockets there, so the harness sets `TMUX_TMPDIR` to its scratch folder.
8. **Fake omp is detectable like a real one.** `/proc/164511/comm` of a real omp → `omp`; `ps -C omp` shows nested omp processes (child omps have an omp parent). A two-line `#!/bin/sh` script named `omp` (`exec 3<"$1"` then `while :; do sleep 1; done`) started as a scratch tmux pane command gave `pane_pid` with comm `omp` and `/proc/<pid>/fd` → the fixture `.jsonl`. `/proc/164511/fd` of the real omp contains exactly one `.jsonl`.
9. **herdr help text (never ran read/prompt/attach for real).** `which herdr` → `/usr/bin/herdr`, `herdr --version` → `herdr 0.9.1`. `herdr agent --help`: `list, get, read, send-keys, prompt, rename, focus, wait, attach ("Attach directly to an agent terminal"), start, explain`. `herdr agent read --help`: `Usage: herdr agent read <TARGET> [OPTIONS]`, `--source <SOURCE>` (`visible, recent, recent-unwrapped, detection`, default recent), `--lines <N>`, `--format <FORMAT>` (`text, ansi`). `herdr agent prompt --help`: `Usage: herdr agent prompt <TARGET> <TEXT> [OPTIONS]`, `--wait`, `--until <STATUS>` (`idle, working, blocked, done, unknown`). `herdr agent attach --help`: `Usage: herdr agent attach <TARGET> [OPTIONS]`, only option `--takeover`, no description. herdr's own skill text (`herdr --skill`, saved to `scratch/herdr-skill.md`): `herdr agent send-keys reviewer esc`, `herdr agent send-keys reviewer ctrl+c`, "Herdr validates all keys before writing any bytes"; IDs look like `w1`, `w1:t1`, `w1:p1`; `blocked` means an approval or question UI is showing.
10. **herdr JSON shapes** from herdr's API schema (`scratch/herdr-api-schema.json`, protocol 22): success `{"id","result":{...}}`; `agent list` → `result {"type":"agent_list","agents":[AgentInfo]}`; read → `result {"type":"pane_read","read":{"pane_id","workspace_id","tab_id","source","format","text","revision","truncated"}}`; prompt → `result {"type":"agent_prompted","agent":AgentInfo}`; error `{"id","error":{"code","message"}}` (printed on stderr, exit 1; exit 2 for usage errors). AgentInfo required: `terminal_id, agent_status (idle|working|blocked|done|unknown), workspace_id, tab_id, pane_id, focused, revision`; optional `agent, name, cwd, foreground_cwd, terminal_title_stripped, agent_session`. Thalamus's fake (`thalamus/repo/tools/question-watch/tests/fake_herdr.py`) prints `{"result": {"agents": []}}` for `agent list`. **Could not verify** (SPEC 4.1 allows only help text on the real herdr): that the CLI prints these exact envelopes for `agent read` / `agent prompt`, that the CLI accepts `--` before positionals, herdr key names other than `esc` and `ctrl+c`, and what `agent attach` (with or without `--takeover`) does to Ben's own herdr client. hostd parses `read` output as JSON and falls back to raw text; P1 shows herdr panes **read-only** in the terminal view (SPEC 4.4 "Otherwise show a read-only screen and say so") and asks Ben (Needs-Ben item 1).
11. **live-inbox source.** Repo `/home/cymatic/Projects/idea-board`, `git log --oneline -1 94bcde4` → `94bcde4 live-inbox (parked): omp extension + omp-voice send/T3 delivery into live-mode chats; not installed, resume after Moshi`; `git branch --contains 94bcde4` → `+ feat/live-inbox` (checked out in another worktree). `git ls-tree -r --name-only 94bcde4 -- live-inbox/` → `live-inbox/README.md`, `live-inbox/live-inbox.ts`, `live-inbox/omp-voice`. `git show 94bcde4:<path>` sizes: `live-inbox.ts` 124 lines / 4541 bytes (sha256 prefix `ba0db0c7e79566e4`), `README.md` 46 / 2613, `omp-voice` 1068 / 39413. The extension: inbox `$XDG_RUNTIME_DIR/omp-inbox/<omp pid>/` (0700), created only when `ctx.hasUI`; takes files matching `/^[A-Za-z0-9][A-Za-z0-9._-]*\.msg$/` in name order, max 512 KiB (bigger files are deleted with a warning), sends `pi.sendUserMessage(text.trim())`, polls every 1 s plus `fs.watch`, removes its folder on `session_shutdown`/exit. `omp-voice` `deliver()` writes `"." + name + ".part"`, renames to `name`, then waits until the file is gone; it matches live voice by `application.name in {"omp","oh-my-pi"}` and `media.name == "voice"`, strips spinner glyphs `[\u2800-\u28ff]`, and checks `/proc/<pid>/comm == "omp"`. `/run/user/1000/omp-inbox` exists (0700).
12. **`cymatic.session-status` entry** (`~/.omp/agent/extensions/session-status.ts` lines 25-50, 120-133, 245-251): a transcript line `{"type":"custom","customType":"cymatic.session-status","data":SessionStatus,"id","parentId","timestamp"}` where `SessionStatus = {schema:"cymatic.session-status/v2", status, derivedStatus, hold, questionCount, questions:[{number,title,text,priority:{local,global}}], priority:{project,global}, tags:{effective,auto,manual,removed}, recordedAt, source:{entryId, trigger:"reply"|"turn-start"|"manual"|"derived"}}`; `status` is one of `awaiting-decision, in-progress, blocked, interrupted, no-report, abandoned, fulfilled`. It finds its transcript as the open fd whose `path.dirname(path.dirname(target)) === ~/.omp/agent/sessions`.
13. **omp transcript line shapes** (omp 18.10.3; this session's own file `~/.omp/agent/sessions/--home-cortex-00-system-porthole-repo--/2026-10-12T18-10-56-194Z_01a1314f-....jsonl`, line types counted with a script): line 1 `{"type":"title","v":1,"title","source","updatedAt","pad":"<spaces>"}` (padded so it can be rewritten in place, [INFERENCE]: byte offsets of later lines stay stable), line 2 `{"type":"session","version":3,"id","timestamp","cwd"}`; then `{"type":"message","id","parentId","timestamp","message":{"role":"user"|"assistant"|"toolResult"|"developer","content":[...]}}` with content blocks `{"type":"text","text"}`, `{"type":"thinking",...}`, `{"type":"toolCall","id","name","arguments","intent"}`, assistant `stopReason`; `{"type":"custom","customType","data",...}`; `{"type":"custom_message","customType","content":"<string>","display","attribution","details"?,"id","parentId","timestamp"}`; plus `model_change`, `thinking_level_change`, `model_usage`, `credential_pin`, `title_change`. **No `live-delegation` line exists in this transcript** (no live voice was used). The omp binary sends it as `sendCustomMessage({ customType: "live-delegation", content: t, display: true, attribution: "agent" }, { triggerTurn: true })` (`LIVE_DELEGATION_MESSAGE_TYPE = "live-delegation"`), so its line is `{"type":"custom_message","customType":"live-delegation","content":"<text>",...}`: **[INFERENCE]** from the `custom_message` lines above, not seen on disk.
14. **pactl.** `pactl --version` → `pactl 17.0-98-gb096`. `pactl -f json list source-outputs` → a JSON array; each row has `index, mute, corked, properties{...}`; `properties["application.process.id"]` is a **string** (`"164511"`). Live sample (2 rows): `{"app":"parec","media":"parec","pid":"7748"}` and `{"app":"omp","media":"voice","pid":"164511"}`.
15. **Binaries and unit prior art.** `which tailscale pactl git systemctl` → `/usr/bin/...` for all. `systemctl --user cat thalamus-mailbox.service`: `Type=simple`, `Restart=on-failure`, `RestartSec=5`, `UMask=0077`, `WantedBy=default.target`.

---

## File Structure

```
package.json                        name, version 0.1.0, test/hostd scripts; no dependencies (Task 1)
.gitignore                          node_modules/ (Task 1)
README.md                           what hostd is, install, config, 127.0.0.1-mode limit (Task 12)
deploy/porthole.service             systemd user unit (Task 12)
deploy/install.sh                   snapshot HEAD into ~/.local/share/porthole/hostd/<sha>, enable unit (Task 12)
deploy/serve.ts                     adds Porthole's two tailscale serve entries, never touches others (Task 12)
omp-extension/live-inbox.ts         byte copy of idea-board 94bcde4:live-inbox/live-inbox.ts (Task 7)
omp-extension/README.md             provenance, install rule, proof run (Task 7)
server/src/json.ts                  asRecord / asString / asArray narrowing helpers (Task 1)
server/src/config.ts                HostdConfig, defaults, load + validate, init from tailscale (Task 1)
server/src/exec.ts                  run() subprocess helper with timeout; cleanEnv() (Task 1)
server/src/sessions/ids.ts          session id encode/decode (Task 2)
server/src/sessions/tmux.ts         socket listing, pane listing, capture, send-keys (Task 2)
server/src/sessions/herdr.ts        herdr agent list/read/prompt/send-keys (Task 2)
server/src/sessions/procs.ts        /proc: omp pid in a pane, its transcript, its inbox (Task 3)
server/src/sessions/livevoice.ts    pactl source-outputs → live-voice omp pids (Task 3)
server/src/sessions/status.ts       transcript status entry and herdr state → session status (Task 3)
server/src/sessions/registry.ts     scan → SessionTree, change listeners (Task 8)
server/src/transcript/parse.ts      transcript line → chat items (Task 4)
server/src/transcript/tail.ts       byte-offset pages and a follower (Task 4)
server/src/auth/auth.ts             X-Porthole, exact Origin, CORS, identity, local token, X-Forwarded-For rule (Task 5)
server/src/auth/identity.ts         tailscale whois node lookup with cache (Task 5)
server/src/auth/localtoken.ts       $XDG_RUNTIME_DIR/porthole/local-token (Task 5)
server/src/auth/accesslog.ts        ~/.local/state/porthole/access.log (Task 5)
server/src/deliver/sentlog.ts       sent.jsonl record per clientMsgId (Task 6)
server/src/deliver/inbox.ts         write-then-rename into a live inbox, wait until taken (Task 6)
server/src/deliver/deliver.ts       Deliverer: inbox / tmux / herdr, exactly once, pending reconcile (Task 10)
server/src/deliver/keys.ts          key-step grammar (SPEC 4.4) and key names per route (Task 10)
server/src/router.ts                Route / Channel / Feature / FeatureDeps / FeatureFactory types, matcher, json() (Task 8)
server/src/hostd.ts                 createHostd: Bun.serve, auth → route → access log, WebSocket dispatch, feature start/stop (Task 8)
server/src/version.ts               VERSION (Task 8)
server/src/events/hub.ts            /v1/events client set and broadcast (Task 8)
server/src/features/machine.ts      GET /v1/machine (Task 8)
server/src/features/sessions.ts     GET /v1/sessions, WS /v1/events (Task 8)
server/src/features/chat.ts         GET + WS /v1/sessions/:id/chat, GET /v1/sessions/:id/screen (Task 9)
server/src/features/send.ts         POST send, GET sends, POST keys; reconcile timer (Task 10)
server/src/features/pty.ts          WS /v1/sessions/:id/pty (Task 11)
server/src/main.ts                  config, compose features, start, signals; `init-config` (Task 12)
server/test/helpers/scratch.ts      Scratch: scratch tmux servers, fakes, fixtures, cleanup (Task 1)
server/test/helpers/client.ts       in-process test hostd, local headers, raw upgrade (Task 8)
server/test/fakes/herdr.ts          fake herdr 0.9.1 (Task 1)
server/test/fakes/pactl.ts          fake pactl (Task 1)
server/test/fakes/tailscale.ts      fake tailscale whois/status (Task 1)
server/test/fixtures/status-needs-you.jsonl, status-working.jsonl, status-done.jsonl (Task 3)
server/test/fixtures/chat-basic.jsonl (Task 4)
server/test/*.test.ts               the test files named in each task's Files list
server/test/live/live-inbox-once.ts the single throwaway omp run (Task 10)
server/test/live/auth-live.ts       P1.5 checks against the installed hostd (Task 12)
```

This list and the per-task **Files (owned)** lists name the same files; the task lists are the authority.

Where P2 slots in without moving P1 files: `server/src/events/socket.ts` + `server/src/events/inbox.ts` (extension socket, inbox state; `events/hub.ts` gains `notify`/`ack`), and new features `server/src/features/push.ts`, `uploads.ts`, `diff.ts` (adds `dirty` to `SessionInfo` in `sessions/registry.ts`), `preview.ts` (second listener on 8798), `usage.ts`, `voice.ts`, `shortcuts.ts` (uses `parseSteps` from `deliver/keys.ts`), `doctor.ts`, plus `omp-extension/porthole-events.ts`; each new feature is one more `FeatureFactory` in `main.ts`'s list.

## Parallel groups and file ownership

| Group | Tasks (run in parallel inside a group) | Needs |
|---|---|---|
| G0 | Task 1 | nothing |
| G1 | Tasks 2, 3, 4, 5, 6, 7 | Task 1 |
| G2 | Task 8 | Tasks 2, 3, 5, 6 |
| G3 | Tasks 9, 10, 11 | Task 8; Task 9 also Task 4; Task 10 also Tasks 6 and 7 |
| G4 | Task 12 | all |

Each task lists the only files it may create or change. No file appears in two tasks. Builders working in parallel each use their own worktree (`omp-worktree new p1-task-<n>`) and stage files by name.

---

### Task 1: Foundation — package, config, subprocess helper, scratch harness, fakes

**Files (owned):**
- Create: `package.json`, `.gitignore`
- Create: `server/src/json.ts`, `server/src/config.ts`, `server/src/exec.ts`
- Create: `server/test/helpers/scratch.ts`
- Create: `server/test/fakes/herdr.ts`, `server/test/fakes/pactl.ts`, `server/test/fakes/tailscale.ts`
- Test: `server/test/config.test.ts`, `server/test/harness.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `json.ts`: `asRecord(v: unknown): Record<string, unknown>`, `asString(v: unknown): string`, `asArray(v: unknown): unknown[]`.
  - `config.ts`: `interface Binaries { tmux; herdr; pactl; tailscale: string }`; `interface HostdConfig { machineName: string; origin: string; peers: string[]; host: "127.0.0.1"; apiPort: number; tmuxSocketDir: string; bin: Binaries; transcriptDirs: string[]; inboxRoot: string; runtimeDir: string; stateDir: string; allowedLogin: string; allowedNodes: string[]; thalamusDir: string; pendingAfterMs: number; scanIntervalMs: number; singleForwardedFor: boolean }`; `type ConfigOverrides = Omit<Partial<HostdConfig>, "bin"> & { bin?: Partial<Binaries> }`; `defaultConfig(): HostdConfig`; `validateConfig(c: HostdConfig): string[]`; `loadConfig(file: string | null, overrides?: ConfigOverrides): HostdConfig` (throws on problems); `selfFromTailscale(bin: string): Promise<{ machineName: string; origin: string }>`; `writeInitialConfig(file: string, tailscaleBin: string): Promise<string>`.
  - `exec.ts`: `interface RunResult { code: number; stdout: string; stderr: string; timedOut: boolean }`; `run(argv: string[], opts?: { timeoutMs?: number; env?: Record<string, string>; input?: string }): Promise<RunResult>` (`input` is written to the program's stdin; missing binary → code 127, never throws); `cleanEnv(extra?: Record<string, string>): Record<string, string>` (process env without `TMUX`, `TMUX_PANE`).
  - `scratch.ts`: `class Scratch` with fields `root, tmuxTmp, socketDir, fakeBin, transcripts, inboxRoot, runtimeDir, stateDir, thalamusDir` and methods `config(o?: ConfigOverrides): HostdConfig`, `newTmuxServer(session: string, command?: string, cwd?: string): string` (returns socket name `porthole-test-<n>`), `tmux(socket: string, ...args: string[]): string`, `transcript(fixture: string, name?: string): string`, `writeTranscript(name: string, text: string): string`, `ompCommand(transcriptPath: string): string`, `panePid(socket: string, target: string): number`, `setHerdrAgents(a: HerdrAgentFixture[]): void`, `setHerdrScreen(paneId: string, text: string): void`, `failHerdrPrompt(on: boolean): void`, `setLiveVoicePids(pids: number[]): void`, `breakPactl(on: boolean): void`, `setWhois(map: Record<string, { node: string; login: string }>): void`, `fakeCalls(name: "herdr" | "pactl" | "tailscale"): string[][]`, `fakeFile(name: string): string`, `cleanup(): void`; `waitFor(check: () => boolean | Promise<boolean>, timeoutMs?: number, stepMs?: number): Promise<void>`; `FIXTURES: string`; `interface HerdrAgentFixture`.
  - Fake programs (sh wrappers written by `Scratch` into `fakeBin`, each `exec`s Bun on the `.ts` file with `FAKE_DIR=<fakeBin>`): `herdr agent list|read|prompt|send-keys`, `pactl -f json list source-outputs`, `tailscale whois --json <ip>` / `status --json`. Each appends its argv as one JSON line to `<fakeBin>/<name>-calls.log`.

- [ ] **Step 1: Write the failing tests**

`server/test/config.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defaultConfig, loadConfig, validateConfig, writeInitialConfig } from "../src/config";
import { Scratch } from "./helpers/scratch";

let s: Scratch;
beforeEach(() => { s = new Scratch(); });
afterEach(() => s.cleanup());

test("defaults match the spec", () => {
  const c = defaultConfig();
  expect(c.host).toBe("127.0.0.1");
  expect(c.apiPort).toBe(8797);
  expect(c.bin).toEqual({ tmux: "/usr/bin/tmux", herdr: "/usr/bin/herdr", pactl: "/usr/bin/pactl", tailscale: "/usr/bin/tailscale" });
  expect(c.tmuxSocketDir).toMatch(/^\/tmp\/tmux-\d+$/);
  expect(c.allowedLogin).toBe("bengovernale@gmail.com");
  expect(c.allowedNodes).toEqual(["bencell", "benacer-omarchy", "bendesk-omarchy"]);
  expect(c.pendingAfterMs).toBe(30_000);
  expect(c.singleForwardedFor).toBe(false);
  expect(c.stateDir.endsWith("/.local/state/porthole")).toBe(true);
});

test("file values override defaults and test overrides win; bin merges per key", () => {
  const file = path.join(s.root, "hostd.json");
  writeFileSync(file, JSON.stringify({ machineName: "bendesk-omarchy", origin: "https://bendesk-omarchy.tailafe04c.ts.net", bin: { herdr: "/opt/herdr" } }));
  const c = loadConfig(file, { apiPort: 0, bin: { pactl: "/x/pactl" } });
  expect(c.machineName).toBe("bendesk-omarchy");
  expect(c.apiPort).toBe(0);
  expect(c.bin).toEqual({ tmux: "/usr/bin/tmux", herdr: "/opt/herdr", pactl: "/x/pactl", tailscale: "/usr/bin/tailscale" });
});

test("validation rejects relative binaries, origins with ports, and non-loopback hosts", () => {
  const c = { ...defaultConfig(), machineName: "m", origin: "https://m.example.ts.net:8443", bin: { ...defaultConfig().bin, tmux: "tmux" } };
  const problems = validateConfig(c);
  expect(problems.join("\n")).toContain("origin");
  expect(problems.join("\n")).toContain("bin.tmux");
  expect(() => loadConfig(null, { machineName: "m", origin: "https://m.example.ts.net", host: "0.0.0.0" as "127.0.0.1" })).toThrow("host");
});

test("init-config reads this machine's name from tailscale and never overwrites", async () => {
  const file = path.join(s.root, "cfg", "hostd.json");
  const msg = await writeInitialConfig(file, path.join(s.fakeBin, "tailscale"));
  expect(msg).toContain("https://testhost.example.ts.net");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ machineName: "testhost", origin: "https://testhost.example.ts.net", peers: [] });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(await writeInitialConfig(file, path.join(s.fakeBin, "tailscale"))).toContain("kept existing");
});
```

`server/test/harness.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import path from "node:path";
import { run } from "../src/exec";
import { Scratch, waitFor } from "./helpers/scratch";

let s: Scratch;
beforeEach(() => { s = new Scratch(); });
afterEach(() => s.cleanup());

test("scratch tmux servers live in the scratch folder, never in Ben's /tmp/tmux-<uid>", () => {
  const sock = s.newTmuxServer("one");
  expect(existsSync(path.join(s.socketDir, sock))).toBe(true);
  expect(existsSync(path.join("/tmp", "tmux-" + process.getuid?.(), sock))).toBe(false);
  expect(s.tmux(sock, "list-sessions", "-F", "#{session_name}").trim()).toBe("one");
});

test("fake herdr prints the API envelope and logs every call", async () => {
  s.setHerdrAgents([{ terminal_id: "t1", agent_status: "blocked", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", focused: false, revision: 1, name: "rev" }]);
  const r = await run([path.join(s.fakeBin, "herdr"), "agent", "list"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).result.type).toBe("agent_list");
  expect(JSON.parse(r.stdout).result.agents[0].pane_id).toBe("w1:p1");
  const p = await run([path.join(s.fakeBin, "herdr"), "agent", "prompt", "--", "w1:p1", "hi"]);
  expect(p.code).toBe(1);
  expect(JSON.parse(p.stderr).error.code).toBe("agent_blocked");
  expect(s.fakeCalls("herdr")).toEqual([["agent", "list"], ["agent", "prompt", "--", "w1:p1", "hi"]]);
});

test("fake pactl reports live voice rows with string pids, or fails on demand", async () => {
  s.setLiveVoicePids([4242]);
  const r = await run([path.join(s.fakeBin, "pactl"), "-f", "json", "list", "source-outputs"]);
  expect(JSON.parse(r.stdout)[0].properties["application.process.id"]).toBe("4242");
  s.breakPactl(true);
  expect((await run([path.join(s.fakeBin, "pactl"), "-f", "json", "list", "source-outputs"])).code).toBe(1);
});

test("a fake omp pane has comm 'omp' and holds its transcript open", async () => {
  const t = s.writeTranscript("harness.jsonl", '{"type":"session"}\n');
  const sock = s.newTmuxServer("chat", s.ompCommand(t));
  let pid = 0;
  await waitFor(() => {
    pid = s.panePid(sock, "=chat:0.0");
    return existsSync("/proc/" + pid + "/comm") && readFileSync("/proc/" + pid + "/comm", "utf8").trim() === "omp";
  });
  const targets = readdirSync("/proc/" + pid + "/fd").map((fd) => { try { return readlinkSync("/proc/" + pid + "/fd/" + fd); } catch { return ""; } });
  expect(targets).toContain(t);
});

test("cleanup stops the scratch servers and removes the folder", () => {
  const sock = s.newTmuxServer("gone");
  const root = s.root;
  s.cleanup();
  expect(existsSync(root)).toBe(false);
  expect(Bun.spawnSync(["/usr/bin/tmux", "-S", path.join(root, "tmux", "tmux-" + process.getuid?.(), sock), "ls"]).exitCode).not.toBe(0);
  s = new Scratch();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/config.test.ts server/test/harness.test.ts`
Expected: FAIL, `Cannot find module '../src/config'` (and `./helpers/scratch`).

- [ ] **Step 3: Write the implementation**

`package.json`:

```json
{
  "name": "porthole",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test server/test",
    "hostd": "bun server/src/main.ts"
  }
}
```

`.gitignore`:

```
node_modules/
```

`server/src/json.ts`:

```ts
// Narrowing helpers for JSON read from other programs (herdr, pactl, tailscale, transcripts).

export function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
```

`server/src/exec.ts`:

```ts
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

function spawnPiped(argv: string[], env: Record<string, string>, input: string | undefined) {
  return Bun.spawn(argv, { stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe", env });
}

export async function run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  let proc: ReturnType<typeof spawnPiped>;
  try {
    proc = spawnPiped(argv, opts.env ?? cleanEnv(), opts.input);
  } catch (err) {
    return { code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err), timedOut: false };
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, opts.timeoutMs ?? 5000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr, timedOut };
}
```

`server/src/config.ts`:

```ts
// hostd configuration (SPEC 4.1): ~/.config/porthole/hostd.json over built-in defaults.
// Tests pass overrides that point every path at a scratch folder and every binary at a fake.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { asRecord, asString } from "./json";
import { run } from "./exec";

export interface Binaries { tmux: string; herdr: string; pactl: string; tailscale: string }

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
    bin: { tmux: "/usr/bin/tmux", herdr: "/usr/bin/herdr", pactl: "/usr/bin/pactl", tailscale: "/usr/bin/tailscale" },
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
  };
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
```

`server/test/fakes/herdr.ts`:

```ts
// Fake herdr 0.9.1 for tests (shapes from herdr's API schema, plan Verified facts 10).
// State in $FAKE_DIR: herdr-agents.json (AgentInfo[]), herdr-screen-<pane with ":"→"_">.txt,
// herdr-fail-prompt (exists → `agent prompt` fails). Logs: herdr-calls.log (argv per line),
// herdr-prompts.log and herdr-keys.log (one JSON line per delivered prompt / key batch).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

interface FakeAgent { pane_id: string; workspace_id: string; tab_id: string; agent_status: string }

const dir = process.env.FAKE_DIR ?? "";
const argv = process.argv.slice(2);
appendFileSync(path.join(dir, "herdr-calls.log"), JSON.stringify(argv) + "\n");

function ok(result: Record<string, unknown>): never {
  process.stdout.write(JSON.stringify({ id: "fake", result }) + "\n");
  process.exit(0);
}
function fail(code: string, message: string): never {
  process.stderr.write(JSON.stringify({ id: "fake", error: { code, message } }) + "\n");
  process.exit(1);
}
function agents(): FakeAgent[] {
  const f = path.join(dir, "herdr-agents.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as FakeAgent[]) : [];
}
function find(target: string | undefined): FakeAgent {
  return agents().find((a) => a.pane_id === target) ?? fail("agent_not_found", "no agent " + String(target));
}

const [group, cmd, ...rest] = argv;
const args = rest[0] === "--" ? rest.slice(1) : rest;
if (group !== "agent") fail("unsupported", "fake herdr supports only agent commands");
if (cmd === "list") ok({ type: "agent_list", agents: agents() });
if (cmd === "read") {
  const a = find(args[0]);
  const f = path.join(dir, "herdr-screen-" + a.pane_id.replace(/:/g, "_") + ".txt");
  ok({ type: "pane_read", read: { pane_id: a.pane_id, workspace_id: a.workspace_id, tab_id: a.tab_id, source: "recent", format: "text", text: existsSync(f) ? readFileSync(f, "utf8") : "", revision: 1, truncated: false } });
}
if (cmd === "prompt") {
  const a = find(args[0]);
  if (existsSync(path.join(dir, "herdr-fail-prompt"))) fail("internal", "fake failure");
  if (a.agent_status === "blocked") fail("agent_blocked", "agent is showing a question");
  appendFileSync(path.join(dir, "herdr-prompts.log"), JSON.stringify({ target: args[0], text: args[1] }) + "\n");
  ok({ type: "agent_prompted", agent: a });
}
if (cmd === "send-keys") {
  find(args[0]);
  appendFileSync(path.join(dir, "herdr-keys.log"), JSON.stringify({ target: args[0], keys: args.slice(1) }) + "\n");
  ok({ type: "keys_sent" });
}
fail("unsupported", "fake herdr: agent " + String(cmd));
```

`server/test/fakes/pactl.ts`:

```ts
// Fake pactl 17.0 for tests: only `pactl -f json list source-outputs` (plan Verified facts 14).
// Prints $FAKE_DIR/pactl-source-outputs.json (default []); $FAKE_DIR/pactl-fail makes it fail.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = process.env.FAKE_DIR ?? "";
const argv = process.argv.slice(2);
appendFileSync(path.join(dir, "pactl-calls.log"), JSON.stringify(argv) + "\n");
if (existsSync(path.join(dir, "pactl-fail"))) {
  process.stderr.write("Connection failure: Connection refused\n");
  process.exit(1);
}
if (argv.join(" ") !== "-f json list source-outputs") {
  process.stderr.write("fake pactl: unsupported " + argv.join(" ") + "\n");
  process.exit(1);
}
const f = path.join(dir, "pactl-source-outputs.json");
process.stdout.write(existsSync(f) ? readFileSync(f, "utf8") : "[]");
```

`server/test/fakes/tailscale.ts`:

```ts
// Fake tailscale 1.102.4 for tests: `status --json` (Self.DNSName) and `whois --json <ip>`.
// $FAKE_DIR/tailscale-whois.json maps ip → {node, login}; unknown ips exit 1 like the real CLI.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = process.env.FAKE_DIR ?? "";
const argv = process.argv.slice(2);
appendFileSync(path.join(dir, "tailscale-calls.log"), JSON.stringify(argv) + "\n");
const [cmd, flag, ip] = argv;
if (cmd === "status" && flag === "--json") {
  process.stdout.write(JSON.stringify({ Self: { DNSName: "testhost.example.ts.net.", HostName: "testhost" } }));
  process.exit(0);
}
if (cmd === "whois" && flag === "--json" && ip) {
  const f = path.join(dir, "tailscale-whois.json");
  const map = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, { node: string; login: string }>) : {};
  const who = map[ip];
  if (!who) {
    process.stderr.write("no match for IP:port " + ip + "\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ Node: { Name: who.node + ".example.ts.net.", ComputedName: who.node }, UserProfile: { LoginName: who.login } }));
  process.exit(0);
}
process.stderr.write("fake tailscale: unsupported " + argv.join(" ") + "\n");
process.exit(1);
```

`server/test/helpers/scratch.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/config.test.ts server/test/harness.test.ts`
Expected: PASS, 9 tests, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add package.json .gitignore server/src/json.ts server/src/config.ts server/src/exec.ts server/test/helpers/scratch.ts server/test/fakes/herdr.ts server/test/fakes/pactl.ts server/test/fakes/tailscale.ts server/test/config.test.ts server/test/harness.test.ts
git commit -m "P1 task 1: hostd config, subprocess helper, scratch test harness with fake herdr/pactl/tailscale"
git push -u origin HEAD
```


### Task 2: Session sources — ids, tmux, herdr

**Files (owned):**
- Create: `server/src/sessions/ids.ts`, `server/src/sessions/tmux.ts`, `server/src/sessions/herdr.ts`
- Test: `server/test/sources.test.ts`

**Interfaces:**
- Consumes: `HostdConfig`, `run`, `cleanEnv`, `RunResult` (Task 1); `asRecord`, `asString`, `asArray`.
- Produces:
  - `ids.ts`: `interface TmuxWhere { kind: "tmux"; socket: string; session: string; window: number; pane: number }`, `interface HerdrWhere { kind: "herdr"; workspace: string; tab: string; pane: string }`, `type Where = TmuxWhere | HerdrWhere`, `sessionId(w: Where): string`, `tmuxTarget(w: TmuxWhere): string`.
  - `tmux.ts`: `interface TmuxPane extends TmuxWhere { panePid; cwd; title; windowName; attached; command }`, `type PaneList = { ok: true; panes: TmuxPane[] } | { ok: false; error: string }`, `socketPath(cfg, socket)`, `listSockets(cfg): string[]`, `listPanes(cfg, socket): Promise<PaneList>`, `capturePane(cfg, w): Promise<{ ok: boolean; text: string; error: string }>`, `sendText(cfg, w, text): Promise<{ ok: boolean; error: string }>`, `sendKeys(cfg, w, args: string[]): Promise<{ ok: boolean; error: string }>`, `listClients(cfg, socket): Promise<TmuxClient[]>`, `detachClient(cfg, socket, tty): Promise<boolean>`.
  - `herdr.ts`: `interface HerdrAgent { workspace; tab; pane; status; name; agent; cwd; title: string; focused: boolean }`, `listAgents(cfg): Promise<{ ok: true; agents: HerdrAgent[] } | { ok: false; error: string }>`, `readScreen(cfg, pane, lines): Promise<{ ok: boolean; text: string; error: string }>`, `prompt(cfg, pane, text): Promise<{ ok: boolean; error: string }>`, `sendKeys(cfg, pane, keys: string[]): Promise<{ ok: boolean; error: string }>`, `herdrError(r: RunResult): string`.

Facts used: Verified facts 7 (tmux), 9-10 (herdr). `herdr agent read` / `prompt` / `send-keys` output envelopes and `--` before positionals are **unverified on the real herdr** (only help text may be read); these functions follow herdr's API schema and fall back to raw text, and the fake herdr implements the schema.

- [ ] **Step 1: Write the failing test**

`server/test/sources.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sessionId, tmuxTarget } from "../src/sessions/ids";
import { capturePane, listClients, listPanes, listSockets, sendKeys, sendText } from "../src/sessions/tmux";
import { listAgents, prompt, readScreen, sendKeys as herdrKeys } from "../src/sessions/herdr";
import { Scratch, waitFor } from "./helpers/scratch";

let s: Scratch;
beforeEach(() => { s = new Scratch(); });
afterEach(() => s.cleanup());

test("ids follow SPEC 5.2 and escape separators", () => {
  expect(sessionId({ kind: "tmux", socket: "default", session: "1", window: 0, pane: 2 })).toBe("tmux:default:1:0.2");
  expect(sessionId({ kind: "tmux", socket: "a:b", session: "x", window: 1, pane: 0 })).toBe("tmux:a%3Ab:x:1.0");
  expect(sessionId({ kind: "herdr", workspace: "w1", tab: "w1:t1", pane: "w1:p3" })).toBe("herdr:w1:t1:p3");
  expect(tmuxTarget({ kind: "tmux", socket: "s", session: "alpha", window: 0, pane: 1 })).toBe("=alpha:0.1");
});

test("lists every socket and pane; a stopped server is reported, not thrown", async () => {
  const a = s.newTmuxServer("alpha");
  const b = s.newTmuxServer("beta");
  writeFileSync(path.join(s.socketDir, "not-a-socket"), "");
  const cfg = s.config();
  expect(listSockets(cfg)).toEqual([a, b]);
  const pa = await listPanes(cfg, a);
  expect(pa.ok && pa.panes.map((p) => [p.session, p.window, p.pane, p.cwd])).toEqual([["alpha", 0, 0, s.root]]);
  s.tmux(b, "kill-server");
  const pb = await listPanes(cfg, b);
  expect(pb.ok).toBe(false);
  expect(!pb.ok && pb.error).toContain("no server running");
});

test("sendText types multi-line text literally and presses Enter once; capture shows the pane", async () => {
  const out = path.join(s.root, "typed.txt");
  const sock = s.newTmuxServer("cat", "/bin/sh -c 'cat > " + out + "'");
  const w = { kind: "tmux" as const, socket: sock, session: "cat", window: 0, pane: 0 };
  const r = await sendText(s.config(), w, "hello\nworld");
  expect(r).toEqual({ ok: true, error: "" });
  await waitFor(() => existsSync(out) && readFileSync(out, "utf8") === "hello\nworld\n");
  const cap = await capturePane(s.config(), w);
  expect(cap.ok).toBe(true);
  expect(cap.text).toContain("world");
});

test("sendText splits long text into several send-keys calls without losing a byte", async () => {
  const out = path.join(s.root, "long.txt");
  const sock = s.newTmuxServer("cat", "/bin/sh -c 'cat > " + out + "'");
  const w = { kind: "tmux" as const, socket: sock, session: "cat", window: 0, pane: 0 };
  const text = Array.from({ length: 1500 }, (_, i) => "line " + i + " é").join("\n");
  expect(await sendText(s.config(), w, text)).toEqual({ ok: true, error: "" });
  await waitFor(() => existsSync(out) && readFileSync(out, "utf8") === text + "\n", 15_000);
});

test("sendKeys passes a literal that starts with a dash", async () => {
  const sock = s.newTmuxServer("sh");
  const w = { kind: "tmux" as const, socket: sock, session: "sh", window: 0, pane: 0 };
  await sendKeys(s.config(), w, ["-l", "--", "-v dash-ok"]);
  await waitFor(async () => (await capturePane(s.config(), w)).text.includes("-v dash-ok"));
  expect((await listClients(s.config(), sock)).length).toBe(0);
});

test("herdr: list, read, prompt and keys through the fake; errors are plain words", async () => {
  s.setHerdrAgents([
    { terminal_id: "t1", agent_status: "working", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", focused: true, revision: 3, agent: "omp", name: "reviewer", cwd: "/work" },
    { terminal_id: "t2", agent_status: "blocked", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p2", focused: false, revision: 1 },
  ]);
  s.setHerdrScreen("w1:p1", "screen text\n");
  const cfg = s.config();
  const list = await listAgents(cfg);
  expect(list.ok && list.agents.map((a) => [a.pane, a.status, a.name, a.cwd])).toEqual([["w1:p1", "working", "reviewer", "/work"], ["w1:p2", "blocked", "", ""]]);
  expect(await readScreen(cfg, "w1:p1", 2000)).toEqual({ ok: true, text: "screen text\n", error: "" });
  expect(await prompt(cfg, "w1:p1", "-starts with a dash")).toEqual({ ok: true, error: "" });
  expect(JSON.parse(s.fakeFile("herdr-prompts.log").trim())).toEqual({ target: "w1:p1", text: "-starts with a dash" });
  expect(await prompt(cfg, "w1:p2", "x")).toEqual({ ok: false, error: "agent is showing a question" });
  expect(await herdrKeys(cfg, "w1:p1", ["esc"])).toEqual({ ok: true, error: "" });
  expect(s.fakeCalls("herdr")[1]).toEqual(["agent", "read", "w1:p1", "--source", "recent", "--lines", "2000", "--format", "text"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/sources.test.ts`
Expected: FAIL, `Cannot find module '../src/sessions/ids'`.

- [ ] **Step 3: Write the implementation**

`server/src/sessions/ids.ts`:

```ts
// Stable session ids (SPEC 5.2): tmux:<socket>:<session>:<window>.<pane>, herdr:<workspace>:<tab>:<pane>.
// Each part is URI-encoded so a ":" inside a name can never shift the fields.

export interface TmuxWhere { kind: "tmux"; socket: string; session: string; window: number; pane: number }
export interface HerdrWhere { kind: "herdr"; workspace: string; tab: string; pane: string }
export type Where = TmuxWhere | HerdrWhere;

function local(id: string, workspace: string): string {
  return id.startsWith(workspace + ":") ? id.slice(workspace.length + 1) : id;
}

export function sessionId(w: Where): string {
  if (w.kind === "tmux") {
    return ["tmux", encodeURIComponent(w.socket), encodeURIComponent(w.session), w.window + "." + w.pane].join(":");
  }
  return ["herdr", encodeURIComponent(w.workspace), encodeURIComponent(local(w.tab, w.workspace)), encodeURIComponent(local(w.pane, w.workspace))].join(":");
}

/** Exact-match target ("=" stops tmux from prefix-matching another session). */
export function tmuxTarget(w: TmuxWhere): string {
  return "=" + w.session + ":" + w.window + "." + w.pane;
}
```

`server/src/sessions/tmux.ts`:

```ts
// Every tmux call hostd makes. Always `tmux -S <socket folder>/<name>` with TMUX unset.
// Never attach/resize/kill here; the PTY module owns its own attach (Task 11).

import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import type { HostdConfig } from "../config";
import { cleanEnv, run, type RunResult } from "../exec";
import { tmuxTarget, type TmuxWhere } from "./ids";

const SEP = "\x1f";
const PANE_FIELDS = ["session_name", "window_index", "pane_index", "pane_pid", "pane_current_path", "pane_title", "window_name", "session_attached", "pane_current_command"] as const;

export interface TmuxPane extends TmuxWhere { panePid: number; cwd: string; title: string; windowName: string; attached: boolean; command: string }
export type PaneList = { ok: true; panes: TmuxPane[] } | { ok: false; error: string };
export interface TmuxClient { pid: number; tty: string; size: string }

export function socketPath(cfg: HostdConfig, socket: string): string {
  return path.join(cfg.tmuxSocketDir, socket);
}

export function listSockets(cfg: HostdConfig): string[] {
  let names: string[];
  try { names = readdirSync(cfg.tmuxSocketDir); } catch { return []; }
  return names.filter((n) => {
    try { return lstatSync(path.join(cfg.tmuxSocketDir, n)).isSocket(); } catch { return false; }
  }).sort();
}

function tmux(cfg: HostdConfig, socket: string, args: string[], input?: string): Promise<RunResult> {
  return run([cfg.bin.tmux, "-S", socketPath(cfg, socket), ...args], { env: cleanEnv(), input });
}

function failure(r: RunResult): string {
  return r.timedOut ? "tmux did not answer within 5 s" : r.stderr.trim() || "tmux exited with " + r.code;
}

export async function listPanes(cfg: HostdConfig, socket: string): Promise<PaneList> {
  const r = await tmux(cfg, socket, ["list-panes", "-a", "-F", PANE_FIELDS.map((f) => "#{" + f + "}").join(SEP)]);
  if (r.code !== 0) return { ok: false, error: failure(r) };
  const panes = r.stdout.split("\n").filter(Boolean).map((line): TmuxPane => {
    const f = line.split(SEP);
    return { kind: "tmux", socket, session: f[0], window: Number(f[1]), pane: Number(f[2]), panePid: Number(f[3]), cwd: f[4], title: f[5], windowName: f[6], attached: f[7] !== "0", command: f[8] };
  });
  return { ok: true, panes };
}

export async function capturePane(cfg: HostdConfig, w: TmuxWhere): Promise<{ ok: boolean; text: string; error: string }> {
  const r = await tmux(cfg, w.socket, ["capture-pane", "-p", "-J", "-S", "-2000", "-t", tmuxTarget(w)]);
  return r.code === 0 ? { ok: true, text: r.stdout, error: "" } : { ok: false, text: "", error: failure(r) };
}

const SEND_CHUNK_BYTES = 8192;

/** Split text into pieces of at most `max` UTF-8 bytes, never inside a character. */
function chunks(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  let size = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch);
    if (size + n > max && cur) {
      out.push(cur);
      cur = "";
      size = 0;
    }
    cur += ch;
    size += n;
  }
  if (cur) out.push(cur);
  return out;
}

/** SPEC 4.5: type the text literally (`send-keys -l`, in chunks of at most 8 KiB), then press Enter once. */
export async function sendText(cfg: HostdConfig, w: TmuxWhere, text: string): Promise<{ ok: boolean; error: string }> {
  for (const piece of chunks(text, SEND_CHUNK_BYTES)) {
    const typed = await tmux(cfg, w.socket, ["send-keys", "-l", "-t", tmuxTarget(w), "--", piece]);
    if (typed.code !== 0) return { ok: false, error: failure(typed) };
  }
  const enter = await tmux(cfg, w.socket, ["send-keys", "-t", tmuxTarget(w), "Enter"]);
  return enter.code === 0 ? { ok: true, error: "" } : { ok: false, error: failure(enter) };
}

export async function sendKeys(cfg: HostdConfig, w: TmuxWhere, args: string[]): Promise<{ ok: boolean; error: string }> {
  const r = await tmux(cfg, w.socket, ["send-keys", "-t", tmuxTarget(w), ...args]);
  return r.code === 0 ? { ok: true, error: "" } : { ok: false, error: failure(r) };
}

export async function listClients(cfg: HostdConfig, socket: string): Promise<TmuxClient[]> {
  const r = await tmux(cfg, socket, ["list-clients", "-F", "#{client_pid} #{client_tty} #{client_width}x#{client_height}"]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").filter(Boolean).map((l) => {
    const [pid, tty, size] = l.split(" ");
    return { pid: Number(pid), tty, size };
  });
}

/** Detach exactly one client, by its tty (Verified facts 6). */
export async function detachClient(cfg: HostdConfig, socket: string, tty: string): Promise<boolean> {
  return (await tmux(cfg, socket, ["detach-client", "-t", tty])).code === 0;
}
```

`server/src/sessions/herdr.ts`:

```ts
// herdr 0.9.1 CLI calls (Verified facts 9-10). Only `agent list` is verified on the real herdr;
// read/prompt/send-keys follow herdr's API schema and are proven against the fake herdr.

import type { HostdConfig } from "../config";
import { run, type RunResult } from "../exec";
import { asArray, asRecord, asString } from "../json";

export interface HerdrAgent { workspace: string; tab: string; pane: string; status: string; name: string; agent: string; cwd: string; title: string; focused: boolean }

export function herdrError(r: RunResult): string {
  if (r.timedOut) return "herdr did not answer within 5 s";
  try {
    const msg = asString(asRecord(asRecord(JSON.parse(r.stderr)).error).message);
    if (msg) return msg;
  } catch { /* not JSON: use the raw text */ }
  return r.stderr.trim() || "herdr exited with " + r.code;
}

export async function listAgents(cfg: HostdConfig): Promise<{ ok: true; agents: HerdrAgent[] } | { ok: false; error: string }> {
  const r = await run([cfg.bin.herdr, "agent", "list"]);
  if (r.code !== 0) return { ok: false, error: herdrError(r) };
  let parsed: unknown;
  try { parsed = JSON.parse(r.stdout); } catch { return { ok: false, error: "herdr agent list did not print JSON" }; }
  const agents = asArray(asRecord(asRecord(parsed).result).agents).map((v): HerdrAgent => {
    const a = asRecord(v);
    return {
      workspace: asString(a.workspace_id), tab: asString(a.tab_id), pane: asString(a.pane_id),
      status: asString(a.agent_status) || "unknown", name: asString(a.name), agent: asString(a.agent),
      cwd: asString(a.cwd), title: asString(a.terminal_title_stripped), focused: a.focused === true,
    };
  }).filter((a) => a.pane !== "" && a.workspace !== "");
  return { ok: true, agents };
}

export async function readScreen(cfg: HostdConfig, pane: string, lines: number): Promise<{ ok: boolean; text: string; error: string }> {
  const r = await run([cfg.bin.herdr, "agent", "read", pane, "--source", "recent", "--lines", String(lines), "--format", "text"]);
  if (r.code !== 0) return { ok: false, text: "", error: herdrError(r) };
  try {
    const read = asRecord(asRecord(asRecord(JSON.parse(r.stdout)).result).read);
    if (typeof read.text === "string") return { ok: true, text: read.text, error: "" };
  } catch { /* plain text output */ }
  return { ok: true, text: r.stdout, error: "" };
}

export async function prompt(cfg: HostdConfig, pane: string, text: string): Promise<{ ok: boolean; error: string }> {
  const r = await run([cfg.bin.herdr, "agent", "prompt", "--", pane, text], { timeoutMs: 15_000 });
  return r.code === 0 ? { ok: true, error: "" } : { ok: false, error: herdrError(r) };
}

export async function sendKeys(cfg: HostdConfig, pane: string, keys: string[]): Promise<{ ok: boolean; error: string }> {
  const r = await run([cfg.bin.herdr, "agent", "send-keys", pane, ...keys]);
  return r.code === 0 ? { ok: true, error: "" } : { ok: false, error: herdrError(r) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/sources.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/sessions/ids.ts server/src/sessions/tmux.ts server/src/sessions/herdr.ts server/test/sources.test.ts
git commit -m "P1 task 2: session ids, tmux and herdr sources"
git push
```

---

### Task 3: Status inputs — /proc, live voice, session-status entries

**Files (owned):**
- Create: `server/src/sessions/procs.ts`, `server/src/sessions/livevoice.ts`, `server/src/sessions/status.ts`
- Create: `server/test/fixtures/status-needs-you.jsonl`, `server/test/fixtures/status-working.jsonl`, `server/test/fixtures/status-done.jsonl`
- Test: `server/test/status.test.ts`

**Interfaces:**
- Consumes: `HostdConfig`, `run`, json helpers (Task 1); `Scratch` (Task 1).
- Produces:
  - `procs.ts`: `interface ProcTable { comm: Map<number, string>; children: Map<number, number[]> }`, `readProcTable(): ProcTable`, `findOmp(t: ProcTable, rootPid: number): number | null` (top-most `omp` at or under the pane process), `transcriptOf(pid: number, transcriptDirs: string[]): string | null`, `hasInbox(inboxRoot: string, pid: number): boolean`, `ompAlive(pid: number): boolean`.
  - `livevoice.ts`: `liveVoicePids(pactl: string): Promise<{ ok: true; pids: Set<number> } | { ok: false; error: string }>`.
  - `status.ts`: `type SessionStatus = "working" | "idle" | "needs-you" | "done" | "unknown"`, `interface StatusInfo { status: SessionStatus; reported: string | null; questionCount: number; recordedAt: string | null }`, `REPORTED_STATUS: Record<string, SessionStatus>`, `HERDR_STATUS: Record<string, SessionStatus>`, `statusFromTranscript(file: string): StatusInfo`.

Mapping (SPEC 4.1 statuses; [INFERENCE] for `abandoned` → done and `interrupted`/`no-report` → idle): `awaiting-decision` and `blocked` → needs-you; `in-progress` → working; `interrupted`, `no-report` → idle; `fulfilled`, `abandoned` → done. herdr: `idle, working, done` same name, `blocked` → needs-you, `unknown` → unknown.

- [ ] **Step 1: Write the fixtures and the failing test**

`server/test/fixtures/status-needs-you.jsonl` (only the fields hostd reads are filled; shape from Verified facts 12-13):

```
{"type":"title","v":1,"title":"Fixture needs you","source":"auto","updatedAt":"2026-10-13T10:00:00.000Z","pad":"        "}
{"type":"session","version":3,"id":"fx-needs-you","timestamp":"2026-10-13T10:00:00.000Z","cwd":"/tmp/fixture"}
{"type":"message","id":"m1","parentId":null,"timestamp":"2026-10-13T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Pick a colour"}]}}
{"type":"custom","customType":"cymatic.session-status","data":{"schema":"cymatic.session-status/v2","status":"in-progress","questionCount":0,"questions":[],"recordedAt":"2026-10-13T10:00:01.500Z","source":{"entryId":"m1","trigger":"turn-start"}},"id":"s1","parentId":"m1","timestamp":"2026-10-13T10:00:01.500Z"}
{"type":"message","id":"m2","parentId":"s1","timestamp":"2026-10-13T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Red or blue?"}],"stopReason":"stop"}}
{"type":"custom","customType":"cymatic.session-status","data":{"schema":"cymatic.session-status/v2","status":"awaiting-decision","questionCount":1,"questions":[{"number":1,"title":"Colour","text":"Red or blue?","priority":{"local":1,"global":1}}],"recordedAt":"2026-10-13T10:00:03.000Z","source":{"entryId":"m2","trigger":"reply"}},"id":"s2","parentId":"m2","timestamp":"2026-10-13T10:00:03.000Z"}
```

`server/test/fixtures/status-working.jsonl`:

```
{"type":"title","v":1,"title":"Fixture working","source":"auto","updatedAt":"2026-10-13T11:00:00.000Z","pad":"        "}
{"type":"session","version":3,"id":"fx-working","timestamp":"2026-10-13T11:00:00.000Z","cwd":"/tmp/fixture"}
{"type":"custom","customType":"cymatic.session-status","data":{"schema":"cymatic.session-status/v2","status":"fulfilled","questionCount":0,"questions":[],"recordedAt":"2026-10-13T11:00:01.000Z","source":{"entryId":"m0","trigger":"reply"}},"id":"s1","parentId":null,"timestamp":"2026-10-13T11:00:01.000Z"}
{"type":"message","id":"m1","parentId":"s1","timestamp":"2026-10-13T11:00:02.000Z","message":{"role":"user","content":[{"type":"text","text":"Next step please"}]}}
{"type":"custom","customType":"cymatic.session-status","data":{"schema":"cymatic.session-status/v2","status":"in-progress","questionCount":0,"questions":[],"recordedAt":"2026-10-13T11:00:02.500Z","source":{"entryId":"m1","trigger":"turn-start"}},"id":"s2","parentId":"m1","timestamp":"2026-10-13T11:00:02.500Z"}
```

`server/test/fixtures/status-done.jsonl`:

```
{"type":"title","v":1,"title":"Fixture done","source":"auto","updatedAt":"2026-10-13T12:00:00.000Z","pad":"        "}
{"type":"session","version":3,"id":"fx-done","timestamp":"2026-10-13T12:00:00.000Z","cwd":"/tmp/fixture"}
{"type":"custom","customType":"cymatic.session-status","data":{"schema":"cymatic.session-status/v2","status":"fulfilled","questionCount":0,"questions":[],"recordedAt":"2026-10-13T12:00:01.000Z","source":{"entryId":"m0","trigger":"reply"}},"id":"s1","parentId":null,"timestamp":"2026-10-13T12:00:01.000Z"}
```

`server/test/status.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { liveVoicePids } from "../src/sessions/livevoice";
import { findOmp, hasInbox, ompAlive, readProcTable, transcriptOf } from "../src/sessions/procs";
import { HERDR_STATUS, statusFromTranscript } from "../src/sessions/status";
import { FIXTURES, Scratch, waitFor } from "./helpers/scratch";

let s: Scratch;
beforeEach(() => { s = new Scratch(); });
afterEach(() => s.cleanup());

test("finds the omp in a pane, its open transcript and its inbox", async () => {
  const t = s.transcript("status-needs-you.jsonl");
  const sock = s.newTmuxServer("chat", s.ompCommand(t));
  const panePid = s.panePid(sock, "=chat:0.0");
  let omp: number | null = null;
  await waitFor(() => { omp = findOmp(readProcTable(), panePid); return omp !== null && transcriptOf(omp, [s.transcripts]) === t; });
  expect(omp).toBe(panePid);
  expect(ompAlive(panePid)).toBe(true);
  expect(transcriptOf(panePid, [path.join(s.root, "elsewhere")])).toBeNull();
  expect(hasInbox(s.inboxRoot, panePid)).toBe(false);
  mkdirSync(path.join(s.inboxRoot, String(panePid)));
  expect(hasInbox(s.inboxRoot, panePid)).toBe(true);
  expect(findOmp(readProcTable(), process.pid)).toBeNull();
});

test("live voice pids come from pactl source-outputs, failures are explicit", async () => {
  s.setLiveVoicePids([4242, 77]);
  const r = await liveVoicePids(path.join(s.fakeBin, "pactl"));
  expect(r.ok && [...r.pids].sort()).toEqual([4242, 77].sort());
  s.breakPactl(true);
  const bad = await liveVoicePids(path.join(s.fakeBin, "pactl"));
  expect(bad.ok).toBe(false);
});

test("newest cymatic.session-status entry decides the status", () => {
  expect(statusFromTranscript(path.join(FIXTURES, "status-needs-you.jsonl"))).toEqual({ status: "needs-you", reported: "awaiting-decision", questionCount: 1, recordedAt: "2026-10-13T10:00:03.000Z" });
  expect(statusFromTranscript(path.join(FIXTURES, "status-working.jsonl")).status).toBe("working");
  expect(statusFromTranscript(path.join(FIXTURES, "status-done.jsonl")).status).toBe("done");
  const plain = s.writeTranscript("plain.jsonl", '{"type":"session","version":3,"id":"x","timestamp":"t","cwd":"/"}\n');
  expect(statusFromTranscript(plain)).toEqual({ status: "unknown", reported: null, questionCount: 0, recordedAt: null });
  expect(statusFromTranscript(path.join(s.root, "missing.jsonl")).status).toBe("unknown");
  expect(HERDR_STATUS.blocked).toBe("needs-you");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/status.test.ts`
Expected: FAIL, `Cannot find module '../src/sessions/livevoice'`.

- [ ] **Step 3: Write the implementation**

`server/src/sessions/procs.ts`:

```ts
// /proc lookups: which omp runs in a pane, which transcript it holds open (SPEC 4.1: never
// "newest file on disk"), and whether it has a live inbox.

import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";

export interface ProcTable { comm: Map<number, string>; children: Map<number, number[]> }

export function readProcTable(): ProcTable {
  const comm = new Map<number, string>();
  const children = new Map<number, number[]>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try { stat = readFileSync("/proc/" + name + "/stat", "utf8"); } catch { continue; }
    // stat: "<pid> (<comm>) <state> <ppid> ..."; comm may contain spaces or ")".
    const open = stat.indexOf("(");
    const close = stat.lastIndexOf(")");
    const pid = Number(name);
    const ppid = Number(stat.slice(close + 2).split(" ")[1]);
    comm.set(pid, stat.slice(open + 1, close));
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  return { comm, children };
}

/** Top-most process named "omp" at or below rootPid (subagent omps are its children). */
export function findOmp(t: ProcTable, rootPid: number): number | null {
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift() as number;
    if (t.comm.get(pid) === "omp") return pid;
    queue.push(...(t.children.get(pid) ?? []));
  }
  return null;
}

/** The `.jsonl` the omp holds open inside a watched folder (<dir>/<project>/<file>.jsonl). */
export function transcriptOf(pid: number, transcriptDirs: string[]): string | null {
  let fds: string[];
  try { fds = readdirSync("/proc/" + pid + "/fd"); } catch { return null; }
  for (const fd of fds) {
    let target: string;
    try { target = readlinkSync("/proc/" + pid + "/fd/" + fd); } catch { continue; }
    if (target.endsWith(".jsonl") && transcriptDirs.includes(path.dirname(path.dirname(target)))) return target;
  }
  return null;
}

export function hasInbox(inboxRoot: string, pid: number): boolean {
  return existsSync(path.join(inboxRoot, String(pid)));
}

export function ompAlive(pid: number): boolean {
  try { return readFileSync("/proc/" + pid + "/comm", "utf8").trim() === "omp"; } catch { return false; }
}
```

`server/src/sessions/livevoice.ts`:

```ts
// Live voice = a PipeWire source-output with application.name omp (or oh-my-pi), media.name voice
// (same contract as ~/.local/bin/omp-voice; Verified facts 11, 14).

import { run } from "../exec";
import { asArray, asRecord, asString } from "../json";

const VOICE_APPS = new Set(["omp", "oh-my-pi"]);

export async function liveVoicePids(pactl: string): Promise<{ ok: true; pids: Set<number> } | { ok: false; error: string }> {
  const r = await run([pactl, "-f", "json", "list", "source-outputs"]);
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() || "pactl exited with " + r.code };
  let rows: unknown[];
  try { rows = asArray(JSON.parse(r.stdout)); } catch { return { ok: false, error: "pactl did not print JSON" }; }
  const pids = new Set<number>();
  for (const row of rows) {
    const p = asRecord(asRecord(row).properties);
    const pid = Number(asString(p["application.process.id"]));
    if (VOICE_APPS.has(asString(p["application.name"])) && asString(p["media.name"]) === "voice" && pid > 0) pids.add(pid);
  }
  return { ok: true, pids };
}
```

`server/src/sessions/status.ts`:

```ts
// Session status from the newest `cymatic.session-status` custom entry (Verified facts 12).

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { asRecord, asString } from "../json";

export type SessionStatus = "working" | "idle" | "needs-you" | "done" | "unknown";
export interface StatusInfo { status: SessionStatus; reported: string | null; questionCount: number; recordedAt: string | null }

export const REPORTED_STATUS: Record<string, SessionStatus> = {
  "awaiting-decision": "needs-you",
  blocked: "needs-you",
  "in-progress": "working",
  interrupted: "idle",
  "no-report": "idle",
  abandoned: "done",
  fulfilled: "done",
};

export const HERDR_STATUS: Record<string, SessionStatus> = {
  idle: "idle",
  working: "working",
  blocked: "needs-you",
  done: "done",
  unknown: "unknown",
};

const UNKNOWN: StatusInfo = { status: "unknown", reported: null, questionCount: 0, recordedAt: null };
const MARKER = '"customType":"cymatic.session-status"';
const CHUNK = 1024 * 1024;
const MAX_BACK = 16 * CHUNK;

function fromLine(line: string): StatusInfo | null {
  let entry: Record<string, unknown>;
  try { entry = asRecord(JSON.parse(line)); } catch { return null; }
  if (entry.type !== "custom" || entry.customType !== "cymatic.session-status") return null;
  const data = asRecord(entry.data);
  const reported = asString(data.status);
  return {
    status: REPORTED_STATUS[reported] ?? "unknown",
    reported: reported || null,
    questionCount: typeof data.questionCount === "number" ? data.questionCount : 0,
    recordedAt: asString(data.recordedAt) || null,
  };
}

/** Reads backwards in 1 MiB steps (at most 16 MiB) for the newest status line. */
export function statusFromTranscript(file: string): StatusInfo {
  let fd: number;
  try { fd = openSync(file, "r"); } catch { return UNKNOWN; }
  try {
    const size = fstatSync(fd).size;
    let end = size;
    let carry = "";
    while (end > 0 && size - end < MAX_BACK) {
      const start = Math.max(0, end - CHUNK);
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      const lines = (buf.toString("utf8") + carry).split("\n");
      carry = start > 0 ? (lines.shift() ?? "") : "";
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes(MARKER)) continue;
        const info = fromLine(lines[i]);
        if (info) return info;
      }
      end = start;
    }
    return UNKNOWN;
  } finally {
    closeSync(fd);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/status.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/sessions/procs.ts server/src/sessions/livevoice.ts server/src/sessions/status.ts server/test/fixtures/status-needs-you.jsonl server/test/fixtures/status-working.jsonl server/test/fixtures/status-done.jsonl server/test/status.test.ts
git commit -m "P1 task 3: omp/transcript/inbox discovery via /proc, live voice via pactl, session-status mapping"
git push
```

---

### Task 4: Transcript reader — chat items, pages, follower

**Files (owned):**
- Create: `server/src/transcript/parse.ts`, `server/src/transcript/tail.ts`
- Create: `server/test/fixtures/chat-basic.jsonl`
- Test: `server/test/transcript.test.ts`

**Interfaces:**
- Consumes: json helpers (Task 1), `Scratch`, `waitFor`, `FIXTURES`.
- Produces:
  - `parse.ts`: `interface ChatItem { cursor: number; id: string; at: string; kind: "user" | "assistant" | "tools"; text: string; tools: string[]; via: "typed" | "live-voice" | null }`, `parseLine(line: string, cursor: number): ChatItem[]`.
  - `tail.ts`: `interface Page { items: ChatItem[]; start: number; end: number; hasOlder: boolean }`, `readPage(file: string, before: number | null, limit: number): Page` (newest `limit`+ items before the cursor; `null` = end of file), `readAfter(file: string, after: number): Page` (all complete lines whose start is greater than `after`), `class Follower { constructor(file: string, from: number, onItems: (items: ChatItem[], end: number) => void, onReset: () => void, pollMs?: number); start(): void; stop(): void }`.

Cursor = byte offset where a transcript line starts. Only lines ending in `\n` are read, so a half-written line is never shown. Line 1 is rewritten in place with padding ([INFERENCE] from its `pad` field), so later offsets stay valid; if the file ever shrinks, the follower calls `onReset` and the chat channel resends a backlog.

- [ ] **Step 1: Write the fixture and the failing test**

`server/test/fixtures/chat-basic.jsonl`:

```
{"type":"title","v":1,"title":"Chat fixture","source":"auto","updatedAt":"2026-10-13T09:00:00.000Z","pad":"        "}
{"type":"session","version":3,"id":"fx-chat","timestamp":"2026-10-13T09:00:00.000Z","cwd":"/tmp/fixture"}
{"type":"message","id":"u1","parentId":null,"timestamp":"2026-10-13T09:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"List the files"}]}}
{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-10-13T09:00:02.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hidden"},{"type":"text","text":"Looking now."},{"type":"toolCall","id":"c1","name":"read","arguments":{"path":"."},"intent":"Listing"},{"type":"toolCall","id":"c2","name":"grep","arguments":{"pattern":"x"},"intent":"Searching"}],"stopReason":"toolUse"}}
{"type":"message","id":"r1","parentId":"a1","timestamp":"2026-10-13T09:00:03.000Z","message":{"role":"toolResult","content":[{"type":"text","text":"a.txt"}]}}
{"type":"message","id":"a2","parentId":"r1","timestamp":"2026-10-13T09:00:04.000Z","message":{"role":"assistant","content":[{"type":"text","text":"There is **one** file: `a.txt`."}],"stopReason":"stop"}}
{"type":"custom_message","customType":"live-delegation","content":"Also check the tests","display":true,"attribution":"agent","id":"d1","parentId":"a2","timestamp":"2026-10-13T09:00:05.000Z"}
{"type":"message","id":"x1","parentId":"d1","timestamp":"2026-10-13T09:00:06.000Z","message":{"role":"developer","content":[{"type":"text","text":"system reminder"}]}}
{"type":"custom","customType":"cymatic.session-status","data":{"schema":"cymatic.session-status/v2","status":"in-progress","questionCount":0,"questions":[],"recordedAt":"2026-10-13T09:00:06.500Z","source":{"entryId":"d1","trigger":"turn-start"}},"id":"s1","parentId":"d1","timestamp":"2026-10-13T09:00:06.500Z"}
```

`server/test/transcript.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ChatItem } from "../src/transcript/parse";
import { parseLine } from "../src/transcript/parse";
import { Follower, readAfter, readPage } from "../src/transcript/tail";
import { FIXTURES, Scratch, waitFor } from "./helpers/scratch";

let s: Scratch;
beforeEach(() => { s = new Scratch(); });
afterEach(() => s.cleanup());

const shape = (items: ChatItem[]) => items.map((i) => [i.kind, i.text, i.tools.join(","), i.via]);

test("user, assistant, tool calls and live-delegation become chat items; the rest is skipped", () => {
  const page = readPage(path.join(FIXTURES, "chat-basic.jsonl"), null, 50);
  expect(shape(page.items)).toEqual([
    ["user", "List the files", "", "typed"],
    ["assistant", "Looking now.", "", null],
    ["tools", "", "read,grep", null],
    ["assistant", "There is **one** file: `a.txt`.", "", null],
    ["user", "Also check the tests", "", "live-voice"],
  ]);
  expect(page.hasOlder).toBe(false);
  expect(parseLine("{not json", 0)).toEqual([]);
});

test("pages walk backwards by cursor; after returns only newer lines", () => {
  const file = path.join(FIXTURES, "chat-basic.jsonl");
  const last = readPage(file, null, 1);
  expect(shape(last.items)).toEqual([["user", "Also check the tests", "", "live-voice"]]);
  expect(last.hasOlder).toBe(true);
  const older = readPage(file, last.start, 2);
  // readPage keeps whole lines: the line holding "Looking now." + its tools comes in whole.
  expect(shape(older.items).map((r) => r[0])).toEqual(["assistant", "tools", "assistant"]);
  const after = readAfter(file, older.items[0].cursor);
  expect(shape(after.items).map((r) => r[1])).toEqual(["There is **one** file: `a.txt`.", "Also check the tests"]);
  expect(after.end).toBe(readFileSync(file).length);
});

test("the follower appends complete lines only and resets when the file shrinks", async () => {
  const file = s.transcript("chat-basic.jsonl");
  const got: ChatItem[] = [];
  let resets = 0;
  const f = new Follower(file, readFileSync(file).length, (items) => got.push(...items), () => { resets += 1; }, 50);
  f.start();
  const line = '{"type":"message","id":"u9","parentId":"s1","timestamp":"2026-10-13T09:01:00.000Z","message":{"role":"user","content":[{"type":"text","text":"half then whole"}]}}';
  appendFileSync(file, line.slice(0, 40));
  await Bun.sleep(200);
  expect(got.length).toBe(0);
  appendFileSync(file, line.slice(40) + "\n");
  await waitFor(() => got.length === 1);
  expect(got[0].text).toBe("half then whole");
  writeFileSync(file, "");
  await waitFor(() => resets === 1);
  f.stop();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/transcript.test.ts`
Expected: FAIL, `Cannot find module '../src/transcript/parse'`.

- [ ] **Step 3: Write the implementation**

`server/src/transcript/parse.ts`:

```ts
// One omp transcript line → zero or more chat items (SPEC 4.3; line shapes: Verified facts 13).

import { asArray, asRecord, asString } from "../json";

export interface ChatItem {
  cursor: number;                 // byte offset where the line starts
  id: string;
  at: string;
  kind: "user" | "assistant" | "tools";
  text: string;
  tools: string[];
  via: "typed" | "live-voice" | null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return asArray(content).map(asRecord).filter((b) => b.type === "text").map((b) => asString(b.text)).join("\n\n");
}

export function parseLine(line: string, cursor: number): ChatItem[] {
  let e: Record<string, unknown>;
  try { e = asRecord(JSON.parse(line)); } catch { return []; }
  const id = asString(e.id);
  const at = asString(e.timestamp);
  if (e.type === "custom_message" && e.customType === "live-delegation") {
    const text = textOf(e.content).trim();
    return text ? [{ cursor, id, at, kind: "user", text, tools: [], via: "live-voice" }] : [];
  }
  if (e.type !== "message") return [];
  const msg = asRecord(e.message);
  if (msg.role === "user") {
    const text = textOf(msg.content).trim();
    return text ? [{ cursor, id, at, kind: "user", text, tools: [], via: "typed" }] : [];
  }
  if (msg.role !== "assistant") return [];
  const items: ChatItem[] = [];
  const text = textOf(msg.content).trim();
  if (text) items.push({ cursor, id: id + ":text", at, kind: "assistant", text, tools: [], via: null });
  const tools = asArray(msg.content).map(asRecord).filter((b) => b.type === "toolCall").map((b) => asString(b.name));
  if (tools.length) items.push({ cursor, id: id + ":tools", at, kind: "tools", text: "", tools, via: null });
  return items;
}
```

`server/src/transcript/tail.ts`:

```ts
// Byte-offset paging over a growing .jsonl, and a follower for appended lines.

import { closeSync, fstatSync, openSync, readSync, statSync, watch, type FSWatcher } from "node:fs";
import { parseLine, type ChatItem } from "./parse";

export interface Page { items: ChatItem[]; start: number; end: number; hasOlder: boolean }

const CHUNK = 256 * 1024;

function readRange(fd: number, from: number, to: number): Buffer {
  const buf = Buffer.alloc(Math.max(0, to - from));
  if (buf.length) readSync(fd, buf, 0, buf.length, from);
  return buf;
}

/** Offset just after the last "\n" at or before `limit` (a line boundary). */
function lastBoundary(fd: number, limit: number): number {
  let end = limit;
  while (end > 0) {
    const from = Math.max(0, end - CHUNK);
    const nl = readRange(fd, from, end).lastIndexOf(0x0a);
    if (nl >= 0) return from + nl + 1;
    end = from;
  }
  return 0;
}

/** Visit complete lines ending at or before `end` (a boundary), newest first, until visit returns false. */
function scanBackward(fd: number, end: number, visit: (line: string, start: number) => boolean): void {
  let pos = end;
  let tail = Buffer.alloc(0);
  while (pos > 0) {
    const from = Math.max(0, pos - CHUNK);
    const buf = Buffer.concat([readRange(fd, from, pos), tail]);
    let stop = buf.length;
    for (let i = buf.length - 2; i >= -1; i--) {
      const isStart = i === -1 ? from === 0 : buf[i] === 0x0a;
      if (!isStart) continue;
      if (!visit(buf.subarray(i + 1, stop - 1).toString("utf8"), from + i + 1)) return;
      stop = i + 1;
    }
    tail = buf.subarray(0, stop);
    pos = from;
  }
}

export function readPage(file: string, before: number | null, limit: number): Page {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const end = lastBoundary(fd, before === null ? size : Math.min(before, size));
    const lines: ChatItem[][] = [];
    let count = 0;
    let start = end;
    scanBackward(fd, end, (line, lineStart) => {
      const items = parseLine(line, lineStart);
      start = lineStart;
      if (items.length) { lines.push(items); count += items.length; }
      return count < limit;
    });
    return { items: lines.reverse().flat(), start, end, hasOlder: start > 0 };
  } finally {
    closeSync(fd);
  }
}

function forward(fd: number, from: number, to: number): { items: ChatItem[]; end: number } {
  const items: ChatItem[] = [];
  let pos = from;
  let carry = Buffer.alloc(0);
  let carryStart = from;
  while (pos < to) {
    const buf = Buffer.concat([carry, readRange(fd, pos, Math.min(to, pos + CHUNK))]);
    const base = carryStart;
    let lineStart = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 0x0a) continue;
      items.push(...parseLine(buf.subarray(lineStart, i).toString("utf8"), base + lineStart));
      lineStart = i + 1;
    }
    carry = buf.subarray(lineStart);
    carryStart = base + lineStart;
    pos = Math.min(to, pos + CHUNK);
  }
  return { items, end: carryStart };
}

export function readAfter(file: string, after: number): Page {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    // Skip the line that starts at `after` (the client already has it).
    let from = 0;
    if (after >= 0) {
      const nl = readRange(fd, after, Math.min(size, after + CHUNK)).indexOf(0x0a);
      from = nl >= 0 ? after + nl + 1 : size;
    }
    const { items, end } = forward(fd, from, lastBoundary(fd, size));
    return { items, start: from, end, hasOlder: from > 0 };
  } finally {
    closeSync(fd);
  }
}

export class Follower {
  private pos: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private watcher: FSWatcher | null = null;
  private busy = false;

  constructor(
    private readonly file: string,
    from: number,
    private readonly onItems: (items: ChatItem[], end: number) => void,
    private readonly onReset: () => void,
    private readonly pollMs = 500,
  ) {
    this.pos = from;
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), this.pollMs);
    try { this.watcher = watch(this.file, () => this.tick()); } catch { this.watcher = null; }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.watcher?.close();
    this.timer = null;
    this.watcher = null;
  }

  /** Called by the chat channel after it resent a backlog. */
  moveTo(pos: number): void {
    this.pos = pos;
  }

  private tick(): void {
    if (this.busy) return;
    this.busy = true;
    try {
      const size = statSync(this.file).size;
      if (size < this.pos) {
        this.pos = 0;
        this.onReset();
        return;
      }
      if (size === this.pos) return;
      const fd = openSync(this.file, "r");
      try {
        const { items, end } = forward(fd, this.pos, lastBoundary(fd, size));
        if (end > this.pos) {
          this.pos = end;
          if (items.length) this.onItems(items, end);
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      // File briefly missing or unreadable: try again on the next tick.
    } finally {
      this.busy = false;
    }
  }
}
```

Note: `forward` only parses up to the last complete line because callers pass `lastBoundary(...)` as `to`; a half-written line stays in the file until its `\n` arrives.

- [ ] **Step 4: Run the test to verify it passes**

Run: `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/transcript.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/transcript/parse.ts server/src/transcript/tail.ts server/test/fixtures/chat-basic.jsonl server/test/transcript.test.ts
git commit -m "P1 task 4: transcript chat items, byte-cursor pages and follower"
git push
```

---

### Task 5: Auth, identity, local token, access log

**Files (owned):**
- Create: `server/src/auth/auth.ts`, `server/src/auth/identity.ts`, `server/src/auth/localtoken.ts`, `server/src/auth/accesslog.ts`
- Test: `server/test/auth.test.ts`

**Interfaces:**
- Consumes: `HostdConfig`, `run`, json helpers (Task 1); `Scratch` with `setWhois`, `fakeCalls`.
- Produces:
  - `identity.ts`: `interface Who { node: string; login: string }`, `class Whois { constructor(bin: string, ttlMs?: number, missTtlMs?: number); lookup(ip: string): Promise<Who | null> }` (node = first DNS label of `.Node.Name`).
  - `localtoken.ts`: `localTokenPath(runtimeDir: string): string`, `ensureLocalToken(runtimeDir: string): string`.
  - `accesslog.ts`: `interface AccessEntry { device: string; method: string; route: string; session: string; status: number; reason: string }`, `class AccessLog { readonly file: string; constructor(stateDir: string); write(e: AccessEntry): void }`.
  - `auth.ts`: `type Verdict = { ok: true; device: string; via: "tailscale" | "local" } | { ok: false; reason: string }`, `class Auth { constructor(cfg: HostdConfig, whois: Whois, localToken: string); check(req: Request): Promise<Verdict>; corsHeaders(req: Request): Record<string, string> }`.

Rules (SPEC 5.4, in this order): (1) an `Origin` that is present but not exactly `cfg.origin` or one of `cfg.peers` → 403; (2) every non-GET/HEAD request and every WebSocket upgrade needs such an exact `Origin`; (3) every `/v1` HTTP request except `OPTIONS` and upgrades needs `X-Porthole: 1`; (4) `X-Porthole-Local` equal to the token (constant-time compare) → device `local`; (5) otherwise `Tailscale-User-Login` must equal `allowedLogin`; when `cfg.singleForwardedFor` is true, a request with more than one `X-Forwarded-For` entry → 403 `"more than one X-Forwarded-For entry"` (switched on by the orchestrator only after Task 12's live check shows `tailscale serve` writes a single entry); the **last** `X-Forwarded-For` address must resolve through `tailscale whois --json` to a node in `allowedNodes` owned by `allowedLogin`. 127.0.0.1 mode only (Verified facts 5): no Unix-socket branch is built, so there is nothing to unit-test for it; the README states the limit (Task 12).

- [ ] **Step 1: Write the failing test**

`server/test/auth.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { AccessLog } from "../src/auth/accesslog";
import { Auth } from "../src/auth/auth";
import { Whois } from "../src/auth/identity";
import { ensureLocalToken, localTokenPath } from "../src/auth/localtoken";
import { Scratch } from "./helpers/scratch";

let s: Scratch;
let auth: Auth;
const BEN = "bengovernale@gmail.com";
const CONTROL = "https://testhost.example.ts.net";

beforeEach(() => {
  s = new Scratch();
  s.setWhois({
    "100.64.0.1": { node: "bencell", login: BEN },
    "100.64.0.2": { node: "benacer", login: BEN },
    "100.64.0.3": { node: "bencell", login: "someone@example.com" },
  });
  const cfg = s.config();
  auth = new Auth(cfg, new Whois(cfg.bin.tailscale), "local-secret");
});
afterEach(() => s.cleanup());

function req(method: string, p: string, headers: Record<string, string>): Request {
  return new Request("http://127.0.0.1:8797" + p, { method, headers });
}
const fromPhone = { "X-Porthole": "1", "Tailscale-User-Login": BEN, "X-Forwarded-For": "100.64.0.1" };
const upgrade = { Upgrade: "websocket", Connection: "Upgrade" };

test("Ben's phone through tailscale serve is allowed", async () => {
  expect(await auth.check(req("GET", "/v1/machine", fromPhone))).toEqual({ ok: true, device: "bencell", via: "tailscale" });
});

test("each rule refuses on its own", async () => {
  const cases: Array<[string, Request]> = [
    ["no X-Porthole", req("GET", "/v1/machine", { ...fromPhone, "X-Porthole": "" })],
    ["wrong login header", req("GET", "/v1/machine", { ...fromPhone, "Tailscale-User-Login": "someone@example.com" })],
    ["node not on the allowlist", req("GET", "/v1/machine", { ...fromPhone, "X-Forwarded-For": "100.64.0.2" })],
    ["node owned by another login", req("GET", "/v1/machine", { ...fromPhone, "X-Forwarded-For": "100.64.0.3" })],
    ["unknown address", req("GET", "/v1/machine", { ...fromPhone, "X-Forwarded-For": "100.64.0.9" })],
    ["spoofed first X-Forwarded-For entry", req("GET", "/v1/machine", { ...fromPhone, "X-Forwarded-For": "100.64.0.1, 100.64.0.2" })],
    ["no identity at all", req("GET", "/v1/machine", { "X-Porthole": "1" })],
    ["POST without Origin", req("POST", "/v1/sessions/x/send", fromPhone)],
    ["POST from a foreign site", req("POST", "/v1/sessions/x/send", { ...fromPhone, Origin: "https://evil.example" })],
    ["POST from the preview port", req("POST", "/v1/sessions/x/send", { ...fromPhone, Origin: CONTROL + ":8443" })],
    ["GET with a foreign Origin", req("GET", "/v1/machine", { ...fromPhone, Origin: "https://evil.example" })],
    ["WebSocket without Origin", req("GET", "/v1/events", { ...fromPhone, ...upgrade })],
    ["WebSocket from the preview port", req("GET", "/v1/events", { ...fromPhone, ...upgrade, Origin: CONTROL + ":8443" })],
    ["wrong local token", req("GET", "/v1/machine", { "X-Porthole": "1", "X-Porthole-Local": "guess" })],
  ];
  for (const [name, r] of cases) {
    const v = await auth.check(r);
    expect([name, v.ok]).toEqual([name, false]);
  }
});

test("exact origins, preflight and the local token pass", async () => {
  expect((await auth.check(req("POST", "/v1/sessions/x/send", { ...fromPhone, Origin: CONTROL }))).ok).toBe(true);
  expect((await auth.check(req("POST", "/v1/sessions/x/send", { ...fromPhone, Origin: "https://peer.example.ts.net" }))).ok).toBe(true);
  expect((await auth.check(req("GET", "/v1/events", { ...fromPhone, ...upgrade, "X-Porthole": "", Origin: CONTROL }))).ok).toBe(true);
  expect((await auth.check(req("OPTIONS", "/v1/sessions/x/send", { ...fromPhone, "X-Porthole": "", Origin: CONTROL }))).ok).toBe(true);
  expect(await auth.check(req("GET", "/v1/machine", { "X-Porthole": "1", "X-Porthole-Local": "local-secret" }))).toEqual({ ok: true, device: "local", via: "local" });
  expect(auth.corsHeaders(req("GET", "/v1/machine", { Origin: CONTROL }))["Access-Control-Allow-Origin"]).toBe(CONTROL);
  expect(auth.corsHeaders(req("GET", "/v1/machine", { Origin: "https://evil.example" }))).toEqual({});
});

test("whois answers are cached", async () => {
  await auth.check(req("GET", "/v1/machine", fromPhone));
  await auth.check(req("GET", "/v1/machine", fromPhone));
  expect(s.fakeCalls("tailscale").filter((c) => c[0] === "whois").length).toBe(1);
});

test("local token and access log are owner-only; the log never holds message text", () => {
  const token = ensureLocalToken(s.runtimeDir);
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect(ensureLocalToken(s.runtimeDir)).toBe(token);
  expect(statSync(localTokenPath(s.runtimeDir)).mode & 0o777).toBe(0o600);
  expect(statSync(s.runtimeDir).mode & 0o777).toBe(0o700);
  const log = new AccessLog(s.stateDir);
  log.write({ device: "bencell", method: "POST", route: "POST /v1/sessions/:id/send", session: "tmux:a:b:0.0", status: 200, reason: "" });
  expect(statSync(log.file).mode & 0o777).toBe(0o600);
  expect(path.basename(log.file)).toBe("access.log");
  const line = JSON.parse(readFileSync(log.file, "utf8").trim());
  expect(Object.keys(line).sort()).toEqual(["at", "device", "method", "reason", "route", "session", "status"]);
});

test("with singleForwardedFor, more than one X-Forwarded-For entry is refused", async () => {
  const strict = new Auth(s.config({ singleForwardedFor: true }), new Whois(s.config().bin.tailscale), "local-secret");
  expect(await strict.check(req("GET", "/v1/machine", fromPhone))).toEqual({ ok: true, device: "bencell", via: "tailscale" });
  expect(await strict.check(req("GET", "/v1/machine", { ...fromPhone, "X-Forwarded-For": "100.64.0.2, 100.64.0.1" }))).toEqual({ ok: false, reason: "more than one X-Forwarded-For entry" });
  expect((await auth.check(req("GET", "/v1/machine", { ...fromPhone, "X-Forwarded-For": "100.64.0.2, 100.64.0.1" }))).ok).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/auth.test.ts`
Expected: FAIL, `Cannot find module '../src/auth/accesslog'`.

- [ ] **Step 3: Write the implementation**

`server/src/auth/identity.ts`:

```ts
// Which Tailscale device an address belongs to: `tailscale whois --json <ip>` (Verified facts 3-4).

import { run } from "../exec";
import { asRecord, asString } from "../json";

export interface Who { node: string; login: string }

export class Whois {
  private readonly cache = new Map<string, { who: Who | null; until: number }>();

  constructor(private readonly bin: string, private readonly ttlMs = 60_000, private readonly missTtlMs = 5_000) {}

  async lookup(ip: string): Promise<Who | null> {
    if (!/^[0-9a-fA-F:.]+$/.test(ip)) return null;
    const hit = this.cache.get(ip);
    if (hit && hit.until > Date.now()) return hit.who;
    const r = await run([this.bin, "whois", "--json", ip]);
    let who: Who | null = null;
    if (r.code === 0) {
      try {
        const j = asRecord(JSON.parse(r.stdout));
        const node = asString(asRecord(j.Node).Name).split(".")[0];
        const login = asString(asRecord(j.UserProfile).LoginName);
        if (node && login) who = { node, login };
      } catch { who = null; }
    }
    this.cache.set(ip, { who, until: Date.now() + (who ? this.ttlMs : this.missTtlMs) });
    return who;
  }
}
```

`server/src/auth/localtoken.ts`:

```ts
// Token for local tools and tests (SPEC 5.4): $XDG_RUNTIME_DIR/porthole/local-token, 0600 in a 0700 folder.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function localTokenPath(runtimeDir: string): string {
  return path.join(runtimeDir, "local-token");
}

export function ensureLocalToken(runtimeDir: string): string {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  chmodSync(runtimeDir, 0o700);
  const file = localTokenPath(runtimeDir);
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(file, 0o600);
  return readFileSync(file, "utf8").trim();
}
```

`server/src/auth/accesslog.ts`:

```ts
// One JSON line per request: who and what, never message text (SPEC 5.4).

import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface AccessEntry { device: string; method: string; route: string; session: string; status: number; reason: string }

export class AccessLog {
  readonly file: string;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.file = path.join(stateDir, "access.log");
    writeFileSync(this.file, "", { mode: 0o600, flag: "a" });
    chmodSync(this.file, 0o600);
  }

  write(e: AccessEntry): void {
    const line: { at: string } & AccessEntry = { at: new Date().toISOString(), ...e };
    appendFileSync(this.file, JSON.stringify(line) + "\n");
  }
}
```

`server/src/auth/auth.ts`:

```ts
// Who may use hostd (SPEC 5.4), 127.0.0.1 mode. See the README for this mode's limit.

import { timingSafeEqual } from "node:crypto";
import type { HostdConfig } from "../config";
import type { Whois } from "./identity";

export type Verdict = { ok: true; device: string; via: "tailscale" | "local" } | { ok: false; reason: string };

function deny(reason: string): Verdict {
  return { ok: false, reason };
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class Auth {
  private readonly origins: Set<string>;

  constructor(private readonly cfg: HostdConfig, private readonly whois: Whois, private readonly localToken: string) {
    this.origins = new Set([cfg.origin, ...cfg.peers]);
  }

  async check(req: Request): Promise<Verdict> {
    const pathname = new URL(req.url).pathname;
    const origin = req.headers.get("origin");
    const upgrade = (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
    if (origin !== null && !this.origins.has(origin)) return deny("origin " + origin + " is not allowed");
    if ((req.method !== "GET" && req.method !== "HEAD") || upgrade) {
      if (origin === null) return deny("this request needs the control-room Origin");
    }
    const isApi = pathname === "/v1" || pathname.startsWith("/v1/");
    if (isApi && req.method !== "OPTIONS" && !upgrade && req.headers.get("x-porthole") !== "1") {
      return deny("missing the X-Porthole: 1 header");
    }
    const local = req.headers.get("x-porthole-local");
    if (local !== null) return sameSecret(local, this.localToken) ? { ok: true, device: "local", via: "local" } : deny("wrong local token");
    const login = req.headers.get("tailscale-user-login");
    if (login !== this.cfg.allowedLogin) return deny("Tailscale login " + (login ?? "(none)") + " is not allowed");
    // tailscale serve appends the real address last; earlier entries can come from the client.
    const entries = (req.headers.get("x-forwarded-for") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
    if (this.cfg.singleForwardedFor && entries.length > 1) return deny("more than one X-Forwarded-For entry");
    const ip = entries.pop() ?? "";
    if (!ip) return deny("no Tailscale device address on the request");
    const who = await this.whois.lookup(ip);
    if (!who) return deny("Tailscale does not know the device at " + ip);
    if (who.login !== this.cfg.allowedLogin) return deny("device " + who.node + " belongs to another Tailscale login");
    if (!this.cfg.allowedNodes.includes(who.node)) return deny("device " + who.node + " is not on the allowlist");
    return { ok: true, device: who.node, via: "tailscale" };
  }

  corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get("origin");
    if (origin === null || !this.origins.has(origin)) return {};
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, X-Porthole",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/auth.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/auth/auth.ts server/src/auth/identity.ts server/src/auth/localtoken.ts server/src/auth/accesslog.ts server/test/auth.test.ts
git commit -m "P1 task 5: auth (X-Porthole, exact Origin, Tailscale login + node via whois, local token) and access log"
git push
```

---

### Task 6: Sent record and live-inbox writer

**Files (owned):**
- Create: `server/src/deliver/sentlog.ts`, `server/src/deliver/inbox.ts`
- Test: `server/test/sentlog.test.ts`

**Interfaces:**
- Consumes: `Scratch`, `waitFor` (Task 1).
- Produces:
  - `sentlog.ts`: `type SendStatus = "delivered" | "pending" | "refused" | "failed"`, `type SendRoute = "inbox" | "tmux" | "herdr" | "none"`, `interface SendRecord { at: string; clientMsgId: string; sessionId: string; status: SendStatus; reason: string; route: SendRoute; text: string; pid: number | null; file: string | null }`, `class SentLog { readonly file: string; constructor(stateDir: string); latest(id: string): SendRecord | undefined; pending(): SendRecord[]; append(r: Omit<SendRecord, "at">): SendRecord }`.
  - `inbox.ts`: `CLIENT_MSG_ID: RegExp`, `MAX_MESSAGE_BYTES = 524288`, `interface Staged { part: string; final: string }`, `inboxDir(inboxRoot: string, pid: number): string`, `stageInbox(dir: string, clientMsgId: string, text: string): Staged`, `commitInbox(s: Staged): void`, `waitTaken(file: string, timeoutMs: number, stepMs?: number): Promise<boolean>`.

`CLIENT_MSG_ID` is `/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/`, so `<id>.msg` always matches live-inbox's `MESSAGE_FILE` (`/^[A-Za-z0-9][A-Za-z0-9._-]*\.msg$/`) and `.<id>.msg.part` never does (Verified facts 11). Every status change is one line in `sent.jsonl`; the newest line per id wins when the file is read back after a restart.

- [ ] **Step 1: Write the failing test**

`server/test/sentlog.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { CLIENT_MSG_ID, commitInbox, inboxDir, stageInbox, waitTaken } from "../src/deliver/inbox";
import { SentLog } from "../src/deliver/sentlog";
import { Scratch } from "./helpers/scratch";

let s: Scratch;
beforeEach(() => { s = new Scratch(); });
afterEach(() => s.cleanup());

const base = { sessionId: "tmux:a:b:0.0", reason: "", route: "tmux" as const, text: "hello", pid: null, file: null };

test("records survive a restart and the newest record per id wins", () => {
  const a = new SentLog(s.stateDir);
  a.append({ ...base, clientMsgId: "m1", status: "pending" });
  a.append({ ...base, clientMsgId: "m1", status: "delivered" });
  a.append({ ...base, clientMsgId: "m2", status: "pending" });
  const b = new SentLog(s.stateDir);
  expect(b.latest("m1")?.status).toBe("delivered");
  expect(b.pending().map((r) => r.clientMsgId)).toEqual(["m2"]);
  expect(b.latest("m1")?.text).toBe("hello");
  expect(path.basename(b.file)).toBe("sent.jsonl");
  expect(statSync(b.file).mode & 0o777).toBe(0o600);
  expect(readFileSync(b.file, "utf8").trim().split("\n").length).toBe(3);
});

test("ids are safe inbox file names", () => {
  expect(CLIENT_MSG_ID.test("c-1700000000.abc_1")).toBe(true);
  for (const bad of [".hidden", "../x", "a/b", "", "x".repeat(101)]) expect(CLIENT_MSG_ID.test(bad)).toBe(false);
});

test("write-then-rename, and taken means the extension removed the file", async () => {
  const dir = inboxDir(s.inboxRoot, 4242);
  mkdirSync(dir, { mode: 0o700 });
  const staged = stageInbox(dir, "m1", "hi there");
  expect(readdirSync(dir)).toEqual([".m1.msg.part"]);
  expect(statSync(staged.part).mode & 0o777).toBe(0o600);
  commitInbox(staged);
  expect(readdirSync(dir)).toEqual(["m1.msg"]);
  expect(readFileSync(staged.final, "utf8")).toBe("hi there");
  setTimeout(() => rmSync(staged.final), 150);
  expect(await waitTaken(staged.final, 2000, 20)).toBe(true);
  const again = stageInbox(dir, "m2", "nobody reads this");
  commitInbox(again);
  expect(await waitTaken(again.final, 200, 20)).toBe(false);
  expect(existsSync(again.final)).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/sentlog.test.ts`
Expected: FAIL, `Cannot find module '../src/deliver/inbox'`.

- [ ] **Step 3: Write the implementation**

`server/src/deliver/sentlog.ts`:

```ts
// ~/.local/state/porthole/sent.jsonl (0600): every status change of every send, with its text (SPEC 4.5).

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type SendStatus = "delivered" | "pending" | "refused" | "failed";
export type SendRoute = "inbox" | "tmux" | "herdr" | "none";

export interface SendRecord {
  at: string;
  clientMsgId: string;
  sessionId: string;
  status: SendStatus;
  reason: string;
  route: SendRoute;
  text: string;
  pid: number | null;   // omp pid for inbox sends
  file: string | null;  // final inbox file for inbox sends
}

export class SentLog {
  readonly file: string;
  private readonly latestById = new Map<string, SendRecord>();

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.file = path.join(stateDir, "sent.jsonl");
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const r = JSON.parse(line) as SendRecord;
          this.latestById.set(r.clientMsgId, r);
        } catch {
          // A torn last line from a crash: the earlier records still count.
        }
      }
    } else {
      writeFileSync(this.file, "", { mode: 0o600 });
    }
    chmodSync(this.file, 0o600);
  }

  latest(id: string): SendRecord | undefined {
    return this.latestById.get(id);
  }

  pending(): SendRecord[] {
    return [...this.latestById.values()].filter((r) => r.status === "pending");
  }

  append(r: Omit<SendRecord, "at">): SendRecord {
    const rec: SendRecord = { at: new Date().toISOString(), ...r };
    appendFileSync(this.file, JSON.stringify(rec) + "\n");
    this.latestById.set(rec.clientMsgId, rec);
    return rec;
  }
}
```

`server/src/deliver/inbox.ts`:

```ts
// Live inbox sender: same contract as deliver() in idea-board 94bcde4 live-inbox/omp-voice
// (write ".<name>.part", rename to "<name>", delivered once the extension removed it).

import { existsSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CLIENT_MSG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const MAX_MESSAGE_BYTES = 512 * 1024;

export interface Staged { part: string; final: string }

export function inboxDir(inboxRoot: string, pid: number): string {
  return path.join(inboxRoot, String(pid));
}

export function stageInbox(dir: string, clientMsgId: string, text: string): Staged {
  const part = path.join(dir, "." + clientMsgId + ".msg.part");
  writeFileSync(part, text, { mode: 0o600 });
  return { part, final: path.join(dir, clientMsgId + ".msg") };
}

export function commitInbox(s: Staged): void {
  renameSync(s.part, s.final);
}

export async function waitTaken(file: string, timeoutMs: number, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (existsSync(file)) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(stepMs);
  }
  return true;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/sentlog.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/deliver/sentlog.ts server/src/deliver/inbox.ts server/test/sentlog.test.ts
git commit -m "P1 task 6: sent.jsonl record and live-inbox write-then-rename"
git push
```

---

### Task 7: Move `live-inbox.ts` into this repo

**Files (owned):**
- Create: `omp-extension/live-inbox.ts` (byte copy), `omp-extension/README.md`
- Test: `server/test/extension-copy.test.ts`

**Interfaces:**
- Consumes: idea-board commit `94bcde4` (read-only; never check out or edit idea-board, its `feat/live-inbox` branch is checked out in another worktree).
- Produces: `omp-extension/live-inbox.ts`, identical to `94bcde4:live-inbox/live-inbox.ts` (124 lines, 4541 bytes, sha256 starting `ba0db0c7e79566e4`). Installing it is Task 10, after its one throwaway-omp run.

The original has backticks only inside `//` comments (lines 13-14, "`omp-voice send`"); it ran under omp in that form, so the copy stays byte-identical, and the test only forbids backticks in code lines (WATCHDOG trap: no template literals).

- [ ] **Step 1: Write the failing test**

`server/test/extension-copy.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const COPY = path.join(import.meta.dir, "..", "..", "omp-extension", "live-inbox.ts");

test("live-inbox.ts is a byte copy of idea-board 94bcde4", () => {
  const original = Bun.spawnSync(["git", "-C", "/home/cymatic/Projects/idea-board", "show", "94bcde4:live-inbox/live-inbox.ts"]).stdout;
  const copy = readFileSync(COPY);
  expect(createHash("sha256").update(copy).digest("hex")).toBe(createHash("sha256").update(original).digest("hex"));
  expect(createHash("sha256").update(copy).digest("hex").startsWith("ba0db0c7e79566e4")).toBe(true);
});

test("no template literals in code (omp dependency rewriter trap)", () => {
  const code = readFileSync(COPY, "utf8").split("\n").filter((l) => !l.trim().startsWith("//"));
  expect(code.filter((l) => l.includes("`"))).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/extension-copy.test.ts`
Expected: FAIL, `ENOENT ... omp-extension/live-inbox.ts`.

- [ ] **Step 3: Copy the file and write its README**

```bash
mkdir -p omp-extension
git -C /home/cymatic/Projects/idea-board archive 94bcde4 live-inbox/live-inbox.ts | tar -x --strip-components=1 -C omp-extension
```

`omp-extension/README.md`:

````markdown
# omp extensions shipped with Porthole

## live-inbox.ts

Lets hostd hand a message to a running omp session without typing into its terminal
(SPEC 4.5, delivery route 1). Each interactive omp that loads it watches
`$XDG_RUNTIME_DIR/omp-inbox/<omp pid>/` (folder 0700). A finished file `<name>.msg`
(name matching `^[A-Za-z0-9][A-Za-z0-9._-]*\.msg$`, at most 512 KiB) is read, deleted and
sent as a normal user message. It also works while live voice is on.

Sender contract (hostd `server/src/deliver/inbox.ts`): write `.<clientMsgId>.msg.part`,
rename it to `<clientMsgId>.msg`, and count it delivered once the file is gone.

Provenance: byte copy of `live-inbox/live-inbox.ts` from `/home/cymatic/Projects/idea-board`
commit `94bcde4` (branch `feat/live-inbox`), sha256 starting `ba0db0c7e79566e4`.
`server/test/extension-copy.test.ts` checks the copy.

Install (only after its one throwaway-omp run passed, SPEC 7):

```bash
install -m 0644 omp-extension/live-inbox.ts /home/cymatic/.omp/agent/extensions/live-inbox.ts
```

Once installed it loads into every new omp session (Thalamus included, next time it
starts). Sessions started before the install have no inbox; hostd then types with tmux
instead (route 2).
````

- [ ] **Step 4: Run the test to verify it passes**

Run: `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/extension-copy.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add omp-extension/live-inbox.ts omp-extension/README.md server/test/extension-copy.test.ts
git commit -m "P1 task 7: move live-inbox.ts in from idea-board 94bcde4 (byte copy)"
git push
```

---

> **Tasks 8-12 are written at contract level.** Interfaces, file ownership, every test file in
> full, the commands and the commit are fixed below; the implementation code is the builder's,
> written to make those tests pass using only the APIs named under **Consumes**. Same TDD loop as
> Tasks 1-7: write the test file exactly as given, run it and see it fail with `Cannot find module`,
> implement, run it and see it pass, commit with the message given. A builder who finds a test that
> cannot pass as written stops and reports it (never edits the test to fit).

### Task 8: Router, hostd assembly, events hub, session registry, `/v1/machine`, `/v1/sessions`, `/v1/events`

**Files (owned):**
- Create: `server/src/router.ts`, `server/src/hostd.ts`, `server/src/version.ts`, `server/src/events/hub.ts`, `server/src/sessions/registry.ts`, `server/src/features/machine.ts`, `server/src/features/sessions.ts`, `server/test/helpers/client.ts`
- Test: `server/test/registry.test.ts`, `server/test/hostd.test.ts`

**Interfaces:**
- Consumes: Tasks 1-6 (`HostdConfig`, `ConfigOverrides`, `run`, `Scratch`, `waitFor`, `ids`, `tmux`, `herdr`, `procs`, `livevoice`, `status`, `Auth`, `Whois`, `ensureLocalToken`, `AccessLog`, `SentLog`).
- Produces:
  - `router.ts`: `interface Ctx { device: string; via: "tailscale" | "local"; route: string; session: string }` (handlers set `ctx.session` for the access log); `interface Route { method: string; pattern: string; handler(req: Request, params: Record<string, string>, ctx: Ctx): Response | Promise<Response> }`; `interface Channel { pattern: string; open(ws: ServerWebSocket<WsData>): void; message(ws: ServerWebSocket<WsData>, data: string | Buffer): void; close(ws: ServerWebSocket<WsData>): void }`; `interface WsData { channel: Channel; params: Record<string, string>; query: URLSearchParams; ctx: Ctx; state: Record<string, unknown> }`; `interface Feature { routes: Route[]; channels: Channel[]; start?(): Promise<void>; stop?(): void | Promise<void> }`; `interface FeatureDeps { config: HostdConfig; registry: Registry; localToken: string; sentLog: SentLog; hub: EventsHub }`; `type FeatureFactory = (d: FeatureDeps) => Feature`; `match(pattern: string, pathname: string): Record<string, string> | null` (`:id` segments, URL-decoded); `json(body: unknown, status = 200): Response`.
  - `events/hub.ts` (this task owns the events hub; P2 adds its notification and ack messages here): `class EventsHub { add(ws: ServerWebSocket<WsData>): void; remove(ws: ServerWebSocket<WsData>): void; broadcast(msg: object): number` (sends `JSON.stringify(msg)` to every added socket, returns how many) `; readonly size: number }`.
  - `hostd.ts`: `interface Hostd { port: number; url: string; localToken: string; config: HostdConfig; registry: Registry; sentLog: SentLog; hub: EventsHub; stop(): Promise<void> }`; `createHostd(config: HostdConfig, factories: FeatureFactory[]): Promise<Hostd>`. It builds, in order: `ensureLocalToken(config.runtimeDir)`, `Whois(config.bin.tailscale)`, `Auth`, `AccessLog(config.stateDir)`, `Registry(config)`, `SentLog(config.stateDir)`, `EventsHub`; then every feature from `FeatureDeps`; then one `Bun.serve` on `config.host:config.apiPort` (port 0 allowed for tests); then `await feature.start?.()` for each feature in order. `stop()` runs every `feature.stop?.()`, `registry.stopWatching()` until idle, and `server.stop(true)`. Order per request: `Auth.check` → 403 `{error}` (no CORS headers) and access-log line; `OPTIONS` → 204 with `corsHeaders`; route match → handler, CORS headers added; WebSocket upgrade only on a channel pattern; unknown → 404. Every request writes one `AccessLog` line (`route` = pattern, never the text or query).
  - `version.ts`: `VERSION = "0.1.0"`.
  - `registry.ts`: `interface SessionInfo { id: string; kind: "tmux" | "herdr"; name: string; cwd: string; status: SessionStatus; reported: boolean; questionCount: number; liveVoice: boolean | null; pinned: boolean; where: Where; attached: boolean; omp: { pid: number; transcript: string | null; inbox: boolean } | null; herdrStatus: string | null }`; `interface Tree { machine: string; scannedAt: string; sessions: SessionInfo[]; sources: { tmux: { socket: string; ok: boolean; error: string }[]; herdr: { ok: boolean; error: string }; liveVoice: { ok: boolean; error: string } } }`; `class Registry { constructor(cfg: HostdConfig); scan(): Promise<Tree>; current(maxAgeMs = 2000): Promise<Tree>; get(id: string, maxAgeMs = 2000): Promise<SessionInfo | null>; onChange(fn: (t: Tree) => void): () => void; startWatching(): void; stopWatching(): void }`. `get(id, 0)` always scans first. Watching is refcounted: `startWatching` scans every `scanIntervalMs` while the count is above 0; an idle hostd never scans (SPEC 6 battery/CPU). `onChange` fires only when the JSON of `sessions` changed.
  - Rules inside `scan()` (SPEC 4.2-4.4): tmux panes from every socket in `listSockets`; herdr agents from `listAgents`; omp found with `findOmp(procTable, panePid)`, transcript via `transcriptOf`, inbox via `hasInbox`; status from the transcript when it has an entry, else from `HERDR_STATUS[agent.status]` for herdr, else `unknown`; `herdrStatus` = the agent's raw herdr status (`null` for tmux). tmux `name` = pane title with braille spinner chars `[\u2800-\u28ff]` and surrounding spaces removed, unless it equals the hostname or is empty, then `basename(cwd)`; herdr `name` = agent `name`, else title, else `basename(cwd)`, else the pane id. `pinned` = cwd is `config.thalamusDir` or below; sort pinned first, then needs-you, then name, then id. `liveVoice` for a tmux pane: `null` when pactl failed, else `true` when any live-voice pid is the pane process or below it (this covers omp and anything else in the pane), else `false`. For herdr: `null` when pactl failed or when any live-voice pid could not be placed in a tmux pane (Verified facts 9: herdr pane pids are not exposed), else `false`.
  - `features/machine.ts`: `machineFeature: FeatureFactory`, `GET /v1/machine` → `{ name, version, authMode: "127.0.0.1", you: { device, via, forwardedFor: string[] }, features: { tmux: boolean, herdr: boolean, pactl: boolean, tailscale: boolean } }` (`forwardedFor` = the request's `X-Forwarded-For` entries in order, trimmed, for Task 12's live check; `features` = presence of each `config.bin` file). Never lists sessions.
  - `features/sessions.ts`: `sessionsFeature: FeatureFactory`, `GET /v1/sessions` → the `Tree` (`registry.current()`); channel `/v1/events`: on open `hub.add(ws)`, `startWatching()`, send `{ type: "sessions", tree }`; `registry.onChange` → `hub.broadcast({ type: "sessions", tree })`; on close `hub.remove(ws)`, `stopWatching()`.
  - `test/helpers/client.ts` (full code below).

**`server/test/helpers/client.ts`:**

```ts
import { connect } from "node:net";
import type { ConfigOverrides } from "../../src/config";
import { createHostd, type Hostd } from "../../src/hostd";
import type { FeatureFactory } from "../../src/router";
import { sessionId } from "../../src/sessions/ids";
import { findOmp, readProcTable } from "../../src/sessions/procs";
import { type Scratch, waitFor } from "./scratch";

export type TestHostd = Hostd;

/** hostd on 127.0.0.1, port 0, every path inside the scratch folder. */
export function startTestHostd(s: Scratch, factories: FeatureFactory[], overrides: ConfigOverrides = {}): Promise<TestHostd> {
  return createHostd(s.config(overrides), factories);
}

export function localHeaders(h: TestHostd): Record<string, string> {
  return { "X-Porthole": "1", "X-Porthole-Local": h.localToken };
}

export function get(h: TestHostd, p: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(h.url + p, { headers: { ...localHeaders(h), ...headers } });
}

export function post(h: TestHostd, p: string, body: unknown): Promise<Response> {
  return fetch(h.url + p, {
    method: "POST",
    headers: { ...localHeaders(h), Origin: h.config.origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export interface WsMessage { type: string; [key: string]: unknown }
export interface TestWs {
  ws: WebSocket;
  /** Every JSON text message, in arrival order. */
  seen: WsMessage[];
  /** The next message of `type` that `next` has not returned yet. */
  next(type: string, timeoutMs?: number): Promise<WsMessage>;
  /** All binary frames so far, decoded as UTF-8. */
  output(): string;
  send(data: string | Uint8Array): void;
  closed: Promise<number>;
  close(): void;
}

export async function openWs(h: TestHostd, p: string, origin: string = h.config.origin): Promise<TestWs> {
  const ws = new WebSocket(h.url.replace(/^http/, "ws") + p, { headers: { Origin: origin, "X-Porthole-Local": h.localToken } });
  ws.binaryType = "arraybuffer";
  const seen: WsMessage[] = [];
  const taken = new Set<WsMessage>();
  const dec = new TextDecoder();
  let out = "";
  ws.onmessage = (e: MessageEvent) => {
    if (typeof e.data === "string") seen.push(JSON.parse(e.data) as WsMessage);
    else out += dec.decode(new Uint8Array(e.data as ArrayBuffer), { stream: true });
  };
  const closed = new Promise<number>((resolve) => { ws.onclose = (e: CloseEvent) => resolve(e.code); });
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("WebSocket to " + p + " did not open"));
  });
  return {
    ws,
    seen,
    async next(type, timeoutMs = 3000) {
      let found: WsMessage | undefined;
      await waitFor(() => {
        found = seen.find((m) => m.type === type && !taken.has(m));
        return found !== undefined;
      }, timeoutMs, 10);
      taken.add(found as WsMessage);
      return found as WsMessage;
    },
    output: () => out,
    send: (data) => ws.send(data),
    closed,
    close: () => ws.close(1000),
  };
}

/** Status code of a WebSocket upgrade, read from the raw HTTP answer (0 = no answer). */
export function rawUpgrade(port: number, p: string, headers: Record<string, string>): Promise<number> {
  const lines = ["GET " + p + " HTTP/1.1", "Host: 127.0.0.1:" + port, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", ...Object.entries(headers).map(([k, v]) => k + ": " + v)];
  return new Promise((resolve) => {
    const sock = connect(port, "127.0.0.1", () => sock.write(lines.join("\r\n") + "\r\n\r\n"));
    let buf = "";
    const timer = setTimeout(() => { sock.destroy(); resolve(0); }, 3000);
    sock.on("data", (d: Buffer) => {
      buf += d.toString("latin1");
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (m) { clearTimeout(timer); sock.destroy(); resolve(Number(m[1])); }
    });
    sock.on("error", () => { clearTimeout(timer); resolve(0); });
  });
}

export interface TestPane { socket: string; pid: number; id: string }

/** A scratch tmux session running `command`; on `socket` when given, else on a new scratch server. `pid` = pane process. */
export async function pane(s: Scratch, session: string, command = "/bin/sh", socket?: string): Promise<TestPane> {
  const sock = socket ?? s.newTmuxServer(session, command);
  if (socket) s.tmux(socket, "new-session", "-d", "-s", session, "-x", "120", "-y", "40", "-c", s.root, command);
  return { socket: sock, pid: s.panePid(sock, "=" + session + ":0.0"), id: sessionId({ kind: "tmux", socket: sock, session, window: 0, pane: 0 }) };
}

/** A scratch tmux session running the fake omp on `transcript`; `pid` = the omp process. */
export async function ompPane(s: Scratch, session: string, transcript: string, socket?: string): Promise<TestPane> {
  const p = await pane(s, session, s.ompCommand(transcript), socket);
  let pid = 0;
  await waitFor(() => {
    pid = findOmp(readProcTable(), p.pid) ?? 0;
    return pid > 0;
  });
  return { ...p, pid };
}
```

**Tests (`server/test/registry.test.ts`, scratch tmux servers + fake herdr + fake pactl):**

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import type { HostdConfig } from "../src/config";
import { sessionId } from "../src/sessions/ids";
import { Registry, type SessionInfo, type Tree } from "../src/sessions/registry";
import { statusFromTranscript } from "../src/sessions/status";
import { Scratch, waitFor } from "./helpers/scratch";

let s: Scratch;
let cfg: HostdConfig;
beforeEach(() => {
  s = new Scratch();
  cfg = s.config();
});
afterEach(() => s.cleanup());

const bySession = (t: Tree, session: string): SessionInfo => {
  const found = t.sessions.find((x) => x.where.kind === "tmux" && x.where.session === session);
  if (!found) throw new Error("no session " + session + " in " + JSON.stringify(t.sessions.map((x) => x.id)));
  return found;
};
const addSession = (sock: string, session: string, command: string, cwd = s.root) =>
  s.tmux(sock, "new-session", "-d", "-s", session, "-x", "120", "-y", "40", "-c", cwd, command);
const herdrAgent = (status: string, extra: Record<string, string> = {}) =>
  s.setHerdrAgents([{ terminal_id: "t1", agent_status: status, workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", focused: false, revision: 1, ...extra }]);

test("finds a scratch tmux omp session with its transcript and status", async () => {
  const file = s.transcript("chat-basic.jsonl");
  const sock = s.newTmuxServer("work", s.ompCommand(file));
  let t: Tree = await new Registry(cfg).scan();
  await waitFor(async () => {
    t = await new Registry(cfg).scan();
    return t.sessions[0]?.omp !== null && t.sessions[0]?.omp !== undefined;
  });
  expect(t.sessions.length).toBe(1);
  const one = t.sessions[0];
  expect(one.id).toBe(sessionId({ kind: "tmux", socket: sock, session: "work", window: 0, pane: 0 }));
  expect(one.kind).toBe("tmux");
  expect(one.omp?.pid).toBeGreaterThan(0);
  expect(one.omp?.transcript?.endsWith("chat-basic.jsonl")).toBe(true);
  expect(one.omp?.inbox).toBe(false);
  expect(one.status).toBe(statusFromTranscript(file).status);
  expect(one.liveVoice).toBe(false);
  expect(one.herdrStatus).toBeNull();
});

test("live voice shows on the matching session only; unknown when pactl fails", async () => {
  const sock = s.newTmuxServer("work", s.ompCommand(s.transcript("chat-basic.jsonl")));
  addSession(sock, "other", "/bin/sh");
  const r = new Registry(cfg);
  let pid = 0;
  await waitFor(async () => {
    pid = bySession(await r.scan(), "work").omp?.pid ?? 0;
    return pid > 0;
  });
  s.setLiveVoicePids([pid]);
  const t = await r.scan();
  expect([bySession(t, "work").liveVoice, bySession(t, "other").liveVoice]).toEqual([true, false]);
  s.breakPactl(true);
  const broken = await r.scan();
  expect([bySession(broken, "work").liveVoice, bySession(broken, "other").liveVoice]).toEqual([null, null]);
  expect(broken.sources.liveVoice.ok).toBe(false);
});

test("herdr agents become sessions; their liveVoice is null while an unplaced live-voice pid exists", async () => {
  herdrAgent("idle", { name: "rev", cwd: "/work" });
  const r = new Registry(cfg);
  const t = await r.scan();
  const h = t.sessions.find((x) => x.kind === "herdr");
  expect(h && [h.id, h.status, h.herdrStatus, h.name, h.liveVoice]).toEqual([sessionId({ kind: "herdr", workspace: "w1", tab: "w1:t1", pane: "w1:p1" }), "idle", "idle", "rev", false]);
  herdrAgent("blocked", { name: "rev" });
  const blocked = (await r.scan()).sessions.find((x) => x.kind === "herdr");
  expect([blocked?.status, blocked?.herdrStatus]).toEqual(["needs-you", "blocked"]);
  s.setLiveVoicePids([99999]);
  expect((await r.scan()).sessions.find((x) => x.kind === "herdr")?.liveVoice).toBeNull();
  expect(t.sources.herdr.ok).toBe(true);
});

test("names: spinner stripped, hostname falls back to the folder", async () => {
  const sock = s.newTmuxServer("work", "/bin/sh");
  const r = new Registry(cfg);
  s.tmux(sock, "select-pane", "-t", "=work:0.0", "-T", "\u280b fixing auth ");
  expect(bySession(await r.scan(), "work").name).toBe("fixing auth");
  s.tmux(sock, "select-pane", "-t", "=work:0.0", "-T", hostname());
  expect(bySession(await r.scan(), "work").name).toBe(path.basename(s.root));
});

test("Thalamus is pinned first, then needs-you, then by name", async () => {
  const sock = s.newTmuxServer("aaa", "/bin/sh");
  addSession(sock, "zzz", "/bin/sh", s.thalamusDir);
  addSession(sock, "ask", s.ompCommand(s.transcript("status-needs-you.jsonl")));
  const r = new Registry(cfg);
  let t: Tree = await r.scan();
  await waitFor(async () => {
    t = await r.scan();
    return bySession(t, "ask").status === "needs-you";
  });
  expect(t.sessions[0].pinned).toBe(true);
  expect((t.sessions[0].where as { session: string }).session).toBe("zzz");
  expect((t.sessions[1].where as { session: string }).session).toBe("ask");
  expect(bySession(t, "aaa").pinned).toBe(false);
});

test("a dead tmux socket is reported, not thrown", async () => {
  s.newTmuxServer("alive", "/bin/sh");
  writeFileSync(path.join(s.socketDir, "dead-socket"), "");
  const t = await new Registry(cfg).scan();
  expect(t.sources.tmux.find((x) => x.socket === "dead-socket")?.ok).toBe(false);
  expect(t.sessions.map((x) => (x.where as { session: string }).session)).toEqual(["alive"]);
});

test("an idle registry does not scan; watching scans; stopping stops", async () => {
  const r = new Registry(cfg);
  await Bun.sleep(cfg.scanIntervalMs * 3);
  expect(s.fakeCalls("herdr").length).toBe(0);
  r.startWatching();
  await waitFor(() => s.fakeCalls("herdr").length > 0, 3000);
  r.stopWatching();
  await Bun.sleep(cfg.scanIntervalMs);
  const n = s.fakeCalls("herdr").length;
  await Bun.sleep(cfg.scanIntervalMs * 3);
  expect(s.fakeCalls("herdr").length).toBe(n);
});

test("P1.1 acceptance: two sockets, three omp statuses, a herdr pane, one live-voice pid", async () => {
  const sockA = s.newTmuxServer("needs", s.ompCommand(s.transcript("status-needs-you.jsonl")));
  addSession(sockA, "working", s.ompCommand(s.transcript("status-working.jsonl")));
  const sockB = s.newTmuxServer("done", s.ompCommand(s.transcript("status-done.jsonl")));
  herdrAgent("working", { name: "herdr-agent" });
  const r = new Registry(cfg);
  let t: Tree = await r.scan();
  await waitFor(async () => {
    t = await r.scan();
    return ["needs", "working", "done"].every((n) => t.sessions.some((x) => x.where.kind === "tmux" && x.where.session === n && x.omp));
  });
  s.setLiveVoicePids([bySession(t, "working").omp?.pid ?? -1]);
  t = await r.scan();
  const view = Object.fromEntries(t.sessions.map((x) => [x.id, [x.status, x.liveVoice]]));
  expect(view).toEqual({
    [sessionId({ kind: "tmux", socket: sockA, session: "needs", window: 0, pane: 0 })]: ["needs-you", false],
    [sessionId({ kind: "tmux", socket: sockA, session: "working", window: 0, pane: 0 })]: ["working", true],
    [sessionId({ kind: "tmux", socket: sockB, session: "done", window: 0, pane: 0 })]: ["done", false],
    [sessionId({ kind: "herdr", workspace: "w1", tab: "w1:t1", pane: "w1:p1" })]: ["working", false],
  });
  expect(t.sources.tmux.map((x) => x.ok)).toEqual([true, true]);
  expect([t.sources.herdr.ok, t.sources.liveVoice.ok]).toEqual([true, true]);
  expect(t.sessions[0].status).toBe("needs-you");
});
```

**Tests (`server/test/hostd.test.ts`):**

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AccessLog } from "../src/auth/accesslog";
import { SentLog } from "../src/deliver/sentlog";
import { machineFeature } from "../src/features/machine";
import { sessionsFeature } from "../src/features/sessions";
import type { FeatureFactory } from "../src/router";
import { get, localHeaders, openWs, pane, rawUpgrade, startTestHostd, type TestHostd } from "./helpers/client";
import { Scratch, waitFor } from "./helpers/scratch";

let s: Scratch;
let h: TestHostd;
beforeEach(async () => {
  s = new Scratch();
  h = await startTestHostd(s, [machineFeature, sessionsFeature]);
});
afterEach(async () => {
  await h.stop();
  s.cleanup();
});

test("GET /v1/machine with the local token", async () => {
  const r = await get(h, "/v1/machine");
  expect(r.status).toBe(200);
  const body = (await r.json()) as Record<string, unknown>;
  expect(body.name).toBe("testhost");
  expect(body.version).toBe("0.1.0");
  expect(body.authMode).toBe("127.0.0.1");
  expect(body.you).toEqual({ device: "local", via: "local", forwardedFor: [] });
  expect(Object.keys(body.features as object).sort()).toEqual(["herdr", "pactl", "tailscale", "tmux"]);
  expect("sessions" in body).toBe(false);
});

test("refusals are 403 and logged without text", async () => {
  expect((await fetch(h.url + "/v1/machine", { headers: { "X-Porthole-Local": h.localToken } })).status).toBe(403);
  expect((await get(h, "/v1/machine", { Origin: "https://evil.example" })).status).toBe(403);
  const lines = readFileSync(new AccessLog(s.stateDir).file, "utf8").trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1]) as { status: number; reason: string; route: string };
  expect(last.status).toBe(403);
  expect(last.reason.length).toBeGreaterThan(0);
  expect(last.route).toBe("/v1/machine");
});

test("GET /v1/sessions lists the scratch session; unknown path 404; OPTIONS 204 with CORS", async () => {
  const p = await pane(s, "work", "/bin/sh");
  const tree = (await (await get(h, "/v1/sessions")).json()) as { sessions: { id: string }[] };
  expect(tree.sessions.map((x) => x.id)).toEqual([p.id]);
  expect((await get(h, "/v1/nothing-here")).status).toBe(404);
  const opt = await fetch(h.url + "/v1/sessions", { method: "OPTIONS", headers: { Origin: h.config.origin } });
  expect(opt.status).toBe(204);
  expect(opt.headers.get("access-control-allow-origin")).toBe(h.config.origin);
});

test("events: snapshot on open, update on change, through the hub", async () => {
  const p = await pane(s, "one", "/bin/sh");
  const ws = await openWs(h, "/v1/events");
  const first = await ws.next("sessions", 3000);
  expect(((first.tree as { sessions: unknown[] }).sessions).length).toBe(1);
  expect(h.hub.size).toBe(1);
  s.tmux(p.socket, "new-session", "-d", "-s", "two", "/bin/sh");
  await waitFor(() => ws.seen.some((m) => m.type === "sessions" && (m.tree as { sessions: unknown[] }).sessions.length === 2), 5000);
  ws.close();
  await waitFor(() => h.hub.size === 0);
});

test("WebSocket upgrades need the exact control-room Origin", async () => {
  const token = { "X-Porthole-Local": h.localToken };
  expect(await rawUpgrade(h.port, "/v1/events", token)).toBe(403);
  expect(await rawUpgrade(h.port, "/v1/events", { ...token, Origin: "https://evil.example" })).toBe(403);
  expect(await rawUpgrade(h.port, "/v1/events", { ...token, Origin: h.config.origin + ":8443" })).toBe(403);
  expect(await rawUpgrade(h.port, "/v1/events", { ...token, Origin: h.config.origin })).toBe(101);
});

test("binds only to config.host", () => {
  expect(h.url.startsWith("http://127.0.0.1:")).toBe(true);
  expect(localHeaders(h)["X-Porthole-Local"]).toBe(h.localToken);
});

test("features get sentLog and hub, start before createHostd resolves, and stop with hostd", async () => {
  const calls: string[] = [];
  const probe: FeatureFactory = (deps) => ({
    routes: [],
    channels: [],
    async start() {
      await Bun.sleep(50);
      calls.push("start:" + (deps.sentLog instanceof SentLog) + ":" + deps.hub.size);
    },
    stop() {
      calls.push("stop");
    },
  });
  const h2 = await startTestHostd(s, [probe]);
  expect(calls).toEqual(["start:true:0"]);
  expect(h2.sentLog.file).toBe(new SentLog(s.stateDir).file);
  await h2.stop();
  expect(calls).toEqual(["start:true:0", "stop"]);
});
```

Run: `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/registry.test.ts server/test/hostd.test.ts`
Expected before implementing: FAIL, `Cannot find module '../src/sessions/registry'`. After: PASS, 15 tests.

Commit: `P1 task 8: router, hostd assembly, events hub, session registry, machine/sessions/events routes`

---

### Task 9: Chat and screen routes

**Files (owned):**
- Create: `server/src/features/chat.ts`
- Test: `server/test/chat.test.ts`

**Interfaces:**
- Consumes: Task 4 (`readPage`, `readAfter`, `Follower`, `Page`), Task 2 (`capturePane`, `readScreen`), Task 8 (`FeatureFactory`, `FeatureDeps`, `Registry`, `client.ts`).
- Produces: `chatFeature: FeatureFactory` with
  - `GET /v1/sessions/:id/chat?before=<cursor>|after=<cursor>&limit=<1..200, default 50>` → `Page` (`after` → `readAfter`). No such session → 404 `{ error: "no such session" }`; no transcript → 200 `{ items: [], start: 0, end: 0, hasOlder: false, note: "this session has no omp transcript; use Terminal or Screen" }`.
  - channel `/v1/sessions/:id/chat` → on open `{ type: "backlog", page }` (last 50) then `{ type: "append", items, end }` from a `Follower` started at `page.end`; on the follower's reset `{ type: "backlog", page }` again. No such session → `{ type: "error", error: "no such session" }` and close 1000; no transcript → `{ type: "error", error: "this session has no omp transcript" }` and close 1000.
  - **Transcript change (omp `/new`, or omp restarted in the pane):** while any chat socket is open the feature holds `registry.startWatching()` (released with `stopWatching()` when the last one closes) and listens with `registry.onChange`. When the session's `omp.transcript` differs from the file the socket follows, it calls `stop()` on the old `Follower`, sends a fresh `{ type: "backlog", page }` from the new file, and starts a **new** `Follower` on the new file at that page's `end` (a `Follower`'s file is fixed for its life).
  - `GET /v1/sessions/:id/screen?lines=<1..2000, default 200>` → `{ text, source: "tmux" | "herdr", at }` from `capturePane` / `readScreen`; a source error → 502 `{ error }`; no such session → 404.

**Tests (`server/test/chat.test.ts`):**

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, truncateSync } from "node:fs";
import { chatFeature } from "../src/features/chat";
import { sessionId } from "../src/sessions/ids";
import { get, ompPane, openWs, pane, startTestHostd, type TestHostd } from "./helpers/client";
import { Scratch, waitFor } from "./helpers/scratch";

let s: Scratch;
let h: TestHostd;
beforeEach(async () => {
  s = new Scratch();
  h = await startTestHostd(s, [chatFeature]);
});
afterEach(async () => {
  await h.stop();
  s.cleanup();
});

type Item = { cursor: number; text: string };
type PageBody = { items: Item[]; start: number; end: number; hasOlder: boolean; note?: string };
const userLine = (id: string, text: string) =>
  JSON.stringify({ type: "message", id, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
const chatPath = (id: string) => "/v1/sessions/" + encodeURIComponent(id) + "/chat";

test("pages over HTTP", async () => {
  const p = await ompPane(s, "omp", s.transcript("chat-basic.jsonl"));
  const last = (await (await get(h, chatPath(p.id) + "?limit=1")).json()) as PageBody;
  expect(last.items.map((i) => i.text)).toEqual(["Also check the tests"]);
  expect(last.hasOlder).toBe(true);
  const older = (await (await get(h, chatPath(p.id) + "?before=" + last.start + "&limit=50")).json()) as PageBody;
  expect(older.items.length).toBeGreaterThan(0);
  expect(older.items.every((i) => i.cursor < last.start)).toBe(true);
  const after = (await (await get(h, chatPath(p.id) + "?after=" + older.items[0].cursor)).json()) as PageBody;
  expect(after.items.at(-1)?.text).toBe("Also check the tests");
});

test("WebSocket backlog, then append, then a new backlog after the file shrinks", async () => {
  const file = s.transcript("chat-basic.jsonl", "live.jsonl");
  const p = await ompPane(s, "omp", file);
  const ws = await openWs(h, chatPath(p.id));
  const first = await ws.next("backlog", 3000);
  expect((first.page as PageBody).items.at(-1)?.text).toBe("Also check the tests");
  appendFileSync(file, userLine("u90", "new from the test"));
  const add = await ws.next("append", 3000);
  expect((add.items as Item[]).map((i) => i.text)).toEqual(["new from the test"]);
  truncateSync(file, 0);
  const again = await ws.next("backlog", 3000);
  expect((again.page as PageBody).items).toEqual([]);
  ws.close();
});

test("a different transcript in the same pane (omp /new) restarts the follower on the new file", async () => {
  const fileA = s.transcript("chat-basic.jsonl", "a.jsonl");
  const fileB = s.writeTranscript("b.jsonl", userLine("b1", "from file B"));
  const p = await ompPane(s, "omp", fileA);
  const ws = await openWs(h, chatPath(p.id));
  await ws.next("backlog", 3000);
  s.tmux(p.socket, "respawn-pane", "-k", "-t", "=omp:0.0", s.ompCommand(fileB));
  const moved = await ws.next("backlog", 5000);
  expect((moved.page as PageBody).items.map((i) => i.text)).toEqual(["from file B"]);
  appendFileSync(fileA, userLine("a99", "old file, ignored"));
  appendFileSync(fileB, userLine("b2", "B again"));
  const add = await ws.next("append", 3000);
  expect((add.items as Item[]).map((i) => i.text)).toEqual(["B again"]);
  await Bun.sleep(500);
  expect(JSON.stringify(ws.seen)).not.toContain("old file, ignored");
  ws.close();
});

test("no transcript: HTTP note and a WebSocket error", async () => {
  const p = await pane(s, "plain", "/bin/sh");
  const r = await get(h, chatPath(p.id));
  expect(r.status).toBe(200);
  expect(((await r.json()) as PageBody).note).toBe("this session has no omp transcript; use Terminal or Screen");
  const ws = await openWs(h, chatPath(p.id));
  expect((await ws.next("error", 3000)).error).toBe("this session has no omp transcript");
  expect(await ws.closed).toBe(1000);
});

test("screen shows the tmux pane and the herdr screen", async () => {
  const p = await pane(s, "plain", "/bin/sh");
  s.tmux(p.socket, "send-keys", "-t", "=plain:0.0", "printf 'marker-%s\\n' 42", "Enter");
  await waitFor(async () => (((await (await get(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/screen")).json()) as { text: string }).text.includes("marker-42")));
  const tm = (await (await get(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/screen")).json()) as { source: string };
  expect(tm.source).toBe("tmux");
  s.setHerdrAgents([{ terminal_id: "t1", agent_status: "idle", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", focused: false, revision: 1 }]);
  s.setHerdrScreen("w1:p1", "hello herdr\n");
  const hid = sessionId({ kind: "herdr", workspace: "w1", tab: "w1:t1", pane: "w1:p1" });
  const hr = (await (await get(h, "/v1/sessions/" + encodeURIComponent(hid) + "/screen")).json()) as { text: string; source: string };
  expect([hr.source, hr.text.includes("hello herdr")]).toEqual(["herdr", true]);
});

test("unknown session: 404 on chat and screen, error on the channel", async () => {
  const id = "tmux:nope:nope:0.0";
  expect((await get(h, chatPath(id))).status).toBe(404);
  expect((await get(h, "/v1/sessions/" + encodeURIComponent(id) + "/screen")).status).toBe(404);
  const ws = await openWs(h, chatPath(id));
  expect((await ws.next("error", 3000)).error).toBe("no such session");
  expect(await ws.closed).toBe(1000);
});
```

Run: `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/chat.test.ts`
Expected before implementing: FAIL, `Cannot find module '../src/features/chat'`. After: PASS, 6 tests.

Commit: `P1 task 9: chat history/live chat and screen routes`

---

### Task 10: Delivery (send, status, keys) and the one live-inbox run

**Files (owned):**
- Create: `server/src/deliver/deliver.ts`, `server/src/deliver/keys.ts`, `server/src/features/send.ts`, `server/test/live/live-inbox-once.ts`
- Test: `server/test/deliver.test.ts`, `server/test/keys.test.ts`

**Interfaces:**
- Consumes: Task 1 (`HostdConfig`, `Scratch`, `waitFor`), Task 2 (`sessionId`, `sendText`, `sendKeys`, `prompt`, `herdrSendKeys`† , `herdrError`), Task 3 (`ompAlive`), Task 6 (`SentLog`, `SendRecord`, `CLIENT_MSG_ID`, `MAX_MESSAGE_BYTES`, `inboxDir`, `stageInbox`, `commitInbox`, `waitTaken`), Task 8 (`Feature`, `FeatureDeps` incl. `sentLog`, `FeatureFactory`, `Registry`, `client.ts`). † `herdr.ts`'s `sendKeys`, imported as `sendKeys as herdrSendKeys`.
- Produces:
  - `keys.ts`: `type KeyStep = { key: string } | { text: string }`; `parseSteps(keys: unknown): KeyStep[] | { error: string }` accepting an array of strings: `Tab Enter Esc Space BSpace Up Down Left Right Home End PageUp PageDown`, `C-<a-z>`, one printable character, and `text:<anything>`; 1 to 32 entries. `TMUX_KEYS: Record<string, string>` (`Esc → Escape`, others the same name). `HERDR_KEYS: Record<string, string>` (`Esc → esc`, `C-c → ctrl+c` verified; the rest lower-case names, **GUESS**, Needs Ben 2).
  - `deliver.ts`: `type KeyResult = { status: "sent" | "refused" | "failed"; reason: string }`; `class Deliverer { constructor(cfg: HostdConfig, registry: Registry, sentLog: SentLog); send(sessionId: string, clientMsgId: string, text: string): Promise<SendRecord>; status(clientMsgId: string): SendRecord | undefined; keys(sessionId: string, steps: KeyStep[]): Promise<KeyResult>; reconcilePending(): Promise<void>; hasPending(): boolean }`. `send` expects an id that matches `CLIENT_MSG_ID` and text within `MAX_MESSAGE_BYTES` (the route checks both).
  - `features/send.ts`: `sendFeature: FeatureFactory` (a plain factory like the others): it builds `new Deliverer(deps.config, deps.registry, deps.sentLog)`; its `start()` runs `await reconcilePending()` once, then a timer every `config.scanIntervalMs` that runs `reconcilePending()` while `hasPending()`; `stop()` clears the timer. Routes:
    - `POST /v1/sessions/:id/send` body `{ "clientMsgId", "text" }` → the `SendRecord` without `text`; 200 `delivered`/`pending`, 409 `refused`, 502 `failed`; 400 `{error}` for a bad id, missing text, or text over `MAX_MESSAGE_BYTES` (nothing recorded).
    - `GET /v1/sends/:clientMsgId` → latest record without `text`; 404 `{error: "no such message"}`.
    - `POST /v1/sessions/:id/keys` body `{ "keys": ["Esc", "C-c", "y", "text:hello"] }` (SPEC 5.2) → `KeyResult`; 200 `sent`, 409 `refused`, 502 `failed`; 400 `{error}` when `keys` is missing or `parseSteps` fails.

**Rules (SPEC 4.5):**
1. **Seen-before check under a per-id lock.** `send` first takes a lock keyed by `clientMsgId` (a `Map<string, Promise<unknown>>` chain), and does everything below inside it, so two simultaneous sends of one id run one after the other. Inside: `latest = sentLog.latest(clientMsgId)`.
   - `latest` is `delivered` or `pending` for the same session → return `latest`; nothing is typed or written.
   - `latest` is `delivered` or `pending` for another session → return `{ ...latest, sessionId, status: "refused", reason: "this message id was already used for another session", route: "none", text: "" }` **without** writing it to `sent.jsonl` (the original record must stay the latest one).
   - `latest` is `refused` or `failed`, or there is none → deliver now (a retry is allowed after refused/failed).
2. **One delivery at a time per session:** a second lock keyed by session id, taken inside the id lock.
3. **Route choice** from `await registry.get(sessionId, 0)` (a fresh scan):
   - no such session → append and return `refused "no such session"`, route `none`.
   - omp with inbox → **inbox**: `stageInbox(inboxDir(cfg.inboxRoot, pid), id, text)` → append `pending` with `pid`, `file = staged.final` → `commitInbox` → `waitTaken(file, cfg.pendingAfterMs)` → true: append `delivered`; false: return the `pending` record (reconcile finishes it).
   - omp without inbox → **tmux**, only when `liveVoice === false`; otherwise refused `"live voice is on and this omp has no inbox; turn live voice off or restart omp"` (`liveVoice` true) or `"cannot tell if live voice is on; refusing to type into this omp"` (null).
   - plain tmux pane → **tmux**.
   - tmux route: append `pending` (route `tmux`, no pid/file) → `sendText(cfg, where, text)` (Task 2: `send-keys -l` then `Enter`) → `delivered`, or `failed "tmux could not type: <error>"`.
   - herdr → refused `"cannot tell if live voice is on for this herdr pane"` when `liveVoice === null`, refused `"live voice is on"` when true; refused `"the agent is showing a question; answer it with the key row first"` when `herdrStatus === "blocked"` (checked **before** any prompt call); else append `pending` (route `herdr`) → `prompt(cfg, pane, text)` → `delivered`, or `failed "herdr could not send: <herdrError text>"` (HTTP 502). The fake's `failHerdrPrompt(true)` is P1.3's forced failure.
4. **`reconcilePending()`** (at hostd start through `Feature.start`, then on the timer) handles every `sentLog.pending()` record whose id is **not** in flight in this process (the Deliverer keeps an in-flight id set):
   - inbox, with `part = <dir of file>/.<basename of file>.part`:
     - `part` exists (hostd died between "record pending" and the rename): omp alive (`ompAlive(pid)`) → `commitInbox({ part, final: file })`, stays `pending`; omp dead → remove `part`, `failed "omp exited before reading the message"`.
     - `file` exists: omp alive → stays `pending`; omp dead → remove `file`, `failed "omp exited before reading the message"`.
     - neither exists → `delivered` (omp took it). This is the only case counted as delivered.
   - tmux / herdr → `failed "hostd stopped while typing; check the pane"`.
5. **`keys`**: no such session → refused `"no such session"`. tmux: an omp pane needs `liveVoice === false`, else refused `"live voice is on; keys would mix with it"` (true) or `"cannot tell if live voice is on, so keys are off"` (null); each step → `sendKeys(cfg, where, [TMUX_KEYS[key]])` or `sendKeys(cfg, where, ["-l", text])`; an error → `failed`. herdr: refused the same way when `liveVoice` is `null` or `true` (same as send); `text:` steps → refused `"text steps work on tmux panes only; use Send for herdr"`; key steps → `herdrSendKeys(cfg, pane, steps.map(HERDR_KEYS))`; error → `failed`. A blocked herdr agent accepts keys (that is how its question gets answered).

**Tests (`server/test/deliver.test.ts`, scratch tmux + fakes only):**

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { HostdConfig } from "../src/config";
import { Deliverer } from "../src/deliver/deliver";
import { inboxDir, stageInbox } from "../src/deliver/inbox";
import { SentLog } from "../src/deliver/sentlog";
import { sendFeature } from "../src/features/send";
import { sessionId } from "../src/sessions/ids";
import { Registry } from "../src/sessions/registry";
import { localHeaders, ompPane, pane, post, startTestHostd } from "./helpers/client";
import { Scratch, waitFor } from "./helpers/scratch";

let s: Scratch;
let cfg: HostdConfig;
let log: SentLog;
let d: Deliverer;
beforeEach(() => {
  s = new Scratch();
  cfg = s.config();
  log = new SentLog(cfg.stateDir);
  d = new Deliverer(cfg, new Registry(cfg), log);
});
afterEach(() => s.cleanup());

const HERDR_ID = sessionId({ kind: "herdr", workspace: "w1", tab: "w1:t1", pane: "w1:p1" });
function herdrAgent(status: string): void {
  s.setHerdrAgents([{ terminal_id: "t1", agent_status: status, workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", focused: false, revision: 1, name: "rev" }]);
}
function herdrPrompts(): { target: string; text: string }[] {
  return s.fakeFile("herdr-prompts.log").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const capture = (sock: string, session: string) => s.tmux(sock, "capture-pane", "-p", "-J", "-t", "=" + session + ":0.0");
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
/** Deletes every *.msg in `dir` as omp's live-inbox would, and counts how many it saw. */
function watcher(dir: string): { seen: string[]; stop(): void } {
  const seen: string[] = [];
  const t = setInterval(() => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".msg")) {
        seen.push(f);
        rmSync(path.join(dir, f), { force: true });
      }
    }
  }, 20);
  return { seen, stop: () => clearInterval(t) };
}
async function deadPid(): Promise<number> {
  const p = Bun.spawn(["true"]);
  await p.exited;
  return p.pid;
}

test("plain tmux send types the text and Enter once (P1.3 b)", async () => {
  const p = await pane(s, "work", "cat > /dev/null");
  const r = await d.send(p.id, "m-tmux-1", "hello porthole");
  expect([r.status, r.route]).toEqual(["delivered", "tmux"]);
  await waitFor(() => capture(p.socket, "work").includes("hello porthole"));
  const again = await d.send(p.id, "m-tmux-1", "hello porthole");
  expect(again).toEqual(r);
  await Bun.sleep(300);
  expect(count(capture(p.socket, "work"), "hello porthole")).toBe(1);
});

test("multi-line text arrives as lines, then one Enter", async () => {
  const p = await pane(s, "work", "cat > /dev/null");
  const r = await d.send(p.id, "m-lines", "line one\nline two\nline three");
  expect(r.status).toBe("delivered");
  await waitFor(() => /line one\nline two\nline three/.test(capture(p.socket, "work")));
});

test("the same id sent twice at the same moment is delivered once", async () => {
  const p = await pane(s, "work", "cat > /dev/null");
  const [a, b] = await Promise.all([d.send(p.id, "m-race", "race text"), d.send(p.id, "m-race", "race text")]);
  expect(a.status).toBe("delivered");
  expect(b).toEqual(a);
  await Bun.sleep(300);
  expect(count(capture(p.socket, "work"), "race text")).toBe(1);
  herdrAgent("idle");
  await Promise.all([d.send(HERDR_ID, "h-race", "once"), d.send(HERDR_ID, "h-race", "once")]);
  expect(herdrPrompts()).toEqual([{ target: "w1:p1", text: "once" }]);
});

test("an id used for one session is refused for another, and the first record stays", async () => {
  const p1 = await pane(s, "one", "cat > /dev/null");
  const p2 = await pane(s, "two", "cat > /dev/null", p1.socket);
  const first = await d.send(p1.id, "m-shared", "first");
  const other = await d.send(p2.id, "m-shared", "first");
  expect([other.status, other.reason]).toEqual(["refused", "this message id was already used for another session"]);
  expect(d.status("m-shared")).toEqual(first);
  expect(capture(p2.socket, "two")).not.toContain("first");
});

test("a refused id can be retried and is then delivered once", async () => {
  herdrAgent("idle");
  s.setLiveVoicePids([99999]);
  const refused = await d.send(HERDR_ID, "m-retry", "after the retry");
  expect([refused.status, refused.reason]).toEqual(["refused", "cannot tell if live voice is on for this herdr pane"]);
  s.setLiveVoicePids([]);
  const ok = await d.send(HERDR_ID, "m-retry", "after the retry");
  expect(ok.status).toBe("delivered");
  expect(await d.send(HERDR_ID, "m-retry", "after the retry")).toEqual(ok);
  expect(herdrPrompts()).toEqual([{ target: "w1:p1", text: "after the retry" }]);
});

test("a failed id can be retried", async () => {
  herdrAgent("idle");
  s.failHerdrPrompt(true);
  expect((await d.send(HERDR_ID, "m-fail-retry", "x")).status).toBe("failed");
  s.failHerdrPrompt(false);
  expect((await d.send(HERDR_ID, "m-fail-retry", "x")).status).toBe("delivered");
});

test("inbox route: delivered when omp takes the file, exactly once for the same id (P1.3 a)", async () => {
  const p = await ompPane(s, "omp", s.transcript("chat-basic.jsonl"));
  const dir = inboxDir(cfg.inboxRoot, p.pid);
  mkdirSync(dir, { recursive: true });
  const w = watcher(dir);
  try {
    const r = await d.send(p.id, "m-inbox", "through the inbox");
    expect([r.status, r.route, r.pid]).toEqual(["delivered", "inbox", p.pid]);
    expect(await d.send(p.id, "m-inbox", "through the inbox")).toEqual(r);
    await Bun.sleep(200);
    expect(w.seen).toEqual(["m-inbox.msg"]);
  } finally {
    w.stop();
  }
});

test("inbox route without a reader stays pending, then reconcile marks it delivered", async () => {
  const p = await ompPane(s, "omp", s.transcript("chat-basic.jsonl"));
  const dir = inboxDir(cfg.inboxRoot, p.pid);
  mkdirSync(dir, { recursive: true });
  const r = await d.send(p.id, "m-wait", "nobody reads");
  expect(r.status).toBe("pending");
  expect(existsSync(path.join(dir, "m-wait.msg"))).toBe(true);
  expect(d.hasPending()).toBe(true);
  rmSync(path.join(dir, "m-wait.msg"));
  await d.reconcilePending();
  expect(d.status("m-wait")?.status).toBe("delivered");
  expect(d.hasPending()).toBe(false);
});

test("omp without an inbox is refused while live voice is on or unknown", async () => {
  const p = await ompPane(s, "omp", s.transcript("chat-basic.jsonl"));
  s.setLiveVoicePids([p.pid]);
  expect((await d.send(p.id, "m-lv-1", "x")).reason).toBe("live voice is on and this omp has no inbox; turn live voice off or restart omp");
  s.setLiveVoicePids([]);
  s.breakPactl(true);
  expect((await d.send(p.id, "m-lv-2", "x")).reason).toBe("cannot tell if live voice is on; refusing to type into this omp");
  s.breakPactl(false);
  const ok = await d.send(p.id, "m-lv-3", "x");
  expect([ok.status, ok.route]).toEqual(["delivered", "tmux"]);
});

test("herdr: delivered when idle, refused on a question, failed on a forced failure (P1.3 c)", async () => {
  herdrAgent("idle");
  const ok = await d.send(HERDR_ID, "h-1", "hi herdr");
  expect([ok.status, ok.route]).toEqual(["delivered", "herdr"]);
  expect(herdrPrompts()).toEqual([{ target: "w1:p1", text: "hi herdr" }]);
  herdrAgent("blocked");
  const q = await d.send(HERDR_ID, "h-2", "should not go");
  expect([q.status, q.reason]).toEqual(["refused", "the agent is showing a question; answer it with the key row first"]);
  expect(herdrPrompts().length).toBe(1);
  herdrAgent("idle");
  s.failHerdrPrompt(true);
  const f = await d.send(HERDR_ID, "h-3", "forced");
  expect(f.status).toBe("failed");
  expect(f.reason).toBe("herdr could not send: fake failure");
  s.setLiveVoicePids([99999]);
  expect((await d.send(HERDR_ID, "h-4", "x")).reason).toBe("cannot tell if live voice is on for this herdr pane");
});

test("crash recovery: half-typed tmux/herdr records fail, inbox records follow the files", async () => {
  const omp = await ompPane(s, "omp", s.transcript("chat-basic.jsonl"));
  const live = inboxDir(cfg.inboxRoot, omp.pid);
  mkdirSync(live, { recursive: true });
  const dead = await deadPid();
  const deadDir = inboxDir(cfg.inboxRoot, dead);
  mkdirSync(deadDir, { recursive: true });
  const base = { reason: "", text: "t", sessionId: omp.id } as const;
  log.append({ ...base, clientMsgId: "c-tmux", status: "pending", route: "tmux", pid: null, file: null });
  log.append({ ...base, clientMsgId: "c-herdr", status: "pending", route: "herdr", pid: null, file: null });
  // .part only, omp alive: hostd died before the rename -> commit it, stay pending.
  const partLive = stageInbox(live, "c-part-live", "t");
  log.append({ ...base, clientMsgId: "c-part-live", status: "pending", route: "inbox", pid: omp.pid, file: partLive.final });
  // .part only, omp dead -> failed, .part removed.
  const partDead = stageInbox(deadDir, "c-part-dead", "t");
  log.append({ ...base, clientMsgId: "c-part-dead", status: "pending", route: "inbox", pid: dead, file: partDead.final });
  // .msg present, omp dead -> failed, .msg removed.
  const msgDead = stageInbox(deadDir, "c-msg-dead", "t");
  Bun.spawnSync(["mv", msgDead.part, msgDead.final]);
  log.append({ ...base, clientMsgId: "c-msg-dead", status: "pending", route: "inbox", pid: dead, file: msgDead.final });
  // neither file -> delivered.
  log.append({ ...base, clientMsgId: "c-gone", status: "pending", route: "inbox", pid: omp.pid, file: path.join(live, "c-gone.msg") });

  const fresh = new Deliverer(cfg, new Registry(cfg), new SentLog(cfg.stateDir));
  await fresh.reconcilePending();
  const st = (id: string) => [fresh.status(id)?.status, fresh.status(id)?.reason];
  expect(st("c-tmux")).toEqual(["failed", "hostd stopped while typing; check the pane"]);
  expect(st("c-herdr")).toEqual(["failed", "hostd stopped while typing; check the pane"]);
  expect(st("c-part-live")).toEqual(["pending", ""]);
  expect([existsSync(partLive.part), existsSync(partLive.final)]).toEqual([false, true]);
  expect(st("c-part-dead")).toEqual(["failed", "omp exited before reading the message"]);
  expect(existsSync(partDead.part)).toBe(false);
  expect(st("c-msg-dead")).toEqual(["failed", "omp exited before reading the message"]);
  expect(existsSync(msgDead.final)).toBe(false);
  expect(st("c-gone")).toEqual(["delivered", ""]);
  rmSync(partLive.final);
  await fresh.reconcilePending();
  expect(st("c-part-live")).toEqual(["delivered", ""]);
});

test("HTTP: hostd start reconciles, checks bodies, and never returns text", async () => {
  const p = await pane(s, "work", "cat > /dev/null");
  log.append({ clientMsgId: "boot-1", sessionId: p.id, status: "pending", reason: "", route: "tmux", text: "t", pid: null, file: null });
  const h = await startTestHostd(s, [sendFeature]);
  try {
    expect(new SentLog(cfg.stateDir).latest("boot-1")?.status).toBe("failed");
    const url = "/v1/sessions/" + encodeURIComponent(p.id);
    const noOrigin = await fetch(h.url + url + "/send", { method: "POST", headers: localHeaders(h), body: JSON.stringify({ clientMsgId: "h-a", text: "x" }) });
    expect(noOrigin.status).toBe(403);
    expect((await post(h, url + "/send", { clientMsgId: "bad id!", text: "x" })).status).toBe(400);
    expect((await post(h, url + "/send", { clientMsgId: "h-big", text: "x".repeat(600 * 1024) })).status).toBe(400);
    expect(new SentLog(cfg.stateDir).latest("h-big")).toBeUndefined();
    const sent = await post(h, url + "/send", { clientMsgId: "h-ok", text: "over http" });
    expect(sent.status).toBe(200);
    const body = (await sent.json()) as Record<string, unknown>;
    expect(body.status).toBe("delivered");
    expect("text" in body).toBe(false);
    const got = await fetch(h.url + "/v1/sends/h-ok", { headers: localHeaders(h) });
    expect("text" in ((await got.json()) as object)).toBe(false);
    expect((await fetch(h.url + "/v1/sends/nope", { headers: localHeaders(h) })).status).toBe(404);
    expect((await post(h, url + "/keys", { keys: ["Esc"] })).status).toBe(200);
    expect((await post(h, url + "/keys", { steps: ["Esc"] })).status).toBe(400);
    herdrAgent("blocked");
    expect((await post(h, "/v1/sessions/" + encodeURIComponent(HERDR_ID) + "/send", { clientMsgId: "h-q", text: "x" })).status).toBe(409);
    herdrAgent("idle");
    s.failHerdrPrompt(true);
    expect((await post(h, "/v1/sessions/" + encodeURIComponent(HERDR_ID) + "/send", { clientMsgId: "h-f", text: "x" })).status).toBe(502);
  } finally {
    await h.stop();
  }
});
```

**Tests (`server/test/keys.test.ts`):**

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Deliverer } from "../src/deliver/deliver";
import { parseSteps } from "../src/deliver/keys";
import { SentLog } from "../src/deliver/sentlog";
import { sessionId } from "../src/sessions/ids";
import { Registry } from "../src/sessions/registry";
import { ompPane, pane } from "./helpers/client";
import { Scratch, waitFor } from "./helpers/scratch";

let s: Scratch;
let d: Deliverer;
beforeEach(() => {
  s = new Scratch();
  const cfg = s.config();
  d = new Deliverer(cfg, new Registry(cfg), new SentLog(cfg.stateDir));
});
afterEach(() => s.cleanup());

const HERDR_ID = sessionId({ kind: "herdr", workspace: "w1", tab: "w1:t1", pane: "w1:p1" });
function herdrAgent(status: string): void {
  s.setHerdrAgents([{ terminal_id: "t1", agent_status: status, workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", focused: false, revision: 1, name: "rev" }]);
}

test("parseSteps accepts the key row and refuses anything else", () => {
  expect(parseSteps(["Esc", "C-c", "y", "text:hello"])).toEqual([{ key: "Esc" }, { key: "C-c" }, { key: "y" }, { text: "hello" }]);
  expect("error" in (parseSteps(["Hyper"]) as object)).toBe(true);
  expect("error" in (parseSteps([]) as object)).toBe(true);
  expect("error" in (parseSteps(Array(33).fill("Tab")) as object)).toBe(true);
  expect("error" in (parseSteps("Esc") as object)).toBe(true);
});

test("tmux keys reach a scratch pane", async () => {
  const p = await pane(s, "work", "cat -v");
  const r = await d.keys(p.id, parseSteps(["text:abc", "C-a", "Enter"]) as never);
  expect(r).toEqual({ status: "sent", reason: "" });
  await waitFor(() => s.tmux(p.socket, "capture-pane", "-p", "-t", "=work:0.0").includes("abc^A"));
});

test("herdr keys appear in the fake's log, even while the agent asks a question", async () => {
  herdrAgent("blocked");
  expect(await d.keys(HERDR_ID, [{ key: "Esc" }])).toEqual({ status: "sent", reason: "" });
  const last = s.fakeFile("herdr-keys.log").trim().split("\n").pop() ?? "";
  expect(JSON.parse(last)).toEqual({ target: "w1:p1", keys: ["esc"] });
  expect((await d.keys(HERDR_ID, [{ text: "hi" }])).reason).toBe("text steps work on tmux panes only; use Send for herdr");
});

test("keys are refused while live voice is on or unknown", async () => {
  const p = await ompPane(s, "omp", s.transcript("chat-basic.jsonl"));
  s.setLiveVoicePids([p.pid]);
  expect(await d.keys(p.id, [{ key: "Esc" }])).toEqual({ status: "refused", reason: "live voice is on; keys would mix with it" });
  herdrAgent("idle");
  expect((await d.keys(HERDR_ID, [{ key: "Esc" }])).status).toBe("sent");
  s.setLiveVoicePids([99999]);
  expect(await d.keys(HERDR_ID, [{ key: "Esc" }])).toEqual({ status: "refused", reason: "cannot tell if live voice is on, so keys are off" });
  s.setLiveVoicePids([]);
  s.breakPactl(true);
  expect((await d.keys(HERDR_ID, [{ key: "Esc" }])).status).toBe("refused");
  expect((await d.keys(p.id, [{ key: "Esc" }])).status).toBe("refused");
});
```

Run: `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/deliver.test.ts server/test/keys.test.ts`
Expected before implementing: FAIL, `Cannot find module '../src/deliver/deliver'`. After: PASS, 16 tests.

Commit: `P1 task 10: delivery (inbox/tmux/herdr, exactly once, retry, crash recovery), key row`

**Live check, run exactly once by the orchestrator (`server/test/live/live-inbox-once.ts`, SPEC 7, one cheap model reply, about 9 US cents, needs Ben's yes in the run report).** The real omp's live-inbox writes `$XDG_RUNTIME_DIR/omp-inbox/<pid>`, so the throwaway omp is started with `XDG_RUNTIME_DIR` set to the scratch run folder and hostd's `inboxRoot` points at `<that folder>/omp-inbox`; nothing touches `/run/user/1000`.

```ts
// One live check of the inbox route against a real, throwaway omp (P1.3 a). Run once; never rerun,
// whether it passes or fails. Exit 0 = pass, 1 = fail (stop, report to Ben), 2 = could not start.
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Deliverer } from "../../src/deliver/deliver";
import { inboxDir } from "../../src/deliver/inbox";
import { SentLog } from "../../src/deliver/sentlog";
import { Registry } from "../../src/sessions/registry";
import { Scratch, waitFor } from "../helpers/scratch";

const repo = path.join(import.meta.dir, "..", "..", "..");
const omp = Bun.which("omp");
if (!omp) {
  console.log("CANNOT RUN: omp is not on PATH");
  process.exit(2);
}
const s = new Scratch();
mkdirSync(s.runtimeDir, { recursive: true, mode: 0o700 });
const cfg = s.config({ inboxRoot: path.join(s.runtimeDir, "omp-inbox"), pendingAfterMs: 30_000 });
const registry = new Registry(cfg);
const log = new SentLog(cfg.stateDir);
const d = new Deliverer(cfg, registry, log);
let code = 1;
let ompPid = 0;
try {
  const cmd = "XDG_RUNTIME_DIR='" + s.runtimeDir + "' '" + omp + "' --no-extensions -e '" + path.join(repo, "omp-extension", "live-inbox.ts") + "' --no-session --model haiku";
  s.newTmuxServer("live-inbox", cmd, s.root);
  let id = "";
  await waitFor(async () => {
    const t = await registry.scan();
    const found = t.sessions.find((x) => x.omp?.inbox);
    if (found?.omp) {
      id = found.id;
      ompPid = found.omp.pid;
    }
    return id !== "";
  }, 60_000, 500);
  const dir = inboxDir(cfg.inboxRoot, ompPid);
  console.log("omp pid " + ompPid + ", inbox " + dir);
  const first = await d.send(id, "porthole-live-1", "reply with the word porthole");
  console.log("first send: " + first.status + " " + first.reason);
  const linesBefore = readFileSync(log.file, "utf8").split("\n").filter(Boolean).length;
  const second = await d.send(id, "porthole-live-1", "reply with the word porthole");
  await Bun.sleep(2000);
  const leftover = readdirSync(dir).filter((f) => f.includes("porthole-live-1"));
  const linesAfter = readFileSync(log.file, "utf8").split("\n").filter(Boolean).length;
  console.log("second send: " + second.status + ", files left: " + JSON.stringify(leftover) + ", new sent.jsonl lines: " + (linesAfter - linesBefore));
  const pass = first.status === "delivered" && second.at === first.at && leftover.length === 0 && linesAfter === linesBefore;
  console.log(pass ? "PASS" : "FAIL: stop, do not rerun, report to Ben");
  code = pass ? 0 : 1;
} catch (e) {
  console.log("FAIL: " + (e instanceof Error ? e.message : String(e)) + " (stop, do not rerun, report to Ben)");
} finally {
  if (ompPid > 0 && existsSync("/proc/" + ompPid)) process.kill(ompPid, "SIGTERM");
  s.cleanup();
}
process.exit(code);
```

Orchestrator steps for this run (once, after the full `bun test server/test` passed and Ben said yes):
- [ ] `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun run server/test/live/live-inbox-once.ts`. Record its output in the run report. It kills only the omp pid it found and removes only its scratch tmux server.
- [ ] Exit 1 or 2 → **stop**: no rerun, no install, put the output under Needs Ben.
- [ ] Exit 0 → if `/home/cymatic/.omp/agent/extensions/live-inbox.ts` does not exist, install it with the command in `omp-extension/README.md`; if it exists and differs from `omp-extension/live-inbox.ts`, do not overwrite it, put it under Needs Ben 4. Either way, the same turn's report to Ben says what was installed (or not) and where.

---

### Task 11: Terminal (pty) channel

**Files (owned):**
- Create: `server/src/features/pty.ts`
- Test: `server/test/pty.test.ts`

**Interfaces:**
- Consumes: Task 1 (`cleanEnv`, `Scratch`, `waitFor`), Task 2 (`socketPath`, `tmuxTarget`, `listClients`, `detachClient`, `readScreen`), Task 8 (`FeatureFactory`, `FeatureDeps`, `Registry`, `client.ts`).
- Produces: `ptyFeature: FeatureFactory`, channel `/v1/sessions/:id/pty?cols=<20..400>&rows=<5..200>` (defaults 80×24; out of range → clamped):
  - tmux session → `Bun.spawn([cfg.bin.tmux, "-S", socketPath(cfg, where.socket), "attach-session", "-t", "=" + where.session], { terminal: { cols, rows, data(_t, bytes) { ws.send(bytes) } }, env: cleanEnv() })` (Verified facts 6: Bun 1.4.2 `terminal` option). Text frame `{ "type": "resize", "cols", "rows" }` → `proc.terminal.resize(cols, rows)`.
  - **Input is checked on every frame (SPEC 4.3).** Each binary input frame goes into one ordered queue per socket; for each frame, `await deps.registry.get(id, cfg.scanIntervalMs)` and write it with `proc.terminal.write(bytes)` only when the session's `liveVoice === false`. When `liveVoice` is `true` or `null`, the frame is dropped and the socket turns read-only for good (sticky until it closes): one `{ "type": "readonly", "reason" }` message, reason `"live voice is on; typing here would mix with it"` (true) or `"cannot tell if live voice is on, so typing is off"` (null). The feature also subscribes with `registry.onChange` while any pty socket is open, so the `readonly` message arrives as soon as a scan sees live voice, even before the next keystroke. The same check runs at open: not writable → `readonly` is the first message (output still streams).
  - herdr session → first message `{ "type": "readonly", "reason": "herdr terminals are read-only in P1" }`, then `{ "type": "screen", "text" }` every second from `readScreen(cfg, pane, 200)` (Needs Ben 1). No session → `{ "type": "error", "error": "no such session" }` and close 1000.
  - On close: find our client with `listClients(cfg, where.socket)` where `pid === proc.pid`, `detachClient(cfg, where.socket, tty)` for that tty only, then kill our own child pid (`proc.kill()`) after 2 s if still alive. Never detach any other client.

**Tests (`server/test/pty.test.ts`):**

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ptyFeature } from "../src/features/pty";
import { cleanEnv } from "../src/exec";
import { sessionId } from "../src/sessions/ids";
import { listClients, socketPath } from "../src/sessions/tmux";
import { openWs, pane, startTestHostd, type TestHostd } from "./helpers/client";
import { Scratch, waitFor } from "./helpers/scratch";

let s: Scratch;
let h: TestHostd;
beforeEach(async () => {
  s = new Scratch();
  h = await startTestHostd(s, [ptyFeature]);
});
afterEach(async () => {
  await h.stop();
  s.cleanup();
});

const enc = new TextEncoder();
const capture = (sock: string, session: string) => s.tmux(sock, "capture-pane", "-p", "-t", "=" + session + ":0.0");

test("attach, type, see the echo", async () => {
  const p = await pane(s, "work", "/bin/sh");
  const ws = await openWs(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/pty?cols=100&rows=30");
  ws.send(enc.encode("echo pty-$((40+2))\r"));
  await waitFor(() => ws.output().includes("pty-42"), 5000);
  ws.close();
  expect(await ws.closed).toBe(1000);
});

test("resize changes our own client's width", async () => {
  const p = await pane(s, "work", "/bin/sh");
  const ws = await openWs(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/pty?cols=80&rows=24");
  await waitFor(async () => (await listClients(h.config, p.socket)).length === 1);
  const ours = (await listClients(h.config, p.socket))[0];
  ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
  await waitFor(() => s.tmux(p.socket, "display", "-p", "-c", ours.tty, "#{client_width}").trim() === "100");
  ws.close();
});

test("close detaches only our client", async () => {
  const p = await pane(s, "work", "/bin/sh");
  const other = Bun.spawn([h.config.bin.tmux, "-S", socketPath(h.config, p.socket), "attach-session", "-t", "=work"], {
    terminal: { cols: 80, rows: 24, data() {} },
    env: cleanEnv(),
  });
  try {
    await waitFor(async () => (await listClients(h.config, p.socket)).some((c) => c.pid === other.pid));
    const ws = await openWs(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/pty");
    await waitFor(async () => (await listClients(h.config, p.socket)).length === 2);
    ws.close();
    await waitFor(async () => {
      const left = await listClients(h.config, p.socket);
      return left.length === 1 && left[0].pid === other.pid;
    }, 3000);
  } finally {
    other.kill();
  }
});

test("live voice at open makes it read-only and typed bytes never reach the pane", async () => {
  const p = await pane(s, "work", "cat");
  s.setLiveVoicePids([p.pid]);
  const ws = await openWs(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/pty");
  expect((await ws.next("readonly", 3000)).reason).toBe("live voice is on; typing here would mix with it");
  ws.send(enc.encode("never-typed\r"));
  await Bun.sleep(500);
  expect(capture(p.socket, "work")).not.toContain("never-typed");
  ws.close();
});

test("live voice turning on mid-session drops input from then on", async () => {
  const p = await pane(s, "work", "cat");
  const ws = await openWs(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/pty");
  ws.send(enc.encode("before-voice\r"));
  await waitFor(() => capture(p.socket, "work").includes("before-voice"));
  expect(ws.seen.some((m) => m.type === "readonly")).toBe(false);
  s.setLiveVoicePids([p.pid]);
  await Bun.sleep(h.config.scanIntervalMs + 100);
  ws.send(enc.encode("after-voice\r"));
  expect((await ws.next("readonly", 3000)).reason).toBe("live voice is on; typing here would mix with it");
  await Bun.sleep(500);
  expect(capture(p.socket, "work")).not.toContain("after-voice");
  s.setLiveVoicePids([]);
  await Bun.sleep(h.config.scanIntervalMs + 100);
  ws.send(enc.encode("still-dropped\r"));
  await Bun.sleep(500);
  expect(capture(p.socket, "work")).not.toContain("still-dropped");
  ws.close();
});

test("unknown live voice (pactl failing) is read-only too", async () => {
  const p = await pane(s, "work", "cat");
  s.breakPactl(true);
  const ws = await openWs(h, "/v1/sessions/" + encodeURIComponent(p.id) + "/pty");
  expect((await ws.next("readonly", 3000)).reason).toBe("cannot tell if live voice is on, so typing is off");
  ws.close();
});

test("herdr is read-only and streams the screen", async () => {
  s.setHerdrAgents([{ terminal_id: "t1", agent_status: "idle", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", focused: false, revision: 1, name: "rev" }]);
  s.setHerdrScreen("w1:p1", "hello herdr\n");
  const id = sessionId({ kind: "herdr", workspace: "w1", tab: "w1:t1", pane: "w1:p1" });
  const ws = await openWs(h, "/v1/sessions/" + encodeURIComponent(id) + "/pty");
  expect((await ws.next("readonly", 3000)).reason).toBe("herdr terminals are read-only in P1");
  expect((await ws.next("screen", 3000)).text).toContain("hello herdr");
  ws.close();
});

test("unknown session gets an error and a clean close", async () => {
  const ws = await openWs(h, "/v1/sessions/" + encodeURIComponent("tmux:nope:nope:0.0") + "/pty");
  expect((await ws.next("error", 3000)).error).toBe("no such session");
  expect(await ws.closed).toBe(1000);
});
```

Run: `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/pty.test.ts`
Expected before implementing: FAIL, `Cannot find module '../src/features/pty'`. After: PASS, 8 tests.

Commit: `P1 task 11: terminal channel (attach own tmux client, resize, live voice checked on every frame)`

---

### Task 12: Entry point, service, install, `tailscale serve`, README, auth live check

**Files (owned):**
- Create: `server/src/main.ts`, `deploy/porthole.service`, `deploy/install.sh`, `deploy/serve.ts`, `server/test/live/auth-live.ts`, `README.md` (the repo has no README yet)
- Test: `server/test/main.test.ts`

**Interfaces:**
- Consumes: Task 1 (`defaultConfig`, `loadConfig`, `writeInitialConfig`, `selfFromTailscale`, `run`, `cleanEnv`, json helpers, `Scratch`), Task 5 (`localTokenPath`), Task 8 (`createHostd`, `machineFeature`, `sessionsFeature`, `VERSION`), Task 9 (`chatFeature`), Task 10 (`sendFeature`), Task 11 (`ptyFeature`).
- Produces:
  - `main.ts`: `FEATURES: FeatureFactory[] = [machineFeature, sessionsFeature, chatFeature, sendFeature, ptyFeature]`; `configPath(env: Record<string, string | undefined> = process.env): string` → `env.PORTHOLE_CONFIG` when set, else `<env.HOME>/.config/porthole/hostd.json`. Under `if (import.meta.main)` only (importing `main.ts` starts nothing):
    - `bun run server/src/main.ts init-config [--tailscale <path>]` → `writeInitialConfig(configPath(), <path> ?? defaultConfig().bin.tailscale)`, prints its message, exit 0 (exit 1 with the error text on failure). Tests always pass `--tailscale` with the fake and set `PORTHOLE_CONFIG`, so they never write `~/.config/porthole/hostd.json` and never run the real `/usr/bin/tailscale`.
    - `bun run server/src/main.ts` → `loadConfig(configPath())`, `await createHostd(cfg, FEATURES)` (which runs every `Feature.start`, so `reconcilePending` runs inside hostd, Task 10), prints exactly one line `porthole hostd <VERSION> on 127.0.0.1:<port>`, and on SIGTERM or SIGINT `await h.stop()` then exits 0.
  - `deploy/serve.ts`: `planServe(status: unknown, host: string): { add: string[][]; refuse: string }`, a pure function; run as a script (`import.meta.main`) it reads `tailscale serve status --json`, prints it as `before: <json>`, takes `host` from `selfFromTailscale`, prints and exits 1 when `refuse` is non-empty, otherwise runs each `add` argv with the configured tailscale binary, then prints `after: <json>`. It only ever adds; the words `reset` and `off` appear nowhere in the file (comments included), which `main.test.ts` checks. The status JSON shape (`TCP` port → `{HTTPS}`, `Web` `"<host>:<port>"` → `{Handlers: {"/": {Proxy}}}`, `{}` when nothing is served) is a **GUESS** from tailscale's serve config format; serve.ts prints the raw status first so the orchestrator sees the real shape before anything changes. Rules: for each of 443 → `http://127.0.0.1:8797` (control room; P2 fills it) and 8443 → `http://127.0.0.1:8798` (preview): already proxied to exactly that target → nothing; the port held by anything else → `refuse` naming the port and `add: []` (no change at all); free → `["serve", "--bg", "--https=<port>", "<target>"]`.

`deploy/porthole.service`:

```ini
[Unit]
Description=Porthole hostd (phone access to this machine's agent sessions)
After=network-online.target

[Service]
Type=simple
ExecStart=/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun run %h/.local/share/porthole/hostd/current/server/src/main.ts
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
```

`deploy/install.sh`:

```bash
#!/usr/bin/env bash
# Install the committed HEAD of this repo as the porthole user service. No sudo (SPEC 7).
#   deploy/install.sh            snapshot + unit file + daemon-reload
#   deploy/install.sh --enable   the same, then enable and start the service (only after Ben's yes)
set -euo pipefail
repo="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
sha="$(git -C "$repo" rev-parse --short HEAD)"
root="$HOME/.local/share/porthole/hostd"
mkdir -p "$root/$sha"
git -C "$repo" archive HEAD | tar -x -C "$root/$sha"
ln -sfn "$root/$sha" "$root/current"
mkdir -p "$HOME/.config/systemd/user"
install -m 0644 "$repo/deploy/porthole.service" "$HOME/.config/systemd/user/porthole.service"
systemctl --user daemon-reload
if [ "${1:-}" = "--enable" ]; then
  systemctl --user enable --now porthole.service
fi
echo "installed $sha into $root/current"
```

`README.md` sections (Create): **What hostd is** (one paragraph, SPEC 1 and 5.1); **Running hostd** (`init-config`, `deploy/install.sh`, `deploy/install.sh --enable`, `bun run deploy/serve.ts`, where the config, `sent.jsonl`, `access.log` and the local token live); **Security limit of 127.0.0.1 mode**: "hostd listens on 127.0.0.1, so any program running as cymatic or root on this machine can reach it with the local token file, or by sending Tailscale identity headers directly. Unix-socket mode with peer checks is not possible in Bun 1.4.2: `Bun.serve` exposes no peer uid (Verified facts 5)."; **Identity**: hostd uses the last `X-Forwarded-For` entry and, when `singleForwardedFor` is true, refuses requests with more than one entry (set after `auth-live.ts` shows that `tailscale serve` writes a single entry).

**Tests (`server/test/main.test.ts`, scratch config and fake tailscale only):**

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { planServe } from "../../deploy/serve";
import { localTokenPath } from "../src/auth/localtoken";
import { cleanEnv } from "../src/exec";
import { configPath } from "../src/main";
import { Scratch } from "./helpers/scratch";

const BUN = process.execPath;
const REPO = path.join(import.meta.dir, "..", "..");
const MAIN = path.join(REPO, "server", "src", "main.ts");
const REAL_STATE = path.join(homedir(), ".local", "state", "porthole");

let s: Scratch;
beforeEach(() => { s = new Scratch(); });
afterEach(() => s.cleanup());

/** Names, sizes and times of the real state folder, to prove a test wrote nothing there. */
function snapshot(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().map((n) => {
    const st = statSync(path.join(dir, n));
    return n + ":" + st.size + ":" + st.mtimeMs;
  });
}

async function readUntil(stream: ReadableStream<Uint8Array>, re: RegExp, ms: number): Promise<RegExpExecArray> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  const deadline = Date.now() + ms;
  let out = "";
  while (Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), Bun.sleep(Math.max(1, deadline - Date.now())).then(() => null)]);
    if (chunk === null || chunk.done) break;
    out += dec.decode(chunk.value);
    const m = re.exec(out);
    if (m) {
      reader.releaseLock();
      return m;
    }
  }
  throw new Error("no match for " + re.source + " in: " + out);
}

test("configPath honours PORTHOLE_CONFIG, else uses HOME", () => {
  expect(configPath({ PORTHOLE_CONFIG: "/x/hostd.json", HOME: "/home/x" })).toBe("/x/hostd.json");
  expect(configPath({ HOME: "/home/x" })).toBe("/home/x/.config/porthole/hostd.json");
});

test("init-config writes the PORTHOLE_CONFIG file from the given tailscale, 0600, and never overwrites", () => {
  const file = path.join(s.root, "cfg", "hostd.json");
  const argv = [BUN, MAIN, "init-config", "--tailscale", path.join(s.fakeBin, "tailscale")];
  const env = cleanEnv({ PORTHOLE_CONFIG: file, HOME: s.root });
  const first = Bun.spawnSync(argv, { env, stdout: "pipe", stderr: "pipe" });
  expect(first.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ machineName: "testhost", origin: "https://testhost.example.ts.net", peers: [] });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const second = Bun.spawnSync(argv, { env, stdout: "pipe", stderr: "pipe" });
  expect(second.exitCode).toBe(0);
  expect(second.stdout.toString()).toContain("kept existing");
  expect(s.fakeCalls("tailscale")).toEqual([["status", "--json"]]);
  expect(existsSync(path.join(s.root, ".config", "porthole", "hostd.json"))).toBe(false);
});

test("a started main.ts uses only its scratch config, lists only scratch sessions, and exits 0 on SIGTERM", async () => {
  const before = snapshot(REAL_STATE);
  const sock = s.newTmuxServer("only-scratch");
  const file = path.join(s.root, "hostd.json");
  writeFileSync(file, JSON.stringify(s.config()), { mode: 0o600 });
  const proc = Bun.spawn([BUN, MAIN], { env: cleanEnv({ PORTHOLE_CONFIG: file, HOME: s.root, XDG_RUNTIME_DIR: s.runtimeDir }), stdout: "pipe", stderr: "pipe" });
  try {
    const m = await readUntil(proc.stdout, /porthole hostd 0\.1\.0 on 127\.0\.0\.1:(\d+)/, 10_000);
    const base = "http://127.0.0.1:" + m[1];
    const headers = { "X-Porthole": "1", "X-Porthole-Local": readFileSync(localTokenPath(s.runtimeDir), "utf8").trim() };
    const machine = await fetch(base + "/v1/machine", { headers });
    expect(machine.status).toBe(200);
    expect(((await machine.json()) as { name: string }).name).toBe("testhost");
    const tree = (await (await fetch(base + "/v1/sessions", { headers })).json()) as { sessions: { id: string }[] };
    expect(tree.sessions.map((x) => x.id)).toEqual(["tmux:" + sock + ":only-scratch:0.0"]);
    expect(existsSync(path.join(s.stateDir, "access.log"))).toBe(true);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
  } finally {
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }
  expect(snapshot(REAL_STATE)).toEqual(before);
}, 20_000);

test("unit file, install script and serve script follow SPEC 7", () => {
  const unit = readFileSync(path.join(REPO, "deploy", "porthole.service"), "utf8");
  for (const line of ["UMask=0077", "Restart=on-failure", "RestartSec=5", "WantedBy=default.target", "ExecStart=/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun run %h/.local/share/porthole/hostd/current/server/src/main.ts"]) {
    expect(unit).toContain(line);
  }
  const install = readFileSync(path.join(REPO, "deploy", "install.sh"), "utf8");
  const serve = readFileSync(path.join(REPO, "deploy", "serve.ts"), "utf8");
  for (const src of [install, serve]) {
    expect(src).not.toMatch(/\bsudo\b/);
    expect(src).not.toMatch(/tailscaled/);
  }
  expect(install).toContain("systemctl --user enable --now porthole.service");
  // serve.ts only adds entries (SPEC 7): it never calls `tailscale serve reset` or `... off`.
  expect(serve).not.toMatch(/\breset\b/);
  expect(serve).not.toMatch(/\boff\b/);
});

test("planServe adds only Porthole's two entries and refuses a port something else holds", () => {
  const host = "testhost.example.ts.net";
  const api = "http://127.0.0.1:8797";
  const preview = "http://127.0.0.1:8798";
  const web = (port: string, proxy: string) => ({ [host + ":" + port]: { Handlers: { "/": { Proxy: proxy } } } });
  expect(planServe({}, host)).toEqual({ refuse: "", add: [["serve", "--bg", "--https=443", api], ["serve", "--bg", "--https=8443", preview]] });
  const ours = { TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } }, Web: { ...web("443", api), ...web("8443", preview) } };
  expect(planServe(ours, host)).toEqual({ refuse: "", add: [] });
  const clash = { TCP: { "443": { HTTPS: true } }, Web: web("443", "http://127.0.0.1:3000") };
  const r = planServe(clash, host);
  expect(r.add).toEqual([]);
  expect(r.refuse).toContain("443");
  const unrelated = { TCP: { "10000": { HTTPS: true } }, Web: web("10000", "http://127.0.0.1:3000") };
  expect(planServe(unrelated, host).add.map((a) => a[2])).toEqual(["--https=443", "--https=8443"]);
});
```

Run: `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/main.test.ts`
Expected before implementing: FAIL, `Cannot find module '../../deploy/serve'`. After: PASS, 5 tests.

**`server/test/live/auth-live.ts`** (SPEC P1.5; run only by the orchestrator, in live step L3 below; calls only `/v1/machine` and the auth checks, so it never lists or touches a session):

```ts
// P1.5 live auth check against the INSTALLED hostd (port 8797) and its `tailscale serve` entry.
// Exit 0 = every check passed. Exit 1 = a check failed: STOP, change nothing, report to Ben.
// Exit 2 = could not run (no config, no token, tailscale or serve unreachable): also stop and report.
// `--ping` only asks GET /v1/machine with the local token (P1.6 evidence after a restart).
import { existsSync, readFileSync } from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { localTokenPath } from "../../src/auth/localtoken";
import { loadConfig } from "../../src/config";
import { run } from "../../src/exec";
import { asArray, asRecord, asString } from "../../src/json";
import { configPath } from "../../src/main";

const API = "http://127.0.0.1:8797";

function cannotRun(why: string): never {
  console.log("CANNOT RUN: " + why);
  process.exit(2);
}

const cfg = (() => {
  try { return loadConfig(configPath()); } catch (e) { return cannotRun(e instanceof Error ? e.message : String(e)); }
})();
const tokenFile = localTokenPath(cfg.runtimeDir);
if (!existsSync(tokenFile)) cannotRun("no local token at " + tokenFile + " (is porthole.service running?)");
const token = readFileSync(tokenFile, "utf8").trim();
const local = { "X-Porthole": "1", "X-Porthole-Local": token };

async function machine(base: string, headers: Record<string, string>, method = "GET"): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(base + "/v1/machine", { method, headers, signal: AbortSignal.timeout(10_000) });
  let body: Record<string, unknown> = {};
  try { body = asRecord(await r.json()); } catch { body = {}; }
  return { status: r.status, body };
}

/** Status code of a WebSocket upgrade to /v1/events (0 = no answer). Reads only the status line. */
function upgradeStatus(base: string, headers: Record<string, string>): Promise<number> {
  const u = new URL(base);
  const secure = u.protocol === "https:";
  const lines = ["GET /v1/events HTTP/1.1", "Host: " + u.host, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", ...Object.entries(headers).map(([k, v]) => k + ": " + v)];
  return new Promise((resolve) => {
    const port = Number(u.port || (secure ? 443 : 80));
    const sock: Socket = secure ? tlsConnect({ host: u.hostname, port, servername: u.hostname }) : netConnect(port, u.hostname);
    let buf = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (code: number) => { if (timer) clearTimeout(timer); sock.destroy(); resolve(code); };
    timer = setTimeout(() => done(0), 10_000);
    sock.once(secure ? "secureConnect" : "connect", () => sock.write(lines.join("\r\n") + "\r\n\r\n"));
    sock.on("data", (d: Buffer) => {
      buf += d.toString("latin1");
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (m) done(Number(m[1]));
    });
    sock.on("error", () => done(0));
  });
}

if (process.argv.includes("--ping")) {
  const r = await machine(API, local).catch(() => cannotRun("hostd does not answer on " + API));
  console.log("ping /v1/machine: " + r.status);
  process.exit(r.status === 200 ? 0 : 1);
}

// Addresses from `tailscale status --json`: Self.DNSName is used by Task 1; Self/Peer TailscaleIPs and
// Peer DNSName are GUESS field names until this first run (a missing field stops with exit 2).
const st = await run([cfg.bin.tailscale, "status", "--json"]);
if (st.code !== 0) cannotRun("tailscale status failed: " + st.stderr.trim());
const status = asRecord(JSON.parse(st.stdout));
const selfIp = asString(asArray(asRecord(status.Self).TailscaleIPs)[0]);
if (!selfIp) cannotRun("tailscale status shows no address for this machine");
const peers = Object.values(asRecord(status.Peer)).map((p) => ({ name: asString(asRecord(p).DNSName).split(".")[0], ip: asString(asArray(asRecord(p).TailscaleIPs)[0]) }));
const allowedPeer = peers.find((p) => p.ip && p.name !== cfg.machineName && cfg.allowedNodes.includes(p.name));
const foreignPeer = peers.find((p) => p.ip && !cfg.allowedNodes.includes(p.name));
const spoofIp = allowedPeer?.ip ?? "100.64.0.1";
const wrongNodeIp = foreignPeer?.ip ?? "100.64.0.254";

let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log((ok ? "PASS " : "FAIL ") + name + ": " + detail);
  if (!ok) failed += 1;
}

// Through `tailscale serve` (cfg.origin is https://<this machine>.<tailnet>.ts.net on port 443).
const r1 = await machine(cfg.origin, { "X-Porthole": "1" }).catch((e) => cannotRun("cannot reach " + cfg.origin + ": " + String(e)));
const you1 = asRecord(r1.body.you);
check("serve: this allowed device gets 200", r1.status === 200 && asString(you1.device) === cfg.machineName && asString(you1.via) === "tailscale", r1.status + " " + JSON.stringify(you1));
const r2 = await machine(cfg.origin, { "X-Porthole": "1", "X-Forwarded-For": spoofIp });
const you2 = asRecord(r2.body.you);
const xff = asArray(you2.forwardedFor).map(asString);
check("serve: a spoofed X-Forwarded-For " + spoofIp + " is not believed", r2.status === 200 && asString(you2.device) === cfg.machineName, r2.status + " " + JSON.stringify(you2));
const verdict = r2.status !== 200 ? "unknown (spoofed request refused)"
  : xff.length === 1 && xff[0] !== spoofIp ? "serve sets one entry"
  : xff.length > 1 && xff[0] === spoofIp && xff[xff.length - 1] !== spoofIp ? "serve appends"
  : "serve passes the client value through";
console.log("xff: " + verdict + " " + JSON.stringify(xff));
check("serve: X-Forwarded-For comes from serve, not the client", verdict === "serve sets one entry" || verdict === "serve appends", verdict);
check("serve: a request without X-Porthole gets 403", (await machine(cfg.origin, {})).status === 403, "");
check("serve: a POST with a foreign Origin gets 403", (await machine(cfg.origin, { "X-Porthole": "1", Origin: "https://evil.example" }, "POST")).status === 403, "");
check("serve: a WebSocket from the preview origin gets 403", (await upgradeStatus(cfg.origin, { Origin: cfg.origin + ":8443" })) === 403, "");
check("serve: a WebSocket from a foreign origin gets 403", (await upgradeStatus(cfg.origin, { Origin: "https://evil.example" })) === 403, "");

// Direct to 127.0.0.1:8797 with injected identity headers (127.0.0.1 mode, SPEC P1.5).
check("direct: injected wrong login gets 403", (await machine(API, { "X-Porthole": "1", "Tailscale-User-Login": "someone@example.com", "X-Forwarded-For": selfIp })).status === 403, "");
check("direct: injected node " + (foreignPeer?.name ?? "(unknown address)") + " gets 403", (await machine(API, { "X-Porthole": "1", "Tailscale-User-Login": cfg.allowedLogin, "X-Forwarded-For": wrongNodeIp })).status === 403, wrongNodeIp);
const r9 = await machine(API, local);
check("direct: the local token works", r9.status === 200 && asString(asRecord(r9.body.you).device) === "local", String(r9.status));
check("direct: a WebSocket with a foreign Origin gets 403", (await upgradeStatus(API, { Origin: "https://evil.example", "X-Porthole-Local": token })) === 403, "");
check("direct: a WebSocket with the preview origin gets 403", (await upgradeStatus(API, { Origin: cfg.origin + ":8443", "X-Porthole-Local": token })) === 403, "");
if (cfg.singleForwardedFor) {
  const two = await machine(API, { "X-Porthole": "1", "Tailscale-User-Login": cfg.allowedLogin, "X-Forwarded-For": "100.64.0.254, " + selfIp });
  check("direct: two X-Forwarded-For entries get 403 (singleForwardedFor)", two.status === 403, String(two.status));
}

console.log(failed === 0 ? "ALL PASS" : failed + " FAILED: stop, change nothing, report to Ben (Needs Ben 5)");
process.exit(failed === 0 ? 0 : 1);
```

Commit: `P1 task 12: main entry, user service, install, tailscale serve setup, README, auth live check`

**Live steps (orchestrator only, after every task is merged and the full `bun test server/test` passed; each step once, in this order; any failure stops the run and goes to Needs Ben, never fix-and-continue):**

- [ ] **L1. Config and snapshot.** `bun run server/src/main.ts init-config` (reads this machine's real name from `tailscale status --json`, read-only; keeps an existing file), then `bash deploy/install.sh` (no `--enable`). Record both outputs.
- [ ] **L2. Enable and serve (Ben's yes first, SPEC 7).** `bash deploy/install.sh --enable`, then `bun run deploy/serve.ts`. Record the `before:` and `after:` status lines. serve.ts exit 1 (a port is held by something else) → stop, Needs Ben.
- [ ] **L3. Live auth check (P1.5).** `bun run server/test/live/auth-live.ts`. Exit 1 or 2 → **stop**: do not deploy anything else, do not change the config, put the full output in the run report under Needs Ben (item 5 when the `xff:` line says the client value is passed through). Exit 0 with `xff: serve sets one entry` → set `"singleForwardedFor": true` in `~/.config/porthole/hostd.json`, `systemctl --user restart porthole.service`, and run `auth-live.ts` one more time (its two-entry check now runs); that second run must also exit 0. Exit 0 with `xff: serve appends` → keep `singleForwardedFor` false (the last-entry rule already protects) and say so in the report.
- [ ] **L4. P1.6 evidence.** Record the output of each, in the run report:
  1. `systemctl --user is-enabled porthole.service` → `enabled`.
  2. `systemctl --user restart porthole.service`, wait up to 10 s, then `systemctl --user is-active porthole.service` → `active` and `bun run server/test/live/auth-live.ts --ping` → `ping /v1/machine: 200` (exit 0).
  3. `tailscale serve status --json` → Porthole's 443 and 8443 entries **plus** every entry that was in serve.ts's `before:` line (nothing removed or changed).
  4. `main.test.ts` test "unit file, install script and serve script follow SPEC 7" passed in the full run (serve.ts contains no `reset` or `off`).

---

## Self-review

- **SPEC coverage (P1):** P1.1 sessions from two scratch sockets + fake herdr with statuses and live voice (T8 registry test 8); P1.2 chat backlog then append (T9); screen (T9); P1.3 send exactly once over inbox/tmux/herdr, same id twice, retry after refused/failed, crash recovery, forced failure (T6, T10, the one live-inbox run); key row (T10); P1.4 terminal attach, input, own-client detach, live-voice read-only (T11); P1.5 auth, Origin, X-Porthole, injected identity, local token, access log (T5, T8, T12 L3); P1.6 service, restart, serve entries (T12 L4); live-inbox move and install (T7, T10). Phone app, control room UI, notifications: P2+, not here.
- **Names checked across tasks:** `HostdConfig` fields (incl. `singleForwardedFor`), `Scratch` methods, `sessionId`/`tmuxTarget`/`socketPath`, `SendRecord`, `CLIENT_MSG_ID`, `MAX_MESSAGE_BYTES`, `Registry`, `EventsHub`, `Feature`/`FeatureDeps`/`FeatureFactory`, `Hostd`, `Deliverer`, `configPath` are spelled the same everywhere they appear.
- **Honest gap:** Tasks 8-12 give contracts and complete test files, not finished implementation code (see the note above Task 8).

## Needs Ben (carried into the P1 run report)

1. **herdr terminal is read-only in P1.** Whether `herdr` can attach a second viewer (or `--takeover` safely) was not verified without touching real panes. Options: keep read-only (recommended), or let a builder test it against a scratch herdr later.
2. **herdr key names and the `--` separator** for `herdr prompt`/`keys` are partly **GUESS** (`esc` and `ctrl+c` verified from herdr's own help text). Task 10's fake accepts what the plan sends; the first real herdr send in P1.5 confirms or corrects.
3. **127.0.0.1 mode only.** Bun 1.4.2 gives no peer-credential check on a Unix socket, so hostd uses 127.0.0.1 + a local token file; any program running as cymatic or root can reach it. Options: accept and document (recommended), or wait for a later runtime.
4. **Installing `live-inbox.ts`** makes every new omp session (Thalamus included, next start) watch an inbox folder. Options: install after the one passing run (recommended; the orchestrator reports the install in that same turn's report), or keep it opt-in per session with `-e`.
5. **If `auth-live.ts` shows that `tailscale serve` passes a client's `X-Forwarded-For` through** (Task 12 L3), any device signed in as Ben could claim another device's address. Options: hold P1.5 until a safer identity source exists (recommended), or accept login-only identity (no device allowlist).
6. **Multi-line text over the tmux route.** SPEC 4.5's `send-keys -l` types each line break as a Ctrl-J key. Whether omp's input box treats that as a new line or as "send" is not verified ([INFERENCE]: most editors insert a line); P1.3(b) proves it with a plain `cat`. Options: keep SPEC's method (recommended, built), or switch to a bracketed paste for omp panes later.

## Execution handoff

Run Tasks 1-12 in the parallel groups above: one builder per task in its own worktree (`omp-worktree new p1-task-<n>`), each told "at most 2 failed attempts per step; if a step fails twice, stop and report", and Section 7 of the SPEC. Merge each green task into `feat/p1-hostd` after `git merge-tree --write-tree` shows no conflicts. The orchestrator runs the full `bun test server/test` once after all merges, then `live-inbox-once.ts` exactly once (with Ben's yes; pass or fail, never rerun; install and report as Task 10 says), then Task 12's live steps L1-L4.
