# Porthole: feature spec (v1)

Status: **spec, approved for build by Ben on 2026-10-12** ("Just go ahead and give me a feature
spec ... I'll run the build in another window"). Two choices are marked **ASSUMED** below: they are
the recommendations Ben was given and had not yet answered. Ask him before changing them; build
them as written otherwise.

## 1. What it is, in one paragraph

Porthole is a small private web app, served from Ben's desktop (`bendesk-omarchy`) and opened on his
phone (Pixel 7 Pro, "bencell") as a home-screen app over Tailscale. It lists his running agent
sessions (tmux sessions and herdr helper panes), shows each one as a readable **chat view** (main) or
a **real terminal** (one tap away), lets him **type, paste or dictate** into a session without ever
losing what he wrote, and has a **talk mode** for a spoken back-and-forth with Thalamus (his main omp
session). It replaces Moshi for this job: no subscription, no use limit, no third-party server.

## 2. Why (the problems it fixes)

- **Lost words.** omp live voice sends speech to an OpenAI realtime model that only *sometimes*
  passes it to the agent; the transcript is never saved, and live mode hides the message box.
  Evidence: vault note `10-Knowledge/omp-live-voice-loses-spoken-messages-the-voice-model-must-ch.md`.
  Porthole keeps every word visible and saved on the phone until the desktop confirms delivery.
- **Moshi** works (set up 2026-10-12) but shows "20 of 20 free uses left", cannot open a non-default
  tmux socket, and carries features Ben will never use. Vault:
  `30-Decisions/moshi-not-paseo-is-the-preferred-phone-front-end-for-thalamu.md`.
- **Paseo** was rejected for Thalamus (clunky, always-on daemon model).

## 3. Users and devices

- Only Ben. Phone first (Android Chrome, portrait, ~412 CSS px wide). Must also work in a desktop
  browser on the laptop `benacer-omarchy` and the desktop itself.
- Network: Tailscale only. Desktop Tailscale IP `100.78.36.107`, MagicDNS name
  `bendesk-omarchy.tailafe04c.ts.net` (HTTPS certificate domain available, verified 2026-10-12).
  Phone Tailscale IP was `100.120.182.107` on 2026-10-12.

## 4. Scope of v1

### 4.1 Session list (home screen)
- Lists every tmux session on **every** socket in `/tmp/tmux-1000/` (today only `default`; Thalamus's
  design home is `-L thalamus`, session `thalamus`, so both must work), and every herdr agent pane
  (`herdr agent list`; check its JSON output flag at build time).
- Each row: a human name (omp window/pane title with the Braille spinner stripped, else folder name;
  Thalamus is recognised by its folder `/home/cortex/00-system/thalamus` and pinned to the top),
  where it runs (tmux/herdr), and a status chip: **working**, **idle**, **has a question**, or
  **live voice on**.
- Status sources, in order of trust:
  - omp sessions: the newest `cymatic.session-status` custom entry in the session's `.jsonl` file
    (written by `~/.omp/agent/extensions/session-status.ts`: `in-progress`, `awaiting-decision`,
    `fulfilled`, `interrupted`, ...). Find the file through `/proc/<omp pid>/fd` (the open `.jsonl`).
  - live voice: a PipeWire source-output with `application.name=omp`, `media.name=voice` and that
    omp's `application.process.id` (same contract as `~/.local/bin/omp-voice`).
  - herdr panes: the status herdr reports. Prior art for reading it safely:
    `/home/cortex/00-system/thalamus/repo/tools/question-watch/`.
- Refreshes by itself (poll every 2 s or server push; builder's choice), and on pull-to-refresh.

### 4.2 Chat view (default when a session is opened)
- For an **omp** session: render the conversation from its `.jsonl` transcript, not from the
  screen: Ben's messages (including `live-delegation` custom messages) and the assistant's text as
  chat bubbles with Markdown (headings, lists, tables scroll sideways, code blocks). Tool calls are a
  single collapsed line each ("ran 3 tools"). Newest at the bottom; loads older on scroll-up.
- For a **non-omp** pane (plain shell, other agents, herdr panes where no transcript is found): show
  the pane's latest screen text (`tmux capture-pane -p -J -S -2000`, or `herdr agent read`) in a
  large, wrapped, monospace block.
- A **message box** pinned at the bottom (see 4.4) and a **key row** above it:
  `Esc`, `↑`, `↓`, `Enter`, `Tab`, and `Stop`. These answer omp's question boxes and pickers.
  `Stop` sends Escape (omp's interrupt). There is **no Ctrl+C button** in the chat view.
- If the session is in **live voice** mode, the key row is disabled with the note "Live voice is on
  at the desk: keys go to the live panel (Space mutes, Esc ends it)". Text sending still works (4.4).

### 4.3 Terminal view (one tap: "Terminal")
- A real terminal (xterm.js in the page) connected over a WebSocket to a PTY on the desktop running
  `tmux -L <socket> attach -t =<session>` for tmux sessions. For herdr panes, use herdr's own attach
  or screen read; if herdr offers no attachable PTY, show a read-only screen and say so.
- Phone extras: a toolbar with Ctrl, Esc, Tab, arrows; font size controls (pinch or +/−).
- Leaving the view **detaches only Porthole's own tmux client** (never another client, never
  kill-session). The tmux window size follows the most recent client; that is expected.
- Prior art for xterm.js over a PTY: `skill://embed-omp-pty-terminal-in-local-app`
  (Dino-Doctor-preview `api/cloud_terminal.py`, `frontend/public/runtime/cloud-terminal.js`), and
  `mission-control` slice 1 (`/home/cortex/00-system/mission-control`, embedded omp terminal). Reuse
  their approach; do not import from those repos.

### 4.4 Sending text: never lose a word
- The message box keeps a **draft per session in the phone's localStorage**, written on every
  keystroke. A draft is cleared only after the server confirms delivery. Sent messages also go into a
  **local "sent" history** (last 50 per session) the user can reopen and copy.
- Delivery, chosen per target:
  1. **omp session with a live inbox** (`$XDG_RUNTIME_DIR/omp-inbox/<omp pid>/` exists): write
     `.<ns>.msg.part`, rename to `<ns>.msg`, and confirm delivery when the file is gone (the
     extension consumed it). Works with live voice on. The extension and its proven sender logic are
     parked on idea-board branch `feat/live-inbox` (commit `94bcde4`): `live-inbox/live-inbox.ts`,
     `live-inbox/README.md`, and `deliver()` in `live-inbox/omp-voice`. **Move `live-inbox.ts` into
     this repo** (`omp-extension/live-inbox.ts`), install it to `~/.omp/agent/extensions/` as part of
     the build, and note that only omp sessions started after install have an inbox.
  2. **tmux pane without an inbox**: `tmux send-keys -l` the text, then `Enter`; refuse (and keep the
     draft) if the pane is an omp in live voice mode.
  3. **herdr pane**: `herdr agent prompt` (plain text). Never send text into a pane that shows a
     question box; tell Ben to use the key row instead.
- On any failure the draft stays, and the page says what happened in plain words.
- The server also appends every delivered message to `~/.local/state/porthole/sent.jsonl`
  (mode 0600) so nothing is lost even if the phone is.

### 4.5 Talk mode (voice back-and-forth) — **ASSUMED: approach A**
Ben's requirement: "as long as ... I can still talk back and forth to Thalamus." Approach A
(recommended, not yet confirmed by Ben): Porthole's own voice loop, no OpenAI realtime go-between.
- A mic button on the chat view. Tap to start, tap to stop (and optional auto-stop after ~2 s of
  silence). The page records with `getUserMedia`/`MediaRecorder`, converts to **16 kHz mono WAV** in
  the browser, and POSTs it to the desktop.
- The desktop transcribes with `voxtype transcribe <file.wav>` (verified to exist, voxtype 1.1.0;
  local Whisper, no per-use cost), then optionally cleans it with `voxflow enhance` (the same
  post-processor voxtype uses; check its stdin/stdout contract in `~/.config/voxflow/config.toml`).
  The audio file is deleted after a successful transcription and kept (0600, under
  `~/.local/state/porthole/audio/`) if transcription fails, so the words can be recovered.
- The text appears in the message box first; in talk mode it **auto-sends** after transcription
  (toggle in settings), using 4.4.
- **Reply read aloud** — **ASSUMED: summary only.** When the session's next assistant reply finishes
  (seen in the transcript), the phone speaks it with the browser's built-in `speechSynthesis`: the
  first paragraph plus the numbered titles under `## Needs your decision`. A "Read all" button speaks
  the whole reply minus tables and code. A tap on the speaker stops it.
- Porthole **never** starts, stops or changes omp's own `/live` mode, voxtype's daemon, or any
  microphone routing on the desktop. Desktop live voice (Quick Ask) keeps working exactly as before.
- Microphone access requires HTTPS: serve through Tailscale (5.2).

### 4.6 Home-screen app
- Web app manifest + icon so Chrome offers "Add to Home screen"; opens full screen.

## 5. Architecture

### 5.1 Pieces
- **Server**: TypeScript on Bun (`/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun`),
  binding **127.0.0.1 only** on a free port (proposed `8797`; 8787, 8788, 8795, 8796 and 6767 are
  taken). Modules with one job each: `sessions` (discover + status), `transcript` (read omp `.jsonl`),
  `screen` (tmux/herdr screen text), `deliver` (4.4), `pty` (terminal WebSocket), `voice`
  (transcribe), `auth` (5.3).
- **Page**: plain HTML/CSS/JS served by the server, no build step unless clearly needed. xterm.js is
  vendored (pinned version, licence kept), not loaded from a CDN.
- **omp extension**: `omp-extension/live-inbox.ts` (4.4).

### 5.2 Reaching it from the phone
- `tailscale serve` publishes `https://bendesk-omarchy.tailafe04c.ts.net/` (or a path/port under it)
  to `http://127.0.0.1:8797`. Use the background/persistent form so it survives restarts. If the
  command needs root or an operator setting, **stop and hand Ben the exact command** (rule: hand
  sudo commands to Ben's own terminal; never ask for his password).
- **systemd user unit** `porthole.service` (enabled, `Restart=on-failure`), starting at login like
  `thalamus-mailbox.service`. User linger is off on this machine; that is acceptable (Ben logs in).

### 5.3 Who may use it
- Only Ben's own Tailscale devices. Behind `tailscale serve`, read the identity headers Tailscale adds
  (`Tailscale-User-Login`, and the node identity if available) and allow only Ben's login
  (`bengovernale@`, per `tailscale status`) **and** an allowlist of node names: `bencell`,
  `benacer-omarchy`, `bendesk-omarchy`. Verify at build time which headers `tailscale serve` really
  sets and that a client cannot forge them (requests reaching 127.0.0.1 directly, not via serve,
  must be refused unless from the desktop itself). Anything else gets 403. No passwords, no tokens.
- Log each request's device and action to `~/.local/state/porthole/access.log` (0600). Never log
  message text there.

## 6. Non-goals for v1

Phone notifications (later, via the existing private ntfy on :8796); starting or killing sessions;
Moshi/Paseo integration; using OpenAI realtime; changing Thalamus's restart setup (separate work:
vault note `30-Decisions/thalamus-runs-in-its-own-tmux-session-separate-from-the-herd.md`, section
"Checked 2026-10-12"); the T3 keyboard mod in `omp-voice` (stays parked on `feat/live-inbox`);
iPhone-specific features; a native Android app.

## 7. Safety rules for the build itself

- **Never type into, attach to, resize, detach or restart Thalamus (tmux session `1` today), any
  herdr helper, or any other real session while testing.** Use scratch tmux servers
  (`tmux -L porthole-test`) with fake panes, like the crash-routing and question-watch tests in
  `/home/cortex/00-system/thalamus/repo/tools/`.
- Never start omp live voice to test anything (it uses the desk microphone and a paid realtime
  connection). Test talk mode with a pre-recorded WAV.
- No adb/phone screenshot loops: they cost ~58M tokens in an earlier build. Check the page in a
  phone-sized **headless browser on the desktop** (`skill://verify-web-ui-headless-cdp`), then ask
  Ben for one real-phone check.
- One real omp test is allowed: a throwaway `omp --no-extensions -e <live-inbox.ts> --no-session
  --model haiku` session in a temp folder (this is how the extension was proven, ~9 cents).
- Kill only exact PIDs you started. No `pkill`/`killall`.
- No secrets in the repo. Commit and push your own branch after each checked step; no remote exists
  yet: ask Ben before creating one (suggest a private repo under CymaticStatic).

## 8. Acceptance (each needs evidence: command output, test, or screenshot from the headless browser)

1. The list shows every scratch tmux session on two sockets and a fake herdr pane, with correct
   status chips driven by fixture `.jsonl` and PipeWire-like inputs.
2. Chat view renders a fixture omp transcript (user, assistant with a table, a `live-delegation`
   message, collapsed tool calls) readably at 412 px wide.
3. Sending to (a) a throwaway omp with the live inbox, (b) a scratch tmux pane, (c) a fake herdr
   target each delivers exactly once; a forced failure keeps the draft and says why; reloading the
   page mid-draft keeps the draft.
4. Terminal view attaches to a scratch session, accepts input, and leaving detaches only its own
   client (`tmux list-clients` before/after).
5. Talk mode: a pre-recorded 16 kHz WAV posted to the server returns the right text through
   `voxtype transcribe`; a failed transcription keeps the audio file; the page speaks a fixture
   reply's summary (first paragraph + decision titles).
6. Requests without Ben's Tailscale identity get 403; requests via `tailscale serve` from an
   allowed device get 200.
7. `porthole.service` starts at login and after `systemctl --user restart`; `tailscale serve`
   survives a `tailscaled` restart.
8. Ben opens it on his phone, adds it to the home screen, reads Thalamus, sends one typed and one
   spoken message, and hears the reply summary. (His check, not the build's.)

## 9. Open decisions for Ben (do not block the build on these)

1. Confirm talk mode **approach A** (Porthole's own voice loop) over B (pipe the phone into omp's
   live voice). Built as A.
2. Confirm **read-aloud length**: summary + decision titles (built), whole reply, or nothing.
3. Name: "Porthole" is a working name.
4. Private GitHub repo for `repo/` (needs his OK).
