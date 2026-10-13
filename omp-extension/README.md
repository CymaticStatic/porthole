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
