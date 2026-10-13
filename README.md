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
