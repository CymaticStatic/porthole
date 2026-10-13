# Porthole

Ben's private window into the coding-agent sessions running on his two Linux computers (desktop `bendesk-omarchy`, laptop `benacer-omarchy`). The full design is `docs/SPEC.md`.

## What hostd is

`hostd` (`server/`) is the small background program that runs on each computer. It is TypeScript on Bun and listens on `127.0.0.1` only (port 8797). It finds the tmux and herdr sessions on the machine, reads omp's transcripts, shows pane screens, delivers typed messages exactly once (over omp's live inbox, tmux or herdr), relays a terminal over a WebSocket, and tells the phone or the browser when anything changes. Everything reaches it through `tailscale serve` over Ben's own Tailscale network. There is no Porthole company server.

## Running hostd

All paths below are for the desktop; run the commands from the repo root.

Write the first config (reads this machine's name from `tailscale status --json`; an existing file is kept, never overwritten). `PORTHOLE_CONFIG` overrides the path and `--tailscale <path>` the tailscale binary:

```bash
bun run server/src/main.ts init-config
```

Snapshot the committed `HEAD` into `~/.local/share/porthole/hostd/<sha>` (symlinked as `current`) and install `~/.config/systemd/user/porthole.service`. No sudo; it does not start anything:

```bash
bash deploy/install.sh
```

The same, then enable and start the service (only after Ben says yes):

```bash
bash deploy/install.sh --enable
```

Publish hostd on the tailnet. This only ever adds `tailscale serve` entries (`https://<machine>/` to `127.0.0.1:8797`, `https://<machine>:8443/` to `127.0.0.1:8798`), prints the status before and after, and refuses, changing nothing, when a port is already held by something else:

```bash
bun run deploy/serve.ts
```

Where things live:

| What | Where |
| --- | --- |
| Config | `~/.config/porthole/hostd.json` (0600; override with `PORTHOLE_CONFIG`) |
| Sent-message record (`sent.jsonl`) | `~/.local/state/porthole/sent.jsonl` |
| Access log (`access.log`; no message text, no query) | `~/.local/state/porthole/access.log` |
| Local token | `$XDG_RUNTIME_DIR/porthole/local-token` (0600; lives only until logout or reboot) |

Live auth check against the installed service and its serve entry (calls only `/v1/machine` and the refusal checks; `--ping` only asks `/v1/machine`):

```bash
bun run server/test/live/auth-live.ts
```

Tests: `bun run typecheck`, then `cd server && bun test`.

## Security limit of 127.0.0.1 mode

hostd listens on 127.0.0.1, so any program running as cymatic or root on this machine can reach it with the local token file, or by sending Tailscale identity headers directly. Unix-socket mode with peer checks is not possible in Bun 1.4.2: `Bun.serve` exposes no peer uid (Verified facts 5).

## Identity

Behind `tailscale serve`, hostd reads the identity headers Tailscale adds and allows only Ben's login and his allowlisted node names. It takes the node from the last `X-Forwarded-For` entry. When `singleForwardedFor` is true in the config, it refuses any request that carries more than one entry; set that to true only after `auth-live.ts` shows that `tailscale serve` writes a single entry. Every `/v1` request also needs `X-Porthole: 1` and, for browsers, an exact allowed `Origin` (SPEC 5.4).

## P2 features

P2 adds the features below to hostd (`server/src/features/`). All of them answer on the same loopback API port (8797) except the preview proxy. Every `/v1` request needs `X-Porthole: 1` and the identity rules above.

| Endpoint | What it does |
| --- | --- |
| `GET /v1/inbox`, `GET /v1/inbox/archive` | Needs-you / working / done items, built from omp events and herdr statuses. Closed items archive on their own. |
| `POST /v1/inbox/:itemId/archive` | Move one item to the archive. |
| `POST /v1/inbox/:itemId/answer` | Answer an open omp `ask` question by pressing keys in its pane: `{"optionIndexes":[n]}` (single-select only) or `{"text":"..."}`. Refused (409) for a closed question, a multi-select or multi-question dialog, a pane whose omp is not the one that asked, or typed text while live voice is on. |
| `POST /v1/uploads` | Multipart upload (field `file`, at most 50 MB); answers `{path}`. |
| `GET /v1/sessions/:id/diff` | What changed in the session's folder (staged, unstaged, untracked). Git runs without taking locks or running repo-configured programs. |
| `GET /v1/previews` | Dev servers found on this computer (see "Preview proxy"). |
| `GET /v1/usage` | Claude 5-hour and 7-day usage windows (see "Usage"). |
| `POST /v1/voice`, `GET /v1/voice/kept` | Speech to text for a 16 kHz mono WAV (see "Voice"). |
| `GET /v1/shortcuts`, `PUT /v1/shortcuts` | Saved key sequences (see "Shortcut steps"). |
| `GET /v1/config`, `PUT /v1/config` | The settings the app may change: `previewRanges`, `usageCollection`, `peers`, `voiceEnhance`. A changed `peers` list takes effect only after a restart (the answer says `restartNeeded: true`). |
| `GET /v1/doctor` | Read-only health checks (see "Doctor"). |
| `GET /` and the files under `web/` | The control-room page, served from hostd's own origin. A missing `web/` folder serves nothing and does not stop hostd from starting. |

Where P2 keeps its files:

| What | Where |
| --- | --- |
| Uploads | `~/.local/state/porthole/uploads/<YYYY-MM-DD>/` (files 0600, folders 0700; deleted after 30 days) |
| Recordings whose transcription failed | `~/.local/state/porthole/audio/` (0600; kept 30 days) |
| Inbox and its archive | `~/.local/state/porthole/inbox.json` |
| Notification queue (replayed to a device until it acknowledges) | `~/.local/state/porthole/notify.json` |
| Shortcuts | `~/.local/state/porthole/shortcuts.json` |
| Events socket (omp extension to hostd) | `$XDG_RUNTIME_DIR/porthole/events.sock` (0600) |

### Events from omp

The inbox needs the omp extension `omp-extension/porthole-events.ts` (see `omp-extension/README.md`). It tells hostd, over the events socket, when a session starts, asks a question, finishes a turn or ends. It never blocks omp: if hostd is down or slow the event is dropped. Only new omp sessions load it after install.

### Preview proxy

hostd runs a second loopback listener, the preview proxy, on `127.0.0.1:8798`. `GET /v1/previews` lists HTTP servers that are listening, are inside `previewRanges` (default `3000-3999,4000-4999,5000-5999,8000-8999`; `none` turns previews off) and were found by the latest scan. Never previewable, whatever the config says: 8795-8796, hostd's own ports, 9222-9225, 8443 and anything below 1024. `/__porthole/preview?port=N` on the proxy sets a cookie; after that the device's requests, WebSockets included, go to `127.0.0.1:N`. Writes through the proxy must carry the preview page's own origin.

The proxy is not reachable from other computers yet: the `https://<machine>:8443/` entry in `tailscale serve` is **not added** by P2 and has not been added yet. Publishing it is the job of `deploy/serve.ts` and happens only after Ben says yes. P2 changes no Tailscale setting.

### Usage

`GET /v1/usage` runs `omp usage --json -p anthropic -r` (omp already holds the Claude login; hostd reads no credential) and answers `{windows: [{id: "5h"|"7d", usedPercent, resetsAt, status}], readAt}`. Answers are cached for 60 seconds, `?refresh=1` is honoured at most every 10 seconds, and after a failed read omp is not asked again for 30 seconds. Numbers are never estimated; a failure is a 502 with the reason. `usageCollection: false` in the config turns it off (404).

### Voice

`POST /v1/voice` takes a 16 kHz mono WAV (at most 25 MB; transcriptions run one at a time) and answers `{text}`, using the local `voxtype transcribe` (SenseVoice on this desktop; no per-use cost). The audio is deleted after a good transcription. If voxtype fails, the audio is kept for 30 days and `GET /v1/voice/kept` lists it. `voiceEnhance` (cleaning the text with `voxflow enhance`) is **off by default**: voxflow works through the clipboard and pastes into the focused window, so running it from hostd could change what Ben has copied.

### Shortcut steps

A shortcut is `{label, steps}`. `steps` is a comma-separated list of key steps, the same names `/keys` accepts (at most 32 steps; at most 50 shortcuts; labels 1-40 characters and unique). Each step is trimmed, so spaces around a `text:` step are dropped. A comma inside a `text:` step must be written `\,`: `text:ls\, -la` sends `ls, -la`, while `text:hello, world` is two steps and the second is refused. There is no `\\` escape, so a step cannot end in a literal backslash directly before a separator (a backslash followed by a comma is always a literal comma).

### Doctor

`GET /v1/doctor` answers `{checks: [{id, ok, detail}]}` and changes nothing. Read each `detail` of a check with `ok: false`:

- `tmux-mouse:<socket>`: scrolling in a pane needs `set -g mouse on` in that tmux server.
- `extension:porthole-events`, `extension:live-inbox`: the file in `~/.omp/agent/extensions/` is missing ("not installed") or differs from the repo copy ("older than the repo copy").
- `events-socket`: hostd's inbox is not listening on `events.sock`.
- `voxtype`, `git`: the configured program is missing or not executable.
- `state-dir`: the state folder is missing or not mode 0700.

### One real omp run

`server/test/live/events-once.ts` is the single throwaway-omp check of the events extension (inbox question with options, answer through the key row, closed question read-only, omp still answering with hostd stopped). It runs in a scratch tmux server and a scratch hostd and is run once, by hand, never in the normal test suite.

```bash
bun run server/test/live/events-once.ts
```
