# Porthole: feature spec (v2, Moshi parity)

Status: **v2, approved for build by Ben on 2026-10-13** ("approve"). Supersedes v1 (2026-10-12, last v1 commit `21b54fe`).
v1's design was approved by Ben on 2026-10-12. v2 widens the scope to the useful features of the
commercial app Moshi, as Ben asked on 2026-10-12 ("reverse engineer the app Moshi ... the backend is
priority"). Ben chose every scope item in section 10 on 2026-10-12 and 2026-10-13.

**Clean room.** Moshi's features were studied only from its public docs (getmoshi.app/docs, read
2026-10-12). Porthole copies no Moshi code, text or assets. Research notes:
`/home/cortex/00-system/porthole/files/research-2026-10-12/`.

## 1. What it is, in one paragraph

Porthole is Ben's private window into the coding-agent sessions running on his two Linux computers
(desktop `bendesk-omarchy`, laptop `benacer-omarchy`). It has the same three parts as Moshi:

1. a small **background program** on each computer (`porthole-hostd`);
2. an **Android app** on his phone (Pixel 7 Pro, "bencell");
3. a **desktop control room**: the same screens, opened in a browser on either computer.

A **Galaxy Watch6 app** with watch-face complications (small live readouts) hangs off the phone app.
Everything travels between Ben's own devices over Tailscale (his private network). There is no
Porthole company server, no subscription, and no use limit.

## 2. Why (the problems it fixes)

- **Lost words.** omp live voice sends speech to an OpenAI realtime model that only *sometimes*
  passes it to the agent; the transcript is never saved. Evidence: vault note
  `10-Knowledge/omp-live-voice-loses-spoken-messages-the-voice-model-must-ch.md`. Porthole keeps every
  word saved on the phone until the computer confirms delivery.
- **Moshi** works but meters its useful features ("20 of 20 free uses left"), routes inbox summaries
  through its own servers (docs: /docs/hooks), lists tmux sessions with a plain `tmux list-sessions`
  probe, so it sees only the default socket ([INFERENCE] from /docs/debug-multiplexer-chooser), and
  builds its watch app for Apple Watch only (/docs/apple-watch). Ben has a Galaxy Watch6. Vault: `30-Decisions/porthole-build-our-own-phone-window-into-agent-sessions-inst.md`.
- **Paseo** was rejected for Thalamus (clunky, always-on daemon model).

## 3. Users, devices, network

- Only Ben. Phone first (Android 17 / SDK 37, portrait, about 412 CSS px wide). The control room must
  also work in a desktop browser on both computers.
- Galaxy Watch6, paired to the phone through Samsung's Galaxy Wearable app (packages verified on the
  phone 2026-10-12). Its Wear OS version is **not verified** (check on the watch before the watch
  phase).
- Network: Tailscale only. Desktop MagicDNS name `bendesk-omarchy.tailafe04c.ts.net` (HTTPS
  certificate available, verified 2026-10-12). Laptop `benacer-omarchy` is on the same tailnet;
  its MagicDNS name is read from `tailscale status --json` at build time, never guessed.
- **Staying connected while out.** Tailscale keeps each computer reachable at one fixed private
  address from any network the phone is on. When the phone changes network the link pauses for a
  second or two and Tailscale finds the new route. Porthole adds auto-reconnect (section 4.13).
  Mosh and Eternal Terminal are not used (decision 10.4).

## 4. Scope

Each feature names the Moshi feature it replaces. "hostd" is `porthole-hostd`, the background
program on each computer.

### 4.1 Machines and sessions (Moshi: saved connections, active sessions, multiplexer integration)
- **Machines** ("saved connections"): the phone app and control room keep a list of computers
  (name + Tailscale HTTPS address). Defaults: desktop and laptop. Add, rename, remove. No passwords
  or keys are stored: access is by Tailscale identity (section 5.4).
- **Sessions** on each machine, found by that machine's hostd:
  - every tmux session on **every** socket in the socket folder (default `/tmp/tmux-<uid>/`;
    Thalamus's design home is `-L thalamus`, session `thalamus`, per vault note
    `30-Decisions/thalamus-runs-in-its-own-tmux-session-separate-from-the-herd.md`; on 2026-10-12 only
    the `default` socket existed, with sessions `0`-`5`), with windows and panes;
  - every herdr workspace, tab and agent pane (`herdr agent list`, which prints JSON by default,
    verified on herdr 0.9.1). The other herdr commands this spec uses (`herdr agent read`,
    `herdr agent prompt`, any herdr attach) are **not yet verified**: only their help text may be
    read on the real herdr. They are proven against a fake `herdr` at the start of P1, and anything
    missing is reported to Ben.
  - Zellij is **not** supported (decision 10.6).
- Each session shows a human name (omp window or pane title with the Braille spinner stripped, else
  the folder name; Thalamus is recognised by its folder `/home/cortex/00-system/thalamus` and pinned
  to the top), where it runs (tmux socket or herdr workspace), and a **status**: working, idle,
  needs you (a question or approval is waiting), done, or live voice on.
- Status sources, most trusted first:
  - omp sessions: the newest `cymatic.session-status` custom entry in the session's `.jsonl`
    transcript (written by `~/.omp/agent/extensions/session-status.ts`), plus events from the
    Porthole omp extension (4.6). The transcript file is found through `/proc/<omp pid>/fd`, and
    the pane-to-session mapping comes from the extension, **never** from "newest file on disk".
  - live voice: a PipeWire source-output with `application.name=omp`, `media.name=voice` and that
    omp's `application.process.id` (same contract as `~/.local/bin/omp-voice`).
  - herdr panes: the state herdr reports (idle, working, done, blocked). Prior art:
    `/home/cortex/00-system/thalamus/repo/tools/question-watch/`.
- **Active sessions**: each device keeps a list of the sessions Ben has open on it, shown at the top
  of the sidebar's Chats/Terminals groups, with a switcher (tap to switch, ✕ to close Porthole's view;
  closing never touches the session itself). The last one reopens on launch, and each one
  reconnects on its own (4.13).
- hostd config (`~/.config/porthole/hostd.json`) sets: the tmux socket folder, the `tmux` and `herdr`
  binaries plus `pactl` (absolute paths, because a systemd user service has a thin PATH, Moshi's most
  common support failure), and the folders it watches for omp transcripts. Tests point these at scratch
  sockets and a fake `herdr`, so a test hostd never sees Ben's real sessions.
- Updates are pushed over hostd's event WebSocket on change. Pull-to-refresh forces a re-scan.

### 4.2 Workspace sidebar (Moshi: workspace sidebar / Jump to)
Ben's reading (2026-10-13): a side panel. It is a permanent column on wide screens and a slide-in
drawer on the phone. Its groups, top to bottom:
1. **Machine switcher** (desktop, laptop), each with a "N need you" badge.
2. **Inbox** (4.6), with its count.
3. **Chats**: agent sessions that have a chat view (omp sessions with a transcript), each with its
   status dot.
4. **Terminals**: every session as a tree. tmux is shown as socket → session → window → pane;
   herdr as workspace → tab → pane. Each row has a status dot. Tapping a row opens it.
5. **Settings**: this device's preferences (machines list, talk mode, read-aloud, gestures,
   notifications, text size).
6. **Config**: things stored on the computer, per machine: custom shortcuts, hostd settings
   (preview port ranges, usage collection), the omp extension status, and a `doctor` page. (The
   machines list itself lives on each device, under Settings.)

### 4.3 Chat view (Moshi: Chat View)
- For an **omp** session: render the conversation from its `.jsonl` transcript, not from the screen.
  Ben's messages (including `live-delegation` custom messages) and the assistant's text show as
  chat bubbles with Markdown (headings, lists, sideways-scrolling tables, code blocks). Tool calls
  collapse to one line each ("ran 3 tools"). Newest is at the bottom; older messages load on
  scroll-up. hostd streams a `backlog` message, then `append` messages, as the transcript grows.
- For a **non-omp** pane (plain shell, other agents, herdr panes with no transcript): show the pane's
  latest screen text (`tmux capture-pane -p -J -S -2000`, or `herdr agent read`) in a large, wrapped,
  monospace block.
- A **message box** (the composer) is pinned at the bottom (4.5), with a **key row** above it:
  `Esc`, `↑`, `↓`, `Enter`, `Tab`, `Stop`, plus Ben's custom shortcuts (4.4). These answer omp's
  question boxes and pickers. `Stop` sends Escape (omp's interrupt). There is **no Ctrl+C button**
  in the chat view.
- If the session is in **live voice** mode, the key row is disabled with the note "Live voice is on
  at the desk: keys go to the live panel (Space mutes, Esc ends it)". Text sending still works
  through the live inbox (4.5).
- **hostd enforces this, not just the screen**: for an omp pane in live voice, hostd refuses every
  key press, shortcut, Stop, and option answer, whoever sends it (chat view, terminal toolbar, inbox,
  notification button, watch). Typed answers to an open question are refused too ("Answer at the
  desk"), because the live inbox would deliver them as a new message, not as the answer. Ordinary
  new messages still go through the live inbox.
- The terminal view of such a pane is read-only with the same note. If live voice turns on while a
  terminal is attached, hostd drops input on that PTY WebSocket from then on.

### 4.4 Terminal view, gestures, shortcuts (Moshi: terminal, gestures, custom shortcuts)
- A real terminal (xterm.js, vendored at a pinned version with its licence) connected over a
  WebSocket to a PTY on the computer running `tmux -L <socket> attach -t =<session>` for tmux. For
  herdr panes, use herdr's own attach if it offers an attachable PTY. Otherwise show a read-only
  screen and say so.
- **Leaving the view detaches only Porthole's own tmux client** (never another client, never
  kill-session). The tmux window size follows the most recent client; that is expected.
- **Toolbar**: Ctrl (double-tap locks it), Esc, Tab, arrows, paste, shortcut panel, text size −/+.
- **Gestures** (phone, remappable in Settings): one-finger horizontal swipe = next/previous tmux
  window or herdr tab; two-finger horizontal = next/previous pane; two-finger vertical = next/previous
  session or workspace; pinch = text size; double-tap = paste; drag up = scroll back. With tmux,
  scrolling becomes mouse-wheel events (needs `set -g mouse on`; hostd's doctor reports if it is off).
- **Custom shortcuts**: buttons Ben defines, stored on hostd so the phone and the control room share
  them. Step syntax, steps separated by commas: `C-b, n` (Ctrl+B then n), `Esc`, `Enter`,
  `text:/clear` (types the text). Key names: Tab, Enter, Esc, Space, BSpace, Up, Down, Left, Right,
  Home, End, PageUp, PageDown. Unknown names are rejected when saved. No count limit.
- Prior art for xterm.js over a PTY: `skill://embed-omp-pty-terminal-in-local-app`, and
  `mission-control` slice 1 (`/home/cortex/00-system/mission-control`). Reuse their approach; do not
  import from those repos.

### 4.5 Sending text: never lose a word (v1 4.4, unchanged in substance)
- The composer keeps a **draft per session** in the device's local storage, written on every
  keystroke. A draft is cleared only after hostd confirms delivery. Sent messages also go into a
  **local "sent" history** (last 50 per session) that can be reopened and copied.
- The composer collects typed text, dictated text (4.12) and attachments (4.8), then sends them
  as one message (Moshi's "chat mode").
- Delivery, chosen per target:
  1. **omp session with a live inbox** (`$XDG_RUNTIME_DIR/omp-inbox/<omp pid>/` exists): write
     `.<clientMsgId>.msg.part`, rename it to `<clientMsgId>.msg`, and confirm delivery when the file
     is gone (the extension consumed it). If it is still there after 30 s, the send is reported as
     `pending` (not failed, never re-written). The client keeps the draft and asks
     `GET /v1/sends/<clientMsgId>` until it turns `delivered`. A repeat of the same `clientMsgId`
     never writes a second file. Works with live voice on. The extension and its proven sender logic are
     parked on idea-board branch `feat/live-inbox` (commit `94bcde4`): `live-inbox/live-inbox.ts`,
     `live-inbox/README.md`, and `deliver()` in `live-inbox/omp-voice`. **Move `live-inbox.ts` into
     this repo** (`omp-extension/live-inbox.ts`) and install it to `~/.omp/agent/extensions/`. Only
     omp sessions started after install have an inbox.
  2. **tmux pane without an inbox**: `tmux send-keys -l` the text, then `Enter`. Refuse (and keep
     the draft) if the pane is an omp in live voice mode.
  3. **herdr pane**: `herdr agent prompt` (plain text). Never send text into a pane that shows a
     question box; tell Ben to use the key row instead.
- Every send has a `clientMsgId` made on the device. hostd records every status change for each id
  in `sent.jsonl`, so a retry after a dropped connection (or a hostd restart) is answered from that
  record and never delivered twice. A `pending` send becomes `failed` (draft kept) if its omp process
  exits. Ids that ended `refused` or `failed` may be retried. Statuses: `delivered`, `pending`, `refused` (with the reason, e.g.
  live voice or a question box is showing), `failed` (with the reason).
- On anything but `delivered` the draft stays, and the screen says what happened in plain words.
- `sent.jsonl` lives at `~/.local/state/porthole/sent.jsonl` (mode 0600) and holds the text of
  delivered messages, so nothing is lost even if the phone is.

### 4.6 Inbox and inbox actions (Moshi: agent inbox, inbox actions)
- One feed across all machines, in three columns: **Needs you / Working / Done**. Items are grouped
  by project folder, then machine. Each session has at most one live item; new events update it.
- Item lifetime (Moshi's numbers): "needs you" stays until answered; a "done" item is archived 10
  minutes after it finished; any item is archived after 6 hours. Swipe to archive. Archived items
  leave `/v1/inbox` and stay in an archive list for 7 days.
- Event sources:
  - **Porthole omp extension** (`omp-extension/porthole-events.ts`, installed to
    `~/.omp/agent/extensions/`). It reports session start (with the pane it runs in and its
    transcript path), each question it asks Ben (the `ask` tool: question text, options, whether
    several can be picked), when that question closes (answered at the desk, by Porthole, or
    cancelled), turn finished, and session end. It posts to hostd over a Unix socket at
    `$XDG_RUNTIME_DIR/porthole/events.sock` (mode 0600). It must never block or slow omp: if hostd is
    down, events are dropped and omp carries on.
  - herdr agent states (blocked → needs you, working, done).
- **Actions** on an item: open the session; answer a question by tapping one of its options;
  type a free answer; Stop. Answers go to the live pane by key presses (arrows + Enter, or the text)
  **only** when hostd confirms that the pane still shows that same question: the extension reported
  the question open (by its question id) and has not reported it closed. Otherwise the item becomes
  read-only with "Answer this in the terminal". Live-voice panes: see 4.3.
- **Multi-select questions**: in the app, options are ticked and then sent with Submit. On
  notifications and the watch they show only Open.
- **Context left**: when the transcript reports it, each item shows a ring for the context window
  that is left, warning below 15%.

### 4.7 Push notifications (Moshi: push notifications, unified push)
- hostd sends a notification when an item becomes "needs you" or a turn finishes. A notification
  carries a short summary only (title up to 80 characters, body up to 200), never a transcript.
  Limit: 60 notifications per minute per machine.
- Buttons on the notification: **Open**, plus up to two answer options when the question has two or
  three options. Tapping a button sends the answer (4.6 rules apply) without opening the app.
- Notifications from both computers reach the phone. Android shows phone notifications on the
  Galaxy Watch6, including action buttons [INFERENCE: standard Wear OS notification bridging,
  confirmed on Ben's watch in phase P5].
- **Delivery route: Porthole's own connection** (decision 10.3, Ben 2026-10-13). No ntfy, no
  KDE Connect, no Google:
  - The Android app runs a foreground service (an Android background task that shows a small
    permanent "Porthole is connected" notification). It keeps one `/v1/events` WebSocket open to each
    machine in its list, with the reconnect rules of 4.13. The builder picks the foreground-service
    type Android 17 requires and records why.
  - hostd sends each notification on that socket as a `notify` message with an id. The app shows
    it with its buttons and replies `ack`. hostd keeps unacknowledged notifications per device (up to
    100, for 24 h, oldest dropped first) and sends them again when that device reconnects, so nothing
    is missed while the phone was out of signal. An acknowledged id is never shown twice.
  - Each machine notifies the phone directly, so the laptop does not depend on the desktop.
  - Battery: one always-open connection per machine. Ben sets Porthole's battery setting to
    "Unrestricted" once, so Android does not cut it off. The extra battery use is a **GUESS** until
    measured in P4.

### 4.8 Remote image paste and file sharing (Moshi: image paste, file sharing)
- From the composer: camera, photo picker, file picker, or clipboard image. From any Android app:
  **Share → Porthole** (the Android share sheet).
- The file is uploaded over HTTPS to the hostd of the session's machine and saved to
  `~/.local/state/porthole/uploads/<YYYY-MM-DD>/<safe-name>` (files 0600, folders 0700). Its full path
  is inserted into the composer, so the agent reads it from disk. Files never leave Ben's devices.
- `<safe-name>`: the original name with anything other than letters, digits, `.`, `-` and `_`
  replaced by `_`, leading dots removed, cut to 100 characters, and prefixed with the time
  (`HHMMSS-`). A name left empty (e.g. all dots) becomes `upload`. A clash adds `-2`, `-3`, … Paths
  are checked to stay inside the uploads folder.
- Limit: 50 MB per file. Uploads older than 30 days are deleted by hostd.

### 4.9 Diff viewer (Moshi: diff viewer)
- A "Changes" button on a session opens what changed in that session's folder. The folder is the
  pane's current path: tmux `#{pane_current_path}`, or the herdr pane's cwd.
- hostd runs git so that it can neither take locks nor run repo-configured programs: every call
  has `GIT_OPTIONAL_LOCKS=0` in its environment and
  `-c core.fsmonitor=false -c diff.external= --no-ext-diff --no-textconv` (the last two where the
  command takes them). Commands: `status --porcelain=v2`, `diff`, `diff --cached`, and the untracked
  file list. Repo filters (e.g. git-lfs) are switched off too: for each driver in
  `git config --get-regexp '^filter\.'`, hostd adds `-c filter.<name>.process= -c filter.<name>.clean=`
  `-c filter.<name>.smudge=` and `-c filter.<name>.required=false`. A live agent's commit therefore never collides with Porthole. Staged, unstaged and untracked files are listed
  separately. A tap shows the diff: unified on the phone, side-by-side on wide screens. Binary files
  are listed, not shown. The button shows a badge when uncommitted changes exist (`dirty` in the session data, 5.2).
- Not a git repo: the button is greyed out with "No git repo here".

### 4.10 Web preview (Moshi: browser preview)
- hostd lists HTTP servers listening on the computer. It probes ports from a configured list
  (default `3000-3999,4000-4999,5000-5999,8000-8999`, editable in Config; `none` turns it off). Each
  shows its process name, PID and port.
- **Only proxy what was found.** A port can be previewed only if it is inside the configured ranges
  **and** was found by the latest scan. These are always refused, whatever the config says:
  8795-8796 (Thalamus mailbox, ntfy), hostd's own configured ports (8797, 8798 by default) and any
  test hostd's port, 9222-9225 (Chrome remote-debugging ports), 8443, and any port below 1024.
- Tapping one opens it in a separate in-app browser on the phone (one with **no** JS bridge, 4.16),
  or a new tab on the control room.
- How: hostd runs a second loopback listener, the **preview proxy** (127.0.0.1:8798), published by
  `tailscale serve` on HTTPS port 8443. Opening a preview hits `/__porthole/preview?port=N`, which
  sets a cookie. From then on that device's requests (including WebSockets, for hot reload) are
  proxied to `127.0.0.1:N` unchanged, so pages that use absolute paths still work. One preview at a
  time per device. The Tailscale identity and node check of 5.4 applies (preview pages cannot send
  `X-Porthole`). Preview pages are a different origin from the control room (port 8443 vs 443), and
  the API rejects them (5.4).

### 4.11 Agent usage (Moshi: agent usage)
- Shows how much of Ben's Claude usage limits is used: the 5-hour and 7-day windows, with the time
  each resets and when the numbers were last read. Refresh about once a minute, or pull to refresh.
- Source: **not yet verified.** The builder must find a real source on the computer that reports
  these numbers using credentials already present, without storing any new secret. Candidates:
  omp's own usage reporting, or what Claude Code's `/usage` reads. If none exists, stop and ask Ben.
  Never show a made-up or estimated number. Hidden when Config → "usage collection" is off.
- Watch complication: the highest used % across the windows (4.14).

### 4.12 Talk mode (v1 4.5; Porthole's own voice loop and summary read-aloud confirmed by Ben 2026-10-12 and again 2026-10-13)
- A mic button on the chat view. Tap to start, tap to stop, with optional auto-stop after about 2 s of
  silence. The app records 16 kHz mono WAV (the phone app records natively; the control room uses
  `getUserMedia`/`MediaRecorder` and converts in the browser) and uploads it to hostd.
- hostd transcribes with `voxtype transcribe <file.wav>` (local Whisper, no per-use cost; the v1
  spec records voxtype 1.1.0 and this command as checked on 2026-10-12: **GUESS** for v2, not
  re-checked; confirm with `voxtype --version` and `voxtype transcribe --help` at P2 start), then
  optionally cleans the text with `voxflow enhance` (check its stdin/stdout contract in
  `~/.config/voxflow/config.toml`). The audio is deleted after a successful transcription. If it
  fails, the audio is kept (0600, `~/.local/state/porthole/audio/`) for 30 days so the words can be
  recovered; Config lists the kept files.
- Limits: 25 MB per recording (about 13 minutes at 16 kHz mono). Transcriptions run one at a time.
  voxtype's own daemon has crashed before from running out of graphics-card memory (VRAM). So before
  the first P2 transcription, the builder checks whether `voxtype transcribe` loads a second model
  onto the graphics card while the daemon is running (watch `nvidia-smi` memory). If it does, it uses
  voxtype's CPU mode, or stops and asks Ben.
- The text lands in the composer first. In talk mode it **auto-sends** after transcription (toggle
  in Settings), using 4.5. A transcription history (last 50) is kept on the device.
- **Reply read aloud** (summary only): when the session's next assistant reply finishes, the device
  speaks the first paragraph plus the numbered titles under `## Needs your decision`. It uses
  Android's text-to-speech in the phone app, and the browser's `speechSynthesis` in the control room.
  A "Read all" button speaks the whole reply minus tables and code. Tapping the speaker stops it.
- Porthole **never** starts, stops or changes omp's own `/live` mode, voxtype's daemon, or any
  microphone routing on the computers. Desktop live voice (Quick Ask) keeps working exactly as
  before.
- Dictation is local only (decision 10.5): no cloud speech engine and no API keys.

### 4.13 Reconnect and auto-reattach (Moshi: auto-attach after reconnect)
- Every live connection (events, terminal, chat stream) reconnects by itself: right away when Android
  reports a network change, then with backoff (1, 2, 4 … capped at 15 s).
- On reconnect the terminal re-attaches to the **same** tmux session or herdr pane, and tmux repaints
  the screen. The chat view asks for messages after the last one it holds. Nothing typed is lost,
  because drafts live on the device (4.5).
- A thin status strip shows "Reconnecting…" while the link is down. Sending is held, not dropped,
  and goes out when the link is back.

### 4.14 Galaxy Watch6 app and complications (Moshi: Apple Watch app)
- A Wear OS app (Kotlin, Compose for Wear OS Material 3). Screens:
  - **Inbox**: "needs you" items from both computers. Tap an item to see the question and its
    options, then answer with one tap or Stop.
  - **Usage**: the 4.11 numbers.
- Complications that any watch face accepting third-party complications can show (types per the
  Samsung custom-complication guide, developer.samsung.com 2025-09-09; the full Android type list was
  not read, so check it at the start of P5):
  - **ranged value**: the highest usage %;
  - **short text**: "N waiting" (needs-you count). Tapping it opens the Inbox.
- The watch has no Tailscale client (Tailscale does not support Wear OS; issue #3972 still open,
  checked 2026-10-12). So the **phone app relays**: it sends state to the watch and receives answers
  from it over the Wearable Data Layer (DataClient for state, MessageClient for answers).
- No terminal, no paste and no dictation on the watch (same boundary as Moshi's watch app).

### 4.15 Desktop control room (Moshi: Moshi Desktop)
- hostd serves the control room at `/` on each computer. It is the same screens the phone app shows
  (approach A, decision 10.1), laid out for a wide window with the sidebar always visible. It opens
  in any browser on the desktop or the laptop.
- **Both machines in one view** (decision 10.12): the page (or the phone app) talks to every machine in its list
  directly: one event WebSocket per machine, and requests to each machine's `/v1` API. hostds never
  talk to each other. The inbox, the badges and the sidebar merge what each machine reports. Each
  hostd accepts calls from its own control-room origin and from the origins of the machines in its
  config `peers` list (exact `https://<name>.ts.net`, port 443), and from nothing else (5.4).

### 4.16 Android app (approach A)
- A native Android app (Kotlin). It shows the shared screens from the machine's hostd in a WebView,
  and does natively only what a web page cannot:
  - the always-connected service and notifications with action buttons (4.7);
  - the Android share target (4.8), and camera/photo/file pickers;
  - the microphone recording and text-to-speech (4.12);
  - noticing network changes to reconnect quickly (4.13);
  - the watch relay over the Wearable Data Layer (4.14);
  - the machines list (4.1).
- The WebView talks to the native side through one small JavaScript bridge with named methods (no
  generic "run anything" call). It is installed with `addWebMessageListener` and an exact-origin
  rule: `https://<machine>.ts.net` (port 443) for each configured machine, nothing else. Previews
  (4.10) and any other page open in a separate WebView or Custom Tab that has no bridge.
- Installed by Ben as a debug build (no Play Store). Package name `ai.porthole.app`
  (**GUESS**: a working name; Ben may rename it).
- When the app calls a hostd from native code (share target uploads, push registration), it sends
  the same `Origin` and `X-Porthole` headers the pages send (5.4).

## 5. Architecture

### 5.1 Pieces
- **hostd** (`server/`): TypeScript on Bun (`/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun`,
  1.4.2 on 2026-10-12). It binds **127.0.0.1 only** (or owner-only Unix sockets, 5.4): port 8797
  for the app/API and 8798 for the preview proxy. Each module has one job: `sessions` (discover tmux/herdr + status), `transcript`
  (read omp `.jsonl`), `screen` (pane text), `deliver` (4.5), `pty` (terminal WebSocket), `events`
  (Unix socket + inbox state), `push` (4.7), `uploads` (4.8), `diff` (4.9), `preview` (4.10),
  `usage` (4.11), `voice` (4.12), `shortcuts`, `auth` (5.4), `doctor`.
- **Shared screens** (`web/`): plain HTML/CSS/JS served by hostd, with no build step unless one is
  clearly needed. xterm.js and any Markdown library are vendored at pinned versions with their
  licences kept, not loaded from a CDN. Designed with `skill://impeccable`.
- **omp extensions** (`omp-extension/`): `live-inbox.ts` (4.5) and `porthole-events.ts` (4.6).
- **Android app** (`android/app`) and **Wear OS app** (`android/wear`): one Gradle project, Kotlin.
- **Systemd user units**: `porthole.service` (hostd, enabled, `Restart=on-failure`, starts at login
  like `thalamus-mailbox.service`). User linger is off; that is acceptable.

### 5.2 API contract (all JSON; one version prefix `/v1`)
Every `/v1` HTTP request carries the `X-Porthole: 1` header (WebSockets cannot, and rely on the
exact `Origin`, 5.4; CORS preflight `OPTIONS` requests are exempt from the header but still need an
allowed exact `Origin`). Request bodies are `application/json`, except uploads (`multipart/form-data`),
voice (`audio/wav`), and `DELETE` (no body).
- `GET /v1/machine`: this machine's name, hostd version, feature health.
- `GET /v1/sessions`: the session tree (4.1), including per session `status`, `liveVoice`, `cwd`
  and `dirty` (uncommitted git changes, 4.9). `WS /v1/events?device=<name>&since=<notifyId>`:
  session, status and inbox changes pushed on change, plus `notify` messages (4.7) that the client
  answers with `{type: "ack", id}`.
- `GET /v1/sessions/:id/chat?after=<cursor>` and `WS /v1/sessions/:id/chat`: `backlog`, then
  `append`.
- `GET /v1/sessions/:id/screen`; `WS /v1/sessions/:id/pty`.
- `POST /v1/sessions/:id/send` `{text, clientMsgId}` →
  `{status: delivered|pending|refused|failed, reason}`; `GET /v1/sends/:clientMsgId` → same shape.
- `POST /v1/sessions/:id/keys` `{keys: [...]}` (key row and shortcuts); refused for live-voice
  panes (4.3).
- `GET /v1/inbox`; `GET /v1/inbox/archive` (last 7 days);
  `POST /v1/inbox/:itemId/answer` `{optionIndexes: [..] | text}`; `POST /v1/inbox/:itemId/archive`.
- `POST /v1/uploads` (multipart) → `{path}`. `POST /v1/voice` (WAV) → `{text}`;
  `GET /v1/voice/kept` (failed recordings kept for recovery).
- `GET /v1/sessions/:id/diff`; `GET /v1/previews` (each with its open URL
  `https://<machine>.ts.net:8443/__porthole/preview?port=N`); `GET /v1/usage`;
  `GET|PUT /v1/shortcuts`; `GET|PUT /v1/config` (preview ranges, usage collection, peers);
  `GET /v1/doctor`.
- Session ids are stable strings, e.g. `tmux:<socket>:<session>:<window>.<pane>` and
  `herdr:<workspace>:<tab>:<pane>`.

### 5.3 Reaching it
- `tailscale serve` publishes `https://<machine>.ts.net/` → `http://127.0.0.1:8797` and
  `https://<machine>.ts.net:8443/` → `http://127.0.0.1:8798` (or the Unix sockets of 5.4), in the background/persistent form so it
  survives restarts. If a command needs root or an operator setting, **stop and hand Ben the exact
  command** (never ask for his password).

### 5.4 Who may use it
- **Only Ben's own Tailscale devices.** Behind `tailscale serve`, hostd reads the identity headers
  Tailscale adds (`Tailscale-User-Login`, and the node identity if available). It allows only Ben's
  login (`bengovernale@`, per `tailscale status`) **and** an allowlist of node names: `bencell`,
  `benacer-omarchy`, `bendesk-omarchy`. Verify at build time which headers `tailscale serve` really
  sets. Anything else gets 403. No passwords.
- **Web pages cannot borrow that identity.** `tailscale serve` adds Ben's headers to every request
  from his devices, including ones a random web page in his browser makes. So hostd also requires:
  - on every `/v1` HTTP request, the `X-Porthole: 1` header (browsers must ask permission first for
    a custom header, and hostd never grants it to other sites);
  - on every non-GET HTTP request **and every WebSocket upgrade**, an `Origin` that exactly matches
    this machine's control-room origin `https://<machine>.ts.net` (port 443) or one of its `peers`
    (4.15). Browsers cannot put custom headers on WebSockets, so the exact `Origin` is the check
    there. Preview pages (port 8443) and every other site fail it.
  - CORS headers are sent only to those same exact origins. Preflight `OPTIONS` requests are exempt
    from `X-Porthole` but still need an allowed exact `Origin`.
- **Local programs (decision 10.13).** `tailscale serve` forwards to hostd on this computer,
  so hostd must tell a forwarded request from a local program that fakes the headers:
  - At P1 start the builder checks whether `tailscale serve` can forward to a Unix socket, and
    whether Bun can read the connecting process's user (`SO_PEERCRED`). If both work, hostd listens
    on Unix sockets in `$XDG_RUNTIME_DIR/porthole/` (folder 0700) and trusts identity headers only
    from a connection owned by root (uid 0, `tailscaled`). Every other local connection must carry
    the local token.
  - If either does not work, hostd listens on 127.0.0.1 and the limit is written down in the README:
    any program already running as Ben could fake the headers, which is no worse than what such a
    program can already do (type into his sessions with `tmux send-keys`).
  - Local tools and tests use a token file (`$XDG_RUNTIME_DIR/porthole/local-token`, 0600), sent as
    `X-Porthole-Local`; a request with that token skips the identity check, but still needs
    `X-Porthole` and, where 5.4 requires it, the exact `Origin`.
- The omp extension's events socket is owner-only (0600 in a 0700 folder).
- Each request's device and action is logged to `~/.local/state/porthole/access.log` (0600). Message
  text is never logged there.

## 6. Non-goals

Everything Apple (iOS, macOS, Apple Watch, iCloud sync, Live Activity, Dynamic Island); custom
themes; custom fonts; biometric key protection; Mosh and Eternal Terminal; Zellij; cloud or
bring-your-own-key dictation; Moshi's cloud pastebin (files stay on Ben's computers); simulator
preview; starting or killing sessions; Moshi/Paseo integration; using OpenAI realtime; changing
Thalamus's restart setup (separate work: vault note
`30-Decisions/thalamus-runs-in-its-own-tmux-session-separate-from-the-herd.md`); the T3 keyboard mod
in `omp-voice` (stays parked on `feat/live-inbox`); a Play Store listing; iPhone support.

## 7. Safety rules for the build itself

- **Never type into, attach to, resize, detach or restart Thalamus (believed to be tmux session `1`
  today: **GUESS**, it was the only attached session on 2026-10-12), any herdr helper, or any other
  real session while testing.** Use scratch tmux servers
  (`tmux -L porthole-test`) with fake panes, like the crash-routing and question-watch tests in
  `/home/cortex/00-system/thalamus/repo/tools/`. Use a fake `herdr` on PATH for herdr tests.
- Never start omp live voice to test anything (it uses the desk microphone and a paid realtime
  connection). Test talk mode with a pre-recorded WAV.
- No adb or phone screenshot loops: they cost about 58M tokens in an earlier build. Check screens in a
  phone-sized **headless browser on the desktop** (`skill://verify-web-ui-headless-cdp`). Then ask Ben
  for one real-phone check.
- **Installing on the phone or watch needs Ben's OK at that moment** (Ben, 2026-10-13: "later").
  Allowed adb use otherwise: read-only queries. Watch pairing over Wi-Fi needs Ben to read the code
  off the watch.
- One real omp test run is allowed per omp extension: a throwaway
  `omp --no-extensions -e <extension.ts> --no-session --model haiku` session in a temp folder (this is
  how live-inbox was proven, about 9 cents). P2.1 and P2.9 share one run. P4.3 has one more
  throwaway run (about 10 cents) for its scratch session.
- Every test hostd runs with config overrides (4.1): a scratch tmux socket folder, a fake `herdr`,
  a fake `pactl`, fixture transcript folders, and a test port. A test hostd must never list Ben's
  real sessions. The one exception is P1.5: it runs against the installed hostd behind
  `tailscale serve`, and calls only `/v1/machine` and the auth checks.
- Never restart `tailscaled` and never remove or change existing `tailscale serve` entries. Porthole
  only adds its own two entries, after reading `tailscale serve status`.
- `porthole-events.ts` and `live-inbox.ts` load into **every** new omp session once installed to
  `~/.omp/agent/extensions/` (Thalamus included, next time it starts). Install each only after its
  throwaway-omp test passes, and tell Ben in that turn's report.
- Kill only exact PIDs you started. No `pkill`/`killall`.
- Android tooling (JDK 17, Android SDK) is installed into Ben's home folder without sudo (Ben said
  yes 2026-10-13). Nothing system-wide; no Zellij install.
- No secrets in the repo. Commit and push your own branch after each checked step to the private
  remote `origin` (https://github.com/CymaticStatic/porthole, approved by Ben 2026-10-12, created
  2026-10-12). Never change the repo's visibility. Merge into `main` only when Ben asks, after a
  conflict check.
- The laptop install (phase P6) is done only after Ben OKs it at that time.

## 8. Build phases and acceptance

Backend first (Ben: "the backend is priority"). Each acceptance item needs evidence: command
output, a test, or a screenshot from the headless browser.

**P1. hostd core (desktop)**: sessions, status, chat stream, screen, send, keys, PTY, auth, access
log, systemd unit, tailscale serve, `live-inbox.ts` moved in and installed.
1. A test hostd (scratch socket folder, fake `herdr`) lists every scratch tmux session on two
   sockets and a fake herdr pane, with the right statuses driven by fixture `.jsonl` and
   PipeWire-like inputs.
2. The chat stream returns a fixture omp transcript as `backlog`, then `append` when a line is
   added.
3. Sending to (a) a throwaway omp with the live inbox, (b) a scratch tmux pane, and (c) a fake herdr
   target each delivers exactly once, including when the same `clientMsgId` is sent twice. A forced
   failure returns `failed` with a plain reason.
4. The PTY attaches to a scratch session and accepts input. Closing it detaches only its own client
   (`tmux list-clients` before/after).
5. Run against the installed hostd (port 8797), calling only `/v1/machine` and the auth checks (it
   never lists or touches sessions in this test). Requests through `tailscale serve` from an allowed
   device get 200. A wrong-login or wrong-node identity gets 403 (tested with injected headers: a
   direct request in 127.0.0.1 mode, a unit test of `auth` in Unix-socket mode). A non-GET with the wrong `Origin`,
   an HTTP request without `X-Porthole`, and a WebSocket upgrade with a preview origin (port 8443) or
   a foreign origin each get 403. In Unix-socket mode only: a local connection not owned by root
   that sends identity headers without the local token gets 403. The local token works in both
   modes.
6. `systemctl --user is-enabled porthole.service` says `enabled` (`WantedBy=default.target`), and
   the service comes back after `systemctl --user restart porthole.service`. `tailscale serve status`
   shows Porthole's two entries in its persisted config (no `tailscaled` restart).

**P2. hostd features**: events extension, inbox, push, uploads, diff, preview proxy, usage, voice,
shortcuts, doctor.
1. With `porthole-events.ts` loaded in a throwaway omp running inside a `tmux -L porthole-test` pane
   (one run, shared with item 9), an `ask`
   question appears in `/v1/inbox` with its options and closes when answered. Answering option 2 on a
   scratch pane that shows the same open question presses the right keys. A closed question is
   refused as read-only.
2. Inbox lifetimes with a fake clock: a done item is archived after 10 min, any item after 6 h, and
   archived items leave `/v1/inbox`.
3. A "needs you" item produces exactly one `notify` message on a test client's `/v1/events` socket,
   carrying the item id, summary and options. Not acknowledged, it is sent again after the client
   reconnects; acknowledged, it is not. The 61st notification in a minute is held back.
4. An upload lands under `uploads/<date>/` with mode 0600 and its path is returned; 51 MB is refused.
5. The diff for a scratch git repo lists staged, unstaged and untracked files correctly; a non-repo
   says so.
6. A scratch HTTP server on a listed port appears in `/v1/previews` and is reachable through the
   preview proxy, including a WebSocket. Ports 8795 and 9224, and a port not found by the scan, are
   refused.
7. `/v1/usage` returns real numbers from the verified source, or the phase stops with a question to
   Ben.
8. A pre-recorded 16 kHz WAV returns the right text through `voxtype transcribe`. A failed
   transcription keeps the audio file.
9. omp is never slowed: in the same run as item 1, after hostd is stopped, the throwaway omp still
   answers normally.
10. With a fake `pactl` reporting live voice on a scratch omp pane: `keys`, Stop, option answers and
    typed answers are refused with a plain reason; input on an already-open PTY WebSocket is
    dropped; a new message still goes through the live inbox.
11. Before transcribing, the VRAM check in 4.12 is done and its result reported.

**P3. Shared screens / control room** (design with `skill://impeccable`): sidebar, chat, terminal with
toolbar, gestures and shortcuts, composer with drafts and attachments, inbox, diff, preview list,
usage, talk mode, settings, config, reconnect strip.
1. At 412 px wide in the headless browser: the sidebar drawer, a fixture chat (user, assistant with a
   table, a `live-delegation` message, collapsed tool calls), the inbox and a diff are all readable.
2. Reloading mid-draft keeps the draft. A failed send keeps the draft and shows why.
3. Cutting the event WebSocket shows "Reconnecting…", then recovers by itself, and the terminal
   re-attaches to the same session.
4. With `speechSynthesis` replaced by a recording stub, a fixture reply makes the page speak exactly
   its first paragraph plus its decision titles.

**P4. Android app** (after installing the toolchain).
1. `./gradlew :app:assembleDebug` builds on the desktop.
2. Unit tests cover the JS bridge allowlist (pages from unknown origins get no bridge) and the
   reconnect backoff.
3. With Ben's OK at the time, a debug build goes on bencell. Ben checks, against a scratch session
   made for the test (not Thalamus): open the desktop, send one typed and one spoken message, hear
   the summary, share a photo into the session, answer one notification button, and switch the phone
   from Wi-Fi to mobile data mid-session. Reading Thalamus's chat view (read-only) is also checked.
   The scratch session is one extra throwaway omp run (haiku, about 10 cents) so a reply exists to
   read aloud.

**P5. Galaxy Watch6 app.**
1. `./gradlew :wear:assembleDebug` builds. Complication previews render (`getPreviewData`).
2. With Ben's OK and his pairing code, it is installed on the watch. Ben checks: the complication
   shows usage % and "N waiting", an answer from the watch reaches a scratch session, and a phone
   notification's buttons appear on the watch.

**P6. Laptop.** With Ben's OK at the time: hostd and its units are installed on `benacer-omarchy`,
and each hostd's config `peers` lists the other machine's origin.
The phone app and both control rooms switch between the two machines, and the inbox shows items from
both.

## 9. Open decisions for Ben (do not block P1 on these)

1. Android package and app name: `ai.porthole.app` / "Porthole" are working names.

## 10. Decision log

1. **Phone app: approach A** (Ben, 2026-10-13): native Android app that reuses the control room's screens in a
   WebView. Rejected: B, fully native screens (everything built twice); C, a home-screen web page
   only (the watch cannot reach it).
2. **Helper models**: Anthropic only (Ben, 2026-10-12). Rejected: GPT only, both.
3. **Push route: Porthole's own always-open connection** (Ben, 2026-10-13: "porthole"). Rejected:
   - KDE Connect: checked 2026-10-13 (`kdeconnect-cli --list-devices`): 26.08.1 runs on the desktop,
     and the Pixel is paired and reachable at its Tailscale address (100.120.182.107; the tool labels
     the link "LAN"). But its desktop-to-phone message (`kdeconnect.ping`) is plain text with no
     buttons, and [INFERENCE] another app cannot receive KDE Connect messages without its own copy of
     the protocol (github.com/KDE/kdeconnect-meta, `protocol-schemas/protocol.md`).
   - ntfy + UnifiedPush through Ben's private ntfy: Google-free and lighter on battery, but one more
     moving part between Porthole and the phone.
   - Google push: needs a Google project and goes through Google.
4. **No Mosh / ET** (Ben, 2026-10-12: "whatever Moshi uses ... I would like to be able to reconnect").
   Tailscale + auto-reconnect + tmux covers it; browsers and WebViews cannot speak Mosh's UDP.
5. **Dictation**: local voxtype only (Ben, 2026-10-12). Rejected: bring-your-own-key cloud, phone
   keyboard only.
6. **Zellij dropped** (Ben, 2026-10-13: "don't install, I don't think I'll need it").
7. **Machines**: desktop and laptop (Ben, 2026-10-12). Rejected: desktop only.
8. **Kept features** (Ben, 2026-10-12): tmux/herdr sessions, auto-reattach, workspace sidebar, image
   paste, file sharing, diff viewer, web preview, push, terminal gestures, saved connections, custom
   shortcuts, inbox actions, active sessions, agent usage, Galaxy Watch6 with complications.
   Dropped: themes, fonts, biometrics, iCloud sync, everything Apple.
9. **Sidebar groups** (Ben, 2026-10-13): machines, inbox, chats, terminals, settings, config.
10. **Talk mode: Porthole's own voice loop, and summary read-aloud, confirmed** (Ben, 2026-10-12: "2. both"; again
    2026-10-13: "8 both"). Rejected: piping the phone into omp's OpenAI live voice.
11. **Toolchain** install in the home folder: yes (Ben, 2026-10-13). **Device installs**: ask at the
    time (Ben, 2026-10-13). **GitHub**: private `CymaticStatic/porthole` (Ben, 2026-10-12; again
    2026-10-13).
12. **Both machines in one view** (Ben, 2026-10-13: "keep as written"): the page and the phone app
    call each machine directly and merge the results (4.15). Rejected: one hostd fetching from the
    other (machine-to-machine trust, single point of failure).
13. **Local programs** (Ben, 2026-10-13: "accept this"): if hostd cannot prove a request came
    through `tailscale serve` (5.4), the limit is written down instead.
