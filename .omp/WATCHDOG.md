# Porthole review priorities

1. **Never lose Ben's words.** Drafts survive reloads and failures; nothing is cleared until delivery
   is confirmed; failed voice audio is kept.
2. **Never touch real sessions while testing.** Thalamus and herdr helpers are live; tests use
   scratch tmux sockets and fixture transcripts.
3. **Private by construction.** 127.0.0.1 or owner-only Unix sockets behind `tailscale serve`, Ben's identity and device
   allowlist checked on every request, no secrets in git.
4. **Plain language in the UI.** Ben is new to most technical terms: errors say what happened and
   what to do, in everyday words.

## Traps

- omp live voice replaces the message box; keys sent to a live session go to the live panel
  (Space mutes, Esc ends live). Use the live inbox for text; disable the key row in live mode.
- omp inbox folders exist only for omp sessions started after `live-inbox.ts` was installed.
- `tmux attach` from Porthole resizes the session for every viewer; detach only Porthole's client.
- The omp extension dependency rewriter has rejected template literals: none in `live-inbox.ts` or
  `porthole-events.ts`.
- Esc ends omp live voice. Inbox answers, notification buttons, the watch and shortcuts all send
  keys, so hostd must refuse keys for live-voice panes itself (SPEC 4.3), not rely on the screen.
- Preview pages (port 8443) are same-site with the control room (port 443): cookies and SameSite do
  not separate them. Only the exact-Origin check and the X-Porthole header do (SPEC 5.4).
- `tailscale serve` forwards locally, so identity headers can be faked by local programs. In Unix-socket
  mode trust them only from a connection owned by root (`tailscaled`, checked with SO_PEERCRED); a
  0600 socket alone is not enough. In 127.0.0.1 mode the limit is documented (SPEC 5.4, 9.4). WebSockets cannot carry X-Porthole: check exact Origin.
- `git status` takes index.lock and repo config can run programs: always use GIT_OPTIONAL_LOCKS=0 and
  the flags in SPEC 4.9.
- `voxtype transcribe` may load a second Whisper model onto the graphics card and crash voxtype's
  daemon (SPEC 4.12): one transcription at a time, VRAM checked first.
