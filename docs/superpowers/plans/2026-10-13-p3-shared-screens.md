# Porthole P3: shared screens (control room) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build phase P3 of Porthole: the shared screens in `web/` that hostd serves at `/` (the desktop control room, and later the Android app's WebView): sidebar, chat, terminal with toolbar, gestures and shortcuts, composer with drafts and attachments, inbox, diff, preview list, usage, talk mode, settings, config, reconnect strip, exactly as `docs/SPEC.md` section 8 P3 items 1-4 define (sections 4.1-4.6, 4.8-4.13, 4.15, 4.16, 5.1, 5.2, 5.4).

**Architecture:** Plain HTML, CSS and JavaScript ES modules, no build step (SPEC 5.1). Pure logic lives in small modules under `web/src/lib/` that never touch the DOM, so `bun test` checks them directly. Screens live under `web/src/views/`, each one a function that builds DOM nodes with a tiny `h()` helper that only ever sets `textContent` (no `innerHTML` anywhere, so transcript text can never become markup). One API client per machine adds `X-Porthole: 1`; a "fleet" object holds one link per machine in the device's list and merges their sessions and inbox (SPEC 4.15). Every live connection reconnects by itself with backoff 1, 2, 4, 8, 15 s (SPEC 4.13). Drafts, sent history and the outbox live in `localStorage` (SPEC 4.5). A small native-bridge adapter does nothing in a plain browser and talks to the Android app in the WebView (SPEC 4.16). Third-party code (xterm.js, its fit add-on, marked) is vendored at pinned versions with licences in `web/vendor/`. Headless Chromium checks the four P3 acceptance items at 412 px against a **test** hostd with fixture sessions, reached through a small fake "tailscale serve" TLS proxy so the page has the real `https://<machine>.ts.net` origin shape.

**Tech Stack:** HTML, CSS (custom properties, OKLCH colours, `prefers-color-scheme`, `prefers-reduced-motion`), JavaScript ES2022 modules with JSDoc types checked by `tsc --noEmit -p web` (`checkJs`), `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0, `marked` 18.1.1, `bun test` (Bun 1.4.2) for pure modules, headless Chromium driven over the Chrome DevTools Protocol (CDP) for the acceptance checks. No npm runtime dependencies; the three libraries are copied files.

## Global Constraints

From `docs/SPEC.md` (sections 3, 5.1, 5.4, 6, 7). Every task's requirements include these.

- **Phone first:** Android, portrait, about **412 CSS px** wide. The same screens must work in a desktop browser on both computers, with the sidebar always visible on wide windows (SPEC 3, 4.2, 4.15).
- **Shared screens** (`web/`): plain HTML/CSS/JS served by hostd, no build step. xterm.js and the Markdown library are vendored at pinned versions with their licences kept, **never loaded from a CDN**. Designed with `skill://impeccable` (SPEC 5.1).
- **Non-goals:** custom fonts, custom themes (SPEC 6). The system font stack and the system light/dark setting only.
- **Every `/v1` HTTP request carries `X-Porthole: 1`.** WebSockets cannot carry it; hostd checks their exact `Origin` instead (SPEC 5.4). Cross-machine calls are plain CORS requests: hostd allows `Content-Type, X-Porthole` and methods `GET, POST, PUT, DELETE` for its own origin and its `peers` (`server/src/auth/auth.ts` lines 57-63).
- **Safety (SPEC 7):** never type into, attach to, resize, detach or restart Thalamus or any real session while testing. Every check in this plan runs against a **test hostd** started by `startTestHostd` (`server/test/helpers/client.ts`) on a scratch tmux socket with fixture transcripts. Never start omp live voice. Never use Ben's Chrome profiles (personal relay 9224, Modern Mountain CDP 9225) or his signed-in browsers: the headless Chromium gets its own throwaway `--user-data-dir` and its own DevTools port, and is stopped by its exact PID. No `pkill`/`killall`. No screenshot retry loops: a screenshot that fails once is skipped and reported.
- **No secrets** in the repo or in logs. The test hostd's local token stays in memory and in the scratch folder.
- **Never lose a word (SPEC 4.5):** the draft for a session is written on every keystroke and cleared only after hostd answers `delivered`.
- **Plain language:** every word on screen is everyday English; errors say what happened and what to do next. Rules in "Voice" below.
- **Git:** work on branch `feat/p3-web` in its own worktree (`omp-worktree new p3-web`), branched from the merged P2 branch. Each task commits and pushes its own files, staged by name. Merging to `main` and restarting `porthole.service` wait for Ben's OK.
- **At most 2 failed attempts per step.** If a step fails twice, stop and report (orchestrator rule).

## Verified facts (read in this session, 2026-10-13)

| # | Fact | Source |
|---|---|---|
| V1 | Branch `feat/p1-hostd`. `package.json` scripts: `test` = `bun test server/test`, `hostd` = `bun server/src/main.ts`, `typecheck` = `tsc --noEmit -p .`; devDependencies `@types/bun` ^1.4.3, `typescript` ^7.0.2. Root `tsconfig.json` includes `server/**/*.ts` only. No `web/` folder yet. | `package.json`, `tsconfig.json`, `glob web/` |
| V2 | The router (`server/src/router.ts`, `match()`) matches exact segments and `:param` segments only (no wildcard). An unmatched path answers 404 JSON. **No route serves files**, so `/` and `/src/...` are 404 today (gap G1). | `server/src/router.ts`, `server/src/hostd.ts` lines 73-106 |
| V3 | Auth: a GET with no `Origin` passes the origin rule; `X-Porthole: 1` is required only on `/v1` non-upgrade requests; identity comes from `X-Porthole-Local: <token>` or `Tailscale-User-Login` + `X-Forwarded-For` + whois. `config.origin` and every `peers` entry must match `https://<machine>.<tailnet>.ts.net` with no port. | `server/src/auth/auth.ts` lines 26-63, `server/src/config.ts` lines 14-15, 67-68 |
| V4 | Test helpers: `startTestHostd(scratch, factories, overrides)` (`server/test/helpers/client.ts`) returns `{port, url, localToken, config, registry, sentLog, hub, stop}`; also `localHeaders`, `get`, `post`, `openWs(h, path, origin)`, `pane(s, session, cmd)`, `ompPane(s, session, transcript)`. `Scratch`, `FIXTURES`, `waitFor`, `useTestTimeout` (30 s per test) live in `server/test/helpers/scratch.ts`. Feature factories are `const`s such as `machineFeature`, `sessionsFeature`, `chatFeature`, `ptyFeature`, `sendFeature` (`server/src/features/*.ts`). Transcript entries look like `server/test/fixtures/chat-basic.jsonl` (`title`, `session`, `message` with `role` user/assistant/toolResult and `content` parts `text`/`toolCall`, `custom_message` with `customType: "live-delegation"`). | `server/test/helpers/client.ts`, `server/test/helpers/scratch.ts`, `server/src/features/`, `server/test/fixtures/chat-basic.jsonl` |
| V5 | Sessions: `GET /v1/sessions` → `Tree {machine, scannedAt, sessions: SessionInfo[], sources}`; `SessionInfo {id, kind: "tmux"|"herdr", name, cwd, status, reported, questionCount, liveVoice, pinned, where, attached, omp: {pid, transcript, inbox}|null, herdrStatus}`; P2 adds `dirty: boolean|null`. `registry.current()` re-scans when the cached tree is older than 2 s, so pull-to-refresh is a plain `GET /v1/sessions`. | `server/src/sessions/registry.ts` lines 14-39; P2 plan gap 4 |
| V6 | Chat: `GET /v1/sessions/:id/chat?before=&after=&limit=` → `Page {items, start, end, hasOlder}`; `WS /v1/sessions/:id/chat` sends `{type:"backlog", page}` then `{type:"append", items, end}`, or `{type:"error", error}`. `ChatItem {cursor, id, at, kind: "user"|"assistant"|"tools", text, tools: string[], via: "typed"|"live-voice"|null}`; a `live-delegation` custom message becomes `kind:"user", via:"live-voice"`. `GET /v1/sessions/:id/screen` gives pane text. | `server/src/features/chat.ts`, `server/src/transcript/parse.ts`, `server/src/transcript/tail.ts` |
| V7 | Terminal: `WS /v1/sessions/:id/pty?cols=&rows=`. Server → page: binary frames = terminal output; text frames = JSON `{type:"readonly", reason}`, `{type:"screen", text}` (herdr read-only), `{type:"error", error}`. Page → server: binary frames = typed bytes; text frame `{type:"resize", cols, rows}`. tmux attach is `attach-session -t =<session>`, so the tmux window is shared with the desk's client. | `server/src/features/pty.ts` lines 63-229 |
| V8 | Send: `POST /v1/sessions/:id/send {text, clientMsgId}` → `{clientMsgId, sessionId, status: delivered|pending|refused|failed, reason, route, at}`; `clientMsgId` must be 1-100 of `[A-Za-z0-9._-]`; `GET /v1/sends/:clientMsgId` same shape. `POST /v1/sessions/:id/keys {keys: string[]}` → `{status: sent|refused|failed, reason}`; key names `Tab Enter Esc Space BSpace Up Down Left Right Home End PageUp PageDown`, `C-a`..`C-z`, any single printable character, or `text:<text>`; 1-32 steps. | `server/src/features/send.ts`, `server/src/deliver/keys.ts`, `server/src/deliver/deliver.ts` |
| V9 | P2 (approved plan): `/v1/events?device=&since=` sends `{type:"hello"}`-style messages, `{type:"inbox", items}`, `{type:"notify", id, itemId, title, body, options, at}` (client replies `{type:"ack", id}`); notifications are queued **per device name** and replayed unacked on reconnect. `InboxItem {id, key, sessionId, machine, project, kind, column: needs-you|working|done, title, body, question: {qid, pid, text, options: string[], multi, count, open, outcome}|null, contextLeft, createdAt, updatedAt, doneAt, archivedAt}`. `POST /v1/inbox/:itemId/answer {optionIndexes}|{text}`; `POST /v1/inbox/:itemId/archive`; `GET /v1/inbox/archive`. | P2 plan lines 795-815, 1031, 1166, 1184-1189 |
| V10 | P2: `GET /v1/sessions/:id/diff` → `{repo:true, root, staged: ChangedFile[], unstaged: ChangedFile[], untracked: {path}[]}` or `{repo:false, reason}`; `ChangedFile {path, from, status, binary, patch}`. `GET /v1/previews` → `{proxy:{port}, previews: [{port, pid, process, url}]}`. `GET /v1/usage` → `{windows: [{id: "5h"|"7d", usedPercent, resetsAt, status}], readAt}`. `POST /v1/uploads` (multipart field `file`) → `{path}`. `POST /v1/voice` (audio/wav) → `{text}`; `GET /v1/voice/kept` → `{files}`. `GET|PUT /v1/shortcuts {shortcuts: [{label, steps}]}`, steps split on commas not preceded by `\`. `GET|PUT /v1/config {previewRanges, usageCollection, peers, voiceEnhance, restartNeeded}`. `GET /v1/doctor` → `{checks: [{id, ok, detail}]}`. | P2 plan lines 1462, 1569-1574, 1687-1699, 1852-1855, 1948, 2060-2072 |
| V11 | P2's answer rules accept **one** option per answer; multi-select answers are not built (gap G2). | P2 plan lines 1165-1176 (notebook record of this session's reading) |
| V12 | Vendored packages checked on the npm registry 2026-10-13: `@xterm/xterm` 6.0.0 (MIT) tarball sha256 `908e66e04af6c8dc6b00dd3b54de088e2e81e5ed866284fd6c2fb3c2d1c7a3f6`, files `lib/xterm.mjs`, `css/xterm.css`, `LICENSE`; `@xterm/addon-fit` 0.11.0 (MIT) sha256 `26003b4517a132b64e4ff228fd88a5fda3fff5e606c76093f6dcff772e9ecec0`, files `lib/addon-fit.mjs`, `LICENSE`; `marked` 18.1.1 (MIT) sha256 `c05b3cff890d35e1208805a01fd0501571d09a81e725de0559b10bdfae90adad`, files `lib/marked.esm.js`, `LICENSE`. | `npm view` + tarball hash, this session |
| V13 | Fixture transcripts exist: `server/test/fixtures/chat-basic.jsonl` (user, assistant with tool calls, `live-delegation`, status entry), `status-needs-you.jsonl`, `status-working.jsonl`, `status-done.jsonl`. None has a Markdown table or a `## Needs your decision` block, so P3 adds its own fixture. | `server/test/fixtures/` |

**GUESSES this plan relies on** (each is checked by the task named, with 2 attempts at most, then reported):
- **G-guess 1:** Chromium accepts `--host-resolver-rules="MAP testdesk.example.ts.net:443 127.0.0.1:<port>"` (a port in the rule) so the page can load `https://testdesk.example.ts.net/` from a local TLS proxy. Checked by Task C1 step 1. Fallback written in C1.
- **G-guess 2:** `chromium` is on `PATH` on the desktop. Checked by Task C1 step 1 (`command -v chromium`).
- **G-guess 3:** TypeScript 7 (`tsgo`) checks JSDoc in `.js` files with `allowJs` + `checkJs`. Checked by Task 0 step 4; if it does not, `web/tsconfig.json` is dropped and Task 0 reports it (the unit tests still run).
- **G-guess 4:** Ben's tmux prefix is `C-b` on every socket (tmux default). Used only as the default of Settings → Gestures → "tmux prefix"; gap G3 removes the guess.

## Design direction

Made with `skill://impeccable` (Operate mode: a tool used every day, not a landing page). The build re-runs its context loader in Task 0 and reads `reference/craft-floor.md` before each screen task; this section is the brief those steps work from.

### Who and when

- **Ben**, on his phone (Android, portrait, ~412 px), often away from the desk, glancing between other things; and at the desk in a wide browser window next to his terminals. He is new to most technical words.
- The job, in order: **see what needs him**, **answer it in one or two taps**, **read what the agent said**, **type or say a reply without ever losing it**, and sometimes **drive a terminal**.
- So the feel is **calm, readable, fast to act on a question**. Nothing blinks for attention except a new "needs you"; nothing decorative; the question and its answer buttons are always the biggest thing on the screen when there is one.

### Layout

- **Phone (< 840 px wide):** one column. A top bar (menu button, screen title, machine badge, one context action). The sidebar is a drawer that slides in from the left over a dimmed page, closed by the scrim, the back gesture, Esc, or choosing a row.
- **Wide (≥ 840 px):** the sidebar is a permanent 300 px column; the screen fills the rest. Chat bubbles cap at 72 characters wide (`max-inline-size: 72ch`). The diff shows side by side at ≥ 1100 px.
- The composer and key row are pinned to the bottom and rise above the on-screen keyboard (`interactive-widget=resizes-content` in the viewport meta, plus `env(safe-area-inset-bottom)`).

### Type

System font stack only (SPEC 6): `system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif`; monospace `ui-monospace, "Cascadia Mono", "DejaVu Sans Mono", "Noto Sans Mono", monospace`. `rem`-based scale, ratio 1.2, base `1rem` = 16 px times the Settings text size (87.5 %, 100 %, 112.5 %, 125 %, 150 %):

| Token | Size | Line height | Use |
|---|---|---|---|
| `--fs-1` | 0.75rem (12 px) | 1.4 | **`.meta` only**: timestamps and repeated counts that are never the only copy of a fact (the one place `readable()` allows 12 px) |
| `--fs-2` | 0.875rem (14 px) | 1.45 | badges, captions, status labels (the 14 px floor of `readable()`) |
| `--fs-3` | 1rem | 1.55 | body, bubbles, list rows, buttons |
| `--fs-4` | 1.2rem | 1.35 | screen titles, question text |
| `--fs-5` | 1.44rem | 1.25 | Markdown `#`/`##` inside bubbles |

Weights 400 and 600 only. Numbers in usage and badges use `font-variant-numeric: tabular-nums`. Line length in bubbles ≤ 72ch.

The two small steps leave the 1.2 ratio on purpose so nothing but `.meta` falls under 14 px at the default text size (100 %, the size every `readable()` check runs at). `var(--fs-1)` may appear in exactly one CSS rule, `.meta { font-size: var(--fs-1) }`; Task 0's `tokens.test.ts` enforces it.

### Colour tokens

Restrained: neutral surfaces, one blue accent for actions, and status colours that always come **with a word or a shape**, never colour alone. Light and dark follow the system (`prefers-color-scheme`); no in-app theme switch (SPEC 6). Values are OKLCH; Task 0's contrast test proves every text/background pair below meets WCAG AA (4.5 : 1 for text, 3 : 1 for dots and borders that carry meaning).

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `oklch(98.5% 0.003 250)` | `oklch(17% 0.010 250)` | page |
| `--surface` | `oklch(100% 0 0)` | `oklch(21% 0.012 250)` | cards, sidebar, composer |
| `--surface-2` | `oklch(95.5% 0.006 250)` | `oklch(25.5% 0.012 250)` | assistant bubble, key row, code blocks |
| `--border` | `oklch(88% 0.008 250)` | `oklch(34% 0.012 250)` | hairlines |
| `--text` | `oklch(23% 0.015 250)` | `oklch(93% 0.008 250)` | body |
| `--text-2` | `oklch(45% 0.015 250)` | `oklch(73% 0.010 250)` | secondary text |
| `--accent` | `oklch(50% 0.150 255)` | `oklch(74% 0.120 255)` | primary buttons, links, focus ring |
| `--on-accent` | `oklch(99% 0 0)` | `oklch(17% 0.010 250)` | text on accent |
| `--mine` | `oklch(93% 0.035 255)` | `oklch(30% 0.045 255)` | Ben's bubbles |
| `--needs` | `oklch(60% 0.160 60)` | `oklch(80% 0.140 70)` | "needs you" dot/ring |
| `--needs-text` | `oklch(45% 0.120 55)` | `oklch(84% 0.120 75)` | "needs you" label |
| `--working` | `oklch(52% 0.140 255)` | `oklch(74% 0.120 255)` | "working" dot |
| `--done` | `oklch(50% 0.120 150)` | `oklch(76% 0.120 150)` | "done" dot |
| `--idle` | `oklch(60% 0.010 250)` | `oklch(60% 0.010 250)` | "idle"/"unknown" dot |
| `--live` | `oklch(50% 0.170 300)` | `oklch(74% 0.140 300)` | "live voice on" dot and note |
| `--danger` | `oklch(50% 0.180 25)` | `oklch(72% 0.160 25)` | errors, Stop |
| `--scrim` | `oklch(20% 0.01 250 / 0.45)` | `oklch(5% 0 0 / 0.6)` | drawer backdrop |

Status shapes (so colour is never the only signal): needs you = filled dot with a ring; working = filled dot; done = check mark; idle/unknown = hollow dot; live voice = small mic glyph drawn in CSS (two shapes, no icon font). Every dot has an accessible name ("needs you", "working", …) and the row's visible caption repeats the word on wide screens.

### Spacing, shape, targets

- 4 px grid: `--sp-1` 0.25rem, `--sp-2` 0.5rem, `--sp-3` 0.75rem, `--sp-4` 1rem, `--sp-5` 1.5rem, `--sp-6` 2rem, `--sp-7` 3rem.
- Radius: `--r-1` 6 px (buttons, inputs), `--r-2` 14 px (bubbles, cards), `--r-pill` 999 px (badges). One elevation only (drawer and toasts: `0 8px 24px oklch(0% 0 0 / 0.18)`).
- **Touch targets: at least 48 × 48 CSS px** on touch screens (`@media (pointer: coarse)`), with 8 px between neighbours; at least 32 px on mouse screens. The key row, answer buttons, Send, mic and toolbar keys are 48 px tall everywhere. (The brief said "≤48 px"; this plan reads it as a 48 px floor, Material's minimum. Needs Ben 3.)
- Focus: a 2 px `--accent` outline with 2 px offset on `:focus-visible`, never removed.

### Motion

Minimal and functional: the drawer slides (`transform`, 200 ms, `cubic-bezier(0.2, 0, 0, 1)`), buttons give press feedback (background change, 100 ms), new chat messages fade in (150 ms, opacity only), the reconnect strip slides down (150 ms). No bouncing, no looping animation, no shimmer on skeletons. Under `prefers-reduced-motion: reduce` every duration is 0 and the "Reconnecting…" dots are static. Nothing ever animates layout properties (`width`, `height`, `top`).

### Voice (every on-screen word)

1. Everyday words. Allowed nouns: machine, desktop, laptop, session, chat, terminal, message, draft, question, answer, changes, file, preview, usage, shortcut, settings. Never on screen: WebSocket, PTY, HTTP, 403/404/500, JSON, clientMsgId, origin, CORS, endpoint, payload, stdout, tmux pane id.
2. Errors say **what happened**, then **what to do**, and keep Ben's text on screen: "Couldn't send. Your message is still here. The desktop isn't reachable right now; it will go out when the connection is back."
3. Buttons are verbs naming the result: "Send", "Try again", "Open in terminal", "Answer at the desk" (as a note, not a button), "Copy".
4. hostd's own `reason` strings are already plain sentences (e.g. "Answer this in the terminal", "text steps work on tmux panes only; use Send for herdr"); show them under a plain headline, first letter capitalised, never as the only message.
5. No exclamation marks, no blame, no "Oops". Times are relative and short ("2 min ago", "resets in 3 h 10 min").
6. Empty states teach the next step: "Nothing needs you. New questions from your agents show up here."

Fixed strings used by the acceptance checks (Task A8 exports them from `web/src/lib/copy.js`; tests import them, never retype them):

| Key | Text |
|---|---|
| `reconnecting` | `Reconnecting…` |
| `reconnected` | `Connected again.` |
| `sendHeld` | `Not sent yet. Your message is saved and will go out when the connection is back.` |
| `sendFailedTitle` | `Couldn't send. Your message is still here.` |
| `pendingTitle` | `Waiting for the agent to pick it up. Your message is saved.` |
| `liveVoiceKeys` | `Live voice is on at the desk: keys go to the live panel (Space mutes, Esc ends it)` (SPEC 4.3, verbatim) |
| `noRepo` | `No git repo here` (SPEC 4.9, verbatim) |
| `answerInTerminal` | `Answer this in the terminal` (SPEC 4.6, verbatim) |
| `inboxEmpty` | `Nothing needs you. New questions from your agents show up here.` |
| `draftSaveFailed` | `This device couldn't save your draft. Copy it somewhere safe before leaving.` |

### Wireframes (412 px phone unless marked; one character ≈ 9 px)

**Sidebar drawer** (SPEC 4.2, groups top to bottom; active sessions on top of Chats/Terminals, SPEC 4.1):

```
┌──────────────────────────────────┐░░░░░░
│ Porthole                     [✕] │░░░░░░  ← scrim (tap closes)
│ MACHINES                         │░░░░░░
│ ● Desktop            2 need you  │░░░░░░
│ ○ Laptop    Can't reach it · 1m  │░░░░░░
│──────────────────────────────────│░░░░░░
│ Inbox                         2  │░░░░░░
│──────────────────────────────────│░░░░░░
│ OPEN ON THIS DEVICE              │░░░░░░
│ ◉ porthole · chat       Desktop ✕│░░░░░░
│ ● mission · terminal    Laptop  ✕│░░░░░░
│ CHATS                            │░░░░░░
│ ★ thalamus              ● working│░░░░░░
│ ◉ porthole            ◉ needs you│░░░░░░
│ ✓ intake                   ✓ done│░░░░░░
│ TERMINALS                        │░░░░░░
│ ▾ Desktop                        │░░░░░░
│   ▾ tmux · default      ← socket │░░░░░░
│     ▾ porthole          ← session│░░░░░░
│       ▾ 1 editor        ← window │░░░░░░
│         ● pane 0 · omp  ● working│░░░░░░
│         ○ pane 1 · bash    ○ idle│░░░░░░
│   ▸ herdr · main     ← workspace │░░░░░░
│     (tab → pane rows when opened)│░░░░░░
│──────────────────────────────────│░░░░░░
│ Settings                         │░░░░░░
│ Config · Desktop                 │░░░░░░
└──────────────────────────────────┘░░░░░░
```

**Chat view** with key row and composer (SPEC 4.3, 4.5, 4.8, 4.12):

```
┌──────────────────────────────────────────┐
│ [≡] porthole          Desktop  [Changes•]│ ← top bar; badge when dirty
│ ▔▔ Reconnecting… ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ │ ← strip only while a link is down
│               ┌───────────────────────┐  │
│               │ List the files        │  │ ← Ben (right, --mine)
│               └───────────────────────┘  │
│  ┌──────────────────────────────────┐    │
│  │ There is **one** file:           │    │ ← assistant (left, --surface-2)
│  │ ┌──────┬──────┬───── → scroll    │    │   tables scroll sideways
│  └──────────────────────────────────┘    │
│  ⋯ ran 3 tools                  [show]   │ ← collapsed tool calls
│               ┌───────────────────────┐  │
│               │ 🎙 Also check tests    │  │ ← live-delegation: "said at the desk"
│               └───────────────────────┘  │
│ ┌──────────────────────────────────────┐ │
│ │ Question: Red or blue?               │ │ ← open question card (from inbox)
│ │ [ Red ]  [ Blue ]                    │ │
│ └──────────────────────────────────────┘ │
│ [Esc][ ↑ ][ ↓ ][Enter][Tab][Stop][⋯ more]│ ← key row (no Ctrl+C); disabled + note in live voice
│ ┌──────────────────────────────┐ [🎙][📎] │ ← 📎: Camera · Photo · File · Pasted image
│ │ Type a message…              │  [Send] │ ← composer; draft saved each keystroke
│ └──────────────────────────────┘         │
│ Saved on this device · Sent history ▸    │ ← last 50 sent: reopen into the box, or copy
└──────────────────────────────────────────┘
```

Non-omp pane: the bubbles area becomes one wrapped monospace block of the pane's latest screen text, refreshed by pull-to-refresh or every 3 s while visible, with the caption "Screen text from the terminal, refreshed every few seconds".

**Terminal view** with toolbar (SPEC 4.4):

```
┌──────────────────────────────────────────┐
│ [≡] mission · terminal   Laptop  [Chat]  │
│┌────────────────────────────────────────┐│
││ $ bun test                             ││ ← xterm.js, fit to width
││ 12 pass                                ││
││ █                                      ││
│└────────────────────────────────────────┘│
│ [Ctrl][Esc][Tab][←][↑][↓][→][Paste][⌘][A-][A+]│ ← toolbar, scrolls sideways
└──────────────────────────────────────────┘
 Ctrl: tap = next key only, double tap = locked (button shows "Ctrl 🔒"), tap again = off
 ⌘ opens the shortcut panel (this machine's shortcuts as buttons); A-/A+ = terminal text size
 Gestures (Settings can remap each): 1-finger sideways = window/tab, 2-finger sideways = pane,
 2-finger up/down = session/workspace, pinch = text size, double tap = paste, drag up = scroll back
 Read-only (herdr without attach, or live voice): grey banner above the terminal with the reason.
```

**Inbox** (SPEC 4.6; columns become tabs on the phone, three columns when wide):

```
┌──────────────────────────────────────────┐
│ [≡] Inbox                                │
│ [ Needs you 2 ][ Working 3 ][ Done 1 ]   │
│ porthole · Desktop                       │ ← group: project, then machine
│ ┌──────────────────────────────────────┐ │
│ │ ◉ Pick a colour            ◔ 12% left│ │ ← context ring, warning < 15%
│ │ Red or blue?                         │ │
│ │ [ Red ] [ Blue ]                     │ │
│ │ Type an answer…            [Answer]  │ │
│ │ [Open]                        [Stop] │ │
│ └──────────────────────────────────────┘ │
│ ← swipe any card left to archive · Archive (7 days)│
└──────────────────────────────────────────┘
 Every card (any column) has [Open] and [Stop]; a needs-you card also has the answer controls.
 Multi-select or several questions: "Answer this in the terminal" until gap G2 lands (spec deviation, Needs Ben 2).
 Closed question: note "Answer this in the terminal".
```

**Changes (diff)** (SPEC 4.9):

```
┌──────────────────────────────────────────┐
│ [←] Changes · porthole        Desktop    │
│ STAGED (1)                               │
│  M  server/src/hostd.ts                ▸ │
│ NOT STAGED (2)                           │
│  M  web/index.html                     ▾ │
│ ┌──────────────────────────────────────┐ │
│ │@@ -1,3 +1,4 @@                       │ │ ← unified on phone,
│ │ <!doctype html>                      │ │   side by side ≥ 1100 px
│ │+<meta name="viewport" …>             │ │
│ └──────────────────────────────────────┘ │
│  B  assets/logo.png   Binary file, not shown │
│ NEW FILES (1)                            │
│  ?  notes.md                             │
└──────────────────────────────────────────┘
```

**Previews and usage** (SPEC 4.10, 4.11):

```
┌──────────────────────────────────────────┐   ┌──────────────────────────────────────────┐
│ [≡] Previews · Desktop                   │   │ [≡] Usage                                │
│ ┌──────────────────────────────────────┐ │   │ Claude, 5-hour window                    │
│ │ Port 5173 · vite · process 4121      │ │   │ ███████████░░░░░░░░░  56 %               │
│ │                         [Open ↗]     │ │   │ Resets in 2 h 10 min                     │
│ └──────────────────────────────────────┘ │   │ Claude, 7-day window                     │
│ Only servers found by the latest scan    │   │ ████░░░░░░░░░░░░░░░░  21 %               │
│ can be opened. Pull down to scan again.  │   │ Resets Fri 09:00                         │
└──────────────────────────────────────────┘   │ Read 40 s ago · Pull down to refresh     │
                                               └──────────────────────────────────────────┘
```

**Settings** (this device) and **Config** (per machine) with doctor (SPEC 4.2 items 5, 6):

```
┌──────────────────────────────────────────┐   ┌──────────────────────────────────────────┐
│ [≡] Settings                             │   │ [≡] Config · Desktop                     │
│ MACHINES                                 │   │ SHORTCUTS                                │
│  Desktop  bendesk-omarchy…  [Rename][✕]  │   │  Clear   text:/clear, Enter    [Edit][✕] │
│  Laptop   benacer-omarchy…  [Rename][✕]  │   │  [+ Add shortcut]                        │
│  [+ Add machine]                         │   │ PREVIEWS                                 │
│ TALK MODE                                │   │  Ports to look at  [3000-3999,…      ]   │
│  Send after transcribing        [ on ]   │   │ USAGE                                    │
│  Stop after 2 s of silence      [ on ]   │   │  Collect usage numbers          [ on ]   │
│  Read replies aloud             [ off ]  │   │ VOICE                                    │
│ GESTURES (terminal)                      │   │  Tidy up dictated text          [ off ]  │
│  One finger sideways   Window   [change] │   │  Kept recordings (2)                  ▸  │
│  Two fingers sideways  Pane     [change] │   │ HEALTH CHECK                             │
│  Two fingers up/down   Session  [change] │   │  ✓ Agent add-on installed                │
│  Pinch                 Text size[change] │   │  ✕ Scrolling needs "set -g mouse on" …   │
│  Double tap            Paste    [change] │   │                                          │
│  Drag up               Scroll   [change] │   │                                          │
│  (Window changes also show at the desk)  │   │                                          │
│  tmux prefix key               [ C-b ]   │   │                                          │
│ TEXT SIZE   [A-]  100 %  [A+]            │   │                                          │
│ NOTIFICATIONS (phone app only)           │   │                                          │
└──────────────────────────────────────────┘   └──────────────────────────────────────────┘
```

**Reconnect strip** (SPEC 4.13), under the top bar, on every screen:

```
│ ▔ Reconnecting… Desktop · next try in 4 s  [Try now] ▔ │  (down)
│ ▔ Connected again. ▔                                   │  (shown 2 s after recovery, then hidden)
```

**Wide window** (≥ 840 px): permanent sidebar column, screen to the right:

```
┌──────────────┬───────────────────────────────────────────────┐
│ sidebar      │ top bar                                       │
│ (300 px,     │ reconnect strip                               │
│  same groups │ chat / terminal / inbox (3 columns) / diff    │
│  as drawer)  │ (side by side) / previews / usage / settings  │
└──────────────┴───────────────────────────────────────────────┘
```

The symbols in the wireframes (🎙, 📎, ✕, ≡, ↗) only mark where an icon goes. Icons are one small SVG sprite (`web/src/icons.svg`, `<symbol>`s for menu, close, back, mic, attach, speaker, send, open-outside, check), each `<svg>` use carries `aria-hidden="true"` and its button carries a text label (visible on wide screens, `aria-label` on the phone). No icon font, no emoji in the shipped UI.

## Architecture

### Why no build step (SPEC 5.1)

Native ES modules load directly in Chrome and the Android WebView; JSDoc gives type checking through `tsc --noEmit -p web` without emitting anything; xterm.js 6.0.0 and addon-fit 0.11.0 ship `.mjs` files and marked 18.1.1 ships `lib/marked.esm.js`, so they import directly. A bundler would add a second toolchain and a generated artefact that can drift from source; nothing here needs one. **Rejected:** a framework (React/Preact/Lit) — adds a dependency and a render model for about ten screens a small `h()` helper covers; TypeScript source with a compile step — the spec asks for no build step unless clearly needed, and JSDoc + `checkJs` gives the same checks.

### Layers

```
web/index.html ──► src/main.js (boot: settings, machines, fleet, router, shell)
                     │
   views/  (DOM, one file per screen; only place that touches document)
     shell.js  sidebar.js  strip.js  chat.js  composer.js  keyrow.js  terminal.js
     inbox.js  diff.js  previews.js  usage.js  settings.js  config.js  talk.js
                     │ uses
   lib/   (pure: no DOM, no fetch, no timers unless injected; all unit-tested with bun test)
     storage.js  drafts.js  outbox.js  reconnect.js  steps.js  markdown.js  speech.js
     wav.js  silence.js  chatmodel.js  tree.js  inboxmodel.js  copy.js  format.js  route.js
                     │
   net/   (I/O with injected fetch/WebSocket/timers; unit-tested with fakes)
     api.js  socket.js  machine.js  fleet.js  bridge.js
                     │
   dom/   h.js (createElement + textContent only)  mdom.js (neutral tree → DOM)
```

### Rules every module follows

- **No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, inline event attributes or inline `<script>`.** Task E1 greps for them (exact command in E1) and the static route's Content-Security-Policy blocks inline script.
- **Markdown never becomes HTML.** `lib/markdown.js` runs `marked.lexer()` and turns the tokens into a small neutral tree `{t: tag, a?: attrs, c?: children} | string` using an allowlist (p, h1-h6 → h3-h6 shifted so bubbles never shout, strong, em, del, code, pre, ul, ol, li, blockquote, hr, br, a, table, thead, tbody, tr, th, td). Raw HTML tokens become plain text. Links keep only `http:`, `https:` and `mailto:` URLs (others become text) and open with `target="_blank" rel="noopener noreferrer"`. Images become a link reading "Image: <alt>". Tables are wrapped in a `div.table-scroll` (`tabindex="0"`, `role="region"`, `aria-label="Table, scrolls sideways"`). `dom/mdom.js` builds DOM from the tree with `createElement` and `textContent` only.
- **One API client per machine** (`net/api.js`): `createApi({origin, fetch, timeoutMs = 15000})` returns `{get, post, put, upload, wav}`. Every request: URL `origin + path`, headers `X-Porthole: 1` (plus `Content-Type: application/json` for JSON bodies), `mode: "cors"`, `credentials: "omit"`, `cache: "no-store"`, an `AbortController` timeout. Result is always `{ok: true, status, data}` or `{ok: false, status, error}`; `status 0` means the machine could not be reached, and `error` is a plain sentence (from `copy.js`) or hostd's own `error`/`reason` string. It never throws.
- **One link per machine** (`net/machine.js`): owns that machine's api client, its events socket (`/v1/events?device=<deviceId>&since=<lastNotifyId>`), its latest session tree, inbox items, machine name and link state `"connecting" | "up" | "down"`. On every `open` it re-fetches `GET /v1/sessions` and `GET /v1/inbox` (so nothing missed while down is lost), and acks every `notify` it receives with `{type:"ack", id}` (the page never shows notifications itself; the phone app's native service does, SPEC 4.7).
- **The fleet** (`net/fleet.js`) holds the links for every machine in the device's list and exposes merged, read-only views (sidebar tree, inbox groups, need-you counts) through `subscribe(fn)`. It never merges across machines inside hostd: each hostd stays independent (SPEC 4.15).
- **Reconnect** (`lib/reconnect.js` + `net/socket.js`): delays 1, 2, 4, 8, 15, 15 … seconds; reset to 1 s after a connection opens; `nudge()` retries at once (called on the browser `online` event, on `visibilitychange` → visible, and on the bridge's `network` event in the Android app). Used by the events socket, the chat stream and the terminal (SPEC 4.13).
- **Device identity for events.** The page opens `/v1/events?device=web-<id>` where `<id>` is a random 12-character id kept in `localStorage` (`porthole:device`). It must never use the phone's node name (`bencell`): P2 queues and replays notifications per device name, so a page using `bencell` would take (and ack) the phone app's notifications.
- **Machines list.** In a browser: `localStorage` `porthole:machines` = `[{name, origin}]`; on first run it is filled from this page's own origin (`GET /v1/machine` for the name) plus `GET /v1/config` → `peers` (each peer's name from its own `GET /v1/machine`; if that fails, the host part of the origin). In the Android app the list comes from the bridge (`machines()`), because SPEC 4.16 keeps it native.
- **Drafts and history (SPEC 4.5).** Key `porthole:draft:<origin>|<sessionId>` → `{text, files: string[], updatedAt}`, written on every `input` event (no debounce: one small `setItem` per keystroke is cheap and is the "never lose a word" guarantee). Key `porthole:sent:<origin>|<sessionId>` → the last 50 `{clientMsgId, text, at, status, reason}`. Key `porthole:outbox` → sends not yet answered `delivered` / `refused` / `failed`. A `QuotaExceededError` shows `draftSaveFailed` and keeps the text in the box.
- **Send flow.** Press Send → `clientMsgId = "web-" + crypto.randomUUID()` → outbox entry (status `held`) → if the machine link is up, `POST /v1/sessions/:id/send`. Answers: `delivered` → clear draft, add to sent history, remove from outbox; `pending` → keep draft, show `pendingTitle`, poll `GET /v1/sends/:clientMsgId` every 3 s (also resumed after a reload from the outbox) until it changes; `refused` / `failed` → keep draft, show `sendFailedTitle` plus hostd's `reason`, offer "Try again" (same `clientMsgId`, which hostd allows for refused/failed ids); network failure (status 0) → keep draft and outbox entry as `held`, show `sendHeld`, and stop: the composer never re-sends a held entry itself. **B1 (`net/machine.js`) is the only sender of held entries:** when its link for that origin goes up it re-posts each `outbox.held(origin)` entry with the same `clientMsgId` (hostd answers a repeat from `sent.jsonl`, so it is never delivered twice) and reports each answer through `machine.onSendResult(fn)` as `{clientMsgId, sessionId, action}`, where `action` is `nextAction(entry, answer)`. B1 never edits the outbox; the listener applies `nextAction`. **The listener is fleet-level and owned by D1 (`main.js`), not by any view:** at boot D1 subscribes to `onSendResult` of every machine in `fleet.machines()` (and of each machine added later), and for ANY session, open or not, applies the `action`: draft clear (`drafts.clear`), `drafts.addSent`, `outbox.remove` or `outbox.update`, then emits the app event `send-result` `{clientMsgId, sessionId, action}`. A view never subscribes to `onSendResult`; the composer (D2) listens to the `send-result` app event only to update its status line and re-render when the event's session is its own. So a message held while the page was on another screen is still delivered, cleared from the draft and added to the sent history even though no chat is open.
- **Keys and shortcuts.** In the chat view the key row (`Esc`, `↑`, `↓`, `Enter`, `Tab`, `Stop`, then this machine's shortcuts; SPEC 4.3) goes through `POST /v1/sessions/:id/keys` (hostd refuses them for live voice). `Stop` is the step `Esc` (omp's interrupt). The chat view has **no Ctrl+C button** anywhere: `chatKeyRow` (A3) leaves out any custom shortcut that contains a `C-c` or `prefix` step (both stay in the terminal's shortcut panel). In the terminal view, toolbar keys, gestures (`lib/gestures.js`, A9) and shortcuts are encoded to bytes by `lib/steps.js` and written into the terminal connection, exactly as if typed, so tmux sees its prefix key like a real keyboard (`send-keys` would hand `C-b` to the program instead, so it cannot drive tmux). Shortcut text uses the P2 step syntax: split on commas not preceded by `\`, `\,` becomes `,`.
- **Native bridge** (`net/bridge.js`): if `window.PortholeNative` exists (the object Android's `addWebMessageListener` injects), calls are `PortholeNative.postMessage(JSON.stringify({id, method, args}))` and replies arrive as `{id, ok, result}` / `{id, ok:false, error}` on its `onmessage`; native events arrive as `{event, data}`. Allowed methods (the page refuses any other name before sending): `machines`, `speak`, `stopSpeaking`, `startRecording`, `stopRecording`, `pickFile`, `openExternal`. Native events: `network` (reconnect now), `share` ({path, name} already uploaded by native, inserted into the composer). In a plain browser every method resolves to `null` and callers use the web fallback (`speechSynthesis`, `MediaRecorder`, `<input type=file>`, `window.open`).
- **Routing** (`lib/route.js`): hash routes, all parts `encodeURIComponent`-ed (session ids contain `:` and `.`): `#/inbox`, `#/chat/<machineName>/<sessionId>`, `#/term/<machineName>/<sessionId>`, `#/changes/<machineName>/<sessionId>`, `#/previews/<machineName>`, `#/usage`, `#/settings`, `#/config/<machineName>`. Unknown routes go to `#/inbox`. The last chat or terminal opened is stored (`porthole:open`, the "open on this device" list, SPEC 4.1) and reopened on launch.
- **Security headers** come from the static route (gap G1): `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' <each peer origin> <wss:// form of self and each peer>; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-cache`. `'unsafe-inline'` is for styles only, because xterm.js's DOM renderer inserts its own `<style>` element (**[INFERENCE]** from how xterm's DOM renderer themes cells; Task D3 confirms by loading with `style-src 'self'` first and keeping `'unsafe-inline'` only if the terminal renders unstyled). Scripts stay `'self'` only.


## File structure and ownership

All paths are relative to the worktree root `/home/cortex/00-system/porthole/.worktrees/p3-web` (**GUESS**: where `omp-worktree new p3-web` puts it, `<repo-parent>/.worktrees/<slug>`; Task 0 step 1 prints the real path and every later command uses it). Each file has exactly one owning task; no other task edits it.

| Path | Responsibility | Owner |
|---|---|---|
| `package.json` (scripts only), `.gitignore` | `test:web`, `test:web:e2e`, `typecheck:web`; ignore `web/test/.out/` | 0 |
| `web/tsconfig.json` | `allowJs`, `checkJs`, `noEmit`, `strict`, `lib: ["ES2022","DOM"]`, `include: ["src/**/*.js"]` | 0 |
| `web/index.html` | the one page: `<link>` to the stylesheets, `<main id="app">`, `<script type="module" src="/src/main.js">` | 0 |
| `web/styles/tokens.css`, `web/styles/base.css` | colour, type, spacing, motion tokens; resets, focus ring, `.visually-hidden`, buttons, inputs | 0 |
| `web/src/dom/h.js` | `h(tag, attrs, ...children)`: `createElement`, `setAttribute` (refuses `on*` and `style` strings), `textContent` only | 0 |
| `web/vendor/**`, `web/vendor/VENDOR.md` | pinned xterm 6.0.0, addon-fit 0.11.0, marked 18.1.1, their `LICENSE` files, per-file sha256 table | 0 |
| `web/test/fixtures/chat-p3.jsonl`, `web/test/fixtures/reply-p3.jsonl` | P3 chat fixture and the reply turn (in-between text, tool call, final reply) appended in the read-aloud test | 0 |
| `web/test/unit/oklch.ts`, `web/test/unit/contrast.test.ts`, `web/test/unit/vendor.test.ts`, `web/test/unit/tokens.test.ts` | token contrast proof; vendored file hashes; `--fs-1` used by `.meta` only | 0 |
| `web/src/lib/storage.js`, `drafts.js`, `outbox.js` + `web/test/unit/drafts.test.js`, `outbox.test.js` | draft store, sent history, outbox state machine | A1 |
| `web/src/lib/reconnect.js` + `web/test/unit/reconnect.test.js` | backoff schedule and timer | A2 |
| `web/src/lib/steps.js` + `web/test/unit/steps.test.js` | step syntax parse, labels, keys for `/keys`, bytes for the terminal | A3 |
| `web/src/lib/markdown.js` + `web/test/unit/markdown.test.js` | Markdown → neutral tree, allowlist | A4 |
| `web/src/lib/speech.js` + `web/test/unit/speech.test.js` | read-aloud summary: first paragraph + decision titles | A5 |
| `web/src/lib/wav.js`, `silence.js` + `web/test/unit/wav.test.js`, `silence.test.js` | 16 kHz mono WAV encoder, resampler, 2 s silence detector | A6 |
| `web/src/lib/chatmodel.js`, `tree.js`, `inboxmodel.js`, `format.js`, `route.js` + one `*.test.js` each | chat item merge and final-reply rule, sidebar tree (tmux socket → session → window → pane, herdr workspace → tab → pane), inbox groups (column → project → machine) and context ring, times/sizes, hash routes | A7 |
| `web/src/lib/copy.js` + `web/test/unit/copy.test.js` | every on-screen string; banned-word test | A8 |
| `web/src/lib/gestures.js` + `web/test/unit/gestures.test.js` | terminal gesture recogniser, gesture → action map (remappable), Ctrl tap/lock latch, wheel bytes, terminal text size steps | A9 |
| `web/src/net/api.js`, `socket.js`, `machine.js`, `fleet.js`, `bridge.js` + `web/test/unit/net.test.js`, `bridge.test.js` | I/O with injected fetch/WebSocket/timers | B1 |
| `web/test/e2e/tsproxy.ts`, `cdp.ts`, `browser.ts`, `stack.ts`, `readable.ts`, `web/test/e2e/smoke.test.ts` | test TLS proxy, CDP client, throwaway Chromium, two test hostds with every fixture kind and helper group D uses (C1's interface list), readability check | C1 |
| `web/src/main.js`, `web/src/views/shell.js`, `sidebar.js`, `strip.js`, `web/styles/shell.css`, `web/test/e2e/drawer.test.ts` | boot, top bar, drawer, reconnect strip (machine links and `ctx.reportLink` links), lazy view loading | D1 |
| `web/src/dom/mdom.js`, `web/src/views/chat.js`, `composer.js`, `keyrow.js`, `web/styles/chat.css`, `web/test/e2e/chat.test.ts` | chat view, composer, attachments, sent history, key row | D2 |
| `web/src/views/terminal.js`, `web/styles/terminal.css`, `web/test/e2e/terminal.test.ts` | terminal, toolbar (Ctrl lock, shortcut panel, text size), gestures, shortcuts | D3 |
| `web/src/views/inbox.js`, `web/styles/inbox.css`, `web/test/e2e/inbox.test.ts` | inbox columns, project → machine groups, answer buttons, Stop, swipe-to-archive, context ring | D4 |
| `web/src/views/diff.js`, `previews.js`, `usage.js`, `web/styles/panels.css`, `web/test/e2e/panels.test.ts` | changes, previews, usage | D5 |
| `web/src/views/settings.js`, `config.js`, `web/styles/settings.css`, `web/test/e2e/settings.test.ts` | Settings (this device: machines, talk mode, read-aloud, gestures, text size, notifications) and Config (per machine: custom shortcuts, hostd settings, extension status, doctor) | D6 |
| `web/src/views/talk.js`, `web/styles/talk.css`, `web/test/e2e/talk.test.ts` | talk mode, recording, read-aloud | D7 |
| `web/README.md`, `web/test/e2e/acceptance.test.ts` | how to run, P3 items 1-4 in one file, security greps | E1 |

**How views meet without shared files:** `lib/route.js` (A7) maps each route to a view module name (`inbox`, `chat`, `term`, `changes`, `previews`, `usage`, `settings`, `config`); `main.js` (D1) loads it with `import("./views/" + name + ".js")` and calls its `mount(root, ctx)` export, which returns `{unmount()}`. `ctx` = `{fleet, route, settings, bridge, copy, navigate, reportLink, events}`. `ctx.events` = `{on(name, fn) → off(), emit(name, data)}`, the app event bus, owned by D1 (`main.js`); its one event today is `send-result` `{clientMsgId, sessionId, action}`, emitted by D1's fleet-level send-result listener (see "Send flow") after it has applied the result; a view that listens unsubscribes on unmount. `ctx.settings` = `{get(), set(patch), subscribe(fn)}`, owned by D1 (`main.js`) and backed by the one JSON object in `localStorage` `porthole:settings`: `get()` returns the whole object (keys never saved are absent, so each reader applies its own default), `set(patch)` merges the patch into it, writes it back and calls every subscriber, `subscribe(fn)` calls `fn(settings)` on each change (including a change made in another tab, via the `storage` event) and returns an unsubscribe function. D3, D6 and D7 read and write settings only through it, never through `localStorage` directly. `reportLink(name, state, retry?)` is how a view's own live connection (the chat stream, the terminal) reaches D1's reconnect strip: `name` is a `copy` label such as `copy.linkTerminal`, `state` is `"connecting" | "up" | "down"`, and `retry` (optional) is the view's `nudge` for the strip's "Try now" button; D1 drops every link a view reported when it unmounts that view. So D2-D7 never edit D1's files and D1 never imports theirs statically. A view module that fails to load shows `copy.viewFailed` with a "Reload" button.

## Parallel groups

| Group | Tasks | Starts after | Runs in parallel? |
|---|---|---|---|
| 0 | 0 | P2 merged into the branch point, and gaps G1 and G6 landed (one short backend task right after P2; C1 and every e2e step need `GET /`, D7 needs `stopReason`) | alone |
| A | A1, A2, A3, A4, A5, A6, A7, A8, A9 | 0 | yes, all nine (pure modules, disjoint files) |
| B | B1 | A1, A2, A7, A8 | alongside C |
| C | C1 | 0 | alongside A and B |
| D | D1, D2, D3, D4, D5, D6, D7 | B1, C1 (and the A modules each names) | code: yes, all seven (disjoint files; lazy view loading). e2e steps: **no**, see below |
| E | E1 | all of D | alone |

Unit tests in group A need only Bun. Group C and D e2e tests need `tmux`, `openssl` and `chromium` on the desktop, and **never run two e2e files at once** (each starts its own Chromium and two tmux servers). So in group D the seven workers write code and run their unit-level checks in parallel, but none of them runs `bun test web/test/e2e/...` itself: each D task's e2e step is a request to the **e2e queue**, run by the orchestrator (or the manager it names) one file at a time, in the order the requests arrive. A D worker never waits for the queue: it finishes its code and unit checks, then stops and yields with the e2e file name (and the exact queue command) in its report. The orchestrator runs the queue; if a run fails, it redispatches that D worker with the run's output so it can fix its own files, and the file is queued again (at most 2 failed runs per file, then stop and report). The queue command is exactly the one in the task's e2e step; nothing else may start Chromium meanwhile.

---

## Task 0: Scaffold, tokens, vendored libraries, fixtures

**Files:** Create `web/tsconfig.json`, `web/index.html`, `web/styles/tokens.css`, `web/styles/base.css`, `web/src/dom/h.js`, `web/vendor/xterm/xterm.mjs`, `web/vendor/xterm/xterm.css`, `web/vendor/xterm/LICENSE`, `web/vendor/addon-fit/addon-fit.mjs`, `web/vendor/addon-fit/LICENSE`, `web/vendor/marked/marked.esm.js`, `web/vendor/marked/LICENSE`, `web/vendor/VENDOR.md`, `web/test/fixtures/chat-p3.jsonl`, `web/test/fixtures/reply-p3.jsonl`, `web/test/unit/oklch.ts`, `web/test/unit/contrast.test.ts`, `web/test/unit/vendor.test.ts`, `web/test/unit/tokens.test.ts`. Modify `package.json` (scripts), `.gitignore`.

- [ ] **Step 1: Worktree.** From `/home/cortex/00-system/porthole/repo`:

```bash
omp-worktree new p3-web
```

Print the path it reports; if it is not `/home/cortex/00-system/porthole/.worktrees/p3-web`, use the printed one everywhere below. Confirm the branch point contains P2, G1 and G6: `git log --oneline -1 -- server/src/features/web.ts` must print a commit (the G1 file name is defined in "API gaps"), and `grep -c stopReason server/src/transcript/parse.ts` must print a number above 0 (G6). If either prints nothing or 0, stop and report which gap has not landed.

- [ ] **Step 2: Design context.** Read `skill://impeccable` (Operate mode, app UI) and `skill://impeccable/reference/craft-floor.md`. Read only; nothing is written from them except what this plan already says.

- [ ] **Step 3: Vendor the three libraries.** Run from the worktree root:

```bash
mkdir -p web/vendor/xterm web/vendor/addon-fit web/vendor/marked web/test/.out/pack
```

```bash
npm pack @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0 marked@18.1.1 --pack-destination web/test/.out/pack
```

```bash
sha256sum web/test/.out/pack/*.tgz
```

Expected (V12): `908e66e04af6c8dc6b00dd3b54de088e2e81e5ed866284fd6c2fb3c2d1c7a3f6  …/xterm-xterm-6.0.0.tgz`, `26003b4517a132b64e4ff228fd88a5fda3fff5e606c76093f6dcff772e9ecec0  …/xterm-addon-fit-0.11.0.tgz`, `c05b3cff890d35e1208805a01fd0501571d09a81e725de0559b10bdfae90adad  …/marked-18.1.1.tgz`. Any difference: stop and report (never vendor an unverified tarball).

```bash
tar -xzf web/test/.out/pack/xterm-xterm-6.0.0.tgz -C web/vendor/xterm --strip-components=1 package/lib/xterm.mjs package/css/xterm.css package/LICENSE
```

```bash
tar -xzf web/test/.out/pack/xterm-addon-fit-0.11.0.tgz -C web/vendor/addon-fit --strip-components=1 package/lib/addon-fit.mjs package/LICENSE
```

```bash
tar -xzf web/test/.out/pack/marked-18.1.1.tgz -C web/vendor/marked --strip-components=1 package/lib/marked.esm.js package/LICENSE
```

`--strip-components=1` keeps `lib/` and `css/` folders (`web/vendor/xterm/lib/xterm.mjs`, `web/vendor/xterm/css/xterm.css`, `web/vendor/addon-fit/lib/addon-fit.mjs`, `web/vendor/marked/lib/marked.esm.js`); every import in this plan uses those paths. Then write `web/vendor/VENDOR.md`: one row per file with package, version, licence (MIT), tarball sha256 and the file's own sha256 from:

```bash
sha256sum web/vendor/xterm/lib/xterm.mjs web/vendor/xterm/css/xterm.css web/vendor/xterm/LICENSE web/vendor/addon-fit/lib/addon-fit.mjs web/vendor/addon-fit/LICENSE web/vendor/marked/lib/marked.esm.js web/vendor/marked/LICENSE
```

Row format, exactly (the test parses it): `` | `web/vendor/marked/lib/marked.esm.js` | marked | 18.1.1 | MIT | <file sha256> | ``.

- [ ] **Step 4: Write the failing tests.** `web/test/unit/vendor.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..", "..", "..");
const rows = readFileSync(path.join(ROOT, "web/vendor/VENDOR.md"), "utf8")
  .split("\n").map((l) => l.match(/^\| `(web\/vendor\/[^`]+)` \| ([^|]+) \| ([^|]+) \| MIT \| ([0-9a-f]{64}) \|$/)).filter((m) => m !== null);

test("every vendored file is listed and matches its recorded hash", () => {
  expect(rows.length).toBe(7);
  for (const m of rows) {
    const sum = createHash("sha256").update(readFileSync(path.join(ROOT, m[1]))).digest("hex");
    expect(`${m[1]} ${sum}`).toBe(`${m[1]} ${m[4]}`);
  }
});

test("pinned versions", () => {
  const v = Object.fromEntries(rows.map((m) => [m[2].trim(), m[3].trim()]));
  expect(v).toEqual({ "@xterm/xterm": "6.0.0", "@xterm/addon-fit": "0.11.0", marked: "18.1.1" });
});
```

`web/test/unit/oklch.ts` (test helper, standard OKLCH → sRGB conversion from Björn Ottosson's published matrices, gamut-clipped):

```ts
export type Rgb = [number, number, number];
export function parseOklch(s: string): { l: number; c: number; h: number; a: number } {
  const m = s.match(/oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)/);
  if (!m) throw new Error("not oklch: " + s);
  return { l: Number(m[1]) / 100, c: Number(m[2]), h: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
}
export function oklchToLinearSrgb(s: string): Rgb {
  const { l, c, h } = parseOklch(s);
  const a = c * Math.cos((h * Math.PI) / 180), b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clip = (x: number) => Math.min(1, Math.max(0, x));
  return [
    clip(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    clip(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    clip(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ];
}
export function luminance(rgb: Rgb): number { return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]; }
export function contrast(fg: string, bg: string): number {
  const [x, y] = [luminance(oklchToLinearSrgb(fg)), luminance(oklchToLinearSrgb(bg))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
```

`web/test/unit/contrast.test.ts`:

```ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { contrast } from "./oklch";

const css = readFileSync(path.join(import.meta.dir, "..", "..", "styles", "tokens.css"), "utf8");
const darkStart = css.indexOf("@media (prefers-color-scheme: dark)");
function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+):\s*(oklch\([^)]*\))/g)].map((m) => [m[1], m[2]]));
}
const light = tokens(css.slice(0, darkStart));
const dark = tokens(css.slice(darkStart));
const TEXT: [string, string][] = [
  ["--text", "--bg"], ["--text", "--surface"], ["--text", "--surface-2"], ["--text", "--mine"],
  ["--text-2", "--bg"], ["--text-2", "--surface"], ["--text-2", "--surface-2"],
  ["--accent", "--surface"], ["--accent", "--bg"], ["--on-accent", "--accent"],
  ["--needs-text", "--surface"], ["--danger", "--surface"],
];
const MARKS: [string, string][] = [
  ["--needs", "--surface"], ["--working", "--surface"], ["--done", "--surface"], ["--idle", "--surface"], ["--live", "--surface"], ["--border", "--bg"],
];
for (const [name, t] of [["light", light], ["dark", dark]] as const) {
  test(`${name}: text pairs reach 4.5:1`, () => {
    for (const [f, b] of TEXT) expect(`${f}/${b} ${contrast(t[f]!, t[b]!) >= 4.5}`).toBe(`${f}/${b} true`);
  });
  test(`${name}: status marks reach 3:1`, () => {
    for (const [f, b] of MARKS.filter(([f]) => f !== "--border")) expect(`${f}/${b} ${contrast(t[f]!, t[b]!) >= 3}`).toBe(`${f}/${b} true`);
  });
}
```

`--border` is a hairline that carries no meaning on its own (every state also has a word or a shape), so it is parsed but not held to 3 : 1; the MARKS filter says so explicitly.

`web/test/unit/tokens.test.ts` (finding: only `.meta` may fall under the 14 px floor):

```ts
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const STYLES = path.join(import.meta.dir, "..", "..", "styles");
const files = readdirSync(STYLES).filter((n) => n.endsWith(".css"));
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

test("--fs-2 is the 14 px floor and --fs-1 is 12 px", () => {
  const t = strip(readFileSync(path.join(STYLES, "tokens.css"), "utf8"));
  expect(t).toMatch(/--fs-1:\s*0\.75rem/);
  expect(t).toMatch(/--fs-2:\s*0\.875rem/);
});

test("var(--fs-1) appears in exactly one rule, `.meta`", () => {
  const uses: string[] = [];
  for (const f of files) {
    for (const m of strip(readFileSync(path.join(STYLES, f), "utf8")).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (m[2]!.includes("var(--fs-1)")) uses.push(`${f}: ${m[1]!.trim()}`);
    }
  }
  expect(uses).toEqual(["base.css: .meta"]);
});
```

The test reads every stylesheet present, so it runs again in E1 after group D has added theirs: a D task that uses `var(--fs-1)` anywhere fails it.

- [ ] **Step 5: Run them and watch them fail.**

```bash
bun test web/test/unit
```

Expected: FAIL (`tokens.css` and `VENDOR.md` missing or unparsed).

- [ ] **Step 6: Implement.** `web/styles/tokens.css`: `:root { color-scheme: light dark; … }` with every token from the colour table (light values), the type scale (`--fs-1` … `--fs-5` exactly as the "Type" table, `--lh-body: 1.5`, `--fs-scale: 1` multiplied in by Settings → Text size through `html { font-size: calc(100% * var(--fs-scale)) }`), spacing, radius, the one shadow, `--dur-1: 100ms; --dur-2: 150ms; --dur-3: 200ms; --ease: cubic-bezier(0.2, 0, 0, 1)`, and `--tap: 48px`; then `@media (prefers-color-scheme: dark) { :root { …dark values… } }`; then `@media (prefers-reduced-motion: reduce) { :root { --dur-1: 0ms; --dur-2: 0ms; --dur-3: 0ms } }`. If a colour fails Step 5's test, darken/lighten its `L` in 1 % steps (at most two edits per token) and update the table above in the same commit so plan and code agree. `web/styles/base.css`: box-sizing, body font stacks from "Type", `:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px }`, `button, [role=button], input, select, textarea { min-block-size: var(--tap) }`, `.visually-hidden`, `.table-scroll { overflow-x: auto }`, and the one 12 px rule `.meta { font-size: var(--fs-1); line-height: 1.4; color: var(--text-2) }` (every other small label uses `var(--fs-2)`). `web/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <title>Porthole</title>
  <link rel="stylesheet" href="/styles/tokens.css">
  <link rel="stylesheet" href="/styles/base.css">
  <link rel="stylesheet" href="/vendor/xterm/css/xterm.css">
  <link rel="stylesheet" href="/styles/shell.css">
  <link rel="stylesheet" href="/styles/chat.css">
  <link rel="stylesheet" href="/styles/terminal.css">
  <link rel="stylesheet" href="/styles/inbox.css">
  <link rel="stylesheet" href="/styles/panels.css">
  <link rel="stylesheet" href="/styles/settings.css">
  <link rel="stylesheet" href="/styles/talk.css">
  <script type="module" src="/src/main.js"></script>
</head>
<body>
  <noscript>Porthole needs JavaScript turned on.</noscript>
  <main id="app" aria-live="polite"></main>
</body>
</html>
```

(The stylesheet files are created by their D tasks; Task 0's e2e is not run, so missing ones are expected until group D lands.) `web/src/dom/h.js`:

```js
/** @typedef {string | Node | null | undefined | false} Child */
/**
 * Build an element. Attributes are set with setAttribute; event handlers only via `on: {click: fn}`.
 * Text always goes through textContent (a string child becomes a Text node), never HTML.
 * @param {string} tag @param {Record<string, any>} [attrs] @param {...(Child|Child[])} children @returns {HTMLElement}
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === "class") el.className = v;
    else if (/^on/i.test(k) || k === "style" || k === "srcdoc") throw new Error("h: attribute not allowed: " + k);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}
```

`web/tsconfig.json`: `{"compilerOptions":{"allowJs":true,"checkJs":true,"noEmit":true,"strict":true,"target":"ES2022","module":"ES2022","moduleResolution":"bundler","lib":["ES2022","DOM","DOM.Iterable"],"skipLibCheck":true},"include":["src/**/*.js"]}`. `package.json` scripts add `"test:web": "bun test web/test/unit"`, `"test:web:e2e": "bun test --timeout 120000 web/test/e2e"`, `"typecheck:web": "tsc --noEmit -p web"`. `.gitignore` adds `web/test/.out/`.

Fixtures. `web/test/fixtures/chat-p3.jsonl` (one JSON object per line, shapes copied from `server/test/fixtures/chat-basic.jsonl`): a `title` line ("P3 fixture"), a `session` line (`id: "fx-p3"`), user `u1` "Can you compare the two plans?", assistant `a1` with text "Here they are side by side:\n\n| Plan | Cost | Time |\n|---|---|---|\n| Small | $10 | 1 day |\n| Large | $40 | 3 days |" plus two `toolCall` parts (`read`, `grep`) and `stopReason: "toolUse"`, `toolResult` `r1`, a `custom_message` `d1` with `customType: "live-delegation"`, content "Also check the tests", and assistant `a2` "Done. Both plans are listed above." with `stopReason: "stop"`. `web/test/fixtures/reply-p3.jsonl` (exactly three lines, appended together during the read-aloud test; one finished turn whose in-between text must never be spoken):

1. assistant `a3`, `parentId: "a2"`, `stopReason: "toolUse"`, content = text "Let me run the tests before I answer." plus one `toolCall` (`bash`, arguments `{"command":"bun test"}`);
2. `toolResult` `r3`, `parentId: "a3"`, for that call, text "12 pass";
3. assistant `a4`, `parentId: "r3"`, `stopReason: "stop"`, text

```
The tests pass and the page loads on the phone.

I checked both machines.

## Needs your decision

1. **Merge the branch**
   It is ready.
2. **Turn on the advisor**
   It costs a little each run.
```

- [ ] **Step 7: Run and pass.**

```bash
bun test web/test/unit
```

Expected: PASS, 9 tests (vendor 2, contrast 4, tokens 2; at this point `tokens.test.ts` sees only `tokens.css` and `base.css`; the count Bun prints is the source of truth).

```bash
bun run typecheck:web
```

Expected: no output, exit 0. If `tsc` (TypeScript 7) says it cannot check `.js` files (G-guess 3), delete `web/tsconfig.json` and the `typecheck:web` script, and record "JS type checking unavailable with TypeScript 7" in the commit message and the final report.

- [ ] **Step 8: Commit and push.**

```bash
git add package.json .gitignore web/tsconfig.json web/index.html web/styles/tokens.css web/styles/base.css web/src/dom/h.js web/vendor/VENDOR.md web/vendor/xterm/lib/xterm.mjs web/vendor/xterm/css/xterm.css web/vendor/xterm/LICENSE web/vendor/addon-fit/lib/addon-fit.mjs web/vendor/addon-fit/LICENSE web/vendor/marked/lib/marked.esm.js web/vendor/marked/LICENSE web/test/fixtures/chat-p3.jsonl web/test/fixtures/reply-p3.jsonl web/test/unit/oklch.ts web/test/unit/contrast.test.ts web/test/unit/vendor.test.ts web/test/unit/tokens.test.ts
```

```bash
git commit -m "web: scaffold, design tokens with contrast test, pinned vendored xterm and marked" && git push -u origin HEAD
```

---

## Task A1: Draft store, sent history, outbox

**Files:** Create `web/src/lib/storage.js`, `web/src/lib/drafts.js`, `web/src/lib/outbox.js`, `web/test/unit/drafts.test.js`, `web/test/unit/outbox.test.js`.

**Interfaces.** `storage.js`: `memoryStorage()` → a `Storage`-like object (`getItem/setItem/removeItem/key/length`) for tests and as the fallback when `localStorage` throws on access. `drafts.js`: `createDrafts(store, now = Date.now)` → `{get(origin, sessionId) → {text, files, updatedAt} | null, put(origin, sessionId, text, files) → {ok: true} | {ok: false, reason: "quota"}, clear(origin, sessionId), sent(origin, sessionId) → SentItem[], addSent(origin, sessionId, item)}` (history capped at 50, newest last). `outbox.js`: `createOutbox(store)` → `{all(), get(clientMsgId), held(origin), put(entry), update(clientMsgId, patch), remove(clientMsgId)}`, plus the pure `nextAction(entry, answer)` that maps a hostd answer to `{draft: "keep"|"clear", outbox: "keep"|"remove", show: copy key | null, poll: boolean}`.

- [ ] **Step 1: Failing tests.** `web/test/unit/drafts.test.js`:

```js
import { expect, test } from "bun:test";
import { memoryStorage } from "../../src/lib/storage.js";
import { createDrafts } from "../../src/lib/drafts.js";

const O = "https://testdesk.example.ts.net", S = "tmux:abc:main:0.0";

test("a draft survives a new store object on the same storage (a reload)", () => {
  const st = memoryStorage();
  createDrafts(st, () => 5).put(O, S, "half a sent", ["/tmp/a.png"]);
  expect(createDrafts(st).get(O, S)).toEqual({ text: "half a sent", files: ["/tmp/a.png"], updatedAt: 5 });
});

test("drafts are per machine and per session", () => {
  const d = createDrafts(memoryStorage());
  d.put(O, S, "one", []);
  expect(d.get("https://testlaptop.example.ts.net", S)).toBeNull();
  expect(d.get(O, "tmux:abc:other:0.0")).toBeNull();
});

test("an empty draft with no files removes the key", () => {
  const st = memoryStorage(); const d = createDrafts(st);
  d.put(O, S, "x", []); d.put(O, S, "", []);
  expect(st.length).toBe(0);
});

test("quota errors are reported, not thrown", () => {
  const st = memoryStorage();
  st.setItem = () => { const e = new Error("full"); e.name = "QuotaExceededError"; throw e; };
  expect(createDrafts(st).put(O, S, "keep me", [])).toEqual({ ok: false, reason: "quota" });
});

test("sent history keeps the newest 50", () => {
  const d = createDrafts(memoryStorage());
  for (let i = 0; i < 55; i++) d.addSent(O, S, { clientMsgId: "web-" + i, text: "m" + i, at: i, status: "delivered", reason: null });
  const s = d.sent(O, S);
  expect(s.length).toBe(50);
  expect(s[0].clientMsgId).toBe("web-5");
  expect(s[49].clientMsgId).toBe("web-54");
});

test("corrupt stored JSON reads as no draft", () => {
  const st = memoryStorage(); st.setItem(`porthole:draft:${O}|${S}`, "{nope");
  expect(createDrafts(st).get(O, S)).toBeNull();
});
```

`web/test/unit/outbox.test.js`:

```js
import { expect, test } from "bun:test";
import { memoryStorage } from "../../src/lib/storage.js";
import { createOutbox, nextAction } from "../../src/lib/outbox.js";

const E = { clientMsgId: "web-1", origin: "https://testdesk.example.ts.net", sessionId: "s", text: "hi", status: "held", at: 1 };

test("outbox persists across store objects", () => {
  const st = memoryStorage(); createOutbox(st).put(E);
  expect(createOutbox(st).get("web-1")).toEqual(E);
  expect(createOutbox(st).held(E.origin).map((e) => e.clientMsgId)).toEqual(["web-1"]);
});

test.each([
  [{ ok: true, data: { status: "delivered" } }, { draft: "clear", outbox: "remove", show: null, poll: false }],
  [{ ok: true, data: { status: "pending" } }, { draft: "keep", outbox: "keep", show: "pendingTitle", poll: true }],
  [{ ok: true, data: { status: "refused", reason: "Live voice is on" } }, { draft: "keep", outbox: "remove", show: "sendFailedTitle", poll: false }],
  [{ ok: true, data: { status: "failed", reason: "pane gone" } }, { draft: "keep", outbox: "remove", show: "sendFailedTitle", poll: false }],
  [{ ok: false, status: 0, error: "x" }, { draft: "keep", outbox: "keep", show: "sendHeld", poll: false }],
  [{ ok: false, status: 404, error: "Not found" }, { draft: "keep", outbox: "remove", show: "sendFailedTitle", poll: false }],
])("nextAction %#", (answer, want) => {
  expect(nextAction(E, answer)).toEqual(want);
});
```

- [ ] **Step 2: Run, expect FAIL** (modules missing):

```bash
bun test web/test/unit/drafts.test.js web/test/unit/outbox.test.js
```

- [ ] **Step 3: Implement** with keys exactly `porthole:draft:<origin>|<sessionId>`, `porthole:sent:<origin>|<sessionId>`, `porthole:outbox` (one JSON array). Every `JSON.parse` is wrapped; bad data reads as empty. `put` with text `""` and no files calls `removeItem`. `nextAction` is a pure switch on `answer.ok`, `answer.status` and `answer.data.status` exactly as the table in the test.

- [ ] **Step 4: Run, expect PASS** (same command as Step 2).

- [ ] **Step 5: Commit and push.**

```bash
git add web/src/lib/storage.js web/src/lib/drafts.js web/src/lib/outbox.js web/test/unit/drafts.test.js web/test/unit/outbox.test.js && git commit -m "web: draft store, sent history and outbox" && git push
```

## Task A2: Reconnect backoff

**Files:** Create `web/src/lib/reconnect.js`, `web/test/unit/reconnect.test.js`.

**Interface.** `delayFor(attempt)` → seconds `[1, 2, 4, 8, 15][min(attempt, 4)]`. `createReconnector({connect, setTimeout, clearTimeout})` → `{start(), opened(), closed(), nudge(), stop(), state()}`; `connect()` is called at once on `start()`, after each delay on `closed()`, and immediately on `nudge()` when a retry is waiting; `opened()` resets the attempt counter; `state()` → `"connecting" | "up" | "waiting"`.

- [ ] **Step 1: Failing test.**

```js
import { expect, test } from "bun:test";
import { createReconnector, delayFor } from "../../src/lib/reconnect.js";

test("delays are 1, 2, 4, 8, 15, 15 seconds", () => {
  expect([0, 1, 2, 3, 4, 5, 9].map(delayFor)).toEqual([1, 2, 4, 8, 15, 15, 15]);
});

function fakeTimers() {
  const q = []; return { q, setTimeout: (fn, ms) => (q.push({ fn, ms }), q.length), clearTimeout: (id) => { if (q[id - 1]) q[id - 1].fn = null; } };
}

test("closes back off, an open resets, a nudge skips the wait", () => {
  const t = fakeTimers(); let calls = 0;
  const r = createReconnector({ connect: () => calls++, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
  r.start(); expect(calls).toBe(1);
  r.closed(); expect(t.q.at(-1).ms).toBe(1000); t.q.at(-1).fn(); expect(calls).toBe(2);
  r.closed(); expect(t.q.at(-1).ms).toBe(2000);
  r.nudge(); expect(calls).toBe(3); expect(t.q.at(-1).fn).toBeNull();
  r.closed(); expect(t.q.at(-1).ms).toBe(4000);
  r.opened(); expect(r.state()).toBe("up");
  r.closed(); expect(t.q.at(-1).ms).toBe(1000);
});

test("stop cancels a waiting retry and ignores later closes", () => {
  const t = fakeTimers(); let calls = 0;
  const r = createReconnector({ connect: () => calls++, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
  r.start(); r.closed(); r.stop(); r.closed(); r.nudge();
  expect(calls).toBe(1); expect(t.q.length).toBe(1); expect(t.q[0].fn).toBeNull();
});
```

- [ ] **Step 2: Run, expect FAIL.** `bun test web/test/unit/reconnect.test.js`
- [ ] **Step 3: Implement** (attempt counter increments after each scheduled delay; `nudge()` while `"up"` or `"connecting"` does nothing).
- [ ] **Step 4: Run, expect PASS** (same command).
- [ ] **Step 5: Commit and push.**

```bash
git add web/src/lib/reconnect.js web/test/unit/reconnect.test.js && git commit -m "web: reconnect backoff 1-2-4-8-15 s with nudge" && git push
```

## Task A3: Step syntax (shortcuts, key row, terminal bytes)

**Files:** Create `web/src/lib/steps.js`, `web/test/unit/steps.test.js`.

**Interface.** `parseSteps(text)` → `{ok: true, steps: string[]} | {ok: false, reason}` (split on `,` not preceded by `\`, `\,` → `,`, trim each, 1-32 steps, each a valid key name per V8 or `text:<t>`; reason is a plain sentence naming the bad step). `formatSteps(steps)` → text (escapes `,` inside `text:` steps). `stepLabel(step)` → what a button shows (`"Ctrl+C"`, `"Esc"`, `"↑"`, `"Tab"`, `"Type: git status"`). `stepBytes(step, prefix)` → `Uint8Array` for the terminal: `Enter` `\r`, `Tab` `\t`, `Esc` `\x1b`, `Space` ` `, `BSpace` `\x7f`, arrows `\x1b[A/B/C/D` (`Up/Down/Right/Left`), `Home` `\x1b[H`, `End` `\x1b[F`, `PageUp` `\x1b[5~`, `PageDown` `\x1b[6~`, `C-a`..`C-z` code `1..26`, single printable char as UTF-8, `text:<t>` UTF-8 of `<t>`; the pseudo-step `prefix` emits the tmux prefix (setting, default `C-b`, G-guess 4). `chatKeyRow(shortcuts)` → the chat view's buttons, in this order (SPEC 4.3): `{label:"Esc", steps:["Esc"]}`, `{label:"↑", steps:["Up"]}`, `{label:"↓", steps:["Down"]}`, `{label:"Enter", steps:["Enter"]}`, `{label:"Tab", steps:["Tab"]}`, `{label:"Stop", steps:["Esc"], stop:true}`, then one `{label: shortcut.name, steps}` per custom shortcut, leaving out any shortcut with a `C-c` or `prefix` step (no Ctrl+C button in the chat view). Gesture → step mapping is not here: it lives in A9's `gestures.js`.

- [ ] **Step 1: Failing test.**

```js
import { expect, test } from "bun:test";
import { chatKeyRow, formatSteps, parseSteps, stepBytes, stepLabel } from "../../src/lib/steps.js";

const bytes = (s, p = "C-b") => [...stepBytes(s, p)];

test("splits on unescaped commas only", () => {
  expect(parseSteps("C-c, text:echo a\\, b ,Enter")).toEqual({ ok: true, steps: ["C-c", "text:echo a, b", "Enter"] });
});
test("round-trips through formatSteps", () => {
  const steps = ["Esc", "text:x, y", "Enter"];
  expect(parseSteps(formatSteps(steps))).toEqual({ ok: true, steps });
});
test("refuses unknown names, empty lists and more than 32 steps with a plain reason", () => {
  expect(parseSteps("Ctrl-C")).toEqual({ ok: false, reason: 'Step 1, "Ctrl-C", isn\'t a key Porthole knows. Try C-c for Ctrl+C.' });
  expect(parseSteps("  ").ok).toBe(false);
  expect(parseSteps(Array(33).fill("Enter").join(",")).ok).toBe(false);
});
test("labels", () => {
  expect(["C-c", "Esc", "Up", "text:git status", "BSpace"].map(stepLabel)).toEqual(["Ctrl+C", "Esc", "↑", "Type: git status", "Backspace"]);
});
test("terminal bytes", () => {
  expect(bytes("Enter")).toEqual([13]);
  expect(bytes("C-c")).toEqual([3]);
  expect(bytes("Up")).toEqual([27, 91, 65]);
  expect(bytes("PageDown")).toEqual([27, 91, 54, 126]);
  expect(bytes("text:é")).toEqual([195, 169]);
  expect(bytes("prefix")).toEqual([2]);
  expect(bytes("prefix", "C-a")).toEqual([1]);
});
test("chat key row: fixed keys, Stop sends Esc, no Ctrl+C anywhere", () => {
  const row = chatKeyRow([
    { name: "Clear", steps: ["C-c"] },
    { name: "New window", steps: ["prefix", "c"] },
    { name: "Status", steps: ["text:git status", "Enter"] },
  ]);
  expect(row.map((b) => b.label)).toEqual(["Esc", "↑", "↓", "Enter", "Tab", "Stop", "Status"]);
  expect(row.find((b) => b.label === "Stop")).toEqual({ label: "Stop", steps: ["Esc"], stop: true });
  expect(row.some((b) => b.steps.includes("C-c") || /ctrl\+c/i.test(b.label))).toBe(false);
});
```

- [ ] **Step 2: Run, expect FAIL.** `bun test web/test/unit/steps.test.js`
- [ ] **Step 3: Implement** (`prefix` is accepted by `parseSteps` only when called with `{allowPrefix: true}`, which the terminal settings use; hostd's `/keys` never receives it — the chat key row filters it out and shows `copy.prefixTerminalOnly`).
- [ ] **Step 4: Run, expect PASS** (same command).
- [ ] **Step 5: Commit and push.**

```bash
git add web/src/lib/steps.js web/test/unit/steps.test.js && git commit -m "web: step syntax parse, labels and terminal bytes" && git push
```

## Task A4: Markdown → safe neutral tree

**Files:** Create `web/src/lib/markdown.js`, `web/test/unit/markdown.test.js`.

**Interface.** `toTree(markdown)` → `Node[]` where `Node = string | {t, a?, c?}` per "Rules every module follows". Imports `marked` from `../../vendor/marked/lib/marked.esm.js` and uses only `marked.lexer`.

- [ ] **Step 1: Failing test.**

```js
import { expect, test } from "bun:test";
import { toTree } from "../../src/lib/markdown.js";

const flat = (n) => (typeof n === "string" ? n : (n.c ?? []).map(flat).join(""));
const tags = (n, out = []) => { if (typeof n !== "string") { out.push(n.t); (n.c ?? []).forEach((c) => tags(c, out)); } return out; };
const ALLOWED = new Set(["p","h3","h4","h5","h6","strong","em","del","code","pre","ul","ol","li","blockquote","hr","br","a","table","thead","tbody","tr","th","td","div"]);

test("raw HTML stays text", () => {
  const tree = toTree('Hi <img src=x onerror=alert(1)> <script>alert(2)</script>');
  expect(tree.flatMap((n) => tags(n)).every((t) => ALLOWED.has(t))).toBe(true);
  expect(tree.map(flat).join("")).toContain("<script>alert(2)</script>");
});
test("only http, https and mailto links survive", () => {
  const [p] = toTree("[a](javascript:alert(1)) [b](https://x.example/) [c](data:text/html,x) [d](mailto:a@b.c)");
  const links = p.c.filter((n) => typeof n !== "string" && n.t === "a");
  expect(links.map((l) => l.a.href)).toEqual(["https://x.example/", "mailto:a@b.c"]);
  expect(links[0].a).toEqual({ href: "https://x.example/", target: "_blank", rel: "noopener noreferrer" });
});
test("headings shift down to h3..h6", () => {
  expect(toTree("# A\n\n## B\n\n#### C").map((n) => n.t)).toEqual(["h3", "h4", "h6"]);
});
test("tables are wrapped in a labelled scroll region", () => {
  const [w] = toTree("| A | B |\n|---|---|\n| 1 | 2 |");
  expect(w.t).toBe("div");
  expect(w.a).toEqual({ class: "table-scroll", tabindex: "0", role: "region", "aria-label": "Table, scrolls sideways" });
  expect(w.c[0].t).toBe("table");
});
test("images become a link that says Image", () => {
  const [p] = toTree("![a cat](https://x.example/c.png)");
  expect(p.c[0]).toEqual({ t: "a", a: { href: "https://x.example/c.png", target: "_blank", rel: "noopener noreferrer" }, c: ["Image: a cat"] });
});
test("attribute values never carry anything but the listed keys", () => {
  const all = (n, out = []) => { if (typeof n !== "string") { out.push(...Object.keys(n.a ?? {})); (n.c ?? []).forEach((c) => all(c, out)); } return out; };
  const keys = toTree("[x](https://a.example \"t\") `c` ```js\nx\n```").flatMap((n) => all(n));
  expect(keys.every((k) => ["href", "target", "rel", "class", "tabindex", "role", "aria-label"].includes(k))).toBe(true);
});
```

- [ ] **Step 2: Run, expect FAIL.** `bun test web/test/unit/markdown.test.js`
- [ ] **Step 3: Implement**: a recursive walk over `marked.lexer(md)` tokens (`paragraph`, `heading`, `text`, `strong`, `em`, `del`, `codespan`, `code`, `list`/`list_item`, `blockquote`, `hr`, `br`, `link`, `image`, `table`, `html` → its `raw` as a string, `escape` → its `text`, anything unknown → its `raw` as a string). URL check: `new URL(href)` inside `try`, protocol in the allowlist. Code blocks: `{t:"pre", c:[{t:"code", c:[text]}]}` (no language class: no highlighting in P3).
- [ ] **Step 4: Run, expect PASS** (same command).
- [ ] **Step 5: Commit and push.**

```bash
git add web/src/lib/markdown.js web/test/unit/markdown.test.js && git commit -m "web: markdown to a safe neutral tree (no HTML)" && git push
```

## Task A5: Read-aloud summary

**Files:** Create `web/src/lib/speech.js`, `web/test/unit/speech.test.js`.

**Interface.** `summaryUtterances(markdown)` → `string[]`: first the first paragraph (the first `paragraph` token, as plain text with inline marks removed), then for each item of the first ordered list after a heading whose text is "Needs your decision" (case-insensitive, any level) one string `"<n>. <title>"`, where title = the item's leading `strong` text, else its first line. If there is no such list, only the first paragraph. If that list's single item is "None." the result is only the first paragraph. Uses `marked.lexer` too.

- [ ] **Step 1: Failing test** (the reply text is the exact body of the last line, assistant `a4`, of `web/test/fixtures/reply-p3.jsonl`, read from the file so the e2e test and this one share it; which item gets spoken is A7's `finishedReplies`, not this module):

```js
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { summaryUtterances } from "../../src/lib/speech.js";

const lines = readFileSync(path.join(import.meta.dir, "..", "fixtures", "reply-p3.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const reply = lines.at(-1).message.content.find((p) => p.type === "text").text;

test("fixture reply: first paragraph plus decision titles", () => {
  expect(summaryUtterances(reply)).toEqual(["The tests pass and the page loads on the phone.", "1. Merge the branch", "2. Turn on the advisor"]);
});
test("no decision section: first paragraph only, marks stripped", () => {
  expect(summaryUtterances("Done **now**, see `a.txt`.\n\nMore.")).toEqual(["Done now, see a.txt."]);
});
test("None. means no titles", () => {
  expect(summaryUtterances("Ok.\n\n## Needs your decision\n\nNone.")).toEqual(["Ok."]);
});
test("titles fall back to the first line", () => {
  expect(summaryUtterances("Hi.\n\n### Needs your decision\n\n1. Pick a name\n   context")).toEqual(["Hi.", "1. Pick a name"]);
});
test("a reply that starts with a heading uses the first paragraph after it", () => {
  expect(summaryUtterances("## Result\n\nAll good.")).toEqual(["All good."]);
});
```

- [ ] **Step 2: Run, expect FAIL.** `bun test web/test/unit/speech.test.js`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS** (same command).
- [ ] **Step 5: Commit and push.**

```bash
git add web/src/lib/speech.js web/test/unit/speech.test.js && git commit -m "web: read-aloud summary (first paragraph and decision titles)" && git push
```

## Task A6: WAV encoder and silence detector (talk mode)

**Files:** Create `web/src/lib/wav.js`, `web/src/lib/silence.js`, `web/test/unit/wav.test.js`, `web/test/unit/silence.test.js`.

**Interface.** `resample(float32, fromRate, toRate = 16000)` → `Float32Array` (linear interpolation). `encodeWav(float32At16k)` → `Uint8Array` (RIFF/WAVE, PCM 16-bit, mono, 16000 Hz, little-endian, samples clipped to [-1, 1]). `createSilence({threshold = 0.01, holdMs = 2000})` → `{feed(frame: Float32Array, ms) → "speech" | "silence-started" | "stop" | "quiet"}`: "stop" once quiet lasted `holdMs` after any speech (SPEC 4.12 talk mode ends a turn on 2 s of silence); before any speech it returns "quiet" forever (no auto-stop on an empty start).

- [ ] **Step 1: Failing tests.**

```js
// web/test/unit/wav.test.js
import { expect, test } from "bun:test";
import { encodeWav, resample } from "../../src/lib/wav.js";

test("header and samples", () => {
  const w = encodeWav(new Float32Array([0, 1, -1, 2]));
  const v = new DataView(w.buffer);
  expect(new TextDecoder().decode(w.slice(0, 4))).toBe("RIFF");
  expect(new TextDecoder().decode(w.slice(8, 16))).toBe("WAVEfmt ");
  expect([v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true), v.getUint16(34, true)]).toEqual([1, 1, 16000, 16]);
  expect(v.getUint32(40, true)).toBe(8);
  expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true), v.getInt16(50, true)]).toEqual([0, 32767, -32768, 32767]);
  expect(w.length).toBe(52);
});
test("resample 48k → 16k keeps duration", () => {
  expect(resample(new Float32Array(48000), 48000).length).toBe(16000);
});
```

```js
// web/test/unit/silence.test.js
import { expect, test } from "bun:test";
import { createSilence } from "../../src/lib/silence.js";

const loud = new Float32Array(160).fill(0.2), quiet = new Float32Array(160);
test("stops after 2 s of quiet that follows speech", () => {
  const s = createSilence();
  expect(s.feed(quiet, 10)).toBe("quiet");
  expect(s.feed(loud, 10)).toBe("speech");
  expect(s.feed(quiet, 10)).toBe("silence-started");
  let r = ""; for (let i = 0; i < 198; i++) r = s.feed(quiet, 10);
  expect(r).toBe("silence-started");
  expect(s.feed(quiet, 10)).toBe("stop");
});
test("speech resets the quiet timer", () => {
  const s = createSilence({ holdMs: 100 });
  s.feed(loud, 10); for (let i = 0; i < 9; i++) s.feed(quiet, 10);
  expect(s.feed(loud, 10)).toBe("speech");
  for (let i = 0; i < 9; i++) expect(s.feed(quiet, 10)).toBe("silence-started");
});
```

- [ ] **Step 2: Run, expect FAIL.** `bun test web/test/unit/wav.test.js web/test/unit/silence.test.js`
- [ ] **Step 3: Implement** (RMS per frame vs `threshold`; quiet time accumulates `ms` per quiet frame; "stop" when the total reaches `holdMs`; "silence-started" for the quiet frames before that).
- [ ] **Step 4: Run, expect PASS** (same command).
- [ ] **Step 5: Commit and push.**

```bash
git add web/src/lib/wav.js web/src/lib/silence.js web/test/unit/wav.test.js web/test/unit/silence.test.js && git commit -m "web: 16 kHz WAV encoder and 2 s silence detector" && git push
```

## Task A7: Chat model, sidebar tree, inbox groups, formatting, routes

**Files:** Create `web/src/lib/chatmodel.js`, `tree.js`, `inboxmodel.js`, `format.js`, `route.js` and `web/test/unit/chatmodel.test.js`, `tree.test.js`, `inboxmodel.test.js`, `format.test.js`, `route.test.js`.

**Interfaces.**
- `chatmodel.js`: `createChat()` → `{backlog(page), append(items, end), older(page), items(), newestAssistant()}`; items are unique by `id` (an assistant message's text item and its tools item share one `cursor`, `server/src/transcript/parse.ts` lines 38-40), kept in cursor order; `append` returns the items that are new (the read-aloud trigger uses this, so a reconnect's backlog never re-speaks old replies). `kind:"tools"` items render collapsed: `toolSummary(item)` → `"Used 2 tools: read, grep"`. `finishedReplies(newItems)` → the new items that are the final assistant message of a finished turn: `kind === "assistant"` and `stopReason === "stop"` (gap G6 carries `stopReason` on assistant items). Text an assistant writes before a tool call (`stopReason: "toolUse"`) is never returned, so it is never read aloud.
- `tree.js`: `buildSidebar(trees, openList)` → `{machines: [{name, origin, state, needYou}], active: Row[], chats: Group[], terminals: TermMachine[]}`. **Chats** (SPEC 4.2 item 3): sessions with `omp`, grouped by machine then project (`basename(cwd)`), sorted needs-you first, then working, then name. **Terminals** (SPEC 4.2 item 4): every session as a tree, one `TermMachine = {machine, origin, nodes: Node[]}` per machine, where `Node = {key, kind, label, status, children: Node[]}` for groups and `{key, kind: "pane", label, status, id}` for leaves. tmux: `socket` (label = socket file name) → `session` (label = tmux session name) → `window` (label `"Window <n>"`) → `pane` (label `"Pane <n> · <session name>"`). herdr: `workspace` → `tab` → `pane` (label = session name). Order: tmux sockets first, then herdr workspaces; sockets, tmux sessions, workspaces, tabs and herdr panes by name; tmux windows and panes by number. A group's `status` is its most urgent child (needs-you > working > done > idle > unknown) so a collapsed group still shows the right dot. `neighbour(terminals, sessionId, level, dir)` → the id of the first pane of the next (`dir = 1`) or previous (`-1`) `level` group (`"session"` = tmux session or herdr workspace, `"window"` = tmux window or herdr tab, `"pane"`) inside the same parent, wrapping round, or `null` when there is only one; the terminal's gestures use it. `active` = entries of `porthole:open` that still exist.
- `inboxmodel.js`: `groupInbox(itemsByMachine)` → `{needsYou: Group[], working: Group[], done: Group[]}` where `Group = {project, machines: [{machine, items: Item[]}]}` (SPEC 4.6: grouped by project folder, then machine; `project` = `basename(item.project)`); items newest first by `updatedAt` (a number, ms), groups ordered by their newest item; each item carries its machine. `answerMode(item)` → `"buttons" | "terminal"` (`"terminal"` when `question.multi` is true or `question.count > 1`, because P2 answers one option for one question: gap G2, copy `answerInTerminal`). `contextRing(item)` → `null` when `contextLeft` is `null` (no ring), else `{percent: Math.round(contextLeft * 100), warn: contextLeft < 0.15}` (SPEC 4.6: warning below 15 %).
- `format.js`: `ago(iso, now)` → `"just now" | "3 min ago" | "2 h ago" | "yesterday" | "12 Oct"`; `resetsIn(iso, now)` → `"resets in 2 h 10 min"`; `bytes(n)` → `"1.2 MB"`.
- `route.js`: `parse(hash)` → `{view, machine?, sessionId?}`, `href(route)` → hash, `VIEWS` (route name → module name); unknown → `{view: "inbox"}`.

- [ ] **Step 1: Failing tests** (one file each; the key cases):

```js
// chatmodel.test.js
import { expect, test } from "bun:test";
import { createChat, finishedReplies, toolSummary } from "../../src/lib/chatmodel.js";
const it = (cursor, kind = "assistant", text = "t" + cursor, stopReason = null) => ({ cursor, id: "i" + cursor, at: "2026-10-13T09:00:00Z", kind, text, tools: [], via: null, stopReason });
test("append returns only new items and keeps order", () => {
  const c = createChat();
  c.backlog({ items: [it(1), it(2)], start: 1, end: 2, hasOlder: false });
  expect(c.append([it(2), it(3)], 3).map((i) => i.cursor)).toEqual([3]);
  expect(c.items().map((i) => i.cursor)).toEqual([1, 2, 3]);
});
test("a reconnect backlog does not report old items as new", () => {
  const c = createChat(); c.backlog({ items: [it(1)], start: 1, end: 1, hasOlder: false });
  expect(c.backlog({ items: [it(1), it(2)], start: 1, end: 2, hasOlder: false }).map((i) => i.cursor)).toEqual([2]);
});
test("tool summary", () => {
  expect(toolSummary({ ...it(1, "tools"), tools: ["read", "grep"] })).toBe("Used 2 tools: read, grep");
  expect(toolSummary({ ...it(1, "tools"), tools: ["read"] })).toBe("Used 1 tool: read");
});
test("only the final assistant message of a finished turn is a reply to read aloud", () => {
  const fresh = [it(4, "assistant", "Let me run the tests before I answer.", "toolUse"), it(5, "tools"), it(6, "assistant", "The tests pass.", "stop"), it(7, "user", "thanks")];
  expect(finishedReplies(fresh).map((i) => i.cursor)).toEqual([6]);
  expect(finishedReplies([it(8, "assistant", "half", null)])).toEqual([]);
});
```

```js
// tree.test.js
import { expect, test } from "bun:test";
import { buildSidebar, neighbour } from "../../src/lib/tree.js";
const tm = (socket, session, window, pane) => ({ kind: "tmux", socket, session, window, pane });
const s = (id, name, cwd, status, omp, where = tm("/run/t/default", "main", 0, 0)) => ({ id, kind: where.kind, name, cwd, status, reported: true, questionCount: status === "needs-you" ? 1 : 0, liveVoice: false, pinned: false, where, attached: false, omp: omp ? { pid: 1, transcript: "/t", inbox: true } : null, herdrStatus: null, dirty: null });
const D = "https://testdesk.example.ts.net";
test("omp sessions are chats, needs-you first; machines carry their need-you count", () => {
  const trees = [{ origin: D, state: "up", tree: { machine: "testdesk", scannedAt: "", sources: [], sessions: [s("a", "web", "/p/porthole", "working", true, tm("/run/t/default", "main", 0, 0)), s("b", "api", "/p/porthole", "needs-you", true, tm("/run/t/default", "main", 0, 1)), s("c", "sh", "/p/porthole", "idle", false, tm("/run/t/default", "main", 1, 0))] } }];
  const side = buildSidebar(trees, []);
  expect(side.chats[0].rows.map((r) => r.id)).toEqual(["b", "a"]);
  expect(side.chats[0].label).toBe("testdesk · porthole");
  expect(side.machines).toEqual([{ name: "testdesk", origin: D, state: "up", needYou: 1 }]);
});
test("terminals: tmux is socket → session → window → pane; herdr is workspace → tab → pane", () => {
  const sessions = [
    s("t1", "web", "/p", "working", true, tm("/run/t/default", "main", 0, 0)),
    s("t2", "api", "/p", "needs-you", true, tm("/run/t/default", "main", 0, 1)),
    s("t3", "sh", "/p", "idle", false, tm("/run/t/default", "main", 2, 0)),
    s("t4", "logs", "/p", "idle", false, tm("/run/t/default", "build", 0, 0)),
    s("h1", "fe", "/p", "working", true, { kind: "herdr", workspace: "porthole", tab: "dev", pane: "p1" }),
    s("h2", "be", "/p", "done", true, { kind: "herdr", workspace: "porthole", tab: "dev", pane: "p2" }),
  ];
  const side = buildSidebar([{ origin: D, state: "up", tree: { machine: "testdesk", scannedAt: "", sources: [], sessions } }], []);
  const shape = (n) => (n.kind === "pane" ? `${n.kind}:${n.id}` : { [`${n.kind}:${n.label}:${n.status}`]: n.children.map(shape) });
  expect(side.terminals[0].nodes.map(shape)).toEqual([
    { "socket:default:needs-you": [
      { "session:build:idle": [{ "window:Window 0:idle": ["pane:t4"] }] },
      { "session:main:needs-you": [{ "window:Window 0:needs-you": ["pane:t1", "pane:t2"] }, { "window:Window 2:idle": ["pane:t3"] }] },
    ] },
    { "workspace:porthole:working": [{ "tab:dev:working": ["pane:h1", "pane:h2"] }] },
  ]);
  expect(neighbour(side.terminals, "t1", "pane", 1)).toBe("t2");
  expect(neighbour(side.terminals, "t2", "pane", 1)).toBe("t1");
  expect(neighbour(side.terminals, "t1", "window", 1)).toBe("t3");
  expect(neighbour(side.terminals, "t1", "session", -1)).toBe("t4");
  expect(neighbour(side.terminals, "h1", "session", 1)).toBeNull();
});
test("a machine that is down keeps its row and shows no sessions", () => {
  const side = buildSidebar([{ origin: "https://testlaptop.example.ts.net", state: "down", tree: null, name: "testlaptop" }], []);
  expect(side.machines[0]).toEqual({ name: "testlaptop", origin: "https://testlaptop.example.ts.net", state: "down", needYou: 0 });
  expect(side.chats).toEqual([]);
  expect(side.terminals).toEqual([{ machine: "testlaptop", origin: "https://testlaptop.example.ts.net", nodes: [] }]);
});
```

```js
// inboxmodel.test.js
import { expect, test } from "bun:test";
import { answerMode, contextRing, groupInbox } from "../../src/lib/inboxmodel.js";
const q = (o) => ({ qid: "q", pid: 1, text: "Pick", options: ["A", "B"], multi: false, count: 1, open: true, outcome: null, ...o });
const item = (id, column, updatedAt, project = "/work/porthole") => ({ id, column, updatedAt, project, contextLeft: null, question: null });
test("columns, grouped by project then machine, newest first", () => {
  const g = groupInbox({
    testdesk: [item("1", "needs-you", 9), item("2", "needs-you", 10), item("3", "done", 8), item("4", "needs-you", 5, "/work/finance")],
    testlaptop: [item("5", "needs-you", 7)],
  });
  expect(g.needsYou.map((p) => [p.project, p.machines.map((m) => [m.machine, m.items.map((i) => i.id)])])).toEqual([
    ["porthole", [["testdesk", ["2", "1"]], ["testlaptop", ["5"]]]],
    ["finance", [["testdesk", ["4"]]]],
  ]);
  expect(g.needsYou[0].machines[0].items[0].machine).toBe("testdesk");
  expect(g.done[0].machines[0].items.map((i) => i.id)).toEqual(["3"]);
});
test("context ring: hidden without a number, warns below 15 %", () => {
  expect(contextRing({ contextLeft: null })).toBeNull();
  expect(contextRing({ contextLeft: 0.4 })).toEqual({ percent: 40, warn: false });
  expect(contextRing({ contextLeft: 0.15 })).toEqual({ percent: 15, warn: false });
  expect(contextRing({ contextLeft: 0.12 })).toEqual({ percent: 12, warn: true });
});
test("multi-select or several questions answer in the terminal (gap G2)", () => {
  expect(answerMode({ question: q({}) })).toBe("buttons");
  expect(answerMode({ question: q({ multi: true }) })).toBe("terminal");
  expect(answerMode({ question: q({ count: 2 }) })).toBe("terminal");
});
```

```js
// format.test.js
import { expect, test } from "bun:test";
import { ago, bytes, resetsIn } from "../../src/lib/format.js";
const now = Date.parse("2026-10-13T12:00:00Z");
test("ago", () => {
  expect(["2026-10-13T11:59:40Z", "2026-10-13T11:57:00Z", "2026-10-13T10:00:00Z", "2026-10-12T09:00:00Z", "2026-10-01T09:00:00Z"].map((t) => ago(t, now))).toEqual(["just now", "3 min ago", "2 h ago", "yesterday", "1 Oct"]);
});
test("resetsIn and bytes", () => {
  expect(resetsIn("2026-10-13T14:10:00Z", now)).toBe("resets in 2 h 10 min");
  expect([512, 1536, 1_250_000].map(bytes)).toEqual(["512 bytes", "1.5 KB", "1.2 MB"]);
});
```

```js
// route.test.js
import { expect, test } from "bun:test";
import { href, parse } from "../../src/lib/route.js";
test("session ids with colons and dots round-trip", () => {
  const r = { view: "chat", machine: "testdesk", sessionId: "tmux:/run/t.sock:main:0.0" };
  expect(parse(href(r))).toEqual(r);
});
test("unknown and empty go to the inbox", () => {
  expect(parse("#/nope")).toEqual({ view: "inbox" });
  expect(parse("")).toEqual({ view: "inbox" });
});
```

- [ ] **Step 2: Run, expect FAIL.** `bun test web/test/unit/chatmodel.test.js web/test/unit/tree.test.js web/test/unit/inboxmodel.test.js web/test/unit/format.test.js web/test/unit/route.test.js`
- [ ] **Step 3: Implement** (dates formatted with `Intl.DateTimeFormat("en-GB", {day: "numeric", month: "short"})`; "yesterday" = the previous local calendar day).
- [ ] **Step 4: Run, expect PASS** (same command).
- [ ] **Step 5: Commit and push.**

```bash
git add web/src/lib/chatmodel.js web/src/lib/tree.js web/src/lib/inboxmodel.js web/src/lib/format.js web/src/lib/route.js web/test/unit/chatmodel.test.js web/test/unit/tree.test.js web/test/unit/inboxmodel.test.js web/test/unit/format.test.js web/test/unit/route.test.js && git commit -m "web: chat model, sidebar tree, inbox groups, formatting, routes" && git push
```

## Task A8: Every on-screen string

**Files:** Create `web/src/lib/copy.js`, `web/test/unit/copy.test.js`.

`copy.js` exports one frozen object `copy` holding every string in the "Voice" table above plus each screen's labels (drawer group names "Machines", "Inbox", "Chats", "Terminals", "Settings", "Config"; button labels, including the key row's "Stop", the toolbar's "Ctrl", "Ctrl locked", "Shortcuts", "Smaller text", "Bigger text", the attach menu's "Take a photo", "Choose a photo", "Choose a file", "Paste image", the inbox's "Stop" and "Archive", the sent-history sheet's "Sent messages", "Copy", "Put back in the box"; each gesture action's name for Settings: "Next window or tab", "Previous window or tab", "Next pane", "Previous pane", "Next session or workspace", "Previous session or workspace", "Bigger text", "Smaller text", "Paste", "Scroll back", "Nothing"; the reconnect strip's link names `linkChat` "Chat" and `linkTerminal` "Terminal"; empty states; errors) and functions for strings with values (`copy.needYou(n)` → `"1 needs you"`/`"3 need you"`; `copy.cannotReach(machine)` → `"Can't reach testlaptop. It may be asleep or offline. Porthole keeps trying."`; `copy.contextLeft(n)` → `"40% of the context left"`). Views never write literal user-facing strings; Task E1's grep checks it.

- [ ] **Step 1: Failing test.**

```js
import { expect, test } from "bun:test";
import { copy } from "../../src/lib/copy.js";

const all = (o) => Object.values(o).flatMap((v) => (typeof v === "string" ? [v] : typeof v === "function" ? [String(v(2, "testlaptop"))] : all(v)));
const BANNED = /\b(WebSocket|PTY|HTTP|JSON|clientMsgId|origin|CORS|endpoint|payload|stdout|stderr|pane id|403|404|500|null|undefined|NaN)\b/i;

test("the voice-table strings are exact", () => {
  expect(copy.reconnecting).toBe("Reconnecting…");
  expect(copy.liveVoiceKeys).toBe("Live voice is on at the desk: keys go to the live panel (Space mutes, Esc ends it)");
  expect(copy.noRepo).toBe("No git repo here");
  expect(copy.answerInTerminal).toBe("Answer this in the terminal");
});
test("no technical words on screen", () => {
  for (const s of all(copy)) expect(`${s} ${BANNED.test(s)}`).toBe(`${s} false`);
});
test("errors say what happened and what to do (two sentences at least)", () => {
  for (const k of ["sendHeld", "sendFailedTitle", "draftSaveFailed", "viewFailed", "uploadFailed", "voiceFailed"]) expect(copy[k].split(/[.!?]\s/).length).toBeGreaterThanOrEqual(2);
});
test("plural forms", () => {
  expect([copy.needYou(1), copy.needYou(3)]).toEqual(["1 needs you", "3 need you"]);
});
```

- [ ] **Step 2: Run, expect FAIL.** `bun test web/test/unit/copy.test.js`
- [ ] **Step 3: Implement** (the Voice table verbatim; new strings follow the Voice rules; `Object.freeze` deep).
- [ ] **Step 4: Run, expect PASS** (same command).
- [ ] **Step 5: Commit and push.**

```bash
git add web/src/lib/copy.js web/test/unit/copy.test.js && git commit -m "web: all on-screen words in one place, banned-word test" && git push
```

## Task A9: Terminal gestures, Ctrl latch, text size (pure logic)

**Files:** Create `web/src/lib/gestures.js`, `web/test/unit/gestures.test.js`. No imports from other A tasks (it returns step names; D3 turns them into bytes with A3's `stepBytes`), so it runs in parallel with A1-A8.

**Interface** (SPEC 4.4: toolbar and gestures, remappable in Settings).
- `createRecognizer()` → `{down(t, points), move(t, points), up(t, points)}`; `t` is ms, `points` = every touch still on the screen as `{id, x, y}` (for `up`, the touches left after the lift). Each call returns `Event[]`: `{gesture}` with `gesture` one of `"swipe1-left" | "swipe1-right" | "swipe2-left" | "swipe2-right" | "swipe2-up" | "swipe2-down" | "pinch-in" | "pinch-out" | "double-tap"`, or `{gesture: "drag", dy}` while one finger moves vertically. Rules: a swipe is decided when the last finger lifts: average movement ≥ 60 px, the main direction at least twice the other, within 800 ms; one or two fingers counted at the moment the second finger went down (or one). Two fingers whose distance grows to ≥ 1.2× (or shrinks to ≤ 0.83×) while their average movement stays under 60 px is a pinch. A tap = one finger, < 250 ms, < 10 px movement; two taps < 300 ms apart and < 24 px apart = `double-tap` on the second lift (the first tap returns nothing). One finger that moves ≥ 12 px vertically with `|dy| ≥ 2|dx|` becomes a drag: every later `move` returns `{gesture: "drag", dy}` (px since the previous event, positive = finger moving down) and its lift returns nothing.
- `ACTIONS` = `["window-next", "window-prev", "pane-next", "pane-prev", "session-next", "session-prev", "text-bigger", "text-smaller", "paste", "scroll", "none"]`. `DEFAULT_GESTURES` (SPEC 4.4) = `{"swipe1-left": "window-next", "swipe1-right": "window-prev", "swipe2-left": "pane-next", "swipe2-right": "pane-prev", "swipe2-up": "session-next", "swipe2-down": "session-prev", "pinch-out": "text-bigger", "pinch-in": "text-smaller", "double-tap": "paste", "drag": "scroll"}`. `mergeGestureMap(saved)` → the defaults with every valid saved entry laid over them (unknown gesture or action names ignored); Settings (D6) saves only the changed entries as the `gestures` field of `localStorage` `porthole:settings` (this device's preference, SPEC 4.2 item 5), and D3 reads `mergeGestureMap(settings.gestures)`. `gestureAction(gesture, map)` → action.
- `navPlan(action, kind)` (`kind` = the session's `"tmux" | "herdr"`) → what the terminal does: tmux `window-next` / `window-prev` → `{steps: ["prefix", "n"]}` / `{steps: ["prefix", "p"]}` (the tmux window changes for the session, so the desk sees it too, as SPEC 4.4 says); tmux `pane-next` → `{steps: ["prefix", "o"]}`; tmux `pane-prev` → `{steps: ["prefix", ":", "text:select-pane -t :.-", "Enter"]}`; `session-*` on tmux, and `window-*` / `pane-*` / `session-*` on herdr → `{navigate: {level, dir}}` with `level` `"window" | "pane" | "session"` and `dir` `1 | -1` (D3 opens the neighbour from A7's `neighbour()`); `text-*`, `paste`, `scroll` → `{local: action}`; `none` → `null`.
- `createCtrlLatch({doubleMs = 350})` → `{tap(t) → state, apply(data) → Uint8Array, state()}` with states `"off" | "once" | "locked"`: a tap turns `off` into `once`; a second tap within `doubleMs` turns `once` into `locked`; any other tap returns to `off`. `apply` turns a single letter (or `@ [ \ ] ^ _ space`) into its control byte while `once` or `locked` (`once` then falls back to `off` after one key), and otherwise returns the UTF-8 bytes unchanged.
- `wheelBytes(lines, col, row)` → SGR mouse-wheel bytes for tmux (`set -g mouse on`, SPEC 4.4): `lines < 0` = scroll back, `|lines|` copies of `\x1b[<64;col;rowM`; `lines > 0` = `\x1b[<65;col;rowM`.
- `FONT_STEPS = [10, 12, 14, 16, 18, 20, 24, 28]` (terminal px; default 14); `nextFontSize(px, dir)` → the next step up or down, clamped.

- [ ] **Step 1: Failing test** `web/test/unit/gestures.test.js`:

```js
import { expect, test } from "bun:test";
import { DEFAULT_GESTURES, createCtrlLatch, createRecognizer, gestureAction, mergeGestureMap, navPlan, nextFontSize, wheelBytes } from "../../src/lib/gestures.js";

const p = (id, x, y) => ({ id, x, y });
const run = (frames, r = createRecognizer()) => frames.flatMap(([kind, t, pts]) => r[kind](t, pts)).map((e) => (e.gesture === "drag" ? `drag ${e.dy}` : e.gesture));
const text = (u8) => new TextDecoder().decode(u8);

test("one-finger swipes", () => {
  expect(run([["down", 0, [p(1, 300, 400)]], ["move", 100, [p(1, 200, 405)]], ["up", 150, []]])).toEqual(["swipe1-left"]);
  expect(run([["down", 0, [p(1, 100, 400)]], ["move", 100, [p(1, 200, 395)]], ["up", 150, []]])).toEqual(["swipe1-right"]);
});
test("two-finger swipes, sideways and up/down", () => {
  expect(run([["down", 0, [p(1, 100, 400), p(2, 100, 500)]], ["move", 100, [p(1, 200, 402), p(2, 200, 498)]], ["up", 150, []]])).toEqual(["swipe2-right"]);
  expect(run([["down", 0, [p(1, 200, 500), p(2, 300, 500)]], ["move", 100, [p(1, 202, 400), p(2, 298, 400)]], ["up", 150, []]])).toEqual(["swipe2-up"]);
});
test("pinch", () => {
  expect(run([["down", 0, [p(1, 200, 400), p(2, 260, 400)]], ["move", 100, [p(1, 170, 400), p(2, 290, 400)]], ["up", 150, []]])).toEqual(["pinch-out"]);
  expect(run([["down", 0, [p(1, 150, 400), p(2, 310, 400)]], ["move", 100, [p(1, 200, 400), p(2, 260, 400)]], ["up", 150, []]])).toEqual(["pinch-in"]);
});
test("double tap fires once, on the second tap", () => {
  expect(run([["down", 0, [p(1, 100, 100)]], ["up", 80, []], ["down", 200, [p(1, 104, 102)]], ["up", 260, []]])).toEqual(["double-tap"]);
  expect(run([["down", 0, [p(1, 100, 100)]], ["up", 80, []], ["down", 600, [p(1, 104, 102)]], ["up", 660, []]])).toEqual([]);
});
test("vertical drag reports movement and never becomes a swipe", () => {
  expect(run([["down", 0, [p(1, 100, 300)]], ["move", 50, [p(1, 101, 330)]], ["move", 100, [p(1, 101, 360)]], ["up", 150, []]])).toEqual(["drag 30", "drag 30"]);
});
test("small slow movement is nothing", () => {
  expect(run([["down", 0, [p(1, 100, 100)]], ["move", 300, [p(1, 105, 103)]], ["up", 600, []]])).toEqual([]);
});
test("the gesture map: defaults per SPEC 4.4, remapping keeps only valid entries", () => {
  expect(gestureAction("swipe1-left", DEFAULT_GESTURES)).toBe("window-next");
  expect(gestureAction("swipe2-up", DEFAULT_GESTURES)).toBe("session-next");
  expect(gestureAction("double-tap", DEFAULT_GESTURES)).toBe("paste");
  const m = mergeGestureMap({ "double-tap": "none", "pinch-in": "bogus", nope: "paste" });
  expect(m).toEqual({ ...DEFAULT_GESTURES, "double-tap": "none" });
});
test("what each action does in tmux and herdr", () => {
  expect(navPlan("window-next", "tmux")).toEqual({ steps: ["prefix", "n"] });
  expect(navPlan("pane-prev", "tmux")).toEqual({ steps: ["prefix", ":", "text:select-pane -t :.-", "Enter"] });
  expect(navPlan("session-next", "tmux")).toEqual({ navigate: { level: "session", dir: 1 } });
  expect(navPlan("window-prev", "herdr")).toEqual({ navigate: { level: "window", dir: -1 } });
  expect(navPlan("paste", "tmux")).toEqual({ local: "paste" });
  expect(navPlan("none", "tmux")).toBeNull();
});
test("Ctrl: one tap for one key, double tap locks, tap again unlocks", () => {
  const c = createCtrlLatch();
  expect(c.tap(0)).toBe("once");
  expect([...c.apply("c")]).toEqual([3]);
  expect(c.state()).toBe("off");
  expect(text(c.apply("c"))).toBe("c");
  c.tap(1000); expect(c.tap(1200)).toBe("locked");
  expect([...c.apply("a"), ...c.apply("b")]).toEqual([1, 2]);
  expect(c.tap(5000)).toBe("off");
  c.tap(6000); expect(c.tap(6500)).toBe("off");
});
test("scroll back becomes mouse-wheel bytes", () => {
  expect(text(wheelBytes(-2, 10, 5))).toBe("\x1b[<64;10;5M\x1b[<64;10;5M");
  expect(text(wheelBytes(1, 1, 1))).toBe("\x1b[<65;1;1M");
});
test("text size steps", () => {
  expect([nextFontSize(14, 1), nextFontSize(14, -1), nextFontSize(28, 1), nextFontSize(10, -1)]).toEqual([16, 12, 28, 10]);
});
```

- [ ] **Step 2: Run, expect FAIL.** `bun test web/test/unit/gestures.test.js`
- [ ] **Step 3: Implement** (track touches by `id`; the gesture's finger count is the most fingers down at once; compare against the positions at the first `down`).
- [ ] **Step 4: Run, expect PASS** (same command).
- [ ] **Step 5: Commit and push.**

```bash
git add web/src/lib/gestures.js web/test/unit/gestures.test.js && git commit -m "web: terminal gesture recogniser, remappable gesture map, Ctrl latch, wheel bytes" && git push
```

---

## Task B1: API client, sockets, machine links, fleet, native bridge

**Files:** Create `web/src/net/api.js`, `socket.js`, `machine.js`, `fleet.js`, `bridge.js`, `web/test/unit/net.test.js`, `web/test/unit/bridge.test.js`. Uses A1 (`outbox`), A2 (`reconnect`), A7 (`tree`, `inboxmodel`), A8 (`copy`).

**Interfaces** (behaviour fixed in "Rules every module follows"): `createApi({origin, fetch, timeoutMs, setTimeout})`; `openSocket({url, WebSocket, reconnector deps, onOpen, onMessage, onState, binaryType})` → `{send(data), nudge(), close()}` (uses `createReconnector`; `close()` stops reconnecting); `createMachine({name, origin, deviceId, deps})` → `{name, origin, state(), tree(), inbox(), api, subscribe(fn), onSendResult(fn) → off(), start(), stop(), nudge()}` (`deps` = `{fetch, WebSocket, setTimeout, clearTimeout, outbox}`, `outbox` being A1's `createOutbox(localStorage)`); `createFleet({machines, deviceId, deps})` → `{links(), machines() → machine[], machine(name) → machine | undefined, sidebar(open), inbox(), anyDown(), subscribe(fn), nudgeAll(), stop(), reportLink(name, state, retry?) → drop()}` (`deps` is passed through to every `createMachine`, `outbox` included); `createBridge(win)` → `{available, call(method, args), on(event, fn)}`. Every dependency (`fetch`, `WebSocket`, timers, `crypto.randomUUID`, `localStorage`) is passed in; `main.js` passes the real ones. **Held sends belong to B1 alone.** `machine.onSendResult(fn)` registers a listener and returns its unsubscribe function; each time the machine re-posts a held outbox entry (when its link goes up) it calls every listener with `{clientMsgId, sessionId, action}`, where `action = nextAction(entry, answer)` (A1) for hostd's answer to that re-post, or for the status-0 failure if the machine is still unreachable. The machine does not edit the outbox or any draft: the listener applies the action, including removing the outbox entry. The one real listener is D1's fleet-level one (it subscribes to every machine in `fleet.machines()`, see "Send flow" and D1), so a result is applied for any session, open or not; an entry whose result nobody was listening for stays `held` and is re-posted, with the same `clientMsgId`, at the next `"up"`.

**The `reportLink` contract** (the one D1 hands views as `ctx.reportLink`, see "How views meet without shared files"): `fleet.reportLink(name, state, retry?)` adds or updates one view link (`name` a `copy` label such as `copy.linkChat`, `state` `"connecting" | "up" | "down"`, `retry` the view socket's `nudge`) and returns `drop()`, which removes it. `links()` returns the machine links first, then the view links, each `{name, state, retry}`; `anyDown()` is true when any of them is not `"up"`; `nudgeAll()` also calls every view link's `retry`; every change notifies `subscribe` listeners. D1's strip reads only `links()`.

- [ ] **Step 1: Failing tests.** `web/test/unit/net.test.js`:

```js
import { expect, test } from "bun:test";
import { createApi } from "../../src/net/api.js";
import { createMachine } from "../../src/net/machine.js";
import { createFleet } from "../../src/net/fleet.js";
import { memoryStorage } from "../../src/lib/storage.js";
import { createOutbox } from "../../src/lib/outbox.js";

const O = "https://testdesk.example.ts.net";
function fakeFetch(answers) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); const a = answers.shift(); if (a instanceof Error) throw a; return new Response(JSON.stringify(a.body), { status: a.status, headers: { "Content-Type": "application/json" } }); };
  return { f, calls };
}

test("every request carries X-Porthole: 1, no cookies, no cache", async () => {
  const { f, calls } = fakeFetch([{ status: 200, body: { ok: 1 } }, { status: 200, body: {} }]);
  const api = createApi({ origin: O, fetch: f });
  await api.get("/v1/sessions"); await api.post("/v1/sessions/x/send", { text: "a", clientMsgId: "web-1" });
  for (const c of calls) {
    expect(new Headers(c.init.headers).get("X-Porthole")).toBe("1");
    expect([c.init.mode, c.init.credentials, c.init.cache]).toEqual(["cors", "omit", "no-store"]);
  }
  expect(new Headers(calls[1].init.headers).get("Content-Type")).toBe("application/json");
  expect(calls[0].url).toBe(O + "/v1/sessions");
});

test("network failure is status 0 with a plain sentence, never a throw", async () => {
  const { f } = fakeFetch([new TypeError("Failed to fetch")]);
  const r = await createApi({ origin: O, fetch: f }).get("/v1/sessions");
  expect(r.ok).toBe(false); expect(r.status).toBe(0); expect(r.error).not.toContain("fetch");
});

test("hostd's error text is passed through", async () => {
  const { f } = fakeFetch([{ status: 409, body: { error: "That session is read-only." } }]);
  expect(await createApi({ origin: O, fetch: f }).get("/v1/x")).toEqual({ ok: false, status: 409, error: "That session is read-only." });
});

class FakeWs { static all = []; constructor(url) { this.url = url; this.sent = []; FakeWs.all.push(this); } send(d) { this.sent.push(d); } close() { this.onclose?.({}); } }

test("machine link: device query, tree from the sessions push (no polling), ack every notify", async () => {
  FakeWs.all = [];
  const { f, calls } = fakeFetch(Array(4).fill(0).map(() => ({ status: 200, body: { items: [] } })));
  const timers = []; const m = createMachine({ name: "testdesk", origin: O, deviceId: "web-abc123def456", deps: { fetch: f, WebSocket: FakeWs, setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout() {}, outbox: createOutbox(memoryStorage()) } });
  m.start();
  const ws = FakeWs.all[0];
  expect(ws.url).toBe("wss://testdesk.example.ts.net/v1/events?device=web-abc123def456&since=0");
  ws.onopen?.({}); await Bun.sleep(0);
  expect(calls.map((c) => c.url.replace(O, ""))).toEqual(["/v1/inbox"]);
  const tree = { machine: "testdesk", sessions: [{ id: "tmux:t:main:0.0" }], sources: [], scannedAt: "2026-10-13T10:00:00Z" };
  ws.onmessage?.({ data: JSON.stringify({ type: "sessions", tree }) });
  expect(m.tree()).toEqual(tree);
  expect(timers).toEqual([]);
  ws.onmessage?.({ data: JSON.stringify({ type: "notify", id: 7, itemId: "i", title: "t", body: "b", options: [], at: "" }) });
  expect(ws.sent.map((d) => JSON.parse(d))).toEqual([{ type: "ack", id: 7 }]);
  ws.close(); expect(m.state()).toBe("down"); expect(timers.at(-1).ms).toBe(1000);
  timers.at(-1).fn(); FakeWs.all[1].onopen?.({}); await Bun.sleep(0);
  expect(FakeWs.all[1].url).toContain("since=7");
  expect(calls.length).toBe(2); expect(m.state()).toBe("up");
  expect(calls.some((c) => c.url.endsWith("/v1/sessions"))).toBe(false);
});

test("fleet: views report their own links; the strip sees them; drop removes them", () => {
  const fleet = createFleet({ machines: [], deviceId: "web-abc123def456", deps: { fetch: async () => new Response("{}"), WebSocket: FakeWs, setTimeout() {}, clearTimeout() {} } });
  let nudged = 0; let changes = 0; fleet.subscribe(() => changes++);
  const drop = fleet.reportLink("Terminal", "down", () => nudged++);
  expect(fleet.links()).toEqual([{ name: "Terminal", state: "down", retry: expect.any(Function) }]);
  expect(fleet.anyDown()).toBe(true);
  fleet.nudgeAll(); expect(nudged).toBe(1);
  fleet.reportLink("Terminal", "up"); expect(fleet.anyDown()).toBe(false);
  drop(); expect(fleet.links()).toEqual([]);
  expect(changes).toBe(3);
});

test("held sends: B1 is the only sender; every answer reaches onSendResult; a failed re-post stays held for the next up", async () => {
  FakeWs.all = [];
  const OTHER = "https://other.example.ts.net", SID = "tmux:t:main:0.0", URL1 = "/v1/sessions/tmux%3At%3Amain%3A0.0/send";
  const outbox = createOutbox(memoryStorage());
  outbox.put({ clientMsgId: "web-1", origin: O, sessionId: SID, text: "hello", status: "held", at: 1 });
  outbox.put({ clientMsgId: "web-2", origin: OTHER, sessionId: "s2", text: "elsewhere", status: "held", at: 2 });
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const posts = []; let sendFails = true;
  const f = async (url, init) => {
    if (!url.endsWith("/send")) return json(200, { items: [] });
    posts.push({ url: url.replace(O, ""), body: JSON.parse(init.body) });
    if (sendFails) throw new TypeError("Failed to fetch");
    return json(200, { status: "delivered" });
  };
  const timers = [];
  const m = createMachine({ name: "testdesk", origin: O, deviceId: "web-abc123def456", deps: { fetch: f, WebSocket: FakeWs, setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout() {}, outbox } });
  const got = [];
  // this listener plays D1's role (the real one is the fleet-level listener in main.js): it applies the action; B1 itself never edits the outbox
  const off = m.onSendResult((r) => { got.push(r); if (r.action.outbox === "remove") outbox.remove(r.clientMsgId); });

  // first "up": the machine is reachable for the socket but the re-post fails (status 0): the entry stays held
  m.start(); FakeWs.all[0].onopen?.({}); await Bun.sleep(10);
  expect(posts).toEqual([{ url: URL1, body: { text: "hello", clientMsgId: "web-1" } }]);
  expect(got).toEqual([{ clientMsgId: "web-1", sessionId: SID, action: { draft: "keep", outbox: "keep", show: "sendHeld", poll: false } }]);
  expect(outbox.get("web-1").status).toBe("held");

  // the link drops and comes back: the same entry is re-posted with the same clientMsgId and now delivers
  FakeWs.all[0].close(); sendFails = false; timers.at(-1).fn(); FakeWs.all[1].onopen?.({}); await Bun.sleep(10);
  expect(posts.length).toBe(2);
  expect(posts[1]).toEqual(posts[0]);
  expect(got[1]).toEqual({ clientMsgId: "web-1", sessionId: SID, action: { draft: "clear", outbox: "remove", show: null, poll: false } });
  expect(outbox.held(O)).toEqual([]);
  expect(outbox.held(OTHER).map((e) => e.clientMsgId)).toEqual(["web-2"]); // another machine's entry is never touched

  // after off(), B1 still sends held entries but nobody hears the result, so nothing applies the action
  off();
  outbox.put({ clientMsgId: "web-3", origin: O, sessionId: SID, text: "later", status: "held", at: 3 });
  FakeWs.all[1].close(); timers.at(-1).fn(); FakeWs.all[2].onopen?.({}); await Bun.sleep(10);
  expect(posts.length).toBe(3);
  expect(posts[2].body).toEqual({ text: "later", clientMsgId: "web-3" });
  expect(got.length).toBe(2);
  expect(outbox.get("web-3").status).toBe("held"); // B1 never edits the outbox: with no listener the entry stays held and is re-posted at the next up
});
```

`web/test/unit/bridge.test.js`:

```js
import { expect, test } from "bun:test";
import { createBridge } from "../../src/net/bridge.js";

test("in a plain browser every call resolves to null", async () => {
  const b = createBridge({});
  expect(b.available).toBe(false);
  expect(await b.call("speak", { text: "hi" })).toBeNull();
});
test("with PortholeNative: request/response by id, events by name, unknown methods refused", async () => {
  const sent = []; const native = { postMessage: (s) => sent.push(JSON.parse(s)), onmessage: null };
  const b = createBridge({ PortholeNative: native });
  const p = b.call("machines", {});
  native.onmessage({ data: JSON.stringify({ id: sent[0].id, ok: true, result: [{ name: "testdesk", origin: "https://testdesk.example.ts.net" }] }) });
  expect(await p).toEqual([{ name: "testdesk", origin: "https://testdesk.example.ts.net" }]);
  let seen = null; b.on("network", (d) => (seen = d));
  native.onmessage({ data: JSON.stringify({ event: "network", data: { online: true } }) });
  expect(seen).toEqual({ online: true });
  await expect(b.call("readFile", {})).rejects.toThrow("not allowed");
  expect(sent.length).toBe(1);
});
```

- [ ] **Step 2: Run, expect FAIL.** `bun test web/test/unit/net.test.js web/test/unit/bridge.test.js`
- [ ] **Step 3: Implement.** `machine.js` builds the events URL from `origin` (`https:` → `wss:`), keeps `lastNotifyId` in memory (the page's own queue; P2 replays unacked ones anyway), fetches `GET /v1/inbox` on each open, takes the session tree only from the `{type:"sessions", tree}` message hostd sends on every open and on every change (P1: `server/src/features/sessions.ts` lines 20-39; no polling), applies `{type:"inbox", items}`, and on `"up"` flushes `deps.outbox.held(origin)`: one entry at a time, in order, `POST /v1/sessions/<encodeURIComponent(sessionId)>/send` with `{text, clientMsgId}` (the entry's own id, so hostd answers a repeat from `sent.jsonl`), then calls each `onSendResult` listener with `{clientMsgId, sessionId, action: nextAction(entry, answer)}`. It never edits the outbox or drafts itself (the listener, D1's, applies `nextAction`), and it ignores entries for other origins. `fleet.js` creates one link per machine, returns every machine object from `machines()` (list order), keeps the view links from `reportLink`, calls `nudgeAll()` on `window` `online`, `visibilitychange` → visible and bridge `network`. Machine list: bridge `machines()` when `available`, else `porthole:machines`, else first-run discovery (`GET /v1/machine`, `GET /v1/config` → `peers`, each peer's `GET /v1/machine`).
- [ ] **Step 4: Run, expect PASS** (same command), then the whole unit suite: `bun run test:web`.
- [ ] **Step 5: Commit and push.**

```bash
git add web/src/net/api.js web/src/net/socket.js web/src/net/machine.js web/src/net/fleet.js web/src/net/bridge.js web/test/unit/net.test.js web/test/unit/bridge.test.js && git commit -m "web: API client, reconnecting machine links, fleet, native bridge adapter" && git push
```

## Task C1: Headless test stack (two test hostds, TLS proxy, throwaway Chromium, CDP)

**Files:** Create `web/test/e2e/tsproxy.ts`, `cdp.ts`, `browser.ts`, `stack.ts`, `readable.ts`, `web/test/e2e/smoke.test.ts`. Read `skill://verify-web-ui-headless-cdp` first and follow it where it differs from nothing below; never point anything at ports 9224 or 9225.

**Design.** The page must load from `https://<machine>.<tailnet>.ts.net` because hostd only accepts that origin shape (V3). So:
- `stack.ts` → `startStack({fixtures})`: a `Scratch`, two test hostds via `startTestHostd(s, FACTORIES, {origin, peers})` — testdesk (`origin: "https://testdesk.example.ts.net"`, `peers: ["https://testlaptop.example.ts.net"]`) and testlaptop (the mirror) — each with one pane per fixture on its own scratch tmux socket; `FACTORIES` is the exported production feature list from the merged P2 branch's `server/src/main.ts` (**GUESS** that P2 exports it; if not, C1 lists the factories by name from that file, including G1's `webFeature`). Returns a `Stack`. **This is the whole interface group D may use**; a D task that needs anything else asks the orchestrator, which adds it here (C1's files stay C1's):
  - **Fixture kinds** (strings in `fixtures.desk` / `fixtures.laptop`): `"<file>.jsonl"` → `ompPane(s, <file name without .jsonl>, <copy of web/test/fixtures/<file>>)`, the fake omp holding that transcript, with no live-inbox folder, so sends take the tmux route and come back `delivered` (P1 `server/test/deliver.test.ts` shows both routes); the `status-*.jsonl` fixtures are this kind. `"shell:<name>"` → `pane(s, <name>, "/bin/sh")` plus a second window (index 1, also `/bin/sh`) in the same tmux session, so the terminal tree has two windows and the gesture e2e has somewhere to go. `"repo:<name>"` → a scratch git repo `<scratch>/<name>` with one staged edit, one unstaged edit containing a 200-character line, and one new file, plus a plain `/bin/sh` pane whose cwd is that repo.
  - **Handles:** `desk`, `laptop` (the `TestHostd`s), `proxies: {desk, laptop}`, `chrome` (`{pid, port, profileDir, stop}`), `page` (the CDP page), `stop()` (idempotent).
  - **Helpers** (`m` is `"desk" | "laptop"`, `f` a fixture string as passed in): `chatUrl(m, f)`, `termUrl(m, f)`, `changesUrl(m, f)` → `https://test<m>.example.ts.net/` + A7's `href(...)` for that fixture's session; `sessionId(m, f)` → the id hostd reports for that fixture's pane; `killPane(m, f)` → `kill-pane` on that exact pane, on its scratch socket; `append(m, f, line)` → append one JSONL line to that fixture's transcript copy; `screen(m, f)` → the text of `GET /v1/sessions/:id/screen`; `tmuxFormat(m, f, format)` → `tmux display-message -p -t =<session> <format>` on that scratch socket (read-only, e.g. `"#{window_index}"`); `setLiveVoice(m, f, on)` → `Scratch.setLiveVoicePids(on ? [that omp's pid] : [])` (the fake `pactl`; never real live voice, SPEC 7), then waits until `GET /v1/sessions` reports `liveVoice === on` for that session; `emitQuestion(m, f, {qid, questions})` → writes a `question_open` line for that pane to the hostd's events socket at `config.runtimeDir/events.sock`, the way P2's own tests do; `api(m, path, init?)` → the parsed JSON of a request to that hostd through its proxy with `X-Porthole: 1`; `waitFor(fn, ms = 10000)` → polls an async predicate every 100 ms and throws with the last value on timeout.
  - **One more helper:** `emitEvent(m, f, event)` → writes any other omp extension event for that fixture's pane (`{type: "working"}`, `{type: "turn_finished"}`, `{type: "session_end"}`, with the pane's omp `pid` and the current time filled in) to the same events socket, exactly as `emitQuestion` does; D4 uses it to put cards in Working and Done without depending on what the status transcripts imply.
  - **Proxy controls** (`proxies.desk`, `proxies.laptop`): `drop(prefix)`, `block(prefix, on)`, `failNext(prefix)`, `count(prefix)`, `lastUpgradePath(prefix)`, `requests(prefix)` → every HTTP request seen on `prefix` as `{method, path, body}` (body parsed when it is JSON), oldest first.
- `tsproxy.ts` → `startProxy({target: TestHostd, cert, key})`: Bun TLS server on `127.0.0.1:0` standing in for `tailscale serve`. It forwards every request to the hostd adding `X-Porthole-Local: <token>` (the local-identity path, V3) and forwards WebSocket upgrades by opening a Bun `WebSocket` to hostd with the page's `Origin` plus that header, piping text and binary frames both ways. Test controls: `drop(prefix)` closes every open socket whose path starts with `prefix`; `block(prefix, on)` answers new upgrades on `prefix` with 503 while `on`; `failNext(prefix)` resets the next HTTP request on `prefix` (connection closed, no answer); `count(prefix)` = upgrades seen; `lastUpgradePath(prefix)` = the path and query of the newest upgrade on `prefix`; `requests(prefix)` as above.
- Certificate: `openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=porthole-test" -addext "subjectAltName=DNS:testdesk.example.ts.net,DNS:testlaptop.example.ts.net" -keyout <scratch>/key.pem -out <scratch>/cert.pem`, run with `Bun.spawnSync`.
- `browser.ts` → `startChrome({scratch, map})`: `chromium --headless=new --user-data-dir=<scratch>/chrome --remote-debugging-port=0 --no-first-run --no-default-browser-check --ignore-certificate-errors --host-resolver-rules="MAP testdesk.example.ts.net:443 127.0.0.1:<deskProxyPort>,MAP testlaptop.example.ts.net:443 127.0.0.1:<laptopProxyPort>" about:blank`; records the child PID; reads `<scratch>/chrome/DevToolsActivePort` for the port; returns `{pid, port, profileDir: "<scratch>/chrome", stop()}`; `stop()` kills that exact PID (SIGTERM, then SIGKILL after 3 s), awaits its exit, and touches nothing else.
- `cdp.ts` → `connectPage(port)`: one WebSocket to the first page target; `send(method, params)`, `on(event, fn)`, helpers `goto(url)`, `phone()` (`Emulation.setDeviceMetricsOverride {width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true}` + `Emulation.setTouchEmulationEnabled`), `wide()` (1280 × 800), `eval(expr)` (`Runtime.evaluate`, `awaitPromise`, `returnByValue`, throws on exception), `waitFor(expr, ms)`, `click(selector)`, `type(text)` (`Input.insertText`), `key(name)`, `reload()`, `onNewDocument(source)` (`Page.addScriptToEvaluateOnNewDocument`), `touch(type, points)` (`Input.dispatchTouchEvent`, `points` = `[{x, y, id}]`), `swipe({x, y, dx, dy, fingers = 1, ms = 200})` (`touchStart` with `fingers` points 60 px apart, 8 evenly spaced `touchMove`s over `ms`, `touchEnd`), `setFiles(selector, paths)` (`DOM.getDocument` → `DOM.querySelector` → `DOM.setFileInputFiles`), `shot(name)` (`Page.captureScreenshot` once into `web/test/.out/<name>.png`; a failure is logged and skipped, never retried).
- `readable.ts` → `readable(page, selector)`: evaluates in the page and returns the problems found (empty array = readable): element missing or `display:none`/zero size; document wider than the viewport (`documentElement.scrollWidth > innerWidth`); any text-bearing descendant with computed `font-size` < 14 px (12 px allowed only for `.meta` captions, which are never the only copy of a fact); any descendant whose content is clipped (`scrollWidth > clientWidth + 1` with `overflow: hidden`) unless it is inside `.table-scroll` or has `text-overflow: ellipsis` and a `title`; any interactive element smaller than 44 × 44 CSS px (the craft-floor minimum; 48 px is the design target, Needs Ben 4).

- [ ] **Step 1: Check the guesses.** `command -v chromium` (G-guess 2) and, in `smoke.test.ts`, the first assertion that `https://testdesk.example.ts.net/` loads through the mapped proxy (G-guess 1). If Chromium ignores the port in the rule (attempt 1 fails), attempt 2: start the proxies on fixed free ports and use `--host-resolver-rules="MAP *.example.ts.net 127.0.0.1"` plus the page URL `https://testdesk.example.ts.net:<port>/` with hostd's `origin` override set to the same `https://…:<port>` — **only if** `config.ts` accepts a port (V3 says it does not, so this fallback needs a test-only config override; if neither works, stop and report).
- [ ] **Step 2: Failing test** `web/test/e2e/smoke.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { startStack, type Stack } from "./stack";

// Read-only: every process whose command line carries this exact argument.
const withArg = (arg: string) => readdirSync("/proc").filter((d) => /^\d+$/.test(d)).filter((pid) => {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(arg); } catch { return false; }
});

let st: Stack;
beforeAll(async () => { st = await startStack({ fixtures: { desk: ["chat-p3.jsonl"], laptop: [] } }); });
afterAll(async () => { await st?.stop(); });

test("the page loads over the mapped TLS name with security headers", async () => {
  const r = await st.page.eval(`fetch("/").then(r => ({ s: r.status, csp: r.headers.get("content-security-policy"), n: r.headers.get("x-content-type-options") }))`);
  expect(r.s).toBe(200);
  expect(r.csp).toContain("script-src 'self'");
  expect(r.n).toBe("nosniff");
  expect(await st.page.eval("location.origin")).toBe("https://testdesk.example.ts.net");
});

test("an API call from the page reaches hostd with X-Porthole", async () => {
  const r = await st.page.eval(`fetch("/v1/sessions", { headers: { "X-Porthole": "1" } }).then(r => r.json())`);
  expect(r.machine).toBe("testdesk");
});

test("stop() ends the recorded Chromium and leaves nothing on its profile", async () => {
  const { pid, profileDir } = st.chrome;
  expect(pid).toBeGreaterThan(0);
  expect(withArg(`--user-data-dir=${profileDir}`)).toContain(String(pid));
  await st.stop();
  expect(existsSync(`/proc/${pid}`)).toBe(false);
  expect(withArg(`--user-data-dir=${profileDir}`)).toEqual([]);
});
```

- [ ] **Step 3: Run, expect FAIL** (modules missing): `bun test --timeout 120000 web/test/e2e/smoke.test.ts`
- [ ] **Step 4: Implement** the five modules. `stop()` order: CDP socket, Chromium (exact PID), proxies, hostds, scratch tmux servers (`Scratch` cleanup), scratch folder.
- [ ] **Step 5: Run, expect PASS** (same command). The last smoke test is the leftover check: it matches only the recorded Chromium PID and processes started with this run's own `--user-data-dir=<scratch>/chrome`, so another session's browser (or Ben's) can never match. No `pgrep -f` / `pkill` by pattern anywhere.
- [ ] **Step 6: Commit and push.**

```bash
git add web/test/e2e/tsproxy.ts web/test/e2e/cdp.ts web/test/e2e/browser.ts web/test/e2e/stack.ts web/test/e2e/readable.ts web/test/e2e/smoke.test.ts && git commit -m "web: headless test stack (test hostds, TLS proxy, throwaway Chromium over CDP)" && git push
```

---

Every D task below follows the same five steps, so they are written once here and each task lists only its files, behaviour and test:

1. Re-read `skill://impeccable/reference/craft-floor.md` and the wireframe for the screen above.
2. Write the task's e2e test file exactly as given, then send it to the **e2e queue** (see "Parallel groups"; never run it yourself) and expect it to fail: the queue runs `bun test --timeout 120000 web/test/e2e/<file>` and hands back the output.
3. Implement the view with `h()`/`mdom` only, strings only from `copy.js`, styles only from tokens.
4. Run the unit suite (`bun run test:web`) and `bun run typecheck:web` yourself (Bun only, safe in parallel); then queue the e2e file again and expect PASS (at most 2 failed queue runs, then stop and report).
5. Commit the listed files by name and push: `git add <listed files> && git commit -m "web: <screen>" && git push`.

## Task D1: Shell, drawer, reconnect strip

**Files:** `web/src/main.js`, `web/src/views/shell.js`, `web/src/views/sidebar.js`, `web/src/views/strip.js`, `web/styles/shell.css`, `web/test/e2e/drawer.test.ts`.

**Behaviour.** `main.js` boots: settings (the `ctx.settings` object defined under "How views meet without shared files": `get()` / `set(patch)` / `subscribe(fn)` over the one JSON object in `localStorage` `porthole:settings`; D1 is the only code that touches that key directly, and it re-notifies subscribers when another tab changes it, via the `storage` event) → bridge → device id (`porthole:device`, `"web-" + 12 random [a-z0-9]`) → machine list → fleet (with `deps.outbox = createOutbox(localStorage)`) → the app event bus `ctx.events` and the fleet-level send-result listener (next paragraph) → router; renders the shell (top bar, drawer, strip, `#view`) and lazy-loads the route's view, handing it `ctx` with `settings`, `events` and `reportLink` = `fleet.reportLink` (B1's contract); when a view unmounts, D1 calls the `drop()` of every link that view reported. Drawer per the wireframe and SPEC 4.2: Machines (name, dot + word, need-you count), Inbox (count), active sessions, Chats, **Terminals** as the tree from A7's `buildSidebar(...).terminals` (SPEC 4.2 item 4: tmux socket → session → window → pane, herdr workspace → tab → pane; one collapsible `role="group"` per level with its own status dot; tapping a pane row opens its terminal), Settings, Config (one per machine); pull-to-refresh on the list = `fleet.nudgeAll()` plus `GET /v1/sessions` on every machine that is up (SPEC 4.1: this forces a re-scan; the result arrives as the usual `sessions` push, B1). Opens from the menu button or a swipe from the left edge; closes on scrim, Esc, back (a `history.pushState` entry while open) or choosing a row; focus moves into it and returns to the menu button; `inert` on the page behind it. ≥ 840 px: permanent column, no scrim. Strip: when any entry of `fleet.links()` (the machine links **and** the links views reported) is `down` for more than 1 s, a strip under the top bar says `copy.reconnecting` with the names (machine name, or `copy.linkChat` / `copy.linkTerminal`) and a "Try now" button that calls their `retry` (`role="status"`); when all are up again it shows `copy.reconnected` for 2 s and slides away.

**Send results (fleet-level listener, owned by D1).** At boot `main.js` creates `drafts = createDrafts(localStorage)` and subscribes to `onSendResult` of every machine in `fleet.machines()`; on every `fleet.subscribe` notification it subscribes any machine it has not subscribed yet (machines added later), so no result is ever heard by nobody. For every `{clientMsgId, sessionId, action}` it receives, whatever session it belongs to and whether or not that chat is open, it reads the entry with `outbox.get(clientMsgId)` first and then applies `action`: `draft: "clear"` → `drafts.clear(origin, sessionId)` and `drafts.addSent(origin, sessionId, {clientMsgId, text, at, status: "delivered", reason: null})`; `outbox: "remove"` → `outbox.remove(clientMsgId)`; `outbox: "keep"` → the entry is left as it is (it is re-posted at the next `"up"`, and a `pending` answer is polled by the chat when it is opened, from the outbox). Then it emits the app event `ctx.events.emit("send-result", {clientMsgId, sessionId, action})`. A result for an entry the outbox no longer holds is ignored. Views never subscribe to `onSendResult`; D2 only listens to the `send-result` event (see D2).

Test hooks: each machine's tree is `[data-test=terminals][data-machine=<name>]`; every tree row carries `data-kind` (`socket`, `session`, `window`, `workspace`, `tab`, `pane`) and `data-label`; children sit in a `role="group"` element directly under their row's element; pane rows also carry `data-id` (the session id).

```ts
// web/test/e2e/drawer.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readable } from "./readable";
import { startStack, type Stack } from "./stack";

let st: Stack;
beforeAll(async () => { st = await startStack({ fixtures: { desk: ["chat-p3.jsonl", "status-needs-you.jsonl", "shell:term-p3"], laptop: ["status-working.jsonl"] } }); await st.page.phone(); await st.page.goto("https://testdesk.example.ts.net/#/inbox"); });
afterAll(async () => { await st?.stop(); });

test("P3-1: the drawer is readable at 412 px and lists both machines and the groups", async () => {
  await st.page.click("[data-test=menu]");
  await st.page.waitFor(`document.querySelector("[data-test=drawer]")?.getAttribute("aria-hidden") === "false"`, 5000);
  expect(await readable(st.page, "[data-test=drawer]")).toEqual([]);
  const text = await st.page.eval(`document.querySelector("[data-test=drawer]").innerText`);
  for (const s of ["testdesk", "testlaptop", "Inbox", "Chats", "Terminals", "Settings", "Config", "1 needs you"]) expect(text).toContain(s);
  await st.page.shot("p3-1-drawer");
});

test("Terminals is a tree: socket → session → window → pane (SPEC 4.2)", async () => {
  const tree = await st.page.eval(`(() => {
    const t = document.querySelector("[data-test=terminals][data-machine=testdesk]");
    const kids = (el, kind) => [...el.querySelectorAll(":scope > [role=group] > [data-kind=" + kind + "], :scope > [data-kind=" + kind + "]")];
    return kids(t, "socket").map((so) => ({ socket: kids(so, "session").map((se) => ({ [se.dataset.label]: kids(se, "window").map((w) => [w.dataset.label, kids(w, "pane").length]) })) }));
  })()`);
  expect(tree.length).toBe(1);
  expect(tree[0].socket.find((x: Record<string, unknown>) => "term-p3" in x)).toEqual({ "term-p3": [["Window 0", 1], ["Window 1", 1]] });
  await st.page.click(`[data-test=terminals][data-machine=testdesk] [data-kind=pane][data-id="${st.sessionId("desk", "shell:term-p3")}"]`);
  await st.page.waitFor(`location.hash.startsWith("#/term/testdesk/")`, 5000);
  await st.page.click("[data-test=menu]");
  await st.page.waitFor(`document.querySelector("[data-test=drawer]")?.getAttribute("aria-hidden") === "false"`, 5000);
});

test("Esc closes the drawer and returns focus to the menu button", async () => {
  await st.page.key("Escape");
  expect(await st.page.eval(`document.activeElement?.dataset.test`)).toBe("menu");
});

test("P3-3a: cutting the events socket shows Reconnecting… and recovers by itself", async () => {
  st.proxies.desk.block("/v1/events", true); st.proxies.desk.drop("/v1/events");
  await st.page.waitFor(`document.querySelector("[data-test=strip]")?.innerText.includes("Reconnecting…")`, 5000);
  await st.page.shot("p3-3-reconnecting");
  st.proxies.desk.block("/v1/events", false);
  await st.page.waitFor(`!document.querySelector("[data-test=strip]")?.innerText.includes("Reconnecting…")`, 20000);
  expect(st.proxies.desk.count("/v1/events")).toBeGreaterThanOrEqual(2);
});
```

## Task D2: Chat, composer, key row

**Files:** `web/src/dom/mdom.js`, `web/src/views/chat.js`, `web/src/views/composer.js`, `web/src/views/keyrow.js`, `web/styles/chat.css`, `web/test/e2e/chat.test.ts`.

**Behaviour.** Chat WS (`/v1/sessions/:id/chat`) through `openSocket`, its state reported with `ctx.reportLink(copy.linkChat, state, nudge)`; backlog then appends via `chatmodel`; "Show earlier" uses `GET …/chat?before=`. Ben's bubbles right on `--mine`; assistant bubbles via `toTree` → `mdom`; `via:"live-voice"` bubbles carry a mic mark and "Said at the desk"; `kind:"tools"` collapsed to `toolSummary` in a `<details>`. Stays scrolled to the bottom unless Ben scrolled up ("New messages ↓" pill). Composer: auto-growing textarea, draft saved on every `input` (A1), restored on mount, Send (≥ 48 px) disabled when empty, Enter = newline on phone and Ctrl+Enter sends on wide. **Attachments (SPEC 4.8):** the attach button opens a menu with "Take a photo" (`<input type=file accept="image/*" capture="environment">`), "Choose a photo" (`accept="image/*"`) and "Choose a file" (any type); in the Android app each item calls bridge `pickFile({source: "camera" | "photo" | "file"})` instead. Pasting an image into the textarea (a `paste` event whose `clipboardData` holds an `image/*` file; plain text pastes are left alone) uploads it the same way. Each file → `POST /v1/uploads` → `{path}` → the **full path** is inserted into the textarea at the cursor on its own line (no `@` or other marker; the message carries the path as text) and listed in the draft's `files` as a chip; removing a chip removes its line. Text sent = the textarea text as it is. Send flow, statuses and messages exactly per "Send flow". The composer posts a send itself only while the machine link is up; if the link is down, or its own `POST` answers status 0, it leaves the outbox entry `held`, shows `sendHeld` and does nothing more: **it never re-sends a held entry, B1 is the only sender.** For answers to its own `POST` the composer applies the action itself (draft clear, `addSent`, `outbox.remove`, status line). **It never subscribes to `onSendResult`:** results of B1's re-posts are applied by D1's fleet-level listener for every session (draft clear, `addSent`, `outbox.remove`), which then emits the app event `send-result`. On mount the composer subscribes with `ctx.events.on("send-result", fn)` and unsubscribes on unmount; for an event whose `sessionId` is this chat's session it only refreshes what is on screen: it reloads the textarea and the sent list from `drafts` (already cleared and updated by D1), sets the status line from `action.show` (`sendHeld`, `pendingTitle`, or `sendFailedTitle` alone, since a re-post result carries no hostd reason and "Try again" re-sends the kept draft with the same `clientMsgId`), and starts the 3 s poll when `action.poll` is true. Events for other sessions are ignored, and the composer writes no draft, sent-history or outbox change for them. **Sent history (SPEC 4.5):** a "Sent messages" button on the composer opens a sheet listing `drafts.sent(origin, sessionId)` (A1, the newest 50 for this session) newest first, each with its time, status word, "Copy" (`navigator.clipboard.writeText`) and "Put back in the box" (replaces the textarea text and saves the draft). **Key row (SPEC 4.3):** `chatKeyRow(shortcuts)` from A3: Esc, ↑, ↓, Enter, Tab, Stop, then this machine's shortcuts from `GET /v1/shortcuts` (minus any with a `C-c` or `prefix` step), each press `POST /v1/sessions/:id/keys` with `{keys: steps}` (Stop = `{keys: ["Esc"]}`). There is no Ctrl+C button in the chat view. When the session's `liveVoice` is true (from the `sessions` push), every key-row button is `disabled` and the row shows `copy.liveVoiceKeys` under it; when it turns false the buttons come back.

Test hooks: key row `[data-test=keyrow]`, each button `data-key` (`Esc`, `Up`, `Down`, `Enter`, `Tab`, `Stop`, or the shortcut's name), the live-voice line `[data-test=keyrow-note]`; sent history `[data-test=sent-open]`, sheet `[data-test=sent]`, rows `[data-test=sent-item]` with `[data-test=sent-copy]` and `[data-test=sent-putback]`; attach button `[data-test=attach]`, inputs `[data-test=attach-camera]`, `[data-test=attach-photo]`, `[data-test=attach-file]` (present in the DOM, visually hidden, labelled by their menu items), chips `[data-test=attach-chip]`.

```ts
// web/test/e2e/chat.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { readable } from "./readable";
import { startStack, type Stack } from "./stack";

const CLIP = `window.__copied = []; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { window.__copied.push(t); }, readText: async () => "" } });`;
const box = `document.querySelector("[data-test=composer] textarea")`;
const keyRow = `[...document.querySelectorAll("[data-test=keyrow] button")]`;

let st: Stack; let url: string;
beforeAll(async () => {
  st = await startStack({ fixtures: { desk: ["chat-p3.jsonl"], laptop: [] } });
  await st.page.onNewDocument(CLIP);
  await st.page.phone();
  url = st.chatUrl("desk", "chat-p3.jsonl");
  await st.page.goto(url);
  await st.page.waitFor(`document.querySelectorAll("[data-test=bubble]").length >= 4`, 10000);
});
afterAll(async () => { await st?.stop(); });

test("P3-1: user, table, live-delegation and collapsed tools are readable at 412 px", async () => {
  expect(await readable(st.page, "[data-test=chat]")).toEqual([]);
  expect(await st.page.eval(`!!document.querySelector("[data-test=chat] .table-scroll table")`)).toBe(true);
  expect(await st.page.eval(`document.querySelector("[data-via=live-voice]")?.innerText`)).toContain("Also check the tests");
  expect(await st.page.eval(`[...document.querySelectorAll("[data-test=chat] details")].map(d => [d.open, d.querySelector("summary").innerText])`)).toEqual([[false, "Used 2 tools: read, grep"]]);
  expect(await st.page.eval(`document.querySelectorAll("[data-test=chat] script, [data-test=chat] [onerror]").length`)).toBe(0);
  await st.page.shot("p3-1-chat");
});

test("key row: Esc ↑ ↓ Enter Tab Stop, Stop sends Esc, no Ctrl+C anywhere in the chat view", async () => {
  expect(await st.page.eval(`${keyRow}.slice(0, 6).map(b => b.innerText.trim())`)).toEqual(["Esc", "↑", "↓", "Enter", "Tab", "Stop"]);
  expect(await st.page.eval(`[...document.querySelectorAll("#view button")].filter(b => /ctrl\\s*\\+?\\s*c/i.test(b.innerText) || b.dataset.key === "C-c").length`)).toBe(0);
  await st.page.click(`[data-test=keyrow] [data-key=Stop]`);
  await st.waitFor(async () => st.proxies.desk.requests("/v1/sessions/").some((r) => r.method === "POST" && r.path.endsWith("/keys")));
  const keys = st.proxies.desk.requests("/v1/sessions/").filter((r) => r.method === "POST" && r.path.endsWith("/keys"));
  expect(keys.at(-1).body).toEqual({ keys: ["Esc"] });
  expect(keys.at(-1).path).toContain(encodeURIComponent(st.sessionId("desk", "chat-p3.jsonl")));
});

test("live voice at the desk: the key row is disabled and says why, then comes back", async () => {
  await st.setLiveVoice("desk", "chat-p3.jsonl", true);
  await st.page.waitFor(`${keyRow}.every(b => b.disabled)`, 15000);
  expect(await st.page.eval(`document.querySelector("[data-test=keyrow-note]").innerText`)).toBe("Live voice is on at the desk: keys go to the live panel (Space mutes, Esc ends it)");
  expect(await readable(st.page, "[data-test=keyrow]")).toEqual([]);
  await st.page.shot("p3-live-voice-keys");
  await st.setLiveVoice("desk", "chat-p3.jsonl", false);
  await st.page.waitFor(`${keyRow}.every(b => !b.disabled) && !document.querySelector("[data-test=keyrow-note]")`, 15000);
});

test("P3-2d: a send made while the machine is unreachable is held, then B1 sends it exactly once on reconnect and D1's fleet-level send-result listener applies the result", async () => {
  const sends = () => st.proxies.desk.requests("/v1/sessions/").filter((r) => r.method === "POST" && r.path.endsWith("/send"));
  const before = sends().length;
  st.proxies.desk.block("/v1/events", true); st.proxies.desk.drop("/v1/events");
  await st.page.waitFor(`document.querySelector("[data-test=strip]")?.innerText.includes("Reconnecting…")`, 5000);
  await st.page.click("[data-test=composer] textarea"); await st.page.type("held until the link is back");
  await st.page.click("[data-test=send]");
  await st.page.waitFor(`document.querySelector("[data-test=send-status]")?.innerText.includes("Not sent yet")`, 5000);
  expect(sends().length).toBe(before);
  st.proxies.desk.block("/v1/events", false);
  await st.waitFor(async () => sends().length === before + 1, 20000);
  await st.page.waitFor(`${box}.value === ""`, 10000);
  await st.page.waitFor(`!document.querySelector("[data-test=send-status]")?.innerText.includes("Not sent yet")`, 5000);
  await Bun.sleep(1500);
  expect(sends().length).toBe(before + 1);
  expect(sends().at(-1).body.text).toBe("held until the link is back");
  // the sent-history entry exists only because D1's fleet-level listener applied B1's onSendResult action (`addSent`); P3-2e proves the same with the chat closed
  expect(await st.page.eval(`Object.keys(localStorage).filter((k) => k.startsWith("porthole:sent:")).flatMap((k) => JSON.parse(localStorage.getItem(k))).filter((i) => i.text === "held until the link is back").map((i) => i.status)`)).toEqual(["delivered"]);
});

test("sent history: the held send that B1 delivered (recorded by D1's fleet-level listener) can be reopened, copied and put back", async () => {
  await st.page.click("[data-test=sent-open]");
  await st.page.waitFor(`document.querySelectorAll("[data-test=sent-item]").length >= 1`, 5000);
  expect(await readable(st.page, "[data-test=sent]")).toEqual([]);
  expect(await st.page.eval(`document.querySelector("[data-test=sent-item]").innerText`)).toContain("held until the link is back");
  await st.page.click("[data-test=sent-item] [data-test=sent-copy]");
  expect(await st.page.eval("window.__copied")).toEqual(["held until the link is back"]);
  await st.page.click("[data-test=sent-item] [data-test=sent-putback]");
  await st.page.waitFor(`${box}.value === "held until the link is back"`, 5000);
  await st.page.eval(`(() => { const t = ${box}; t.value = ""; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
});

test("P3-2e: a send held while the chat is closed is still delivered once, clears the draft and lands in the sent history", async () => {
  const sends = () => st.proxies.desk.requests("/v1/sessions/").filter((r) => r.method === "POST" && r.path.endsWith("/send"));
  const TEXT = "sent from the inbox side";
  const chatHash = new URL(url).hash;
  const before = sends().length;
  st.proxies.desk.block("/v1/events", true); st.proxies.desk.drop("/v1/events");
  await st.page.waitFor(`document.querySelector("[data-test=strip]")?.innerText.includes("Reconnecting…")`, 5000);
  await st.page.click("[data-test=composer] textarea"); await st.page.type(TEXT);
  await st.page.click("[data-test=send]");
  await st.page.waitFor(`document.querySelector("[data-test=send-status]")?.innerText.includes("Not sent yet")`, 5000);
  expect(sends().length).toBe(before);
  // leave the chat: no composer is mounted, so nothing view-level can hear the result
  await st.page.eval(`location.hash = "#/inbox"`);
  await st.page.waitFor(`!document.querySelector("[data-test=composer]")`, 5000);
  st.proxies.desk.block("/v1/events", false);
  await st.waitFor(async () => sends().length === before + 1, 20000);
  const sentTexts = `Object.keys(localStorage).filter((k) => k.startsWith("porthole:sent:")).flatMap((k) => JSON.parse(localStorage.getItem(k))).filter((i) => i.text === ${JSON.stringify(TEXT)}).map((i) => i.status)`;
  const draftTexts = `Object.keys(localStorage).filter((k) => k.startsWith("porthole:draft:")).flatMap((k) => { const d = JSON.parse(localStorage.getItem(k)); return d && d.text ? [d.text] : []; })`;
  // still on the inbox: D1's listener has already cleared the draft and recorded the message
  await st.page.waitFor(`${sentTexts}.length === 1`, 10000);
  expect(await st.page.eval(sentTexts)).toEqual(["delivered"]);
  expect(await st.page.eval(draftTexts)).toEqual([]);
  await Bun.sleep(1500);
  expect(sends().length).toBe(before + 1);
  expect(sends().at(-1).body.text).toBe(TEXT);
  // reopen the chat: the draft is empty and the sent history holds the message
  await st.page.eval(`location.hash = ${JSON.stringify(chatHash)}`);
  await st.page.waitFor(`document.querySelector("[data-test=composer] textarea")`, 10000);
  expect(await st.page.eval(`${box}.value`)).toBe("");
  await st.page.click("[data-test=sent-open]");
  await st.page.waitFor(`[...document.querySelectorAll("[data-test=sent-item]")].some((i) => i.innerText.includes(${JSON.stringify(TEXT)}))`, 5000);
  expect(sends().length).toBe(before + 1);
  // remount the chat so the sheet is closed for the tests that follow
  await st.page.eval(`location.hash = "#/inbox"`);
  await st.page.waitFor(`!document.querySelector("[data-test=composer]")`, 5000);
  await st.page.eval(`location.hash = ${JSON.stringify(chatHash)}`);
  await st.page.waitFor(`document.querySelector("[data-test=composer] textarea")`, 10000);
});

test("attachments: a chosen file and a pasted image each put their full uploaded path in the message", async () => {
  expect(await st.page.eval(`(() => { const c = document.querySelector("[data-test=attach-camera]"), p = document.querySelector("[data-test=attach-photo]"); return [c.accept, c.getAttribute("capture"), p.accept]; })()`)).toEqual(["image/*", "environment", "image/*"]);
  await st.page.click("[data-test=attach]");
  await st.page.setFiles("[data-test=attach-file]", [path.join(import.meta.dir, "..", "fixtures", "chat-p3.jsonl")]);
  await st.page.waitFor(`${box}.value.trim().split("\\n").length === 1`, 10000);
  await st.page.eval(`(() => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "shot.png", { type: "image/png" })); ${box}.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
  await st.page.waitFor(`${box}.value.trim().split("\\n").length === 2`, 10000);
  const lines: string[] = (await st.page.eval(`${box}.value`)).trim().split("\n");
  expect(st.proxies.desk.requests("/v1/uploads").filter((r) => r.method === "POST").length).toBe(2);
  for (const l of lines) { expect(l.startsWith("/")).toBe(true); expect(existsSync(l)).toBe(true); }
  expect(lines[1].endsWith(".png")).toBe(true);
  expect(await st.page.eval(`document.querySelectorAll("[data-test=attach-chip]").length`)).toBe(2);
  await st.page.click("[data-test=send]");
  await st.page.waitFor(`${box}.value === ""`, 10000);
  const sent = st.proxies.desk.requests("/v1/sessions/").filter((r) => r.method === "POST" && r.path.endsWith("/send")).at(-1);
  expect(sent.body.text.trim().split("\n")).toEqual(lines);
});

test("P3-2a: reloading mid-draft keeps the draft", async () => {
  await st.page.click("[data-test=composer] textarea");
  await st.page.type("half a thought about the plan");
  await st.page.reload();
  await st.page.waitFor(`document.querySelector("[data-test=composer] textarea")?.value === "half a thought about the plan"`, 10000);
});

test("P3-2b: a send that cannot reach the machine keeps the draft and says why", async () => {
  st.proxies.desk.failNext("/v1/sessions/");
  await st.page.click("[data-test=send]");
  await st.page.waitFor(`document.querySelector("[data-test=send-status]")?.innerText.includes("Not sent yet")`, 10000);
  expect(await st.page.eval(`document.querySelector("[data-test=composer] textarea").value`)).toBe("half a thought about the plan");
});

test("P3-2c: a send hostd refuses or fails keeps the draft and shows hostd's reason", async () => {
  await st.killPane("desk", "chat-p3.jsonl");
  await st.page.click("[data-test=send]");
  await st.page.waitFor(`document.querySelector("[data-test=send-status]")?.innerText.includes("Couldn't send")`, 15000);
  const why = await st.page.eval(`document.querySelector("[data-test=send-reason]").innerText`);
  expect(why.length).toBeGreaterThan(0);
  expect(await st.page.eval(`document.querySelector("[data-test=composer] textarea").value`)).toBe("half a thought about the plan");
  await st.page.shot("p3-2-send-failed");
});
```

## Task D3: Terminal, toolbar, gestures, shortcuts

**Files:** `web/src/views/terminal.js`, `web/styles/terminal.css`, `web/test/e2e/terminal.test.ts`.

**Behaviour.** xterm 6.0.0 + fit addon imported from `/vendor/…/lib/*.mjs`; theme from tokens; font size from `ctx.settings.get().termFontPx` (default 14; the view subscribes with `ctx.settings.subscribe` and unsubscribes on unmount, so a change made in Settings applies without a reload; D3 never reads or writes `localStorage` `porthole:settings` itself). PTY socket `/v1/sessions/:id/pty?cols=&rows=` through `openSocket` with `binaryType = "arraybuffer"`, its state reported with `ctx.reportLink(copy.linkTerminal, state, nudge)`; output → `term.write`, `term.onData` → `ctrl.apply(data)` (A9 Ctrl latch) → binary frame; fit on `ResizeObserver` → `{type:"resize"}`; `{type:"readonly", reason}` → banner + input disabled; `{type:"screen", text}` → render text (herdr). On reconnect the same session is re-attached (same URL) and the screen is cleared before the new attach's first frame. **Toolbar (SPEC 4.4):** Esc, Tab, Ctrl, ↑, ↓, ←, →, Paste, Keyboard toggle, "Smaller text" / "Bigger text" (`nextFontSize`, saved with `ctx.settings.set({termFontPx})`, then refit), and "Shortcuts", which opens a panel listing this machine's saved shortcuts (`GET /v1/shortcuts`, all of them, `prefix` and `C-c` included) as large buttons; a tapped shortcut sends `stepBytes(step, ctx.settings.get().tmuxPrefix)` for each step in order. Ctrl is `createCtrlLatch()`: one tap = the next key is a control key, a double tap locks it until tapped again; the button shows the state (`aria-pressed`, the words "Ctrl locked" when locked, never colour alone). **Gestures (SPEC 4.4)** on the terminal area: touch events → `createRecognizer()` → `gestureAction(gesture, mergeGestureMap(ctx.settings.get().gestures))` → `navPlan(action, session kind)`: `{steps}` → `stepBytes` with `ctx.settings.get().tmuxPrefix` (tmux windows and panes change in tmux itself, so the desk sees it too); `{navigate: {level, dir}}` → open `neighbour(sidebar.terminals, id, level, dir)` (A7) when there is one, else nothing; `{local: "text-bigger" | "text-smaller"}` → font step; `{local: "paste"}` → `navigator.clipboard.readText()` (or the bridge) into the terminal; drag → `wheelBytes(-round(dy / cellHeight), col, row)` for tmux sessions (`term.scrollLines` for herdr text). `touch-action: none` on the terminal area keeps the browser from scrolling or zooming the page. CSP check: load first with the G1 header as built; if the terminal renders unstyled, the static route keeps `'unsafe-inline'` for styles (already in G1's header) and this task reports which was needed.

Test hooks: `[data-test=terminal]` carries `data-state` (link state) and `data-font-px`; toolbar `[data-test=toolbar]`, keys `data-key` (`Esc`, `Tab`, `Ctrl`, `Up`, `Down`, `Left`, `Right`, `Paste`, `Keyboard`, `Smaller`, `Bigger`, `Shortcuts`); the Ctrl button's `data-latch` is `off | once | locked`; panel `[data-test=shortcut-panel]`.

```ts
// web/test/e2e/terminal.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readable } from "./readable";
import { startStack, type Stack } from "./stack";

let st: Stack;
beforeAll(async () => {
  st = await startStack({ fixtures: { desk: ["shell:term-p3"], laptop: [] } });
  await st.page.phone();
  await st.page.goto(st.termUrl("desk", "shell:term-p3"));
  await st.page.waitFor(`!!document.querySelector("[data-test=terminal] .xterm-screen")`, 10000);
});
afterAll(async () => { await st?.stop(); });

const screen = () => st.screen("desk", "shell:term-p3"); // GET /v1/sessions/:id/screen text

test("typing reaches the session and the toolbar is readable", async () => {
  await st.page.click("[data-test=terminal]"); await st.page.type("echo p3-one\r");
  await st.waitFor(async () => (await screen()).includes("p3-one"));
  expect(await readable(st.page, "[data-test=toolbar]")).toEqual([]);
});

test("Ctrl: one tap makes the next key a control key; a double tap locks it", async () => {
  await st.page.type("sleep 30"); await st.page.click("[data-key=Ctrl]");
  expect(await st.page.eval(`document.querySelector("[data-key=Ctrl]").dataset.latch`)).toBe("once");
  await st.page.type("c");
  expect(await st.page.eval(`document.querySelector("[data-key=Ctrl]").dataset.latch`)).toBe("off");
  await st.page.type("echo p3-after-ctrl-c\r");
  await st.waitFor(async () => (await screen()).includes("p3-after-ctrl-c"));
  await st.page.click("[data-key=Ctrl]"); await st.page.click("[data-key=Ctrl]");
  expect(await st.page.eval(`document.querySelector("[data-key=Ctrl]").dataset.latch`)).toBe("locked");
  expect(await st.page.eval(`document.querySelector("[data-key=Ctrl]").innerText`)).toContain("Ctrl locked");
  await st.page.click("[data-key=Ctrl]");
  expect(await st.page.eval(`document.querySelector("[data-key=Ctrl]").dataset.latch`)).toBe("off");
});

test("text size −/+ and the shortcut panel", async () => {
  expect(await st.page.eval(`document.querySelector("[data-test=terminal]").dataset.fontPx`)).toBe("14");
  await st.page.click("[data-key=Bigger]");
  await st.page.waitFor(`document.querySelector("[data-test=terminal]").dataset.fontPx === "16"`, 3000);
  await st.page.click("[data-key=Smaller]");
  await st.page.waitFor(`document.querySelector("[data-test=terminal]").dataset.fontPx === "14"`, 3000);
  await st.page.click("[data-key=Shortcuts]");
  await st.page.waitFor(`!!document.querySelector("[data-test=shortcut-panel]")`, 3000);
  expect(await readable(st.page, "[data-test=shortcut-panel]")).toEqual([]);
  await st.page.key("Escape");
});

test("one-finger swipe left/right moves the tmux window (the desk sees the same window)", async () => {
  expect(await st.tmuxFormat("desk", "shell:term-p3", "#{window_index}")).toBe("0");
  await st.page.swipe({ x: 320, y: 450, dx: -220, dy: 0 });
  await st.waitFor(async () => (await st.tmuxFormat("desk", "shell:term-p3", "#{window_index}")) === "1");
  await st.page.swipe({ x: 100, y: 450, dx: 220, dy: 0 });
  await st.waitFor(async () => (await st.tmuxFormat("desk", "shell:term-p3", "#{window_index}")) === "0");
});

test("P3-3b: after the connection is cut the terminal re-attaches to the same session", async () => {
  const before = st.proxies.desk.count("/v1/sessions/");
  st.proxies.desk.block("/v1/sessions/", true); st.proxies.desk.drop("/v1/sessions/");
  await st.page.waitFor(`document.querySelector("[data-test=strip]")?.innerText.includes("Reconnecting…")`, 5000);
  st.proxies.desk.block("/v1/sessions/", false);
  await st.page.waitFor(`document.querySelector("[data-test=terminal]")?.dataset.state === "up"`, 20000);
  expect(st.proxies.desk.count("/v1/sessions/")).toBeGreaterThan(before);
  expect(st.proxies.desk.lastUpgradePath("/v1/sessions/")).toContain(encodeURIComponent(st.sessionId("desk", "shell:term-p3")));
  await st.page.click("[data-test=terminal]"); await st.page.type("echo p3-reattached\r");
  await st.waitFor(async () => (await screen()).includes("p3-reattached"));
  await st.page.shot("p3-3-terminal-reattached");
});
```

## Task D4: Inbox

**Files:** `web/src/views/inbox.js`, `web/styles/inbox.css`, `web/test/e2e/inbox.test.ts`.

**Behaviour.** Three sections (Needs you / Working / Done) from `groupInbox` across machines; inside each section the cards are **grouped by project folder, then by machine** (SPEC 4.6: a project heading, then a machine sub-heading, then that machine's cards). Each card: title, body (first 3 lines, "More" expands), age, and the context-left ring from `contextRing(item)` (A7): a small ring with the percent as text next to it; when `warn` (below 15 %) the ring and its text use `--warn` **and** the text reads "12 % context left" with a warning shape, so colour is never the only signal; no ring when `contextLeft` is null. `answerMode` `buttons` → one button per option (≥ 48 px, full width on phone) → `POST /v1/inbox/:id/answer {optionIndexes: [i]}`, a free-text "Other answer" field → `{text}`; `terminal` → `copy.answerInTerminal` with an "Open terminal" button. **Stop** (SPEC 4.6): every Needs-you and Working card has a "Stop" button that sends `POST /v1/sessions/:sessionId/keys {keys: ["Esc"]}` to that item's machine (P2: Stop is not an inbox route; hostd refuses it for live voice and the card shows hostd's reason). **Archive:** every card, in any section, can be swiped left (≥ 80 px, mostly horizontal; the card follows the finger and snaps back below the threshold) to archive it, and also has an "Archive" button for people who do not swipe; both call `POST /v1/inbox/:id/archive` (P2 accepts any item) and remove the card when hostd answers `{archived: true}`. "Archived" link opens `GET /v1/inbox/archive`. Empty: `copy.inboxEmpty`. Live updates from the events socket's `{type:"inbox"}`.

Test hooks: sections `[data-test=section-needs-you]`, `[data-test=section-working]`, `[data-test=section-done]`; cards `[data-test=inbox-card]` with `data-column`, `data-machine`, `data-item`; project groups `[data-test=inbox-group]` with `data-project`, holding machine blocks `[data-test=inbox-machine]` with `data-machine`; buttons `[data-action=stop]`, `[data-action=archive]`; the ring `[data-test=context-ring]` with `data-warn`.

```ts
// web/test/e2e/inbox.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readable } from "./readable";
import { startStack, type Stack } from "./stack";

let st: Stack;
beforeAll(async () => {
  st = await startStack({ fixtures: { desk: ["status-needs-you.jsonl", "status-done.jsonl"], laptop: ["status-working.jsonl", "status-done.jsonl"] } });
  await st.emitQuestion("desk", "status-needs-you.jsonl", { qid: "q-p3", questions: [{ id: "q1", question: "Which plan should I use?", options: ["Small", "Large"], multi: false }] });
  await st.emitEvent("laptop", "status-working.jsonl", { type: "working" });
  await st.emitEvent("desk", "status-done.jsonl", { type: "turn_finished" });
  await st.emitEvent("laptop", "status-done.jsonl", { type: "turn_finished" });
  await st.page.phone(); await st.page.goto("https://testdesk.example.ts.net/#/inbox");
  await st.page.waitFor(`document.querySelectorAll("[data-test=inbox-card]").length >= 4`, 10000);
});
afterAll(async () => { await st?.stop(); });

test("P3-1: the inbox is readable at 412 px with both machines' items", async () => {
  expect(await readable(st.page, "[data-test=inbox]")).toEqual([]);
  const t = await st.page.eval(`document.querySelector("[data-test=inbox]").innerText`);
  for (const s of ["Needs you", "Working", "Done", "Which plan should I use?", "testlaptop"]) expect(t).toContain(s);
  await st.page.shot("p3-1-inbox");
});

test("an option button answers through hostd", async () => {
  await st.page.click("[data-test=inbox-card] [data-option='1']");
  await st.page.waitFor(`document.querySelector("[data-test=inbox-card]")?.innerText.includes("Answered: Large")`, 10000);
});

test("cards are grouped by project, then machine", async () => {
  const shape = await st.page.eval(`[...document.querySelectorAll("[data-test=inbox-card]")].map(c => [!!c.closest("[data-test=inbox-group]"), c.closest("[data-test=inbox-machine]")?.dataset.machine === c.dataset.machine])`);
  expect(shape.length).toBeGreaterThanOrEqual(4);
  for (const s of shape) expect(s).toEqual([true, true]);
  const done = await st.page.eval(`[...document.querySelectorAll("[data-test=section-done] [data-test=inbox-machine]")].map(m => m.dataset.machine).sort()`);
  expect(done).toEqual(["testdesk", "testlaptop"]);
});

test("Stop on a working card sends Esc to that session on its own machine", async () => {
  await st.page.click(`[data-test=inbox-card][data-column=working][data-machine=testlaptop] [data-action=stop]`);
  await st.waitFor(async () => st.proxies.laptop.requests("/v1/sessions/").some((r) => r.method === "POST" && r.path.endsWith("/keys")));
  const k = st.proxies.laptop.requests("/v1/sessions/").filter((r) => r.method === "POST" && r.path.endsWith("/keys")).at(-1);
  expect(k.body).toEqual({ keys: ["Esc"] });
  expect(k.path).toContain(encodeURIComponent(st.sessionId("laptop", "status-working.jsonl")));
});

test("swiping any card left archives it (a Working card here)", async () => {
  const id = await st.page.eval(`document.querySelector("[data-test=inbox-card][data-column=working][data-machine=testlaptop]").dataset.item`);
  const box = await st.page.eval(`(() => { const r = document.querySelector("[data-item='${id}']").getBoundingClientRect(); return { x: r.right - 20, y: r.top + r.height / 2 }; })()`);
  await st.page.swipe({ x: box.x, y: box.y, dx: -200, dy: 0 });
  await st.page.waitFor(`!document.querySelector("[data-item='${id}']")`, 10000);
  expect(st.proxies.laptop.requests("/v1/inbox/").filter((r) => r.method === "POST").map((r) => r.path)).toContain(`/v1/inbox/${encodeURIComponent(id)}/archive`);
});
```

## Task D5: Changes (diff), previews, usage

**Files:** `web/src/views/diff.js`, `web/src/views/previews.js`, `web/src/views/usage.js`, `web/styles/panels.css`, `web/test/e2e/panels.test.ts`.

**Behaviour.** Diff (SPEC 4.9): `GET /v1/sessions/:id/diff`; `repo:false` → `copy.noRepo`; else sections Staged / Not staged / New files, each file a collapsible row (status word + path, `binary` → "Binary file, not shown"), hunks as monospace lines with `+`/`-` marks **and** colour, wrapped (`white-space: pre-wrap`, `overflow-wrap: anywhere`) on phone, side by side ≥ 1100 px; no horizontal page scroll. Previews (SPEC 4.10): list of `{port, process, url}` with "Open" (bridge `openExternal` or `window.open`) and the proxy port shown as plain text. Usage (SPEC 4.11): two bars (5 hours, 7 days) with percent as text, `resetsIn`, "Last read <ago>"; unavailable → a sentence saying usage couldn't be read and when it will try again.

```ts
// web/test/e2e/panels.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readable } from "./readable";
import { startStack, type Stack } from "./stack";

let st: Stack;
beforeAll(async () => {
  st = await startStack({ fixtures: { desk: ["repo:diff-p3"], laptop: [] } }); // "repo:<name>" = a scratch git repo with one staged edit, one unstaged edit with a 200-char line, one new file, and a plain shell pane in it
  await st.page.phone();
});
afterAll(async () => { await st?.stop(); });

test("P3-1: a diff is readable at 412 px, long lines wrap, no sideways page scroll", async () => {
  await st.page.goto(st.changesUrl("desk", "repo:diff-p3"));
  await st.page.waitFor(`document.querySelectorAll("[data-test=diff-file]").length === 3`, 10000);
  await st.page.eval(`document.querySelectorAll("[data-test=diff-file] details").forEach(d => d.open = true)`);
  expect(await readable(st.page, "[data-test=diff]")).toEqual([]);
  expect(await st.page.eval(`document.querySelector("[data-test=diff]").innerText`)).toMatch(/Staged[\s\S]*Not staged[\s\S]*New files/);
  await st.page.shot("p3-1-diff");
});

test("previews and usage are readable", async () => {
  await st.page.goto("https://testdesk.example.ts.net/#/previews/testdesk");
  await st.page.waitFor(`!!document.querySelector("[data-test=previews]")`, 10000);
  expect(await readable(st.page, "[data-test=previews]")).toEqual([]);
  await st.page.goto("https://testdesk.example.ts.net/#/usage");
  await st.page.waitFor(`!!document.querySelector("[data-test=usage]")`, 10000);
  expect(await readable(st.page, "[data-test=usage]")).toEqual([]);
});
```

## Task D6: Settings, config, doctor

**Files:** `web/src/views/settings.js`, `web/src/views/config.js`, `web/styles/settings.css`, `web/test/e2e/settings.test.ts`.

**Behaviour.** Settings (this device, SPEC 4.2 item 5, one JSON object in `localStorage` `porthole:settings`, read and written **only through `ctx.settings`** (`get()`, `set(patch)`, `subscribe(fn)`, defined under "How views meet without shared files"; D1 owns the key, D6 never touches `localStorage` for it, and every control calls `ctx.settings.set({...})` with just its own keys)): text size (`termFontPx` and the chat text size, 5 steps, live preview); talk mode (SPEC 4.12): `talkAutoSend` "Send automatically after I speak" (default on) and `talkAutoStop` "Stop recording after 2 seconds of silence" (default on); `readAloud` "Read replies aloud" (default off); gestures (SPEC 4.4): one row per gesture in `DEFAULT_GESTURES` with a select of `ACTIONS` (plain words, e.g. "Next window"), "Reset gestures" is `ctx.settings.set({gestures: {}})`; the swipe-window rows carry the note "Also changes the window on the computer's screen"; only entries that differ from the defaults are saved as `gestures`, and the terminal reads `mergeGestureMap(ctx.settings.get().gestures)` (A9); `tmuxPrefix` for gestures and shortcuts (default `C-b`, GUESS, validated by `parseSteps`); machines (list, add by name → `https://<name>.<tailnet>.ts.net` derived from this page's origin, remove; in the Android app the list is read-only with "Change machines in the app's settings"); notifications (only in the Android app: a link to the app's notification settings through the bridge; the page itself shows none, G4); voice recordings kept (`GET /v1/voice/kept`, count only). Config (per machine, SPEC 4.2 item 6, `#/config/<machine>`): custom shortcuts editor (`GET/PUT /v1/shortcuts` on that machine: label + steps text with live `parseSteps` feedback and a preview of the chips; Save disabled while invalid); hostd settings `GET/PUT /v1/config` with plain labels; `restartNeeded` → "Saved. Restart Porthole on <machine> for this to take effect."; omp extension status and Doctor: `GET /v1/doctor` checks as a list with a word and a shape per result.

Test hooks: `[data-test=settings]`, `[data-test=config]`; toggles `[data-test=talk-auto-send]`, `[data-test=talk-auto-stop]`, `[data-test=read-aloud]` (checkboxes); gesture selects `[data-test=gesture-select][data-gesture=<name>]`; `[data-test=gesture-reset]`; shortcut editor hooks as in the test below, inside `[data-test=config]`.

```ts
// web/test/e2e/settings.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readable } from "./readable";
import { startStack, type Stack } from "./stack";

let st: Stack;
beforeAll(async () => { st = await startStack({ fixtures: { desk: [], laptop: [] } }); await st.page.phone(); });
afterAll(async () => { await st?.stop(); });

test("talk toggles and a remapped gesture are saved on this device", async () => {
  await st.page.goto("https://testdesk.example.ts.net/#/settings");
  await st.page.waitFor(`!!document.querySelector("[data-test=talk-auto-send]")`, 10000);
  await st.page.click("[data-test=talk-auto-send]");
  await st.page.click("[data-test=talk-auto-stop]");
  await st.page.eval(`(() => { const s = document.querySelector("[data-test=gesture-select][data-gesture=swipe1-left]"); s.value = "none"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  const saved = JSON.parse(await st.page.eval(`localStorage.getItem("porthole:settings")`));
  expect(saved.talkAutoSend).toBe(false);
  expect(saved.talkAutoStop).toBe(false);
  expect(saved.gestures).toEqual({ "swipe1-left": "none" });
  await st.page.click("[data-test=gesture-reset]");
  expect(JSON.parse(await st.page.eval(`localStorage.getItem("porthole:settings")`)).gestures ?? {}).toEqual({});
  expect(await readable(st.page, "[data-test=settings]")).toEqual([]);
  await st.page.shot("p3-settings-device");
});

test("a bad shortcut cannot be saved and says why; a good one round-trips through hostd", async () => {
  await st.page.goto("https://testdesk.example.ts.net/#/config/testdesk");
  await st.page.click("[data-test=shortcut-add]");
  await st.page.click("[data-test=shortcut-label]"); await st.page.type("Stop it");
  await st.page.click("[data-test=shortcut-steps]"); await st.page.type("Ctrl-C");
  expect(await st.page.eval(`document.querySelector("[data-test=shortcut-save]").disabled`)).toBe(true);
  expect(await st.page.eval(`document.querySelector("[data-test=shortcut-error]").innerText`)).toContain("Try C-c");
  await st.page.eval(`document.querySelector("[data-test=shortcut-steps]").value = ""`);
  await st.page.click("[data-test=shortcut-steps]"); await st.page.type("C-c, text:echo done\\, ok, Enter");
  await st.page.click("[data-test=shortcut-save]");
  await st.waitFor(async () => JSON.stringify(await st.api("desk", "/v1/shortcuts")).includes("Stop it"));
  expect(await readable(st.page, "[data-test=config]")).toEqual([]);
});

test("config and doctor are readable", async () => {
  await st.page.goto("https://testdesk.example.ts.net/#/config/testdesk");
  await st.page.waitFor(`document.querySelectorAll("[data-test=doctor-check]").length > 0`, 10000);
  expect(await readable(st.page, "[data-test=config]")).toEqual([]);
  await st.page.shot("p3-settings-config");
});
```

## Task D7: Talk mode and read-aloud

**Files:** `web/src/views/talk.js`, `web/styles/talk.css`, `web/test/e2e/talk.test.ts`.

**Behaviour.** `talk.js` exports `mount` for the talk overlay opened from the chat's mic button, and `attachReadAloud(ctx, chatEvents)` that the chat view calls (D2 imports it with a dynamic `import("./talk.js")`, so D2 does not depend on D7 at load time). D7 reads `talkAutoSend`, `talkAutoStop` and `readAloud` only through `ctx.settings.get()` (each time it needs one, so a change in Settings applies at once; it never touches `localStorage`). Read-aloud (SPEC 4.12): when `readAloud` ("Read replies aloud") is on (or talk mode is open), the items that `chatmodel.append` returns as new go through `finishedReplies(newItems)` (A7: only the final assistant message of a finished turn, `stopReason` `"stop"`; a `"toolUse"` message in the middle of a turn is never spoken, and a reconnect's backlog never re-speaks old replies), and each one is turned into `summaryUtterances(text)` and spoken in order: bridge `speak({utterances})` when available, else `speechSynthesis.speak(new SpeechSynthesisUtterance(u))` one by one; a "Stop reading" button cancels. Talk mode (SPEC 4.12): big mic button; bridge `startRecording`/`stopRecording` or `getUserMedia` + `AudioContext` → `resample` → `createSilence` (used only when `talkAutoStop` is on) → `encodeWav` → `POST /v1/voice` → `{text}` placed in the composer draft (saved like typing), then sent automatically only in talk mode and only when `talkAutoSend` is on; errors use `copy.voiceFailed` and keep the recording's text if any.

```ts
// web/test/e2e/talk.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { startStack, type Stack } from "./stack";

const STUB = `
  window.__spoken = [];
  const fake = { speaking: false, pending: false, paused: false,
    speak(u) { window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend(new Event("end")), 0); },
    cancel() {}, pause() {}, resume() {}, getVoices() { return []; }, addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(window, "speechSynthesis", { value: fake, configurable: true });`;

let st: Stack;
beforeAll(async () => {
  st = await startStack({ fixtures: { desk: ["chat-p3.jsonl"], laptop: [] } });
  await st.page.onNewDocument(STUB);
  await st.page.phone();
  await st.page.goto("https://testdesk.example.ts.net/#/inbox");
  await st.page.eval(`localStorage.setItem("porthole:settings", JSON.stringify({ readAloud: true }))`);
  await st.page.goto(st.chatUrl("desk", "chat-p3.jsonl"));
  await st.page.waitFor(`document.querySelectorAll("[data-test=bubble]").length >= 4`, 10000);
});
afterAll(async () => { await st?.stop(); });

test("P3-4: a new fixture turn speaks only its final reply: first paragraph plus decision titles, never the tool-use message", async () => {
  expect(await st.page.eval("window.__spoken")).toEqual([]);
  const line = readFileSync(path.join(import.meta.dir, "..", "fixtures", "reply-p3.jsonl"), "utf8");
  await st.append("desk", "chat-p3.jsonl", line);
  await st.page.waitFor(`window.__spoken.length >= 3`, 15000);
  await Bun.sleep(1000);
  const spoken = await st.page.eval("window.__spoken");
  expect(spoken).not.toContain("Let me run the tests before I answer.");
  expect(spoken).toEqual(["The tests pass and the page loads on the phone.", "1. Merge the branch", "2. Turn on the advisor"]);
});
```

## Task E1: Acceptance run, security greps, README

**Files:** `web/README.md`, `web/test/e2e/acceptance.test.ts`.

- [ ] **Step 1: Acceptance file.** Bun runs test files independently, so E1 does not repeat the D tests. `acceptance.test.ts` holds only the cross-screen check no single D file covers: one stack with both machines at phone size, walking inbox → drawer → chat → terminal → changes by tapping (no `goto`) and asserting `readable` on each screen, then the same at `wide()` with the sidebar visible without opening it.
- [ ] **Step 2: Security greps** (each must print nothing):

```bash
git grep -nE 'innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|on[a-z]+=' -- web/src web/index.html
```

```bash
git grep -nE 'https?://(cdn|unpkg|jsdelivr|esm\.sh|fonts\.)' -- web
```

```bash
git grep -nE '(textContent|innerText|title|placeholder|aria-label)\s*[=:]\s*["'"'"'`][A-Za-z]' -- web/src/views web/src/main.js
```

The third finds literal on-screen strings outside `copy.js`; any hit moves into `copy.js`.
- [ ] **Step 3: Whole run**, one after another (never two e2e files at once):

```bash
bun run test:web && bun run typecheck:web
```

```bash
bun test --timeout 120000 web/test/e2e/smoke.test.ts && bun test --timeout 120000 web/test/e2e/drawer.test.ts && bun test --timeout 120000 web/test/e2e/chat.test.ts && bun test --timeout 120000 web/test/e2e/terminal.test.ts && bun test --timeout 120000 web/test/e2e/inbox.test.ts && bun test --timeout 120000 web/test/e2e/panels.test.ts && bun test --timeout 120000 web/test/e2e/settings.test.ts && bun test --timeout 120000 web/test/e2e/talk.test.ts && bun test --timeout 120000 web/test/e2e/acceptance.test.ts
```

```bash
bun run test
```

(The server suite must still pass: P3 changes nothing in `server/`.) Then the leftover check, with no `pgrep -f` / `pkill` by pattern: every e2e file's `afterAll` calls `st.stop()`, which ends its own Chromium by its recorded PID (a stop that fails shows as a failing `afterAll` in that file's output, so the chain above must report no errors), and the smoke file is run once more after the chain, `bun test --timeout 120000 web/test/e2e/smoke.test.ts`, whose last test (C1 Step 5) proves that `stop()` leaves no process on that run's own `--user-data-dir` and that the recorded PID is gone.
- [ ] **Step 4: README.** `web/README.md`: what the folder is, no build step, how to run unit and e2e tests (the commands above), the vendored versions and where `VENDOR.md` is, the "no innerHTML" rule, and that every string lives in `copy.js`.
- [ ] **Step 5: Report** to the orchestrator with the screenshots in `web/test/.out/` (p3-1-drawer, p3-1-chat, p3-1-inbox, p3-1-diff, p3-2-send-failed, p3-3-reconnecting, p3-3-terminal-reattached), the P3 item → test name map, and the commit/push proof.
- [ ] **Step 6: Commit and push.**

```bash
git add web/README.md web/test/e2e/acceptance.test.ts && git commit -m "web: P3 acceptance walk-through, security greps, README" && git push
```

**P3 acceptance map:** item 1 → `drawer.test.ts` "P3-1", `chat.test.ts` "P3-1", `inbox.test.ts` "P3-1", `panels.test.ts` "P3-1"; item 2 → `chat.test.ts` "P3-2a/2b/2c"; item 3 → `drawer.test.ts` "P3-3a" + `terminal.test.ts` "P3-3b"; item 4 → `talk.test.ts` "P3-4".

---

## API gaps (backend changes P3 needs; none are built by this plan)

| # | Gap | Why P3 needs it | Proposed change (for a P2 follow-up task in `server/`) |
|---|---|---|---|
| G1 | **hostd does not serve `web/`.** The router has no wildcard and no file route (V2), so `GET /` is a 404. | The page must load from hostd's own origin (SPEC 5.1, 5.4); every e2e test needs it. **Blocks group 0.** | New `server/src/features/web.ts` exporting `webFeature(dir)`: at startup it walks `web/` (skipping `web/test/`) and registers one exact `GET` route per file plus `GET /` → `index.html`. Content types by extension (`.html`, `.js`/`.mjs` `text/javascript`, `.css`, `.png`, `.svg`, `.json`, `.md` not served). Headers on every file: the CSP from "Security headers" (connect-src built from `config.origin` + `config.peers`, `https:` and `wss:` forms), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-cache`. Path traversal impossible (only the walked list is routable). Auth unchanged: a GET without `Origin` passes (V3), and the identity check still applies. Tests: `/` 200 with CSP; `/src/main.js` `text/javascript`; `/../package.json` 404; `/test/fixtures/chat-p3.jsonl` 404. |
| G2 | **Multi-select and multi-question answers.** P2 answers exactly one option of one question (V11). | SPEC 4.6 shows option buttons for every question; P3 falls back to "Answer this in the terminal" for `multi` or `count > 1`. | `POST /v1/inbox/:itemId/answer {answers: [{questionId, optionIndexes: number[]} | {questionId, text}]}`, typed into the ask UI in order. Until then the fallback stays (Needs Ben 2). |
| G3 | **No tmux prefix in `SessionInfo`.** | Terminal gestures send the prefix as bytes; P3 guesses `C-b` (G-guess 4) with a Settings override. | Add `tmuxPrefix: string \| null` to `SessionInfo`, read once per socket with `tmux -L/-S <socket> show-options -gv prefix`. |
| G4 | **Per-device notification queues never expire.** Each browser gets its own `web-<id>` device name, so P2 keeps a queue for every browser that ever connected. | The page acks every notify it receives, but a browser that is never opened again leaves its queue behind. | Drop queues for devices not seen for 7 days (or skip queueing for `web-` devices: the page does not show notifications). |
| G5 | **Doc only:** the events contract should say pages must use a device name of their own (`web-<id>`), never the phone app's node name. | Using `bencell` from the page would steal (ack) the phone app's notifications. | One sentence in SPEC 5.2 next to `/v1/events?device=`. |
| G6 | **Chat items carry no `stopReason`.** `ChatItem` (`server/src/transcript/parse.ts` lines 5-12) has no field that says whether an assistant message ended its turn or stopped for a tool call. | Read-aloud (SPEC 4.12) must speak only the reply that finishes a turn; without it, text written before a tool call ("Let me run the tests…") would be spoken too. **Blocks D7** (Task 0 Step 1 checks it). | Add `stopReason: string \| null` to `ChatItem`, copied from the assistant message's `stopReason` on its `kind:"assistant"` item (`null` for user and tools items); one parse test with a `toolUse` message and a `stop` message. |

## Needs your decision

1. **Let the "serve the screens" change (G1) and the "reply finished" marker (G6) land first, as one small backend task.** Context: hostd can't hand out the page yet, so nothing in P3 can be opened or tested until it can (G1); and the chat items don't say which reply ends a turn, so read-aloud would also speak the "let me check…" lines (G6). Options: (a) a short backend task right after P2 adds both (example: one new file `server/src/features/web.ts` plus a `stopReason` field in `server/src/transcript/parse.ts`, each with its tests); (b) let the P3 builder add them inside P3. Recommendation: (a), so the backend stays the priority and P3 touches only `web/`.
2. **Questions with several choices or several parts (a departure from the spec).** Context: SPEC 4.6 says every question gets its option buttons, but P2 can only press one button for one question, so P3 would show "Answer this in the terminal" for questions that allow several choices or ask several things at once. That is a deviation from the approved spec, so it needs your OK. Options: (a) accept the fallback for P3 (planned), example: a two-part question shows its text and an "Open terminal" button; (b) extend the answer API (G2) before P3, so every question gets buttons. Recommendation: (a) now, (b) later if it comes up often.
3. **Button size.** Context: the design aims for 48 px tall buttons; the automatic check fails anything under 44 px (the common accessibility minimum). Options: (a) 48 px target, 44 px hard floor (planned); (b) 48 px hard floor everywhere, which makes the toolbar wrap to two rows on a 412 px phone. Recommendation: (a).
4. **tmux prefix key. GUESS:** `Ctrl+B` (the tmux default) on every socket; not checked against your tmux setup. Options: (a) keep the guess with a Settings override (planned); (b) add G3 so hostd reports it. Recommendation: (a) now; (b) if you use a different prefix.

## Self-review

- **Spec coverage.** SPEC 4.2 items 1-4 sidebar → D1 (+ A7 `buildSidebar`); 4.2 item 5 Settings (machines, talk toggles, read-aloud, gestures, text size, notifications) → D6; 4.2 item 6 Config per machine (shortcuts, hostd settings, extension status, doctor) → D6; 4.3 chat, key row, attachments, live-voice note → D2; 4.4 terminal, toolbar, Ctrl latch, gestures, shortcuts → A9, D3 (+ A3), remap in D6; 4.5 drafts, sent history, clientMsgId → A1, D2; 4.6 inbox grouped by project then machine, Stop, archive, answers → A7, D4 (+ G2, Needs Ben 2); 4.8 attachments → D2; 4.10 previews → D5; 4.9 diff → D5; 4.11 usage → D5; 4.12 talk mode, auto-send and auto-stop toggles, read-aloud of finished replies only → A5, A6, A7 `finishedReplies`, D6, D7 (+ G6); 4.13 reconnect → A2, B1 `reportLink`, D1, D3; 4.14 watch → not P3; 4.15 every machine in the list → B1 (fleet), D1; 4.16 native bridge → B1; 5.1 no build, vendored, no CDN → Task 0, E1 grep; 5.2 contract → V5-V10; 5.4 `X-Porthole` and origin → B1 test, G1 headers; 7 safety → Global Constraints, C1 exact-PID leftover check; 8 P3 items 1-4 → acceptance map in E1.
- **No placeholders.** Every task names its files, interfaces, test code and exact commands. Values not verified in this session are labelled GUESS (worktree path, G-guess 1-4, P2 exporting its feature list, `cancelled` outcome wording from P2).
- **Ownership.** Each file has one owner in the table; views meet only through `route.js` names and lazy `import()`, and D2 reaches D7 by dynamic import, so group D can run in parallel.
- **Type consistency.** `createDrafts`/`createOutbox`/`nextAction` (A1) feed B1's flush and D2's send flow; `delayFor`/`createReconnector` (A2) feed `openSocket` (B1); `parseSteps`/`stepBytes`/`stepLabel` (A3) feed D2, D3, D6; `toTree` (A4) feeds `mdom` (D2); `summaryUtterances` (A5) feeds D7; `groupInbox`/`answerMode` (A7) feed D4; `buildSidebar` (A7) feeds D1; `copy` keys used in tests (`reconnecting`, `sendHeld`, `sendFailedTitle`, `liveVoiceKeys`, `noRepo`, `answerInTerminal`) match the Voice table.
- **Known risks.** G-guess 1 (Chromium host mapping with a port) has a written fallback and a stop condition; xterm's style injection under CSP is checked in D3; TypeScript 7 JSDoc checking (G-guess 3) has a written drop-out.

## Execution handoff

Plan complete. Two ways to run it:

1. **Subagent-driven (recommended):** one fresh agent per task, review between tasks; groups A and D fan out in parallel, C runs beside A and B. Every brief carries: at most 2 failed attempts per step, no Ben browsers or real sessions, e2e files one at a time, exact-PID kills only.
2. **Inline:** run the tasks in this session in group order with checkpoints after groups A, B+C and D.

Precondition for either: P2 merged and G1 and G6 landed (Needs your decision 1).
