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
| `--fs-1` | 0.694rem | 1.4 | badge numbers only |
| `--fs-2` | 0.833rem | 1.45 | captions, timestamps, status labels |
| `--fs-3` | 1rem | 1.55 | body, bubbles, list rows, buttons |
| `--fs-4` | 1.2rem | 1.35 | screen titles, question text |
| `--fs-5` | 1.44rem | 1.25 | Markdown `#`/`##` inside bubbles |

Weights 400 and 600 only. Numbers in usage and badges use `font-variant-numeric: tabular-nums`. Line length in bubbles ≤ 72ch.

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
- **Touch targets: at least 48 × 48 CSS px** on touch screens (`@media (pointer: coarse)`), with 8 px between neighbours; at least 32 px on mouse screens. The key row, answer buttons, Send, mic and toolbar keys are 48 px tall everywhere. (The brief said "≤48 px"; this plan reads it as a 48 px floor, Material's minimum. Needs Ben 4.)
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
│ ▾ Desktop · default              │░░░░░░
│   ▾ 0                            │░░░░░░
│     ▸ 1 editor   ○ ● 2 panes     │░░░░░░
│ ▸ Desktop · herdr                │░░░░░░
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
│ [Esc][ ↑ ][ ↓ ][Enter][Tab][Stop][⋯ more]│ ← key row; disabled + note in live voice
│ ┌──────────────────────────────┐ [🎙][📎] │
│ │ Type a message…              │  [Send] │ ← composer; draft saved each keystroke
│ └──────────────────────────────┘         │
│ Saved on this device · Sent history ▸    │
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
 Ctrl: tap = next key only, double tap = locked (button shows "Ctrl 🔒")
 ⌘ opens the shortcut panel (Ben's shortcuts as buttons)
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
│ ← swipe left to archive · Archive (7 days)│
└──────────────────────────────────────────┘
 Multi-select: options are tick boxes plus [Submit]. Closed question: note "Answer this in the terminal".
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
│ GESTURES                                 │   │  Tidy up dictated text          [ off ]  │
│  Swipe sideways → next window  [change]  │   │  Kept recordings (2)                  ▸  │
│  tmux prefix key               [ C-b ]   │   │ HEALTH CHECK                             │
│ TEXT SIZE   [A-]  100 %  [A+]            │   │  ✓ Agent add-on installed                │
│ NOTIFICATIONS (phone app only)           │   │  ✕ Scrolling needs "set -g mouse on" …   │
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
- **Send flow.** Press Send → `clientMsgId = "web-" + crypto.randomUUID()` → outbox entry (status `held`) → if the machine link is up, `POST /v1/sessions/:id/send`. Answers: `delivered` → clear draft, add to sent history, remove from outbox; `pending` → keep draft, show `pendingTitle`, poll `GET /v1/sends/:clientMsgId` every 3 s (also resumed after a reload from the outbox) until it changes; `refused` / `failed` → keep draft, show `sendFailedTitle` plus hostd's `reason`, offer "Try again" (same `clientMsgId`, which hostd allows for refused/failed ids); network failure (status 0) → keep draft and outbox entry as `held`, show `sendHeld`, and send again with the same `clientMsgId` when the link comes back (hostd answers a repeat from `sent.jsonl`, so it is never delivered twice).
- **Keys and shortcuts.** In the chat view the key row and shortcuts go through `POST /v1/sessions/:id/keys` (hostd refuses them for live voice). In the terminal view, toolbar keys, gestures and shortcuts are encoded to bytes by `lib/steps.js` and written into the terminal connection, exactly as if typed, so tmux sees its prefix key like a real keyboard (`send-keys` would hand `C-b` to the program instead, so it cannot drive tmux). Shortcut text uses the P2 step syntax: split on commas not preceded by `\`, `\,` becomes `,`.
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
| `web/test/fixtures/chat-p3.jsonl`, `web/test/fixtures/reply-p3.jsonl` | P3 chat fixture and the reply line appended in the read-aloud test | 0 |
| `web/test/unit/oklch.ts`, `web/test/unit/contrast.test.ts`, `web/test/unit/vendor.test.ts` | token contrast proof; vendored file hashes | 0 |
| `web/src/lib/storage.js`, `drafts.js`, `outbox.js` + `web/test/unit/drafts.test.js`, `outbox.test.js` | draft store, sent history, outbox state machine | A1 |
| `web/src/lib/reconnect.js` + `web/test/unit/reconnect.test.js` | backoff schedule and timer | A2 |
| `web/src/lib/steps.js` + `web/test/unit/steps.test.js` | step syntax parse, labels, keys for `/keys`, bytes for the terminal | A3 |
| `web/src/lib/markdown.js` + `web/test/unit/markdown.test.js` | Markdown → neutral tree, allowlist | A4 |
| `web/src/lib/speech.js` + `web/test/unit/speech.test.js` | read-aloud summary: first paragraph + decision titles | A5 |
| `web/src/lib/wav.js`, `silence.js` + `web/test/unit/wav.test.js`, `silence.test.js` | 16 kHz mono WAV encoder, resampler, 2 s silence detector | A6 |
| `web/src/lib/chatmodel.js`, `tree.js`, `inboxmodel.js`, `format.js`, `route.js` + one `*.test.js` each | chat item merge, sidebar tree, inbox groups, times/sizes, hash routes | A7 |
| `web/src/lib/copy.js` + `web/test/unit/copy.test.js` | every on-screen string; banned-word test | A8 |
| `web/src/net/api.js`, `socket.js`, `machine.js`, `fleet.js`, `bridge.js` + `web/test/unit/net.test.js`, `bridge.test.js` | I/O with injected fetch/WebSocket/timers | B1 |
| `web/test/e2e/tsproxy.ts`, `cdp.ts`, `browser.ts`, `stack.ts`, `readable.ts`, `web/test/e2e/smoke.test.ts` | test TLS proxy, CDP client, throwaway Chromium, two test hostds, readability check | C1 |
| `web/src/main.js`, `web/src/views/shell.js`, `sidebar.js`, `strip.js`, `web/styles/shell.css`, `web/test/e2e/drawer.test.ts` | boot, top bar, drawer, reconnect strip, lazy view loading | D1 |
| `web/src/dom/mdom.js`, `web/src/views/chat.js`, `composer.js`, `keyrow.js`, `web/styles/chat.css`, `web/test/e2e/chat.test.ts` | chat view, composer, attachments, key row | D2 |
| `web/src/views/terminal.js`, `web/styles/terminal.css`, `web/test/e2e/terminal.test.ts` | terminal, toolbar, gestures, shortcuts | D3 |
| `web/src/views/inbox.js`, `web/styles/inbox.css`, `web/test/e2e/inbox.test.ts` | inbox columns, answer buttons, archive | D4 |
| `web/src/views/diff.js`, `previews.js`, `usage.js`, `web/styles/panels.css`, `web/test/e2e/panels.test.ts` | changes, previews, usage | D5 |
| `web/src/views/settings.js`, `config.js`, `web/styles/settings.css`, `web/test/e2e/settings.test.ts` | settings (text size, shortcuts, gestures, machines), config, doctor | D6 |
| `web/src/views/talk.js`, `web/styles/talk.css`, `web/test/e2e/talk.test.ts` | talk mode, recording, read-aloud | D7 |
| `web/README.md`, `web/test/e2e/acceptance.test.ts` | how to run, P3 items 1-4 in one file, security greps | E1 |

**How views meet without shared files:** `lib/route.js` (A7) maps each route to a view module name (`inbox`, `chat`, `term`, `changes`, `previews`, `usage`, `settings`, `config`); `main.js` (D1) loads it with `import("./views/" + name + ".js")` and calls its `mount(root, ctx)` export, which returns `{unmount()}`. `ctx` = `{fleet, route, settings, bridge, copy, navigate}`. So D2-D7 never edit D1's files and D1 never imports theirs statically. A view module that fails to load shows `copy.viewFailed` with a "Reload" button.

## Parallel groups

| Group | Tasks | Starts after | Runs in parallel? |
|---|---|---|---|
| 0 | 0 | P2 merged into the branch point, and gap G1 landed (Task C1 and every e2e step need `GET /`) | alone |
| A | A1, A2, A3, A4, A5, A6, A7, A8 | 0 | yes, all eight (pure modules, disjoint files) |
| B | B1 | A1, A2, A7, A8 | alongside C |
| C | C1 | 0 | alongside A and B |
| D | D1, D2, D3, D4, D5, D6, D7 | B1, C1 (and the A modules each names) | yes, all seven (disjoint files; lazy view loading) |
| E | E1 | all of D | alone |

Unit tests in group A need only Bun. Group C and D e2e tests need `tmux`, `openssl` and `chromium` on the desktop, and run one test file at a time (each starts its own Chromium; never two e2e files at once, to keep the machine responsive).

---

## Task 0: Scaffold, tokens, vendored libraries, fixtures

**Files:** Create `web/tsconfig.json`, `web/index.html`, `web/styles/tokens.css`, `web/styles/base.css`, `web/src/dom/h.js`, `web/vendor/xterm/xterm.mjs`, `web/vendor/xterm/xterm.css`, `web/vendor/xterm/LICENSE`, `web/vendor/addon-fit/addon-fit.mjs`, `web/vendor/addon-fit/LICENSE`, `web/vendor/marked/marked.esm.js`, `web/vendor/marked/LICENSE`, `web/vendor/VENDOR.md`, `web/test/fixtures/chat-p3.jsonl`, `web/test/fixtures/reply-p3.jsonl`, `web/test/unit/oklch.ts`, `web/test/unit/contrast.test.ts`, `web/test/unit/vendor.test.ts`. Modify `package.json` (scripts), `.gitignore`.

- [ ] **Step 1: Worktree.** From `/home/cortex/00-system/porthole/repo`:

```bash
omp-worktree new p3-web
```

Print the path it reports; if it is not `/home/cortex/00-system/porthole/.worktrees/p3-web`, use the printed one everywhere below. Confirm the branch point contains P2 and G1: `git log --oneline -1 -- server/src/features/web.ts` must print a commit (the G1 file name is defined in "API gaps"). If it prints nothing, stop and report "G1 has not landed".

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

- [ ] **Step 5: Run them and watch them fail.**

```bash
bun test web/test/unit
```

Expected: FAIL (`tokens.css` and `VENDOR.md` missing or unparsed).

- [ ] **Step 6: Implement.** `web/styles/tokens.css`: `:root { color-scheme: light dark; … }` with every token from the colour table (light values), the type scale (`--fs-1` … `--fs-6`, `--lh-body: 1.5`, `--fs-scale: 1` multiplied in by Settings → Text size through `html { font-size: calc(100% * var(--fs-scale)) }`), spacing, radius, the one shadow, `--dur-1: 100ms; --dur-2: 150ms; --dur-3: 200ms; --ease: cubic-bezier(0.2, 0, 0, 1)`, and `--tap: 48px`; then `@media (prefers-color-scheme: dark) { :root { …dark values… } }`; then `@media (prefers-reduced-motion: reduce) { :root { --dur-1: 0ms; --dur-2: 0ms; --dur-3: 0ms } }`. If a colour fails Step 5's test, darken/lighten its `L` in 1 % steps (at most two edits per token) and update the table above in the same commit so plan and code agree. `web/styles/base.css`: box-sizing, body font stacks from "Type", `:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px }`, `button, [role=button], input, select, textarea { min-block-size: var(--tap) }`, `.visually-hidden`, `.table-scroll { overflow-x: auto }`. `web/index.html`:

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

Fixtures. `web/test/fixtures/chat-p3.jsonl` (one JSON object per line, shapes copied from `server/test/fixtures/chat-basic.jsonl`): a `title` line ("P3 fixture"), a `session` line (`id: "fx-p3"`), user `u1` "Can you compare the two plans?", assistant `a1` with text "Here they are side by side:\n\n| Plan | Cost | Time |\n|---|---|---|\n| Small | $10 | 1 day |\n| Large | $40 | 3 days |" plus two `toolCall` parts (`read`, `grep`), `toolResult` `r1`, a `custom_message` `d1` with `customType: "live-delegation"`, content "Also check the tests", and assistant `a2` "Done. Both plans are listed above." with `stopReason: "stop"`. `web/test/fixtures/reply-p3.jsonl` (exactly one line, appended during the read-aloud test): assistant `a3`, `parentId: "a2"`, text

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

Expected: PASS, 6 tests (vendor 2, contrast 4; the count Bun prints is the source of truth).

```bash
bun run typecheck:web
```

Expected: no output, exit 0. If `tsc` (TypeScript 7) says it cannot check `.js` files (G-guess 3), delete `web/tsconfig.json` and the `typecheck:web` script, and record "JS type checking unavailable with TypeScript 7" in the commit message and the final report.

- [ ] **Step 8: Commit and push.**

```bash
git add package.json .gitignore web/tsconfig.json web/index.html web/styles/tokens.css web/styles/base.css web/src/dom/h.js web/vendor/VENDOR.md web/vendor/xterm/lib/xterm.mjs web/vendor/xterm/css/xterm.css web/vendor/xterm/LICENSE web/vendor/addon-fit/lib/addon-fit.mjs web/vendor/addon-fit/LICENSE web/vendor/marked/lib/marked.esm.js web/vendor/marked/LICENSE web/test/fixtures/chat-p3.jsonl web/test/fixtures/reply-p3.jsonl web/test/unit/oklch.ts web/test/unit/contrast.test.ts web/test/unit/vendor.test.ts
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

**Interface.** `parseSteps(text)` → `{ok: true, steps: string[]} | {ok: false, reason}` (split on `,` not preceded by `\`, `\,` → `,`, trim each, 1-32 steps, each a valid key name per V8 or `text:<t>`; reason is a plain sentence naming the bad step). `formatSteps(steps)` → text (escapes `,` inside `text:` steps). `stepLabel(step)` → what a button shows (`"Ctrl+C"`, `"Esc"`, `"↑"`, `"Tab"`, `"Type: git status"`). `stepBytes(step, prefix)` → `Uint8Array` for the terminal: `Enter` `\r`, `Tab` `\t`, `Esc` `\x1b`, `Space` ` `, `BSpace` `\x7f`, arrows `\x1b[A/B/C/D` (`Up/Down/Right/Left`), `Home` `\x1b[H`, `End` `\x1b[F`, `PageUp` `\x1b[5~`, `PageDown` `\x1b[6~`, `C-a`..`C-z` code `1..26`, single printable char as UTF-8, `text:<t>` UTF-8 of `<t>`; the pseudo-step `prefix` emits the tmux prefix (setting, default `C-b`, G-guess 4). `gestureSteps(name)` → steps for swipe left/right (`["prefix","p"]` / `["prefix","n"]`, previous/next tmux window) and long-press paste (`[]`, the view pastes the clipboard as `text:`).

- [ ] **Step 1: Failing test.**

```js
import { expect, test } from "bun:test";
import { formatSteps, parseSteps, stepBytes, stepLabel } from "../../src/lib/steps.js";

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

- [ ] **Step 1: Failing test** (the reply text is the exact body of `web/test/fixtures/reply-p3.jsonl`, read from the file so the e2e test and this one share it):

```js
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { summaryUtterances } from "../../src/lib/speech.js";

const line = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "fixtures", "reply-p3.jsonl"), "utf8").trim());
const reply = line.message.content.find((p) => p.type === "text").text;

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
- `chatmodel.js`: `createChat()` → `{backlog(page), append(items, end), older(page), items(), newestAssistant()}`; items are unique by `cursor`, kept in cursor order; `append` returns the items that are new (the read-aloud trigger uses this, so a reconnect's backlog never re-speaks old replies). `kind:"tools"` items render collapsed: `toolSummary(item)` → `"Used 2 tools: read, grep"`.
- `tree.js`: `buildSidebar(trees, openList)` → `{machines: [{name, origin, state, needYou}], active: Row[], chats: Group[], terminals: Group[]}`; a session with `omp` goes under Chats and Terminals, without `omp` under Terminals only; groups are by machine then project (`basename(cwd)`), sorted needs-you first, then working, then name (SPEC 4.2); `active` = entries of `porthole:open` that still exist.
- `inboxmodel.js`: `groupInbox(itemsByMachine)` → `{needsYou: Item[], working: Item[], done: Item[]}` newest first by `updatedAt`, each item carrying its machine; `answerMode(item)` → `"buttons" | "terminal"` (`"terminal"` when `question.multi` is true or `question.count > 1`, because P2 answers one option for one question: gap G2, copy `answerInTerminal`).
- `format.js`: `ago(iso, now)` → `"just now" | "3 min ago" | "2 h ago" | "yesterday" | "12 Oct"`; `resetsIn(iso, now)` → `"resets in 2 h 10 min"`; `bytes(n)` → `"1.2 MB"`.
- `route.js`: `parse(hash)` → `{view, machine?, sessionId?}`, `href(route)` → hash, `VIEWS` (route name → module name); unknown → `{view: "inbox"}`.

- [ ] **Step 1: Failing tests** (one file each; the key cases):

```js
// chatmodel.test.js
import { expect, test } from "bun:test";
import { createChat, toolSummary } from "../../src/lib/chatmodel.js";
const it = (cursor, kind = "assistant", text = "t" + cursor) => ({ cursor, id: "i" + cursor, at: "2026-10-13T09:00:00Z", kind, text, tools: [], via: null });
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
```

```js
// tree.test.js
import { expect, test } from "bun:test";
import { buildSidebar } from "../../src/lib/tree.js";
const s = (id, name, cwd, status, omp) => ({ id, kind: "tmux", name, cwd, status, reported: true, questionCount: status === "needs-you" ? 1 : 0, liveVoice: false, pinned: false, where: "here", attached: false, omp: omp ? { pid: 1, transcript: "/t", inbox: null } : null, herdrStatus: null, dirty: null });
test("omp sessions are chats and terminals; plain shells are terminals only; needs-you first", () => {
  const trees = [{ origin: "https://testdesk.example.ts.net", state: "up", tree: { machine: "testdesk", scannedAt: "", sources: [], sessions: [s("a", "web", "/p/porthole", "working", true), s("b", "api", "/p/porthole", "needs-you", true), s("c", "sh", "/p/porthole", "idle", false)] } }];
  const side = buildSidebar(trees, []);
  expect(side.chats[0].rows.map((r) => r.id)).toEqual(["b", "a"]);
  expect(side.terminals[0].rows.map((r) => r.id)).toEqual(["b", "a", "c"]);
  expect(side.machines).toEqual([{ name: "testdesk", origin: "https://testdesk.example.ts.net", state: "up", needYou: 1 }]);
  expect(side.chats[0].label).toBe("testdesk · porthole");
});
test("a machine that is down keeps its row and shows no sessions", () => {
  const side = buildSidebar([{ origin: "https://testlaptop.example.ts.net", state: "down", tree: null, name: "testlaptop" }], []);
  expect(side.machines[0]).toEqual({ name: "testlaptop", origin: "https://testlaptop.example.ts.net", state: "down", needYou: 0 });
  expect(side.chats).toEqual([]);
});
```

```js
// inboxmodel.test.js
import { expect, test } from "bun:test";
import { answerMode, groupInbox } from "../../src/lib/inboxmodel.js";
const q = (o) => ({ qid: "q", pid: 1, text: "Pick", options: ["A", "B"], multi: false, count: 1, open: true, outcome: null, ...o });
test("columns, newest first, machine kept", () => {
  const g = groupInbox({ testdesk: [{ id: "1", column: "needs-you", updatedAt: "2026-10-13T09:00:00Z" }, { id: "2", column: "needs-you", updatedAt: "2026-10-13T10:00:00Z" }, { id: "3", column: "done", updatedAt: "2026-10-13T08:00:00Z" }] });
  expect(g.needsYou.map((i) => [i.id, i.machine])).toEqual([["2", "testdesk"], ["1", "testdesk"]]);
  expect(g.done.map((i) => i.id)).toEqual(["3"]);
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

`copy.js` exports one frozen object `copy` holding every string in the "Voice" table above plus each screen's labels (drawer group names "Machines", "Inbox", "Chats", "Terminals", "Settings", "Config"; button labels; empty states; errors) and functions for strings with values (`copy.needYou(n)` → `"1 needs you"`/`"3 need you"`; `copy.cannotReach(machine)` → `"Can't reach testlaptop. It may be asleep or offline. Porthole keeps trying."`). Views never write literal user-facing strings; Task E1's grep checks it.

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

---

## Task B1: API client, sockets, machine links, fleet, native bridge

**Files:** Create `web/src/net/api.js`, `socket.js`, `machine.js`, `fleet.js`, `bridge.js`, `web/test/unit/net.test.js`, `web/test/unit/bridge.test.js`. Uses A1 (`outbox`), A2 (`reconnect`), A7 (`tree`, `inboxmodel`), A8 (`copy`).

**Interfaces** (behaviour fixed in "Rules every module follows"): `createApi({origin, fetch, timeoutMs, setTimeout})`; `openSocket({url, WebSocket, reconnector deps, onOpen, onMessage, onState, binaryType})` → `{send(data), nudge(), close()}` (uses `createReconnector`; `close()` stops reconnecting); `createMachine({name, origin, deviceId, deps})` → `{name, origin, state(), tree(), inbox(), api, subscribe(fn), start(), stop(), nudge()}`; `createFleet({machines, deviceId, deps})` → `{links(), sidebar(open), inbox(), anyDown(), subscribe(fn), nudgeAll(), stop()}`; `createBridge(win)` → `{available, call(method, args), on(event, fn)}`. Every dependency (`fetch`, `WebSocket`, timers, `crypto.randomUUID`, `localStorage`) is passed in; `main.js` passes the real ones.

- [ ] **Step 1: Failing tests.** `web/test/unit/net.test.js`:

```js
import { expect, test } from "bun:test";
import { createApi } from "../../src/net/api.js";
import { createMachine } from "../../src/net/machine.js";

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

test("machine link: device query, refetch on every open, ack every notify", async () => {
  FakeWs.all = [];
  const { f, calls } = fakeFetch(Array(4).fill(0).map(() => ({ status: 200, body: { machine: "testdesk", sessions: [], sources: [], scannedAt: "", items: [] } })));
  const timers = []; const m = createMachine({ name: "testdesk", origin: O, deviceId: "web-abc123def456", deps: { fetch: f, WebSocket: FakeWs, setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout() {} } });
  m.start();
  const ws = FakeWs.all[0];
  expect(ws.url).toBe("wss://testdesk.example.ts.net/v1/events?device=web-abc123def456&since=0");
  ws.onopen?.({}); await Bun.sleep(0);
  expect(calls.map((c) => c.url.replace(O, ""))).toEqual(["/v1/sessions", "/v1/inbox"]);
  ws.onmessage?.({ data: JSON.stringify({ type: "notify", id: 7, itemId: "i", title: "t", body: "b", options: [], at: "" }) });
  expect(ws.sent.map((d) => JSON.parse(d))).toEqual([{ type: "ack", id: 7 }]);
  ws.close(); expect(m.state()).toBe("down"); expect(timers.at(-1).ms).toBe(1000);
  timers.at(-1).fn(); FakeWs.all[1].onopen?.({}); await Bun.sleep(0);
  expect(FakeWs.all[1].url).toContain("since=7");
  expect(calls.length).toBe(4); expect(m.state()).toBe("up");
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
- [ ] **Step 3: Implement.** `machine.js` builds the events URL from `origin` (`https:` → `wss:`), keeps `lastNotifyId` in memory (the page's own queue; P2 replays unacked ones anyway), refetches sessions and inbox on each open, applies `{type:"inbox", items}` and `{type:"sessions"}`-style tree pushes if P2 sends them (else polls `GET /v1/sessions` every 10 s while up; P2's events contract decides, read on the merged branch), and on `"up"` flushes `outbox.held(origin)` by re-posting each with its own `clientMsgId`. `fleet.js` creates one link per machine, calls `nudgeAll()` on `window` `online`, `visibilitychange` → visible and bridge `network`. Machine list: bridge `machines()` when `available`, else `porthole:machines`, else first-run discovery (`GET /v1/machine`, `GET /v1/config` → `peers`, each peer's `GET /v1/machine`).
- [ ] **Step 4: Run, expect PASS** (same command), then the whole unit suite: `bun run test:web`.
- [ ] **Step 5: Commit and push.**

```bash
git add web/src/net/api.js web/src/net/socket.js web/src/net/machine.js web/src/net/fleet.js web/src/net/bridge.js web/test/unit/net.test.js web/test/unit/bridge.test.js && git commit -m "web: API client, reconnecting machine links, fleet, native bridge adapter" && git push
```

## Task C1: Headless test stack (two test hostds, TLS proxy, throwaway Chromium, CDP)

**Files:** Create `web/test/e2e/tsproxy.ts`, `cdp.ts`, `browser.ts`, `stack.ts`, `readable.ts`, `web/test/e2e/smoke.test.ts`. Read `skill://verify-web-ui-headless-cdp` first and follow it where it differs from nothing below; never point anything at ports 9224 or 9225.

**Design.** The page must load from `https://<machine>.<tailnet>.ts.net` because hostd only accepts that origin shape (V3). So:
- `stack.ts` → `startStack({fixtures})`: a `Scratch`, two test hostds via `startTestHostd(s, FACTORIES, {origin, peers})` — testdesk (`origin: "https://testdesk.example.ts.net"`, `peers: ["https://testlaptop.example.ts.net"]`) and testlaptop (the mirror) — each with an `ompPane` per fixture transcript on its own scratch tmux socket; `FACTORIES` is the exported production feature list from the merged P2 branch's `server/src/main.ts` (**GUESS** that P2 exports it; if not, C1 lists the factories by name from that file, including G1's `webFeature`). Returns `{desk, laptop, proxies, chrome, page, stop}`.
- `tsproxy.ts` → `startProxy({target: TestHostd, cert, key})`: Bun TLS server on `127.0.0.1:0` standing in for `tailscale serve`. It forwards every request to the hostd adding `X-Porthole-Local: <token>` (the local-identity path, V3) and forwards WebSocket upgrades by opening a Bun `WebSocket` to hostd with the page's `Origin` plus that header, piping text and binary frames both ways. Test controls: `drop(prefix)` closes every open socket whose path starts with `prefix`; `block(prefix, on)` answers new upgrades on `prefix` with 503 while `on`; `failNext(prefix)` resets the next HTTP request on `prefix` (connection closed, no answer); `count(prefix)` = upgrades seen.
- Certificate: `openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=porthole-test" -addext "subjectAltName=DNS:testdesk.example.ts.net,DNS:testlaptop.example.ts.net" -keyout <scratch>/key.pem -out <scratch>/cert.pem`, run with `Bun.spawnSync`.
- `browser.ts` → `startChrome({scratch, map})`: `chromium --headless=new --user-data-dir=<scratch>/chrome --remote-debugging-port=0 --no-first-run --no-default-browser-check --ignore-certificate-errors --host-resolver-rules="MAP testdesk.example.ts.net:443 127.0.0.1:<deskProxyPort>,MAP testlaptop.example.ts.net:443 127.0.0.1:<laptopProxyPort>" about:blank`; records the child PID; reads `<scratch>/chrome/DevToolsActivePort` for the port; `stop()` kills that exact PID (SIGTERM, then SIGKILL after 3 s) and nothing else.
- `cdp.ts` → `connectPage(port)`: one WebSocket to the first page target; `send(method, params)`, `on(event, fn)`, helpers `goto(url)`, `phone()` (`Emulation.setDeviceMetricsOverride {width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true}` + `Emulation.setTouchEmulationEnabled`), `wide()` (1280 × 800), `eval(expr)` (`Runtime.evaluate`, `awaitPromise`, `returnByValue`, throws on exception), `waitFor(expr, ms)`, `click(selector)`, `type(text)` (`Input.insertText`), `key(name)`, `reload()`, `onNewDocument(source)` (`Page.addScriptToEvaluateOnNewDocument`), `shot(name)` (`Page.captureScreenshot` once into `web/test/.out/<name>.png`; a failure is logged and skipped, never retried).
- `readable.ts` → `readable(page, selector)`: evaluates in the page and returns the problems found (empty array = readable): element missing or `display:none`/zero size; document wider than the viewport (`documentElement.scrollWidth > innerWidth`); any text-bearing descendant with computed `font-size` < 14 px (12 px allowed only for `.meta` captions, which are never the only copy of a fact); any descendant whose content is clipped (`scrollWidth > clientWidth + 1` with `overflow: hidden`) unless it is inside `.table-scroll` or has `text-overflow: ellipsis` and a `title`; any interactive element smaller than 44 × 44 CSS px (the craft-floor minimum; 48 px is the design target, Needs Ben 4).

- [ ] **Step 1: Check the guesses.** `command -v chromium` (G-guess 2) and, in `smoke.test.ts`, the first assertion that `https://testdesk.example.ts.net/` loads through the mapped proxy (G-guess 1). If Chromium ignores the port in the rule (attempt 1 fails), attempt 2: start the proxies on fixed free ports and use `--host-resolver-rules="MAP *.example.ts.net 127.0.0.1"` plus the page URL `https://testdesk.example.ts.net:<port>/` with hostd's `origin` override set to the same `https://…:<port>` — **only if** `config.ts` accepts a port (V3 says it does not, so this fallback needs a test-only config override; if neither works, stop and report).
- [ ] **Step 2: Failing test** `web/test/e2e/smoke.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startStack, type Stack } from "./stack";

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

test("cleanup kills only the recorded Chromium PID", async () => {
  expect(st.chrome.pid).toBeGreaterThan(0);
});
```

- [ ] **Step 3: Run, expect FAIL** (modules missing): `bun test --timeout 120000 web/test/e2e/smoke.test.ts`
- [ ] **Step 4: Implement** the five modules. `stop()` order: CDP socket, Chromium (exact PID), proxies, hostds, scratch tmux servers (`Scratch` cleanup), scratch folder.
- [ ] **Step 5: Run, expect PASS** (same command). Then confirm no Chromium was left: `pgrep -a -f porthole-test-` must print nothing (read-only check; never `pkill`).
- [ ] **Step 6: Commit and push.**

```bash
git add web/test/e2e/tsproxy.ts web/test/e2e/cdp.ts web/test/e2e/browser.ts web/test/e2e/stack.ts web/test/e2e/readable.ts web/test/e2e/smoke.test.ts && git commit -m "web: headless test stack (test hostds, TLS proxy, throwaway Chromium over CDP)" && git push
```

---

Every D task below follows the same five steps, so they are written once here and each task lists only its files, behaviour and test:

1. Re-read `skill://impeccable/reference/craft-floor.md` and the wireframe for the screen above.
2. Write the task's e2e test file exactly as given; run it and watch it fail: `bun test --timeout 120000 web/test/e2e/<file>`.
3. Implement the view with `h()`/`mdom` only, strings only from `copy.js`, styles only from tokens.
4. Run the same command; expect PASS. Then the unit suite (`bun run test:web`) and `bun run typecheck:web`.
5. Commit the listed files by name and push: `git add <listed files> && git commit -m "web: <screen>" && git push`.

## Task D1: Shell, drawer, reconnect strip

**Files:** `web/src/main.js`, `web/src/views/shell.js`, `web/src/views/sidebar.js`, `web/src/views/strip.js`, `web/styles/shell.css`, `web/test/e2e/drawer.test.ts`.

**Behaviour.** `main.js` boots: settings → bridge → device id (`porthole:device`, `"web-" + 12 random [a-z0-9]`) → machine list → fleet → router; renders the shell (top bar, drawer, strip, `#view`) and lazy-loads the route's view. Drawer per the wireframe and SPEC 4.2: Machines (name, dot + word, need-you count), Inbox (count), active sessions, Chats, Terminals (grouped by machine · project), Settings, Config (one per machine); pull-to-refresh on the list = `fleet.nudgeAll()` + `GET /v1/sessions`. Opens from the menu button or a swipe from the left edge; closes on scrim, Esc, back (a `history.pushState` entry while open) or choosing a row; focus moves into it and returns to the menu button; `inert` on the page behind it. ≥ 840 px: permanent column, no scrim. Strip: when any link is `down` for more than 1 s, a strip under the top bar says `copy.reconnecting` with the machine name(s) (`role="status"`); when all are up again it shows `copy.reconnected` for 2 s and slides away.

```ts
// web/test/e2e/drawer.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readable } from "./readable";
import { startStack, type Stack } from "./stack";

let st: Stack;
beforeAll(async () => { st = await startStack({ fixtures: { desk: ["chat-p3.jsonl", "status-needs-you.jsonl"], laptop: ["status-working.jsonl"] } }); await st.page.phone(); await st.page.goto("https://testdesk.example.ts.net/#/inbox"); });
afterAll(async () => { await st?.stop(); });

test("P3-1: the drawer is readable at 412 px and lists both machines and the groups", async () => {
  await st.page.click("[data-test=menu]");
  await st.page.waitFor(`document.querySelector("[data-test=drawer]")?.getAttribute("aria-hidden") === "false"`, 5000);
  expect(await readable(st.page, "[data-test=drawer]")).toEqual([]);
  const text = await st.page.eval(`document.querySelector("[data-test=drawer]").innerText`);
  for (const s of ["testdesk", "testlaptop", "Inbox", "Chats", "Terminals", "Settings", "Config", "1 needs you"]) expect(text).toContain(s);
  await st.page.shot("p3-1-drawer");
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

**Behaviour.** Chat WS (`/v1/sessions/:id/chat`) through `openSocket`; backlog then appends via `chatmodel`; "Show earlier" uses `GET …/chat?before=`. Ben's bubbles right on `--mine`; assistant bubbles via `toTree` → `mdom`; `via:"live-voice"` bubbles carry a mic mark and "Said at the desk"; `kind:"tools"` collapsed to `toolSummary` in a `<details>`. Stays scrolled to the bottom unless Ben scrolled up ("New messages ↓" pill). Composer: auto-growing textarea, draft saved on every `input` (A1), restored on mount, Send (≥ 48 px) disabled when empty, Enter = newline on phone and Ctrl+Enter sends on wide; attach button → bridge `pickFile` or `<input type=file>` → `POST /v1/uploads` → chip with the returned path, saved in the draft's `files`; text sent = draft text plus one `@<path>` line per file. Send flow, statuses and messages exactly per "Send flow". Key row (SPEC 4.3): Esc, Tab, ↑, ↓, Ctrl+C, Enter, then the saved shortcuts from `GET /v1/shortcuts`, through `POST …/keys`; when the session has `liveVoice` the row shows `copy.liveVoiceKeys` and the buttons stay usable (hostd routes them).

```ts
// web/test/e2e/chat.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readable } from "./readable";
import { startStack, type Stack } from "./stack";

let st: Stack; let url: string;
beforeAll(async () => {
  st = await startStack({ fixtures: { desk: ["chat-p3.jsonl"], laptop: [] } });
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

(`stack.ts` provides `chatUrl(machine, fixture)`, `termUrl(machine, fixture)`, `sessionId(machine, fixture)`, `killPane(machine, fixture)` and `append(machine, fixture, line)`; add them in C1.)

## Task D3: Terminal, toolbar, gestures, shortcuts

**Files:** `web/src/views/terminal.js`, `web/styles/terminal.css`, `web/test/e2e/terminal.test.ts`.

**Behaviour.** xterm 6.0.0 + fit addon imported from `/vendor/…/lib/*.mjs`; theme from tokens; font size follows Settings. PTY socket `/v1/sessions/:id/pty?cols=&rows=` through `openSocket` with `binaryType = "arraybuffer"`; output → `term.write`, `term.onData` → UTF-8 bytes → binary frame; fit on `ResizeObserver` → `{type:"resize"}`; `{type:"readonly", reason}` → banner + input disabled; `{type:"screen", text}` → render text (herdr). On reconnect the same session is re-attached (same URL) and the screen is cleared before the new attach's first frame. Toolbar (SPEC 4.4): Esc, Tab, Ctrl, ↑, ↓, ←, →, Paste, Keyboard toggle, then shortcut chips; a sticky Ctrl turns the next typed letter into `C-<letter>`. Gestures: swipe left/right on the terminal area (≥ 60 px horizontal, < 30° from horizontal) → `stepBytes` of `gestureSteps("next"|"prev")` (tmux window switch; shared with the desk, Needs Ben 3); long press → paste. All bytes via `stepBytes(step, settings.tmuxPrefix)`. CSP check: load first with the G1 header as built; if the terminal renders unstyled, the static route keeps `'unsafe-inline'` for styles (already in G1's header) and this task reports which was needed.

```ts
// web/test/e2e/terminal.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readable } from "./readable";
import { startStack, type Stack } from "./stack";

let st: Stack;
beforeAll(async () => {
  st = await startStack({ fixtures: { desk: ["shell:term-p3"], laptop: [] } }); // "shell:<name>" = a plain /bin/sh scratch pane
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

test("toolbar Ctrl+C reaches the session as byte 3", async () => {
  await st.page.type("sleep 30"); await st.page.click("[data-key='C-c']");
  await st.page.type("echo p3-after-ctrl-c\r");
  await st.waitFor(async () => (await screen()).includes("p3-after-ctrl-c"));
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

(The strip shows for the terminal link too: `strip.js` watches the fleet links and every open live view registers its socket state with the shell through `ctx.reportLink(name, state)`. `lastUpgradePath` and `screen`/`waitFor` are C1 helpers.)

## Task D4: Inbox

**Files:** `web/src/views/inbox.js`, `web/styles/inbox.css`, `web/test/e2e/inbox.test.ts`.

**Behaviour.** Three sections (Needs you / Working / Done) from `groupInbox` across machines; each card: machine · project, title, body (first 3 lines, "More" expands), age, context left. `answerMode` `buttons` → one button per option (≥ 48 px, full width on phone) → `POST /v1/inbox/:id/answer {optionIndexes: [i]}`, a free-text "Other answer" field → `{text}`; `terminal` → `copy.answerInTerminal` with an "Open terminal" button. Done cards have "Archive" (`POST …/archive`); "Archived" link opens `GET /v1/inbox/archive`. Empty: `copy.inboxEmpty`. Live updates from the events socket's `{type:"inbox"}`.

```ts
// web/test/e2e/inbox.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readable } from "./readable";
import { startStack, type Stack } from "./stack";

let st: Stack;
beforeAll(async () => {
  st = await startStack({ fixtures: { desk: ["status-needs-you.jsonl", "status-done.jsonl"], laptop: ["status-working.jsonl"] } });
  await st.emitQuestion("desk", "status-needs-you.jsonl", { qid: "q-p3", questions: [{ id: "q1", question: "Which plan should I use?", options: ["Small", "Large"], multi: false }] });
  await st.page.phone(); await st.page.goto("https://testdesk.example.ts.net/#/inbox");
  await st.page.waitFor(`document.querySelectorAll("[data-test=inbox-card]").length >= 2`, 10000);
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
```

(`emitQuestion` writes a `question_open` line to the desk hostd's events socket at `config.runtimeDir/events.sock`, the way P2's own tests do; C1 adds it to `stack.ts`.)

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

**Behaviour.** Settings (this device, `porthole:settings`): text size (5 steps, live preview), read replies aloud (on/off), tmux prefix for gestures (default `C-b`, validated by `parseSteps`), machines (list, add by name → `https://<name>.<tailnet>.ts.net` derived from this page's origin, remove; in the Android app the list is read-only with "Change machines in the app's settings"), shortcuts editor (`GET/PUT /v1/shortcuts` per machine: label + steps text with live `parseSteps` feedback and a preview of the chips; Save disabled while invalid), voice recordings kept (`GET /v1/voice/kept`, count only). Config (per machine, SPEC 4.14): `GET/PUT /v1/config` fields with plain labels; `restartNeeded` → "Saved. Restart Porthole on <machine> for this to take effect."; Doctor: `GET /v1/doctor` checks as a list with a word and a shape per result.

```ts
// web/test/e2e/settings.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readable } from "./readable";
import { startStack, type Stack } from "./stack";

let st: Stack;
beforeAll(async () => { st = await startStack({ fixtures: { desk: [], laptop: [] } }); await st.page.phone(); });
afterAll(async () => { await st?.stop(); });

test("a bad shortcut cannot be saved and says why; a good one round-trips through hostd", async () => {
  await st.page.goto("https://testdesk.example.ts.net/#/settings");
  await st.page.click("[data-test=shortcut-add]");
  await st.page.click("[data-test=shortcut-label]"); await st.page.type("Stop it");
  await st.page.click("[data-test=shortcut-steps]"); await st.page.type("Ctrl-C");
  expect(await st.page.eval(`document.querySelector("[data-test=shortcut-save]").disabled`)).toBe(true);
  expect(await st.page.eval(`document.querySelector("[data-test=shortcut-error]").innerText`)).toContain("Try C-c");
  await st.page.eval(`document.querySelector("[data-test=shortcut-steps]").value = ""`);
  await st.page.click("[data-test=shortcut-steps]"); await st.page.type("C-c, text:echo done\\, ok, Enter");
  await st.page.click("[data-test=shortcut-save]");
  await st.waitFor(async () => JSON.stringify(await st.api("desk", "/v1/shortcuts")).includes("Stop it"));
  expect(await readable(st.page, "[data-test=settings]")).toEqual([]);
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

**Behaviour.** `talk.js` exports `mount` for the talk overlay opened from the chat's mic button, and `attachReadAloud(ctx, chatEvents)` that the chat view calls (D2 imports it with a dynamic `import("./talk.js")`, so D2 does not depend on D7 at load time). Read-aloud: when "Read replies aloud" is on (or talk mode is open), every **new** assistant item that `chatmodel.append` returns with `stopReason` done is turned into `summaryUtterances(text)` and spoken in order: bridge `speak({utterances})` when available, else `speechSynthesis.speak(new SpeechSynthesisUtterance(u))` one by one; a "Stop reading" button cancels. Talk mode (SPEC 4.12): big mic button; bridge `startRecording`/`stopRecording` or `getUserMedia` + `AudioContext` → `resample` → `createSilence` → `encodeWav` → `POST /v1/voice` → `{text}` placed in the composer draft (saved like typing), then sent automatically only in talk mode; errors use `copy.voiceFailed` and keep the recording's text if any.

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

test("P3-4: a new fixture reply is spoken as exactly its first paragraph plus its decision titles", async () => {
  expect(await st.page.eval("window.__spoken")).toEqual([]);
  const line = readFileSync(path.join(import.meta.dir, "..", "fixtures", "reply-p3.jsonl"), "utf8");
  await st.append("desk", "chat-p3.jsonl", line);
  await st.page.waitFor(`window.__spoken.length >= 3`, 15000);
  await Bun.sleep(1000);
  expect(await st.page.eval("window.__spoken")).toEqual(["The tests pass and the page loads on the phone.", "1. Merge the branch", "2. Turn on the advisor"]);
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

(The server suite must still pass: P3 changes nothing in `server/`.) Then the read-only leftover check: `pgrep -a -f porthole-test-` prints nothing.
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

## Needs your decision

1. **Let the "serve the screens" change (G1) land first, as a small backend task.** Context: hostd can't hand out the page yet, so nothing in P3 can be opened or tested until it can. Options: (a) a short backend task right after P2 adds it (example: one new file `server/src/features/web.ts` with its tests); (b) let the P3 builder add it inside P3. Recommendation: (a), so the backend stays the priority and P3 touches only `web/`.
2. **Questions with several choices or several parts.** Context: P2 can only press one button for one question. Options: (a) P3 shows "Answer this in the terminal" for those (planned); (b) extend the answer API (G2) before P3. Recommendation: (a) now, (b) later if it comes up often.
3. **Terminal swipes switch the tmux window at the desk too.** Context: the phone and the desk share one tmux session, so swiping to the next window on the phone also moves the desk's view. Options: (a) keep it (simple, matches how tmux works); (b) leave swipes out of P3. Recommendation: (a), with a one-line note under the gesture in Settings.
4. **Button size.** Context: the design aims for 48 px tall buttons; the automatic check fails anything under 44 px (the common accessibility minimum). Options: (a) 48 px target, 44 px hard floor (planned); (b) 48 px hard floor everywhere, which makes the toolbar wrap to two rows on a 412 px phone. Recommendation: (a).
5. **tmux prefix key. GUESS:** `Ctrl+B` (the tmux default) on every socket; not checked against your tmux setup. Options: (a) keep the guess with a Settings override (planned); (b) add G3 so hostd reports it. Recommendation: (a) now; (b) if you use a different prefix.

## Self-review

- **Spec coverage.** SPEC 4.2 sidebar → D1; 4.3 chat, key row, live-voice note → D2; 4.4 terminal, toolbar, gestures, shortcuts → D3 (+ A3); 4.5 drafts, history, clientMsgId → A1, D2; 4.6 inbox and answers → D4 (+ G2); 4.8/4.10 previews → D5; 4.9 diff → D5; 4.11 usage → D5; 4.12 talk and read-aloud → A5, A6, D7; 4.13 reconnect → A2, B1, D1, D3; 4.14 config/doctor → D6; 4.15 every machine in the list → B1 (fleet), D1; 4.16 native bridge → B1; 5.1 no build, vendored, no CDN → Task 0, E1 grep; 5.2 contract → V5-V10; 5.4 `X-Porthole` and origin → B1 test, G1 headers; 7 safety → Global Constraints, C1; 8 P3 items 1-4 → acceptance map in E1.
- **No placeholders.** Every task names its files, interfaces, test code and exact commands. Values not verified in this session are labelled GUESS (worktree path, G-guess 1-4, P2 exporting its feature list, `cancelled` outcome wording from P2).
- **Ownership.** Each file has one owner in the table; views meet only through `route.js` names and lazy `import()`, and D2 reaches D7 by dynamic import, so group D can run in parallel.
- **Type consistency.** `createDrafts`/`createOutbox`/`nextAction` (A1) feed B1's flush and D2's send flow; `delayFor`/`createReconnector` (A2) feed `openSocket` (B1); `parseSteps`/`stepBytes`/`stepLabel` (A3) feed D2, D3, D6; `toTree` (A4) feeds `mdom` (D2); `summaryUtterances` (A5) feeds D7; `groupInbox`/`answerMode` (A7) feed D4; `buildSidebar` (A7) feeds D1; `copy` keys used in tests (`reconnecting`, `sendHeld`, `sendFailedTitle`, `liveVoiceKeys`, `noRepo`, `answerInTerminal`) match the Voice table.
- **Known risks.** G-guess 1 (Chromium host mapping with a port) has a written fallback and a stop condition; xterm's style injection under CSP is checked in D3; TypeScript 7 JSDoc checking (G-guess 3) has a written drop-out.

## Execution handoff

Plan complete. Two ways to run it:

1. **Subagent-driven (recommended):** one fresh agent per task, review between tasks; groups A and D fan out in parallel, C runs beside A and B. Every brief carries: at most 2 failed attempts per step, no Ben browsers or real sessions, e2e files one at a time, exact-PID kills only.
2. **Inline:** run the tasks in this session in group order with checkpoints after groups A, B+C and D.

Precondition for either: P2 merged and G1 landed (Needs your decision 1).
