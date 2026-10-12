# Porthole review priorities

1. **Never lose Ben's words.** Drafts survive reloads and failures; nothing is cleared until delivery
   is confirmed; failed voice audio is kept.
2. **Never touch real sessions while testing.** Thalamus and herdr helpers are live; tests use
   scratch tmux sockets and fixture transcripts.
3. **Private by construction.** 127.0.0.1 behind `tailscale serve`, Ben's identity and device
   allowlist checked on every request, no secrets in git.
4. **Plain language in the UI.** Ben is new to most technical terms: errors say what happened and
   what to do, in everyday words.

## Traps

- omp live voice replaces the message box; keys sent to a live session go to the live panel
  (Space mutes, Esc ends live). Use the live inbox for text; disable the key row in live mode.
- omp inbox folders exist only for omp sessions started after `live-inbox.ts` was installed.
- `tmux attach` from Porthole resizes the session for every viewer; detach only Porthole's client.
- The omp extension dependency rewriter has rejected template literals: none in `live-inbox.ts`.
