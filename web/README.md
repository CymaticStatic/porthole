# Porthole control room (`web/`)

The control room is the web page that hostd hands out. Open it on a phone, a laptop or a desktop and you see every
coding session on every one of your computers, can read and answer them, type into their terminals, look at what they
changed, and talk to them out loud. It is plain JavaScript files that the browser loads as they are: **there is no build
step**. Edit a file, reload the page.

## How to open it

Open this address in any browser that is signed in to your Tailscale network (the phone app opens the same page inside itself):

```
https://bendesk-omarchy.tailafe04c.ts.net/
```

That is the desktop. Each computer serves the same page and links to the others, so the laptop's own copy works too. Nothing is
reachable from outside the Tailscale network. (The address comes from `docs/SPEC.md` section 3; whether `tailscale serve` is
currently publishing it is checked with `live-status`, not read from this file.)

## The screens

On a phone the menu button (top left, or a swipe from the left edge) opens a drawer. On a wide window (840 px and up) the
same list is a permanent column on the left.

| Screen | What it is for |
|---|---|
| **Inbox** | Everything that wants you, in one list: sessions that **need you** (with a button for each answer), sessions that are **working** (with a Stop button), and ones that are **done**. Grouped by project, then by computer. Swipe a card away to archive it. |
| **Chat** | One session's conversation, read like a messaging app. Type in the box at the bottom and send; an unsent message is kept and shown as failed, never lost. Photos and files can be attached. |
| **Terminal** | The session's real terminal. A key row sits above the keyboard (Esc, Tab, arrows, Ctrl, your own shortcuts), and swipes switch windows and panes. Text size has Smaller and Bigger buttons. |
| **Changes** | What changed in the session's folder: Staged, Not staged, New files. Each file opens to its lines. Reach it with the **Changes** link in the top bar while a chat or terminal is open. |
| **Previews** | The web pages the session is serving on that computer, as links you can open. One entry per computer in the menu. |
| **Usage** | How much of the 5-hour and 7-day AI plan limits has been used, as read by each computer. |
| **Settings** | This device only: which computers it knows about, talk-mode switches, read-aloud, swipe gestures, text size. |
| **Config** | One computer's own settings: shortcuts, hostd settings, extension status, and the doctor (a list of checks that say what is wrong and how to fix it). One entry per computer in the menu. |
| **Talk mode** | In a chat, the microphone button records what you say, sends it, and (if you turn it on in Settings) reads the finished reply aloud. |

A strip under the top bar says **Reconnecting…** whenever a computer cannot be reached, and goes away by itself when it can.

## Run the tests

Unit tests (need only Bun; this includes the security checks below):

```bash
bun run test:web && bun run typecheck:web
```

End-to-end tests need `tmux`, `openssl` and `chromium`. Each file starts its own throwaway Chromium and two scratch hostds (never your
own browser or sessions), so **run the files one at a time**:

```bash
bun test --timeout 120000 web/test/e2e/acceptance.test.ts
```

The other files are `smoke`, `drawer`, `chat`, `terminal`, `inbox`, `panels`, `settings` and `talk`, all in `web/test/e2e/`. The server
suite is `bun run test`. Screenshots land in `web/test/.out/`.

## Vendored code

xterm.js, its fit addon and marked are copied into `web/vendor/`, never loaded from the internet. Versions, licences and file hashes are in
`web/vendor/VENDOR.md`; `web/test/unit/vendor.test.ts` re-hashes every file.

## Two rules the code follows

- **No `innerHTML`.** Pages are built with `h()` (`src/dom/h.js`), which creates elements and sets text, never HTML strings. Markdown from a
  chat is turned into a small tree of allowed tags, not into HTML. `web/test/unit/security.test.ts` fails if `innerHTML`, `outerHTML`,
  `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, an inline event attribute or an inline script appears, or if anything
  points at a CDN.
- **Every word on screen lives in `src/lib/copy.js`.** Views never write a label, title or message themselves; the same test fails when a
  view assigns a literal string to `textContent`, `title`, `placeholder` or `aria-label`. Changing a sentence is a one-line edit in one file.
