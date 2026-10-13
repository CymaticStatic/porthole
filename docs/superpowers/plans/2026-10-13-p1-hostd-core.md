# Porthole P1: hostd core (desktop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `porthole-hostd` phase P1 on the desktop: session discovery with status, chat stream, screen, send (live inbox / tmux / herdr, exactly once), keys, PTY, auth, access log, systemd unit, `tailscale serve`, and `live-inbox.ts` moved into this repo and installed, exactly as `docs/SPEC.md` section 8 P1 items 1-6 define.

**Architecture:** One Bun process (`server/src/main.ts`) bound to 127.0.0.1:8797. Each spec module (5.1) is its own folder or file and exports a `Feature` (a list of routes); `server/src/http/app.ts` runs auth and the access log in front of every route, and `main.ts` composes the features. P2 modules (`events` socket, `push`, `uploads`, `diff`, `preview`, `usage`, `voice`, `shortcuts`, `doctor`) are added later as new files plus one line each in `main.ts`; no P1 file moves. Every test runs an in-process hostd whose config points at a scratch tmux socket folder, fake `herdr` / `pactl` / `tailscale` programs and fixture transcripts.

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
4. **Identity headers.** A string search of the `tailscaled` binary (earlier in this session) found `Tailscale-User-Login`, `Tailscale-User-Name`, `Tailscale-User-Profile-Pic`, `Tailscale-App-Capabilities`, `Tailscale-Headers-Info` and `X-Forwarded-For`, and **no node-name header**. So hostd takes the device address from `X-Forwarded-For` and asks `tailscale whois --json <ip>` for the node. **Could not verify** (needs Porthole's own serve entry, which only Task 12 adds): that `tailscale serve` really sets these headers on requests from this machine itself, and whether a client-supplied `X-Forwarded-For` is kept in front of the real address. hostd uses the **last** `X-Forwarded-For` entry, and Task 12 Step 6 checks both points through the real serve entry.
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
server/src/sessions/routes.ts       GET /v1/sessions, WS /v1/events (Task 8)
server/src/transcript/parse.ts      transcript line → chat items (Task 4)
server/src/transcript/tail.ts       byte-offset pages and a follower (Task 4)
server/src/transcript/routes.ts     GET + WS /v1/sessions/:id/chat (Task 9)
server/src/auth/auth.ts             X-Porthole, exact Origin, CORS, identity, local token (Task 5)
server/src/auth/identity.ts         tailscale whois node lookup with cache (Task 5)
server/src/auth/localtoken.ts       $XDG_RUNTIME_DIR/porthole/local-token (Task 5)
server/src/auth/accesslog.ts        ~/.local/state/porthole/access.log (Task 5)
server/src/deliver/sentlog.ts       sent.jsonl record per clientMsgId (Task 6)
server/src/deliver/inbox.ts         write-then-rename into a live inbox, wait until taken (Task 6)
server/src/deliver/deliver.ts       Deliverer: inbox / tmux / herdr, exactly once (Task 10)
server/src/deliver/routes.ts        POST send, GET sends, POST keys (Task 10)
server/src/keys.ts                  key-step grammar (4.4) and key sending with live-voice refusal (Task 10)
server/src/screen.ts                GET /v1/sessions/:id/screen (Task 9)
server/src/pty.ts                   WS /v1/sessions/:id/pty (Task 11)
server/src/events/hub.ts            /v1/events client set and broadcast (Task 8)
server/src/machine.ts               GET /v1/machine (Task 8)
server/src/http/router.ts           Route/Feature/Channel types, matcher, json() (Task 8)
server/src/http/app.ts              Bun.serve: auth → route → access log; WebSocket dispatch (Task 8)
server/src/main.ts                  config, compose features, start, signals; `init-config` (Task 12)
server/test/helpers/scratch.ts      Scratch: scratch tmux servers, fakes, fixtures, cleanup (Task 1)
server/test/helpers/client.ts       in-process test hostd, local headers, raw upgrade (Task 8)
server/test/fakes/herdr.ts          fake herdr 0.9.1 (Task 1)
server/test/fakes/pactl.ts          fake pactl (Task 1)
server/test/fakes/tailscale.ts      fake tailscale whois/status (Task 1)
server/test/fixtures/status-needs-you.jsonl, status-working.jsonl, status-done.jsonl (Task 3)
server/test/fixtures/chat-basic.jsonl (Task 4)
server/test/*.test.ts               one file per task (named in each task)
server/test/live/live-inbox-once.ts the single throwaway omp run (Task 10)
server/test/live/auth-live.ts       P1.5 checks against the installed hostd (Task 12)
```

Where P2 slots in without moving P1 files: `server/src/events/socket.ts` + `events/inbox.ts` (extension socket, inbox state; `hub.ts` gains `notify`/`ack`), `server/src/push.ts`, `uploads.ts`, `diff.ts` (adds `dirty` to `SessionInfo` in `registry.ts`), `preview.ts` (second listener on 8798), `usage.ts`, `voice.ts`, `shortcuts.ts` (uses `parseSteps` from `keys.ts`), `doctor.ts`, `omp-extension/porthole-events.ts`; each new feature is one more entry in `main.ts`.

## Parallel groups and file ownership

| Group | Tasks (run in parallel inside a group) | Needs |
|---|---|---|
| G0 | Task 1 | nothing |
| G1 | Tasks 2, 3, 4, 5, 6, 7 | Task 1 |
| G2 | Task 8 | Tasks 2, 3, 5 |
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
  - `config.ts`: `interface Binaries { tmux; herdr; pactl; tailscale: string }`; `interface HostdConfig { machineName: string; origin: string; peers: string[]; host: "127.0.0.1"; apiPort: number; tmuxSocketDir: string; bin: Binaries; transcriptDirs: string[]; inboxRoot: string; runtimeDir: string; stateDir: string; allowedLogin: string; allowedNodes: string[]; thalamusDir: string; pendingAfterMs: number; scanIntervalMs: number }`; `type ConfigOverrides = Omit<Partial<HostdConfig>, "bin"> & { bin?: Partial<Binaries> }`; `defaultConfig(): HostdConfig`; `validateConfig(c: HostdConfig): string[]`; `loadConfig(file: string | null, overrides?: ConfigOverrides): HostdConfig` (throws on problems); `selfFromTailscale(bin: string): Promise<{ machineName: string; origin: string }>`; `writeInitialConfig(file: string, tailscaleBin: string): Promise<string>`.
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

test("sendText pastes multi-line text once and presses Enter; capture shows the pane", async () => {
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

/** Paste the text as one bracketed paste (newlines stay inside the message), then press Enter. */
export async function sendText(cfg: HostdConfig, w: TmuxWhere, text: string): Promise<{ ok: boolean; error: string }> {
  const buffer = "porthole-" + crypto.randomUUID();
  const load = await tmux(cfg, w.socket, ["load-buffer", "-b", buffer, "-"], text);
  if (load.code !== 0) return { ok: false, error: failure(load) };
  const paste = await tmux(cfg, w.socket, ["paste-buffer", "-p", "-d", "-b", buffer, "-t", tmuxTarget(w)]);
  if (paste.code !== 0) return { ok: false, error: failure(paste) };
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
Expected: PASS, 5 tests.

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

Rules (SPEC 5.4, in this order): (1) an `Origin` that is present but not exactly `cfg.origin` or one of `cfg.peers` → 403; (2) every non-GET/HEAD request and every WebSocket upgrade needs such an exact `Origin`; (3) every `/v1` HTTP request except `OPTIONS` and upgrades needs `X-Porthole: 1`; (4) `X-Porthole-Local` equal to the token (constant-time compare) → device `local`; (5) otherwise `Tailscale-User-Login` must equal `allowedLogin`, and the **last** `X-Forwarded-For` address must resolve through `tailscale whois --json` to a node in `allowedNodes` owned by `allowedLogin`. 127.0.0.1 mode only (Verified facts 5): no Unix-socket branch is built, so there is nothing to unit-test for it; the README states the limit (Task 12).

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
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",").map((p) => p.trim()).filter(Boolean).pop() ?? "";
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
Expected: PASS, 5 tests.

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

> **Tasks 8-12 are written at contract level.** Interfaces, file ownership, every test case
> and its exact assertion, the commands and the commit are fixed below; the implementation
> code is the builder's, written to make those tests pass using only the Task 1-7 APIs named
> under **Consumes**. Same TDD loop as Tasks 1-7: write the test file, run it and see it fail
> with `Cannot find module`, implement, run it and see it pass, commit with the message given.

### Task 8: Router, hostd assembly, session registry, `/v1/machine`, `/v1/sessions`, events hub

**Files (owned):**
- Create: `server/src/router.ts`, `server/src/hostd.ts`, `server/src/version.ts`, `server/src/sessions/registry.ts`, `server/src/features/machine.ts`, `server/src/features/sessions.ts`, `server/test/helpers/client.ts`
- Test: `server/test/registry.test.ts`, `server/test/hostd.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5 (`HostdConfig`, `run`, `Scratch`, `ids`, `tmux`, `herdr`, `procs`, `livevoice`, `status`, `Auth`, `Whois`, `ensureLocalToken`, `AccessLog`).
- Produces:
  - `router.ts`: `interface Ctx { device: string; via: "tailscale" | "local"; route: string; session: string }` (handlers set `ctx.session` for the access log); `interface Route { method: string; pattern: string; handler(req: Request, params: Record<string, string>, ctx: Ctx): Response | Promise<Response> }`; `interface Channel { pattern: string; open(ws: ServerWebSocket<WsData>): void; message(ws, data: string | Buffer): void; close(ws): void }`; `interface WsData { channel: Channel; params: Record<string, string>; query: URLSearchParams; ctx: Ctx; state: Record<string, unknown> }`; `interface Feature { routes: Route[]; channels: Channel[]; stop?(): void }`; `interface FeatureDeps { config: HostdConfig; registry: Registry; localToken: string }`; `type FeatureFactory = (d: FeatureDeps) => Feature`; `match(pattern, pathname): Record<string,string> | null` (`:id` segments, URL-decoded); `json(body, status = 200): Response`.
  - `hostd.ts`: `createHostd(config: HostdConfig, factories: FeatureFactory[]): { port: number; url: string; localToken: string; registry: Registry; stop(): void }`. One `Bun.serve` on `config.host:config.apiPort` (port 0 allowed for tests). Order per request: `Auth.check` → 403 `{error}` (no CORS headers) and access-log line; `OPTIONS` → 204 with `corsHeaders`; route match → handler, CORS headers added; WebSocket upgrade only on a channel pattern; unknown → 404. Every request writes one `AccessLog` line (`route` = pattern, never the text or query).
  - `version.ts`: `VERSION = "0.1.0"`.
  - `registry.ts`: `interface SessionInfo { id; kind: "tmux" | "herdr"; name; cwd; status: SessionStatus; reported: boolean; questionCount: number; liveVoice: boolean | null; pinned: boolean; where: Where; attached: boolean; omp: { pid: number; transcript: string | null; inbox: boolean } | null; herdrStatus: string | null }`; `interface Tree { machine: string; scannedAt: string; sessions: SessionInfo[]; sources: { tmux: { socket: string; ok: boolean; error: string }[]; herdr: { ok: boolean; error: string }; liveVoice: { ok: boolean; error: string } } }`; `class Registry { constructor(cfg); scan(): Promise<Tree>; current(maxAgeMs = 2000): Promise<Tree>; get(id, maxAgeMs = 2000): Promise<SessionInfo | null>; onChange(fn: (t: Tree) => void): () => void; startWatching(): void; stopWatching(): void }`. Watching is refcounted: `startWatching` scans every `scanIntervalMs` while the count is above 0; an idle hostd never scans (SPEC 6 battery/CPU). `onChange` fires only when the JSON of `sessions` changed.
  - Rules inside `scan()` (SPEC 4.2-4.4): tmux panes from every socket in `listSockets`; herdr agents from `listAgents`; omp found with `findOmp(procTable, panePid)`, transcript via `transcriptOf`, inbox via `hasInbox`; status from the transcript when it has an entry, else from `HERDR_STATUS[agent.status]` for herdr, else `unknown`; `name` = pane title with braille spinner chars `[\u2800-\u28ff]` and surrounding spaces removed, unless it equals the hostname or is empty, then `basename(cwd)`; `pinned` = cwd is `config.thalamusDir` or below; sort pinned first, then needs-you, then name. `liveVoice`: `true` if the omp pid is in `liveVoicePids`, `false` if not, `null` when pactl failed; for herdr sessions `null` whenever any live-voice pid could not be placed in a tmux pane (Verified facts 9: herdr pane pids are not exposed).
  - `features/machine.ts`: `machineFeature: FeatureFactory`, `GET /v1/machine` → `{ name, version, authMode: "127.0.0.1", you: { device, via }, features: { tmux: boolean, herdr: boolean, pactl: boolean, tailscale: boolean } }` (presence of each `config.bin` file). Never lists sessions.
  - `features/sessions.ts`: `sessionsFeature: FeatureFactory`, `GET /v1/sessions` → the `Tree`; channel `/v1/events` sends `{ type: "sessions", tree }` on open and on every change, calls `startWatching` on open and `stopWatching` on close.
  - `test/helpers/client.ts`: `startTestHostd(s: Scratch, factories: FeatureFactory[], overrides?: Partial<HostdConfig>)` → hostd on port 0; `localHeaders(h)` → `{ "X-Porthole": "1", "X-Porthole-Local": token }`; `get(h, path)`, `post(h, path, body)` (adds `Origin: config.origin`); `openWs(h, path)` → `new WebSocket(url, { headers: { Origin, "X-Porthole-Local" } })` plus a message queue `next(type, timeoutMs)`; `rawUpgrade(port, path, headers)` → HTTP status code read with `node:net` (for refused upgrades).

**Tests (`registry.test.ts`, scratch tmux server + fake herdr + fake pactl):**
1. `finds a scratch tmux omp session with its transcript and status`: `newTmuxServer("work", s.ompCommand("chat-basic.jsonl"))`; `scan()` → one tmux session, `id === sessionId(where)`, `omp.pid` set, `omp.transcript` ends with `chat-basic.jsonl`, `status` equal to `statusFromTranscript` of that fixture, `liveVoice === false`.
2. `live voice shows on the matching session only`: `setLiveVoicePids([omp pid])` → that session `liveVoice === true`, a second scratch session `false`; `breakPactl()` → both `null` and `sources.liveVoice.ok === false`.
3. `herdr agents become sessions; their liveVoice is null while an unplaced live-voice pid exists`: `setHerdrAgents([...one idle agent...])` → `kind "herdr"`, `status` from `HERDR_STATUS`; with `setLiveVoicePids([99999])` → herdr `liveVoice === null`.
4. `names: spinner stripped, hostname falls back to the folder`: pane titles `"⠋ fixing auth"` → `"fixing auth"`; title = `os.hostname()` → `basename(cwd)`.
5. `Thalamus is pinned first`: session with cwd `s.thalamusDir` sorts first, `pinned === true`.
6. `a dead tmux socket is reported, not thrown`: an empty file in `s.socketDir` → `sources.tmux` has `{ ok: false }` for it, other sessions still listed.
7. `idle hostd does not scan`: after construction and 3× `scanIntervalMs`, `fakeCalls("herdr").length === 0`; after `startWatching()` it grows; after `stopWatching()` it stops growing.

**Tests (`hostd.test.ts`):**
1. `GET /v1/machine with the local token` → 200, `authMode "127.0.0.1"`, `you.device "local"`, no `sessions` key.
2. `refusals are 403 and logged without text`: no `X-Porthole` → 403; foreign `Origin` → 403; `access.log` last line has `status: 403` and a non-empty `reason`.
3. `GET /v1/sessions` lists the scratch session; unknown path → 404; `OPTIONS` with the right Origin → 204 and `Access-Control-Allow-Origin`.
4. `events: snapshot on open, update on change`: `openWs("/v1/events")` → first message `type "sessions"`; start a second scratch tmux session → a later `sessions` message lists 2.
5. `WebSocket upgrade without Origin is refused`: `rawUpgrade(port, "/v1/events", { "X-Porthole-Local": token })` → 403.
6. `binds only to config.host`: `h.url` starts with `http://127.0.0.1:`.

Run: `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/registry.test.ts server/test/hostd.test.ts`

Commit: `P1 task 8: router, hostd assembly, session registry, machine/sessions/events routes`

---

### Task 9: Chat and screen routes

**Files (owned):**
- Create: `server/src/features/chat.ts`
- Test: `server/test/chat.test.ts`

**Interfaces:**
- Consumes: Task 4 (`readPage`, `readAfter`, `Follower`), Task 2 (`capturePane`, `readScreen`), Task 8 (router, `Registry`, `client.ts`).
- Produces: `chatFeature: FeatureFactory` with
  - `GET /v1/sessions/:id/chat?before=<cursor>|after=<cursor>&limit=<1..200, default 50>` → `Page` (`after` → `readAfter`). No such session → 404 `{error}`; no transcript → 200 `{ items: [], start: 0, end: 0, hasOlder: false, note: "this session has no omp transcript; use Terminal or Screen" }`.
  - channel `/v1/sessions/:id/chat` → on open `{ type: "backlog", page }` (last 50) then `{ type: "append", items, end }` from a `Follower`; on the follower's reset `{ type: "backlog", page }` again; no transcript → `{ type: "error", error }` and close 1000. When the registry later reports a different transcript for the session (omp `/new`), `Follower.moveTo` and a fresh backlog.
  - `GET /v1/sessions/:id/screen?lines=<default 200>` → `{ text, source: "tmux" | "herdr", at }` from `capturePane` / `readScreen`; a source error → 502 `{ error }`.

**Tests (`chat.test.ts`):**
1. `pages over HTTP`: scratch omp session on `chat-basic.jsonl`; `GET .../chat?limit=1` → last item text `"Also check the tests"`, `hasOlder true`; `?before=<start>` returns older items.
2. `WebSocket backlog then append`: open chat channel → `backlog`; `writeTranscript` appends one user line → `append` with that text; truncate the file → a second `backlog`.
3. `no transcript`: plain `bash` scratch session → HTTP note above; WS → `{ type: "error" }`.
4. `screen shows the tmux pane`: `printf` a marker in a scratch pane → `/screen` text contains the marker, `source "tmux"`; herdr session with `setHerdrScreen("hello herdr")` → `source "herdr"`.
5. `unknown session` → 404 on all three.

Run: `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/chat.test.ts`

Commit: `P1 task 9: chat history/live chat and screen routes`

---

### Task 10: Delivery (send, status, keys) and the one live-inbox run

**Files (owned):**
- Create: `server/src/deliver/deliver.ts`, `server/src/deliver/keys.ts`, `server/src/features/send.ts`, `server/test/live/live-inbox-once.ts`
- Test: `server/test/deliver.test.ts`, `server/test/keys.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 6, 8.
- Produces:
  - `keys.ts`: `type KeyStep = { key: string } | { text: string }`; `parseSteps(steps: string[]): KeyStep[] | { error: string }` accepting `Tab Enter Esc Space BSpace Up Down Left Right Home End PageUp PageDown`, `C-<a-z>`, one printable character, and `text:<anything>`; at most 32 steps. `TMUX_KEYS: Record<string, string>` (`Esc → Escape`, others same name). `HERDR_KEYS: Record<string, string>` (`Esc → esc` verified; the rest lower-case names, **GUESS**, Needs Ben 2).
  - `deliver.ts`: `class Deliverer { constructor(cfg, registry, sentlog); send(sessionId, clientMsgId, text): Promise<SendRecord>; status(clientMsgId): SendRecord | undefined; keys(sessionId, steps: KeyStep[]): Promise<{ ok: boolean; reason: string }>; reconcilePending(): Promise<void> }`.
  - `features/send.ts`: `sendFeature(deliverer)`: `POST /v1/sessions/:id/send {clientMsgId, text}` → the `SendRecord` minus `text` (200 delivered/pending, 409 refused, 502 failed, 400 bad id/size); `GET /v1/sends/:clientMsgId` → latest record minus `text`; `POST /v1/sessions/:id/keys {steps}` → `{ ok, reason }` (409 when refused).
- Rules (SPEC 4.5): bad `clientMsgId` or `text` over `MAX_MESSAGE_BYTES` → 400, nothing recorded. Same id seen before: same session → return the existing record, never deliver twice; other session → `refused "this message id was already used for another session"`. One lock per session id (sends run one at a time). Route choice: omp with inbox → **inbox** (stage → record pending with `pid`,`file` → commit → `waitTaken(file, pendingAfterMs)` → delivered, else stays pending); omp without inbox → **tmux** only if `liveVoice === false`, else `refused "live voice is on and this omp has no inbox; turn live voice off or restart omp"`; plain tmux → **tmux** `sendText`; herdr → refused when `liveVoice === null` (`"cannot tell if live voice is on for this herdr pane"`) or `true`; else `prompt`, and a "showing a question" error → `refused "a question box is showing; use the key row"`. `keys` refused for an omp session unless `liveVoice === false`.
- `reconcilePending()` runs at hostd start and every `scanIntervalMs` while anything is pending: inbox record whose file is gone → delivered; whose omp pid is dead → failed `"omp exited before reading the message"` and our `.msg` removed; tmux/herdr record still pending (hostd died mid-typing) → failed `"hostd stopped while typing; check the pane"`.

**Tests (`deliver.test.ts`, scratch tmux + fakes only):**
1. `plain tmux send types the text and Enter`: delivered, `route "tmux"`, `capturePane` shows the text.
2. `exactly once`: same `clientMsgId` twice → second returns the same record, text appears once; same id to another session → refused.
3. `inbox route`: scratch omp session with `<inboxRoot>/<pid>/` created; a test watcher deletes `*.msg` → delivered, `route "inbox"`; with no watcher → pending after `pendingAfterMs`, then deleting the file and `reconcilePending()` → delivered.
4. `omp without inbox is refused while live voice is on or unknown`: `setLiveVoicePids([pid])` → refused; `breakPactl()` → refused; neither → tmux delivered.
5. `herdr`: idle agent → delivered via fake `herdr-prompts.log` `{target, text}`; `failHerdrPrompt("agent is showing a question")` → refused with the key-row reason; unplaced live-voice pid → refused.
6. `crash recovery`: a hand-written pending tmux record in `sent.jsonl` → after `new Deliverer(...).reconcilePending()` it is failed with the "hostd stopped while typing" reason; a pending inbox record whose pid is dead → failed and the `.msg` removed.
7. `HTTP`: `POST .../send` without `Origin` → 403; with 600 KiB text → 400; `GET /v1/sends/<id>` has no `text` key.

**Tests (`keys.test.ts`):** `parseSteps(["Esc","C-c","y","text:hello"])` → 4 steps; `["Hyper"]` → error; 33 steps → error; tmux keys reach a scratch pane (`cat -v` shows `^C`); herdr keys appear in `herdr-keys.log` as `{target, keys}`; omp session with `liveVoice true` → refused.

**Live check, run exactly once (`server/test/live/live-inbox-once.ts`, SPEC 7, about 9 US cents, needs Ben's yes in the run report):** start one throwaway `omp --no-extensions -e omp-extension/live-inbox.ts --no-session --model haiku` in a scratch tmux socket under `s.tmuxTmp`, wait for `<inboxRoot>/<pid>/`, send `"reply with the word porthole"` through `Deliverer`, expect `delivered` within 30 s, kill only that omp pid, remove the scratch server. If it passes and `/home/cymatic/.omp/agent/extensions/live-inbox.ts` does not exist, install it with the command in `omp-extension/README.md`; if it exists and differs, stop and report (Needs Ben 4). Never rerun after a pass.

Run: `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/deliver.test.ts server/test/keys.test.ts`, then once `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun run server/test/live/live-inbox-once.ts`

Commit: `P1 task 10: delivery (inbox/tmux/herdr, exactly once, crash recovery), key row, one live-inbox run`

---

### Task 11: Terminal (pty) channel

**Files (owned):**
- Create: `server/src/features/pty.ts`
- Test: `server/test/pty.test.ts`

**Interfaces:**
- Consumes: Task 2 (`tmuxTarget`, `listClients`, `detachClient`), Task 8.
- Produces: `ptyFeature: FeatureFactory`, channel `/v1/sessions/:id/pty?cols=<20..400>&rows=<5..200>`:
  - tmux session → `Bun.spawn([tmux, "-S", socket, "attach-session", "-t", "=" + session], { terminal: { cols, rows, data(_t, bytes) { ws.send(bytes) } }, env: cleanEnv() })` (Verified facts 6: Bun 1.3.14 `terminal` option). Binary frames in → `proc.terminal.write` when writable; text frame `{ type: "resize", cols, rows }` → `proc.terminal.resize`.
  - Writable only when the session is not omp, or omp with `liveVoice === false`; otherwise first message `{ type: "readonly", reason: "live voice is on; typing here would mix with it" }` and input frames are dropped.
  - herdr session → `{ type: "readonly", reason: "herdr terminals are read-only in P1" }` then screen text every second from `readScreen` (Needs Ben 1).
  - On close: find our client with `listClients` where `pid === proc.pid`, `detachClient` that tty only, then kill our own child pid after 2 s if still alive. Never detach any other client.

**Tests (`pty.test.ts`):**
1. `attach, type, see the echo`: scratch `bash` session; send `"echo pty-ok\r"` as binary → received bytes contain `pty-ok`.
2. `resize`: `{type:"resize",cols:100,rows:30}` → `tmux display -p '#{client_width}'` for our client prints `100`.
3. `close detaches only our client`: a second scratch client attached with `tmux attach` in its own scratch pty stays in `listClients` after our socket closes; ours is gone within 3 s.
4. `live voice makes it read-only`: omp session with `setLiveVoicePids([pid])` → first message `readonly`, typed bytes never reach the pane.
5. `herdr is read-only`: → `readonly` then a screen frame containing the fake screen text.

Run: `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/pty.test.ts`

Commit: `P1 task 11: terminal channel (attach own tmux client, resize, read-only when unsafe)`

---

### Task 12: Entry point, service, install, `tailscale serve`, README, auth live check

**Files (owned):**
- Create: `server/src/main.ts`, `deploy/porthole.service`, `deploy/install.sh`, `deploy/serve.ts`, `server/test/live/auth-live.ts`
- Modify: `README.md` (sections "Running hostd" and "Security limit of 127.0.0.1 mode")
- Test: `server/test/main.test.ts`

**Interfaces:**
- `main.ts` (`if (import.meta.main)`): `bun run server/src/main.ts init-config` writes a default `~/.config/porthole/hostd.json` (0600, refuses to overwrite) from `defaultConfig()`; plain run loads `PORTHOLE_CONFIG` or the default path, calls `createHostd(cfg, [machineFeature, sessionsFeature, chatFeature, sendFeature(deliverer), ptyFeature])`, runs `reconcilePending()`, logs one line `porthole hostd <version> on 127.0.0.1:<port>`, stops cleanly on SIGTERM.
- `deploy/porthole.service`: user unit, `ExecStart=/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun run %h/.local/share/porthole/hostd/current/server/src/main.ts`, `Restart=on-failure`, `RestartSec=5`, `UMask=0077`, `WantedBy=default.target`.
- `deploy/install.sh`: `git archive HEAD` into `~/.local/share/porthole/hostd/<short sha>/`, repoint the `current` symlink, `install -m 0644` the unit into `~/.config/systemd/user/`, `systemctl --user daemon-reload`, `systemctl --user enable --now porthole.service` (the plan's executor asks Ben before the `enable --now` step, SPEC 7).
- `deploy/serve.ts`: reads `tailscale serve status --json`; refuses if 443 or 8443 already serve something other than Porthole; otherwise `tailscale serve --bg --https=443 http://127.0.0.1:8797` (control room, P2 fills it) and `--https=8443 http://127.0.0.1:8798` (preview). Prints what it did.
- `README.md`: how to install/run; the limit: "hostd listens on 127.0.0.1, so any program running as cymatic or root on this machine can reach it with the local token file; Unix-socket mode with peer checks is not possible in Bun 1.3.14 (Verified facts 5)".
- `auth-live.ts`, run once by hand after `serve.ts` (SPEC P1.5): from this machine through the tailnet URL, `GET /v1/machine` with `X-Porthole: 1` → 200 and `you.device` = this node; same with a spoofed first `X-Forwarded-For` → still this node; without `X-Porthole` → 403; `POST` with `Origin: https://evil.example` → 403; WebSocket to `/v1/events` from the `:8443` origin → refused.

**Tests (`main.test.ts`):** `init-config` writes a 0600 file and refuses a second time; a started `main.ts` with a scratch config answers `/v1/machine` with the local token and exits 0 on SIGTERM (exact child PID); `porthole.service` contains `UMask=0077` and `Restart=on-failure`; `install.sh` and `serve.ts` contain no `sudo`.

Run: `/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun test server/test/main.test.ts`

Commit: `P1 task 12: main entry, user service, install, tailscale serve setup, README limit, auth live check`

---

## Self-review

- **SPEC coverage (P1):** sessions from tmux + herdr (T2, T8); omp/transcript/live voice/status (T3, T8); chat history + live chat (T4, T9); screen (T9); send with exactly-once, inbox/tmux/herdr routes, refusals, crash recovery (T6, T10); key row (T10); terminal (T11); auth, Origin, X-Porthole, access log, local token (T5, T8); live-inbox move and single live run (T7, T10); service/install/serve/live auth check (T12). Phone app, control room UI, notifications: P2+, not here.
- **Names checked across tasks:** `HostdConfig` fields, `Scratch` methods, `sessionId`/`tmuxTarget`, `SendRecord`, `CLIENT_MSG_ID`, `MAX_MESSAGE_BYTES`, `Registry`, `FeatureFactory` are spelled the same everywhere they appear.
- **Honest gap:** Tasks 8-12 give contracts and test cases, not finished code (see the note above Task 8).

## Needs Ben (carried into the P1 run report)

1. **herdr terminal is read-only in P1.** Whether `herdr` can attach a second viewer (or `--takeover` safely) was not verified without touching real panes. Options: keep read-only (recommended), or let a builder test it against a scratch herdr later.
2. **herdr key names and the `--` separator** for `herdr prompt`/`keys` are partly **GUESS** (`esc` verified). Task 10's fake accepts what the plan sends; the first real herdr send in P1.5 confirms or corrects.
3. **127.0.0.1 mode only.** Bun 1.3.14 gives no peer-credential check on a Unix socket, so hostd uses 127.0.0.1 + a local token file; any program running as cymatic or root can reach it. Options: accept and document (recommended), or wait for a later runtime.
4. **Installing `live-inbox.ts`** makes every new omp session (Thalamus included, next start) watch an inbox folder. Options: install after the one passing run (recommended), or keep it opt-in per session with `-e`.

## Execution handoff

Run Tasks 1-12 in the parallel groups above: one builder per task in its own worktree (`omp-worktree new p1-task-<n>`), each told "at most 2 failed attempts per step; if a step fails twice, stop and report", and Section 7 of the SPEC. Merge each green task into `feat/p1-hostd` after `git merge-tree --write-tree` shows no conflicts. The orchestrator runs the full `bun test server/test` once after all merges, then `live-inbox-once.ts` (once, with Ben's yes), then T12's install and `auth-live.ts`.
