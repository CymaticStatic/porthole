# Porthole P4 (Android phone app) and P5 (Galaxy Watch6 app) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `skill://sp-subagent-driven-development` (recommended) or `skill://sp-executing-plans` to carry this plan out task by task. Steps use checkbox (`- [ ] `) syntax for tracking.

**Goal:** A native Android app (`app`) that shows each machine's shared screens in a WebView and does natively only what a page cannot (always-connected notifications with answer buttons, share target, pickers, 16 kHz WAV recording, text-to-speech, network-change reconnect, machines list, watch relay), plus a Wear OS app (`wear`) with Inbox and Usage screens and two complications, fed by the phone over the Wearable Data Layer. Acceptance: SPEC 8 P4 items 1-3 and P5 items 1-2.

**Architecture:** One Gradle project `android/` with three modules. `:shared` is pure Kotlin (JVM, no Android imports) and holds every rule worth a unit test: wire shapes, origin and bridge allowlist, navigation policy, backoff, notification planning, WAV header and silence detection, watch state and complication text. `:app` (phone) and `:wear` (watch) are thin Android shells around `:shared`. The phone talks to each hostd over HTTPS through the Tailscale app's VPN (OkHttp); the watch has no Tailscale (SPEC 4.14), so it only talks to the phone (DataClient for state, MessageClient for answers), and the phone relays to hostd.

**Tech Stack:** Kotlin 2.4.21 (Kotlin Gradle plugin, upgrading AGP 9's built-in 2.2.10), Android Gradle plugin 9.4.1, Gradle 9.6.1 (wrapper, sha256-pinned), JDK 17 (Temurin, mise), compileSdk 37, targetSdk 36, Compose BOM 2026.09.00 (phone settings screens only), Wear Compose Material 3 1.7.1, OkHttp 5.5.0, kotlinx-serialization-json 1.11.0, kotlinx-coroutines 1.11.0, androidx.webkit 1.17.1, androidx.browser 1.10.0, play-services-wearable 20.0.1, watchface-complications-data-source-ktx 1.3.0, JUnit 4.13.2, Robolectric 4.17, MockWebServer (okhttp `mockwebserver3`) 5.5.0.

**Spec:** `/home/cortex/00-system/porthole/repo/docs/SPEC.md` sections 3, 4.7, 4.8, 4.12, 4.13, 4.14, 4.16, 5.2, 5.4, 7, 8 (P4, P5), 10. Native bridge contract: `docs/superpowers/plans/2026-10-13-p3-shared-screens.md`, "Rules every module follows" → **Native bridge** (line 369 of that file).

---

## Global Constraints (copied from SPEC section 7, "Safety rules for the build itself")

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

**Plan-specific limits (every worker brief carries these):**

- At most 2 failed attempts per step; if a step fails twice, stop and report the output.
- Every Gradle run goes through `android/gw` (it sets `JAVA_HOME` and `ANDROID_HOME`; nothing global is changed). After Task T1's first online sync, run Gradle with `--offline`.
- Never run `adb install`, `adb shell` writes, `adb pair`, `adb connect` or `adb shell screencap` outside the two stop-and-ask tasks (E2, E3). Read-only `adb devices` is allowed.
- No paid API is called by any test. The one paid run in this plan is the P4.3 scratch omp session on the haiku model (SPEC 7), done only inside E2 after Ben's OK. Voice transcription (voxtype on hostd) is local and has no per-use cost (SPEC 4.12), so spoken messages are not a paid call.
- Stage files by name (`git add <paths>`), never `-A` or `.`; `git status --short` before every commit.

---

## Verified facts and version pins (read 2026-10-13 by the planner)

| Fact | Value | Source |
|---|---|---|
| JDK | Temurin 17.0.20+101 at `/home/cymatic/.local/share/mise/installs/java/temurin-17.0.20+101` | `files/android-toolchain.md` |
| Android SDK | `/home/cymatic/Android/Sdk`: platform-tools 37.0.1, `platforms;android-36`, `build-tools;36.1.0`; `cmdline-tools/latest/bin/sdkmanager` | `files/android-toolchain.md`, `ls` of the SDK |
| AGP | 9.4.1 latest stable (`com/android/tools/build/gradle` maven-metadata: stable 9.3.3, 9.4.0, 9.4.1; 9.5.0 is alpha) | dl.google.com maven-metadata |
| AGP 9.4 compatibility | Gradle ≥ 9.6.0, SDK Build Tools ≥ 36.0.0, JDK 17, maximum API level 37 | developer.android.com/build/releases/gradle-plugin |
| AGP 9 Kotlin | built-in Kotlin on by default (no `org.jetbrains.kotlin.android` plugin); runtime dependency on KGP 2.2.10; a higher KGP on the build classpath wins | developer.android.com/build/releases/agp-9-0-0-release-notes |
| Gradle | 9.6.1, distribution sha256 `9c0f7faeeb306cb14e4279a3e084ca6b596894089a0638e68a07c945a32c9e14` | gradle.org checksum page |
| Kotlin | 2.4.21 latest stable (2.5.0 planned December 2026) | kotlinlang.org/docs/releases.html |
| compileSdk | **37 is required, 36 is not enough**: AAR metadata `minCompileSdk=37` (and `minAndroidGradlePluginVersion=9.1.0`) in `androidx.core:core:1.19.1`, `androidx.compose.ui:ui-android:1.12.1` (Compose BOM 2026.09.00), `androidx.wear.compose:compose-material3:1.7.1` and `compose-foundation:1.7.1` | `META-INF/.../aar-metadata.properties` inside each AAR |
| Other AAR floors | activity 1.13.0 and browser 1.10.0 need compileSdk 36; webkit 1.17.1 needs 33, minSdk 24; complications data source 1.3.0 minSdk 26; wear compose m3 1.7.1 minSdk 25 | same |
| Library pins | Compose BOM 2026.09.00 (ui 1.12.1, material3 1.4.0); core-ktx 1.19.1; activity-compose 1.13.0; lifecycle 2.11.0; wear compose-material3 / compose-foundation / compose-navigation 1.7.1; watchface-complications-data-source-ktx 1.3.0; play-services-wearable 20.0.1; webkit 1.17.1; browser 1.10.0; kotlinx-serialization-json 1.11.0; kotlinx-coroutines-android / -play-services / -test 1.11.0; okhttp / mockwebserver3 5.5.0; junit 4.13.2; androidx.test.ext:junit 1.3.0; robolectric 4.17 | Maven Central / Google Maven maven-metadata `<release>` and stable lists |
| Desktop origin | `https://bendesk-omarchy.tailafe04c.ts.net` | SPEC 3 (verified there) |
| Phone node | `bencell` (Pixel 7 Pro, Android 17 / SDK 37) | SPEC 3, P1 plan |
| hostd wire (server/src, branch feat/p2-hostd) | `WS /v1/events?device=&since=` sends `{type:"sessions",tree}`, `{type:"inbox",items}` (the whole list), `{type:"notify",id,itemId,title,body,options:[{index,label}],at}`; client replies `{type:"ack",id}`; resend = unacked ids `> since` for that device. `POST /v1/inbox/:itemId/answer` body `{optionIndexes:[n]}` or `{text}` → 200 `{status:"sent",reason}`, 409 `{status,reason}` (refused), 404, 400, 502. `POST /v1/sessions/:id/keys` `{keys:["Esc"]}` is Stop. `POST /v1/uploads` multipart field `file` → `{path}` (413 too big). `POST /v1/voice` `audio/wav` → `{text}` (429 busy, 502 `{error,kept}`). `GET /v1/usage` → `{windows:[{id,usedPercent,resetsAt,status}],readAt}` (404 when off). `GET /v1/machine` → `{name,version,authMode,you:{device,via,forwardedFor},features}`. Inbox `column` is `"needs-you" | "working" | "done"`; times are epoch milliseconds. hostd already reduces notify `options` to `[]` for multi-select questions | `server/src/events/inbox.ts`, `server/src/features/*`, read by the planner |

**GUESSES (each is checked by the task named):**

- G-1 `ai.porthole.app` / "Porthole" package and app name: SPEC 4.16 and 9.1 working names. Ben may rename (Needs Ben 1). Changing it later is a one-line `applicationId` edit in two files.
- G-2 Galaxy Watch6 Wear OS version: unread. Wear minSdk 30 (Wear OS 3, the oldest Watch6 can run) is chosen so any shipped Watch6 build works. Checked in T0.
- G-3 Complication types: only RANGED_VALUE and SHORT_TEXT are used; that both exist in `ComplicationType` was read from the `androidx.wear.watchface.complications.data.ComplicationType` reference page, but the full Android type list page and Samsung's support for each on Watch6 faces were not read. Checked in T0.
- G-4 The Data Layer delivers only between apps with the same applicationId and the same signing key. Checked in T0 (developer.android.com Data Layer page); the plan already uses the same `applicationId` and the desktop's one debug key for both modules.
- G-5 Laptop origin `https://benacer-omarchy.tailafe04c.ts.net`: same tailnet suffix as the desktop, not read. Checked in T0 with `tailscale status --json`.
- G-6 Foreground-service type `remoteMessaging` is accepted on Android 17 for an app targeting 36, has no time limit, needs only `FOREGROUND_SERVICE_REMOTE_MESSAGING` (normal permission), and may start from `BOOT_COMPLETED`. Read for Android 14/15 on developer.android.com; Android 17 changes not read. Checked in T0.
- G-7 `platforms;android-37.0` is the sdkmanager package name for API 37 (sdkmanager's list showed 37.0, 37.1, 37.2). Checked in T1 step 1.
- G-8 Robolectric 4.17 runs the complication and notification tests at `@Config(sdk = [35])`. Checked in D3/B2 step 1 (first run).
- G-9 Battery cost of one always-open socket per machine: SPEC 4.7 already marks it GUESS until measured in P4; E2 records the phone's battery screen reading after 24 h.

---

## Design decisions (and what was rejected)

1. **Foreground-service type: `remoteMessaging`.** Android 14+ requires a type for every foreground service. The job is "keep a messaging connection to a remote server and show its messages", which is what `remoteMessaging` names. Rejected: `dataSync` (limited to 6 h per 24 h since Android 15, then the service is stopped, which breaks "always connected"; also barred from starting at boot), `connectedDevice` (requires a Bluetooth/USB/NFC-style runtime prerequisite the app does not have), `specialUse` (needs a Play-review justification and is the fallback only if T0 finds Android 17 refuses `remoteMessaging`; switching is a 3-line manifest change in T1's files). Recorded in `android/README.md` by T1.
2. **compileSdk 37, targetSdk 36, phone minSdk 34, wear minSdk 30.** compileSdk 37 because the current Compose, core and Wear Compose AARs refuse anything lower (facts table). targetSdk 36 keeps Android 17's target-37 behaviour changes off until they are read; the phone still runs on Android 17. Phone minSdk 34 (Android 14) because Ben has one phone on Android 17 and 34 is the first level where foreground-service types are enforced, so the code needs no older branches. Wear minSdk 30 covers every Watch6 software version (G-2). Build tools stay on the installed 36.1.0 (AGP 9.4 needs ≥ 36.0.0). Rejected: compileSdk 36 with older library pins (a year-old Compose for no gain, and 37 is one sdkmanager download into Ben's home folder, already allowed by SPEC 7).
3. **Kotlin 2.4.21, not AGP 9's bundled 2.2.10.** Libraries released in September 2026 carry Kotlin metadata newer than 2.2's compiler reads [INFERENCE: a Kotlin compiler reads metadata at most one minor version ahead]. The root build declares the Kotlin JVM, Compose-compiler and serialization plugins at 2.4.21, which puts KGP 2.4.21 on the classpath; T1 step 8 proves it with `buildEnvironment`.
4. **One WebView per selected machine; no `addJavascriptInterface`.** The bridge is installed with `WebViewCompat.addWebMessageListener(webView, "PortholeNative", allowedOriginRules, listener)` where the rules are exactly the configured machine origins (`https://<name>.ts.net`, no port, no wildcard). The listener also re-checks `sourceOrigin` against the same list (defence in depth) and ignores `isMainFrame == false`. File and content access off, `setAllowFileAccess(false)`, mixed content never, Safe Browsing on, remote debugging only in debug builds. Navigation policy: a top-level navigation to a configured machine origin stays in the WebView; any other `https:` URL (including previews on `:8443`, which is a different origin) opens in a Custom Tab, which has no bridge; every other scheme is blocked. Rejected: `addJavascriptInterface` (exposes the object to every frame and origin), a second in-app WebView for previews (a Custom Tab gives the same isolation with less code).
5. **The page keeps the shared screens; native keeps what SPEC 4.16 lists.** Native screens are only Machines (list, add, rename, remove, default desktop and laptop) and the Battery guide. They are reachable from the "Porthole is connected" notification and from two static launcher shortcuts (`shortcuts.xml`: "Machines", "Battery"). The built page cannot open them: `openSettings` is not in `web/src/net/bridge.js` `ALLOWED`, so a page-side entry point is an optional P3 change (coordination item, Needs Ben 6), not something this plan depends on. There is no native "unsent recordings" screen: the page keeps a failed recording as `pendingWav` and offers it again, and hostd keeps audio it could not transcribe (decision 6).
6. **Bridge v1: the calls the built page makes.** Read from `web/src` on 2026-10-13 (`grep 'bridge.call(\|bridge.on('`, branch `feat/p2-hostd`): `web/src/net/bridge.js` `ALLOWED` has exactly seven methods, and a page call to anything else fails with `Bridge method not allowed: <name>`. The native side matches the page, not the other way round:
   - `machines({})` → `[{name, origin}]`.
   - `speak({utterances:[string]})` → `{finished:true}` after the last utterance, `{finished:false}` if stopped. `readAllUtterances` (`web/src/lib/speech.js`) sends the whole reply with no count cap, so native caps only the total size (100 000 bytes of UTF-8), and `Speaker` splits any single utterance longer than the text-to-speech engine's maximum input length (4 000 characters).
   - `stopSpeaking({})` → `null`.
   - `startRecording({autoStop:boolean})` → `null`. No `origin` argument (`talk.js` sends only `autoStop`).
   - `stopRecording({})` → `{wav}`, where `wav` is the base64 of a 16 kHz mono 16-bit WAV file. When native stops recording on its own (2 s of silence with `autoStop`, the 10-minute cap that equals `MAX_RECORDING_MS` in `web/src/views/talk.js`, or the app going to the background) it emits the event `recordingStopped({wav})` with the same shape. The page then posts the WAV to `/v1/voice` itself and keeps `pendingWav` for "send again"; native never talks to `/v1/voice`.
   - `pickFile({source:"camera"|"photo"|"file"})` → `{path, name}` or `null` when cancelled. Clipboard paste is handled inside the page (`composer.js`). There is no `origin` argument: native uploads to the machine whose origin the bridge listener verified (`sourceOrigin`), through that machine's `/v1/uploads`.
   - `openExternal({url})` → `null`. `https:` URLs open in a Custom Tab (no bridge). The one exact URL `porthole://notification-settings` (called by `web/src/views/settings.js`) opens `ACTION_APP_NOTIFICATION_SETTINGS` for the app. Any other URL is an error.
   - Events from native to page: `network({online})`, `share({path, name, ...})` (native adds `machine` and `origin` keys; extra keys are harmless to the page's adapter) and `recordingStopped({wav})`.
   - Optional P3 change, not a dependency: a method `openSettings({page:"machines"|"battery"})` so the page can open the two native screens. Native implements it only if P3 adds it to `ALLOWED` (E1 step 4 sends P3 the note).
7. **Notifications.** Channel `connection` (importance low, the foreground notice), channel `needs-you` (importance high). One notification per `(origin, itemId)`: tag = origin, id = item hash, so a newer notify for the same item replaces the old one. Buttons: Open, then one button per option when hostd sent 2 or 3 options, at most two answer buttons in total (SPEC 4.7: "Open, plus up to two answer options when the question has two or three options"); a three-option question shows its first two. Answer buttons fire a broadcast to `AnswerReceiver`, which posts the answer natively and replaces the notification with the result ("Sent: Yes", or "Not sent: <reason>" with Open). Notifications are not `setLocalOnly`, so Wear OS bridges them, buttons included, to the watch (SPEC 4.7 [INFERENCE], confirmed in E3). **Cancel rule:** hostd's `apply()` (`server/src/features/inbox.ts`) broadcasts an `inbox` message right after it queues a `turnFinished` notify, and answered items stay in the inbox as `working`, so "the item is not in the inbox" is the wrong test. The app records, per `(origin, itemId)`, whether the notification was shown while the item was in `needs-you`. On an `inbox` message it cancels a notification only if that flag is set and the item is no longer `needs-you` (answered elsewhere, now `working`) or has left the list. A notification shown for an item that was never `needs-you` (a turn-finished notice) is left alone until the user dismisses it.
8. **Ack and replay.** The app acks every notify after posting it (or after recognising it as a duplicate). It keeps a per-origin ledger in `SharedPreferences`: the highest id shown (`since` on the next connect) and the last 200 shown `(id, itemId)` pairs (duplicate guard if an ack was lost). On every (re)connect it sends `since=<highest shown>`, then re-sends acks for any shown-but-unacked ids. **Counter reset:** hostd's notify counter restarts at 1 when `notify.json` is missing and jumps to epoch seconds when it is corrupt (`server/src/notify.ts` `load()`). So a notify whose `id` is not greater than the ledger's highest id, and whose `(id, itemId)` pair the ledger has not recorded, is treated as a counter reset: the ledger for that origin is cleared, the notify is shown, and the ledger restarts from its id. Matching the pair, not just the `itemId`, also handles a reset that re-notifies an item the ledger already knows. Without this, `since=<highest>` hides the replay and `seen()` drops new live ids.
9. **Device name.** The native socket's `device` is the `you.device` from `GET /v1/machine` (Tailscale's node name, `bencell`), read once per machine and cached; fallback `bencell`. The page inside the WebView keeps its own `web-<12>` device id (P3), so hostd keeps separate notification queues and the page's sockets never steal the phone's notifications.
10. **Recording.** `AudioRecord` at 16 000 Hz, mono, 16-bit PCM, written straight to a WAV file in `cacheDir`, header patched on stop. Hard stop at 10 minutes (600 000 ms, the page's `MAX_RECORDING_MS`; 19 200 000 bytes of audio, under the 25 MB hostd limit of SPEC 4.12), optional auto-stop after 2.0 s of silence (RMS below threshold for 2 s after speech was heard). `stopRecording` and the `recordingStopped` event return the file's bytes as base64 `{wav}` and then delete the file; the page keeps the audio from there (decision 6). Recording only while the activity is visible; going to the background stops it and emits `recordingStopped({wav})` with what was recorded so far. So no `microphone` foreground-service type is needed.
11. **Watch data.** Phone → watch: one DataItem at `/porthole/state` holding `WatchState` JSON (needs-you items from all machines, at most 30, newest first, question text cut to 300 characters; usage windows per machine; `updatedAt`), rewritten when an `inbox` message changes the needs-you set or usage changes. Usage is read every 5 min while the service runs and right away when the watch sends `/porthole/refresh` (rejected: once a minute, which SPEC 4.11 asks of the page, not of a background service). Watch → phone: MessageClient `/porthole/answer` (`{origin, itemId, optionIndexes}` or `{origin, sessionId, stop:true}`), answered by `/porthole/answer-result` (`{requestId, ok, message}`). The phone advertises capability `porthole_phone` (`res/values/wear.xml`) so the watch finds the right node.
12. **Complications.** `UsageComplicationService` supports RANGED_VALUE: value = highest `usedPercent` across machines and windows, min 0, max 100, text "72%", content description "Highest Claude usage 72 percent"; tap opens Usage. `WaitingComplicationService` supports SHORT_TEXT: text "3", title "waiting", content description "3 waiting"; tap opens Inbox. Both use `UPDATE_PERIOD_SECONDS = 0` and are pushed with `ComplicationDataSourceUpdateRequester` when a new state arrives. Both implement `getPreviewData` (P5.1).
13. **Phone build only on the desktop.** Both APKs are signed with the desktop's `~/.android/debug.keystore` (created on first build), so the Data Layer sees one signer (G-4). Building on the laptop would make a second key; `android/README.md` says so.

---

## File structure and ownership

All paths are relative to the worktree root `/home/cortex/00-system/porthole/.worktrees/p4-android` (**GUESS**: where `omp-worktree new p4-android` puts it; T1 step 1 prints the real path and every later command uses it). Each file has exactly one owning task; no other task edits it. Kotlin package roots: `ai.porthole.shared`, `ai.porthole.app`, `ai.porthole.wear`.

| Path (under `android/`) | Responsibility | Owner |
|---|---|---|
| `settings.gradle.kts`, `build.gradle.kts`, `gradle.properties`, `gradle/libs.versions.toml`, `gradle/wrapper/*`, `gradlew`, `gradlew.bat`, `gw`, `.gitignore`, `README.md` | build, pins, wrapper, env script, how to build/install | T1 |
| `shared/build.gradle.kts`, `app/build.gradle.kts`, `wear/build.gradle.kts` | module builds | T1 |
| `app/src/main/AndroidManifest.xml`, `wear/src/main/AndroidManifest.xml` | every component, permission and query, final from the start | T1 |
| `app/src/main/res/values/strings.xml`, `themes.xml`, `app/src/main/res/xml/network_security_config.xml`, `shortcuts.xml`, `file_paths.xml`, `app/src/main/res/drawable/ic_notify.xml`, `ic_launcher_foreground.xml`, `app/src/main/res/mipmap-anydpi/ic_launcher.xml`, `wear/src/main/res/values/strings.xml`, `wear/src/main/res/drawable/ic_complication.xml`, `ic_launcher_foreground.xml`, `wear/src/main/res/mipmap-anydpi/ic_launcher.xml` | base resources the manifests point at | T1 |
| `shared/src/main/kotlin/ai/porthole/shared/Wire.kt` + `shared/src/test/kotlin/ai/porthole/shared/WireTest.kt` | hostd JSON shapes (events, answer, usage, machine, upload) and parsing | A1 |
| `shared/.../Origins.kt`, `NavPolicy.kt`, `BridgeAllowlist.kt`, `Routes.kt`, `Machine.kt`, `MachineList.kt` + `OriginsTest.kt`, `NavPolicyTest.kt`, `BridgeAllowlistTest.kt`, `MachineListTest.kt` | origin normalisation, navigation decision, bridge origin rules, events/answer URLs, machines list rules | A2 |
| `shared/.../Backoff.kt` + `BackoffTest.kt` | 1, 2, 4 … 15 s schedule, reset on success, nudge | A3 |
| `shared/.../BridgeProtocol.kt` + `BridgeProtocolTest.kt` | bridge request/response/event JSON, method allowlist, argument validation | A4 |
| `shared/.../NotifyPlanner.kt`, `NotifyLedger.kt`, `AnswerOutcome.kt` + `NotifyPlannerTest.kt`, `NotifyLedgerTest.kt`, `AnswerOutcomeTest.kt` | which buttons a notify gets, text limits, dedupe/since/ack ledger, answer result → user text | A5 |
| `shared/.../Audio.kt` + `AudioTest.kt` | WAV header (16 kHz mono 16-bit), header patch, size limit, silence detector | A6 |
| `shared/.../WatchState.kt`, `WatchAnswer.kt`, `WatchPaths.kt`, `ComplicationText.kt`, `WatchRules.kt` + `WatchStateTest.kt`, `ComplicationTextTest.kt`, `WatchRulesTest.kt` | phone→watch state, watch→phone answers, Data Layer paths, complication values, state building from inbox + usage | A7 |
| `app/src/main/kotlin/ai/porthole/app/net/Http.kt`, `HostClient.kt`, `EventsSocket.kt`, `Scheduler.kt` + `app/src/test/kotlin/ai/porthole/app/net/HostClientTest.kt`, `EventsSocketTest.kt` | OkHttp client with Origin + X-Porthole, typed hostd calls, reconnecting events socket | B1 |
| `app/.../MachineStore.kt`, `Graph.kt`, `Intents.kt`, `PortholeApp.kt` + `app/src/test/.../MachineStoreTest.kt` | machines persistence, one-object dependency graph, intent extras, Application | B1 |
| `app/.../events/Notifier.kt`, `NotifyFlow.kt`, `LedgerStore.kt`, `ConnectionHub.kt`, `EventsService.kt`, `AnswerHandler.kt`, `AnswerReceiver.kt`, `BootReceiver.kt`, `NetworkWatcher.kt` + `app/src/test/.../events/NotifyFlowTest.kt`, `NotifierTest.kt`, `AnswerHandlerTest.kt`, `EventsServiceTest.kt`, `BootReceiverTest.kt`, `LedgerStoreTest.kt` | foreground service, sockets per machine, notifications, ack, answer from buttons, boot start, network-change nudge | B2 |
| `app/.../voice/WavFileWriter.kt`, `Recorder.kt` (with `Mic`, `AudioRecordMic`), `TtsEngine.kt`, `AndroidTts.kt`, `Speaker.kt` + `app/src/test/.../voice/WavFileWriterTest.kt`, `RecorderTest.kt`, `SpeakerTest.kt` | 16 kHz WAV recording (returns the file to the bridge), auto-stop, 10-minute cap, TTS queue | B3 |
| `app/.../share/Uploads.kt`, `LimitedInputStream.kt`, `ShareIntents.kt`, `ShareActivity.kt`, `Pickers.kt` + `app/src/test/.../share/UploadsTest.kt`, `LimitedInputStreamTest.kt`, `ShareIntentsTest.kt` | 50 MB-limited upload of content URIs, share target, camera/photo/file pickers | B4 |
| `app/.../web/MainActivity.kt`, `WebViewSetup.kt`, `PortholeWebClient.kt`, `BridgeHost.kt`, `BridgeMethods.kt`, `EventOutbox.kt` + `app/src/test/.../web/BridgeMethodsTest.kt`, `PortholeWebClientTest.kt`, `WebViewSetupTest.kt`, `EventOutboxTest.kt`, `MainActivityTest.kt` | WebView host, bridge install, method dispatch, Custom Tabs, `porthole://open` links, bridge event outbox | C1 |
| `app/.../settings/MachinesActivity.kt`, `MachineForm.kt`, `BatteryGuideActivity.kt`, `SettingsTheme.kt`, `app/src/main/res/values/settings_strings.xml` + `app/src/test/.../settings/MachineFormTest.kt`, `BatteryGuideActivityTest.kt` | native Compose screens | C2 |
| `app/.../relay/RelayLogic.kt`, `WatchRelay.kt`, `WearMessages.kt`, `RelayListenerService.kt` + `app/src/test/.../relay/RelayLogicTest.kt`, `RelayListenerServiceTest.kt`, `app/src/main/res/values/wear.xml` | phone side of the watch link | C3 (also adds 2 lines to `EventsService.kt`, see C3) |
| `wear/src/main/kotlin/ai/porthole/wear/data/StateRepository.kt`, `PendingAnswers.kt`, `AnswerSender.kt`, `WearDataListenerService.kt`, `ComplicationUpdates.kt` + `wear/src/test/.../data/PendingAnswersTest.kt`, `AnswerSenderTest.kt`, `StateRepositoryTest.kt` | watch side of the link | D1 |
| `wear/.../ui/InboxModel.kt`, `WearApp.kt`, `InboxScreen.kt`, `ItemScreen.kt`, `UsageScreen.kt`, `WearActivity.kt` + `wear/src/test/.../ui/InboxModelTest.kt`, `ItemScreenTest.kt` | watch screens | D2 |
| `wear/.../complications/UsageComplicationService.kt`, `WaitingComplicationService.kt`, `ComplicationBuilders.kt` + `wear/src/test/.../complications/ComplicationPreviewTest.kt` | the two complications | D3 |
| `docs/superpowers/evidence/p4-p5-build.md` (repo root, not under `android/`) | E1 command output, E2/E3 Ben's check results | E1 creates, E2 and E3 append |

The manifests name classes that later tasks create. That is safe: `assembleDebug` does not check that manifest classes exist (lint is not part of a debug assemble), so T1 builds without stub classes, and nobody but the owner ever writes a class file.


## Parallel groups

| Group | Tasks | Starts after | Parallel? |
|---|---|---|---|
| 0 | T0 (facts), then T1 (scaffold) | T0 is research only; T1 needs T0's G-6 and G-7 answers | T0 then T1 |
| A1 | A1, A2, A3, A6 | T1 | yes, all four (pure `:shared` files) |
| A2 | A4, A5, A7 | A1 (Wire) and A2 (Origins) | yes, all three |
| B | B1 | A1, A2, A3 | alone |
| B' | B2, B3, B4 | B1 (B2 also A5; B3 also A6; B4 also A4) | yes, all three |
| C | C1, C2, C3 | C1: B2, B3, B4, A4. C2: B1, B3. C3: B2, A7 | yes, all three (C3's 2-line edit of `EventsService.kt` is the only touch of a B2 file, after B2 is done) |
| D | D1 then D2 and D3 | A7 (D1); D1 (D2, D3) | D runs alongside B and C; D2 and D3 in parallel |
| E | E1, then E2, then E3 | all of the above | alone; E2 and E3 are stop-and-ask |

Gradle note: two Gradle builds at once in one worktree share one daemon and lock the build folder. Workers in a parallel group run only their own module's test task (`./gw --offline :shared:test --tests '…'`, `:app:testDebugUnitTest --tests '…'`, `:wear:testDebugUnitTest --tests '…'`); Gradle serialises them safely through its lock, so a worker that sees "Timeout waiting to lock build" waits 60 s and retries once (that counts as one of its two attempts).

---

## Task T0: Check the unverified facts (research only, no code)

**Files:** none in the repo. Output: a short report the orchestrator pastes into `docs/superpowers/evidence/p4-p5-build.md` when E1 creates it.

- [ ] **Step 1: Wear OS version (G-2).** Ask Ben (through the orchestrator's `## Needs your decision`) to read it off the watch: Settings → About watch → Software information → "Wear OS version" and "One UI Watch version". No adb on the watch here. If he reports Wear OS 3 or newer, wear minSdk 30 stands. If he reports anything older than Wear OS 3, stop and report (the Watch6 shipped with Wear OS 4, so this would mean the reading is wrong).
- [ ] **Step 2: Complication types (G-3).** Fetch with `ctx_fetch_and_index`: `https://developer.android.com/reference/androidx/wear/watchface/complications/data/ComplicationType` and `https://developer.android.com/training/wearables/complications/exposing-data` (the data-source guide). Record the full `ComplicationType` list and confirm `RANGED_VALUE` and `SHORT_TEXT` are both offered to third-party data sources, plus the manifest names `android.support.wearable.complications.SUPPORTED_TYPES` and `UPDATE_PERIOD_SECONDS`. If either name differs from the one in T1's wear manifest, give T1 the corrected name before it starts.
- [ ] **Step 3: Data Layer pairing rule (G-4).** Fetch `https://developer.android.com/training/wearables/data/data-layer` and record the sentence that says what the phone and watch apps must share (package name and signing). If it says anything beyond "same applicationId and same signature", report it before D1 starts.
- [ ] **Step 4: Foreground-service type on Android 17 (G-6).** Fetch `https://developer.android.com/develop/background-work/services/fgs/service-types` and the Android 17 behaviour-changes pages (`https://developer.android.com/about/versions/17/behavior-changes-all` and `.../behavior-changes-17`). Record: `remoteMessaging` still exists, its permission name, whether it has a time limit, whether `BOOT_COMPLETED` may start it, and any Android 17 change for apps targeting 36 (local-network access, WebView, foreground services, background audio). If `remoteMessaging` cannot start from boot on 17, T1 keeps the type and B2's `BootReceiver` only posts a "Tap to reconnect Porthole" notification instead of starting the service (B2 step 6 already has this branch behind `BootPolicy.startFromBoot`).
- [ ] **Step 5: Laptop origin (G-5).** On the desktop, read-only:

```bash
tailscale status --json
```

Pipe it through `ctx_execute` and print only `.Self.DNSName` and the `DNSName` of the peer whose `HostName` is `benacer-omarchy`. Record both without the trailing dot. If the laptop peer is missing, the default machines list carries only the desktop and C2's "Add machine" covers the laptop later (P6).
- [ ] **Step 6: Report.** Yield the five answers, each with its source URL or command. No commit (nothing changed).

## Task T1: Worktree, toolchain check, Gradle scaffold, manifests, base resources

**Files:** Create every file T1 owns in the ownership table (`android/settings.gradle.kts`, `android/build.gradle.kts`, `android/gradle.properties`, `android/gradle/libs.versions.toml`, `android/gradle/wrapper/gradle-wrapper.properties`, `android/gradle/wrapper/gradle-wrapper.jar`, `android/gradlew`, `android/gradlew.bat`, `android/gw`, `android/.gitignore`, `android/README.md`, the three module `build.gradle.kts`, the two manifests, the base resources).

- [ ] **Step 1: Worktree and platform 37.** From `/home/cortex/00-system/porthole/repo`:

```bash
work-status --here
```

If it exits 2 (another live session in this repo), that is fine for a worktree; note it in the report. Then:

```bash
omp-worktree new p4-android
```

Print the path it reports and use it everywhere below. Install API 37 into Ben's home SDK (no sudo; allowed by SPEC 7):

```bash
JAVA_HOME=/home/cymatic/.local/share/mise/installs/java/temurin-17.0.20+101 /home/cymatic/Android/Sdk/cmdline-tools/latest/bin/sdkmanager --sdk_root=/home/cymatic/Android/Sdk "platforms;android-37.0"
```

If sdkmanager asks to accept a licence, answer `y` (the Android SDK licence, already accepted for android-36). If the package name is refused (G-7), run `sdkmanager --list` through `ctx_execute`, print only lines starting with `platforms;android-37`, and install the plain `37.0` entry shown. Then confirm:

```bash
ls /home/cymatic/Android/Sdk/platforms
```

Expected: `android-36` and an `android-37` folder (named `android-37` or `android-37.0`).

- [ ] **Step 2: Version catalogue.** `android/gradle/libs.versions.toml`:

```toml
[versions]
agp = "9.4.1"
kotlin = "2.4.21"
composeBom = "2026.09.00"
coreKtx = "1.19.1"
activityCompose = "1.13.0"
lifecycle = "2.11.0"
wearCompose = "1.7.1"
complications = "1.3.0"
playWearable = "20.0.1"
webkit = "1.17.1"
browser = "1.10.0"
serialization = "1.11.0"
coroutines = "1.11.0"
okhttp = "5.5.0"
junit = "4.13.2"
androidxJunit = "1.3.0"
robolectric = "4.17"

[libraries]
compose-bom = { group = "androidx.compose", name = "compose-bom", version.ref = "composeBom" }
compose-material3 = { group = "androidx.compose.material3", name = "material3" }
compose-ui = { group = "androidx.compose.ui", name = "ui" }
compose-ui-tooling-preview = { group = "androidx.compose.ui", name = "ui-tooling-preview" }
core-ktx = { group = "androidx.core", name = "core-ktx", version.ref = "coreKtx" }
activity-compose = { group = "androidx.activity", name = "activity-compose", version.ref = "activityCompose" }
lifecycle-service = { group = "androidx.lifecycle", name = "lifecycle-service", version.ref = "lifecycle" }
lifecycle-runtime-compose = { group = "androidx.lifecycle", name = "lifecycle-runtime-compose", version.ref = "lifecycle" }
wear-compose-material3 = { group = "androidx.wear.compose", name = "compose-material3", version.ref = "wearCompose" }
wear-compose-foundation = { group = "androidx.wear.compose", name = "compose-foundation", version.ref = "wearCompose" }
wear-compose-navigation = { group = "androidx.wear.compose", name = "compose-navigation", version.ref = "wearCompose" }
complications-data-source-ktx = { group = "androidx.wear.watchface", name = "watchface-complications-data-source-ktx", version.ref = "complications" }
play-services-wearable = { group = "com.google.android.gms", name = "play-services-wearable", version.ref = "playWearable" }
webkit = { group = "androidx.webkit", name = "webkit", version.ref = "webkit" }
browser = { group = "androidx.browser", name = "browser", version.ref = "browser" }
serialization-json = { group = "org.jetbrains.kotlinx", name = "kotlinx-serialization-json", version.ref = "serialization" }
coroutines-android = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-android", version.ref = "coroutines" }
coroutines-play-services = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-play-services", version.ref = "coroutines" }
coroutines-test = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-test", version.ref = "coroutines" }
okhttp = { group = "com.squareup.okhttp3", name = "okhttp", version.ref = "okhttp" }
mockwebserver = { group = "com.squareup.okhttp3", name = "mockwebserver3", version.ref = "okhttp" }
junit = { group = "junit", name = "junit", version.ref = "junit" }
androidx-junit = { group = "androidx.test.ext", name = "junit", version.ref = "androidxJunit" }
robolectric = { group = "org.robolectric", name = "robolectric", version.ref = "robolectric" }

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
kotlin-jvm = { id = "org.jetbrains.kotlin.jvm", version.ref = "kotlin" }
kotlin-compose = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }
kotlin-serialization = { id = "org.jetbrains.kotlin.plugin.serialization", version.ref = "kotlin" }
```

- [ ] **Step 3: Build files.** `android/settings.gradle.kts`:

```kotlin
pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "porthole-android"
include(":shared", ":app", ":wear")
```

`android/build.gradle.kts` (declaring the Kotlin plugins here puts KGP 2.4.21 on the shared build classpath, which AGP 9's built-in Kotlin then uses; decision 3):

```kotlin
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}
```

`android/gradle.properties`:

```properties
org.gradle.jvmargs=-Xmx3g -Dfile.encoding=UTF-8
org.gradle.configuration-cache=true
android.useAndroidX=true
android.nonTransitiveRClass=true
kotlin.code.style=official
```

`android/shared/build.gradle.kts`:

```kotlin
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}
java { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
kotlin { compilerOptions { jvmTarget.set(JvmTarget.JVM_17) } }
dependencies {
    implementation(libs.serialization.json)
    testImplementation(libs.junit)
}
```

`android/app/build.gradle.kts`:

```kotlin
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}
android {
    namespace = "ai.porthole.app"
    compileSdk = 37
    buildToolsVersion = "36.1.0"
    defaultConfig {
        applicationId = "ai.porthole.app" // GUESS G-1: working name, SPEC 9.1
        minSdk = 34
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    testOptions { unitTests { isIncludeAndroidResources = true } }
}
dependencies {
    implementation(project(":shared"))
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.core.ktx)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.service)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.webkit)
    implementation(libs.browser)
    implementation(libs.play.services.wearable)
    implementation(libs.serialization.json)
    implementation(libs.coroutines.android)
    implementation(libs.coroutines.play.services)
    implementation(libs.okhttp)
    testImplementation(libs.junit)
    testImplementation(libs.mockwebserver)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.junit)
}
```

`android/wear/build.gradle.kts`: the same shape with `namespace = "ai.porthole.wear"`, **`applicationId = "ai.porthole.app"`** (same as the phone, decision 13 / G-4), `minSdk = 30`, `targetSdk = 36`, `compileSdk = 37`, `buildToolsVersion = "36.1.0"`, `buildFeatures { compose = true }`, and dependencies `project(":shared")`, `core-ktx`, `activity-compose`, `wear-compose-material3`, `wear-compose-foundation`, `wear-compose-navigation`, `complications-data-source-ktx`, `play-services-wearable`, `serialization-json`, `coroutines-android`, `coroutines-play-services`, `lifecycle-runtime-compose`; tests `junit`, `coroutines-test`, `robolectric`, `androidx-junit`. No `androidx.compose.material3` in `:wear` (Wear Compose Material 3 only; SPEC 4.14).

- [ ] **Step 4: Manifests.** `android/app/src/main/AndroidManifest.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING" />
    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />

    <queries>
        <intent><action android:name="android.intent.action.TTS_SERVICE" /></intent>
        <intent><action android:name="android.support.customtabs.action.CustomTabsService" /></intent>
        <intent><action android:name="android.media.action.IMAGE_CAPTURE" /></intent>
    </queries>

    <application
        android:name=".PortholeApp"
        android:label="@string/app_name"
        android:icon="@mipmap/ic_launcher"
        android:theme="@style/Theme.Porthole"
        android:networkSecurityConfig="@xml/network_security_config"
        android:allowBackup="false"
        android:supportsRtl="true">

        <activity android:name=".web.MainActivity" android:exported="true" android:launchMode="singleTask"
            android:windowSoftInputMode="adjustResize"
            android:configChanges="orientation|screenSize|screenLayout|smallestScreenSize|keyboardHidden|uiMode">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="porthole" android:host="open" />
            </intent-filter>
            <meta-data android:name="android.app.shortcuts" android:resource="@xml/shortcuts" />
        </activity>

        <activity android:name=".share.ShareActivity" android:exported="true"
            android:theme="@style/Theme.Porthole.Translucent" android:excludeFromRecents="true">
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="image/*" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="*/*" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SEND_MULTIPLE" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="*/*" />
            </intent-filter>
        </activity>

        <activity android:name=".settings.MachinesActivity" android:exported="false" />
        <activity android:name=".settings.BatteryGuideActivity" android:exported="false" />

        <service android:name=".events.EventsService" android:exported="false"
            android:foregroundServiceType="remoteMessaging" />

        <service android:name=".relay.RelayListenerService" android:exported="true">
            <intent-filter>
                <action android:name="com.google.android.gms.wearable.MESSAGE_RECEIVED" />
                <data android:scheme="wear" android:host="*" android:pathPrefix="/porthole" />
            </intent-filter>
        </service>

        <receiver android:name=".events.AnswerReceiver" android:exported="false" />
        <receiver android:name=".events.BootReceiver" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
            </intent-filter>
        </receiver>

        <provider android:name="androidx.core.content.FileProvider"
            android:authorities="${applicationId}.files" android:exported="false" android:grantUriPermissions="true">
            <meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/file_paths" />
        </provider>
    </application>
</manifest>
```

`android/wear/src/main/AndroidManifest.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-feature android:name="android.hardware.type.watch" />

    <application
        android:label="@string/app_name"
        android:icon="@mipmap/ic_launcher"
        android:allowBackup="false"
        android:supportsRtl="true">
        <meta-data android:name="com.google.android.wearable.standalone" android:value="false" />

        <activity android:name=".ui.WearActivity" android:exported="true" android:taskAffinity=""
            android:launchMode="singleTask" android:theme="@android:style/Theme.DeviceDefault">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

        <service android:name=".data.WearDataListenerService" android:exported="true">
            <intent-filter>
                <action android:name="com.google.android.gms.wearable.DATA_CHANGED" />
                <action android:name="com.google.android.gms.wearable.MESSAGE_RECEIVED" />
                <data android:scheme="wear" android:host="*" android:pathPrefix="/porthole" />
            </intent-filter>
        </service>

        <service android:name=".complications.UsageComplicationService" android:exported="true"
            android:label="@string/complication_usage" android:icon="@drawable/ic_complication"
            android:permission="com.google.android.wearable.permission.BIND_COMPLICATION_PROVIDER">
            <intent-filter>
                <action android:name="android.support.wearable.complications.ACTION_COMPLICATION_UPDATE_REQUEST" />
            </intent-filter>
            <meta-data android:name="android.support.wearable.complications.SUPPORTED_TYPES" android:value="RANGED_VALUE" />
            <meta-data android:name="android.support.wearable.complications.UPDATE_PERIOD_SECONDS" android:value="0" />
        </service>

        <service android:name=".complications.WaitingComplicationService" android:exported="true"
            android:label="@string/complication_waiting" android:icon="@drawable/ic_complication"
            android:permission="com.google.android.wearable.permission.BIND_COMPLICATION_PROVIDER">
            <intent-filter>
                <action android:name="android.support.wearable.complications.ACTION_COMPLICATION_UPDATE_REQUEST" />
            </intent-filter>
            <meta-data android:name="android.support.wearable.complications.SUPPORTED_TYPES" android:value="SHORT_TEXT" />
            <meta-data android:name="android.support.wearable.complications.UPDATE_PERIOD_SECONDS" android:value="0" />
        </service>
    </application>
</manifest>
```

- [ ] **Step 5: Base resources.** Phone `res/values/strings.xml`: `app_name` "Porthole", `channel_connection` "Connection", `channel_needs_you` "Needs you", `fgs_connected` "Porthole is connected", `fgs_connecting` "Porthole is reconnecting", `action_open` "Open", `shortcut_machines` "Machines", `shortcut_battery` "Battery". `res/values/themes.xml`: `Theme.Porthole` parent `android:Theme.Material.DayNight.NoActionBar`; `Theme.Porthole.Translucent` parent `android:Theme.Translucent.NoTitleBar`. `res/xml/network_security_config.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors><certificates src="system" /></trust-anchors>
    </base-config>
</network-security-config>
```

`res/xml/file_paths.xml`: `<paths><cache-path name="camera" path="camera/" /></paths>`. `res/xml/shortcuts.xml`: two static shortcuts, `machines` (intent `android.intent.action.VIEW`, `targetPackage="ai.porthole.app"`, `targetClass="ai.porthole.app.settings.MachinesActivity"`) and `battery` (`...settings.BatteryGuideActivity`), labels from the strings above. `res/drawable/ic_notify.xml`: a 24 dp single-colour vector (a circle with a dot: the porthole). `res/drawable/ic_launcher_foreground.xml` (108 dp vector, same circle) and `res/mipmap-anydpi/ic_launcher.xml` (`<adaptive-icon>` with `@android:color/black` background and that foreground). Wear: `res/values/strings.xml` `app_name` "Porthole", `complication_usage` "Claude usage", `complication_waiting` "Waiting", `inbox` "Inbox", `usage` "Usage", `stop` "Stop", `no_phone` "Phone not connected", `nothing_waiting` "Nothing needs you"; `res/drawable/ic_complication.xml` and the same two launcher files.

- [ ] **Step 6: Wrapper and env script.** Generate the wrapper with a Gradle that mise installs into Ben's home folder (no sudo):

```bash
mise exec gradle@9.6.1 -- gradle -p android wrapper --gradle-version 9.6.1 --gradle-distribution-sha256-sum 9c0f7faeeb306cb14e4279a3e084ca6b596894089a0638e68a07c945a32c9e14
```

Check `android/gradle/wrapper/gradle-wrapper.properties` contains `distributionSha256Sum=9c0f7faeeb306cb14e4279a3e084ca6b596894089a0638e68a07c945a32c9e14` and `gradle-9.6.1-bin.zip`. `android/gw` (mode 755):

```sh
#!/bin/sh
# Runs the Gradle wrapper with the home-folder JDK 17 and Android SDK. Changes nothing global.
export JAVA_HOME=/home/cymatic/.local/share/mise/installs/java/temurin-17.0.20+101
export ANDROID_HOME=/home/cymatic/Android/Sdk
cd "$(dirname "$0")" && exec ./gradlew "$@"
```

`android/.gitignore`: `.gradle/`, `build/`, `.kotlin/`, `local.properties`, `captures/`, `*.apk`, `*.aab`.

- [ ] **Step 7: First (online) build.** This downloads AGP, Kotlin and the libraries into `~/.gradle` once.

```bash
android/gw :app:assembleDebug :wear:assembleDebug
```

Expected: `BUILD SUCCESSFUL`, and `android/app/build/outputs/apk/debug/app-debug.apk` and `android/wear/build/outputs/apk/debug/wear-debug.apk` exist. If AGP rejects `compileSdk = 37` or `buildToolsVersion`, read the error, fix only that line, retry once.

- [ ] **Step 8: Kotlin version proof (decision 3).**

```bash
android/gw -q buildEnvironment
```

Run it through `ctx_execute` and print only lines containing `kotlin-gradle-plugin`. Expected: `2.4.21` (possibly shown as `2.2.10 -> 2.4.21`). If it shows only `2.2.10`, add `classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.21")` in a `buildscript { dependencies { … } }` block of `android/build.gradle.kts` and rerun.

- [ ] **Step 9: Offline rebuild proof.**

```bash
android/gw --offline clean :app:assembleDebug :wear:assembleDebug
```

Expected: `BUILD SUCCESSFUL` with no network.

- [ ] **Step 10: README.** `android/README.md`: prerequisites (paths above), `./gw :app:assembleDebug`, `./gw --offline …` after first sync, the version table from this plan, decisions 1, 2, 3 and 13 in one paragraph each, and "installing on a device needs Ben's OK at that moment (SPEC 7); the commands are in plan tasks E2 and E3".

- [ ] **Step 11: Commit.**

```bash
git status --short
```

```bash
git add android/settings.gradle.kts android/build.gradle.kts android/gradle.properties android/gradle/libs.versions.toml android/gradle/wrapper/gradle-wrapper.properties android/gradle/wrapper/gradle-wrapper.jar android/gradlew android/gradlew.bat android/gw android/.gitignore android/README.md android/shared/build.gradle.kts android/app/build.gradle.kts android/wear/build.gradle.kts android/app/src/main/AndroidManifest.xml android/wear/src/main/AndroidManifest.xml android/app/src/main/res android/wear/src/main/res && git commit -m "android: Gradle project, pins, manifests, base resources" && git push -u origin HEAD
```

---

## Group A: pure Kotlin rules in `:shared` (JVM unit tests, no Android)

Every A task follows the same five steps: write the test file shown, run it and see it fail, write the implementation, run it and see it pass, commit. Run command pattern (from the worktree root):

```bash
android/gw --offline :shared:test --tests 'ai.porthole.shared.<TestClass>'
```

Expected first run: compilation failure naming the missing class. Expected second run: `BUILD SUCCESSFUL`. Paths below are under `android/shared/src/main/kotlin/ai/porthole/shared/` and `android/shared/src/test/kotlin/ai/porthole/shared/`.

## Task A1: Wire shapes (`Wire.kt`)

**Interfaces:** `object Wire { val json: Json; fun parseEvent(text: String): ServerEvent; fun ack(id: Long): String; fun answerBody(optionIndexes: List<Int>): String; fun keysBody(keys: List<String>): String; fun parseAnswer(text: String): AnswerReply; fun parseUsage(text: String): Usage; fun parseMachineInfo(text: String): MachineInfo; fun parseUpload(text: String): UploadReply }`. `sealed interface ServerEvent { Sessions(tree: JsonElement); Inbox(items: List<InboxItem>); Notify(id: Long, itemId: String, title: String, body: String, options: List<NotifyOption>); Unknown(type: String) }`. `@Serializable data class InboxItem(id, key, sessionId, machine, project, kind, column, title, body, question: Question?, contextLeft: Double?, createdAt: Long, updatedAt: Long, doneAt: Long?, archivedAt: Long?)`, `Question(qid, pid: Int, text, options: List<String>, multi, count: Int, open, outcome: String?)`, `NotifyOption(index: Int, label: String)`, `AnswerReply(status: String, reason: String? = null)` (`reason` is null on a `sent` reply and may be null on a refusal, so a refusal without one must still parse), `Usage(windows: List<UsageWindow>)`, `UsageWindow(id: String, usedPercent: Double? = null, resetsAt: JsonElement? = null, status: String? = null)`, `MachineInfo(name: String, you: You? = null)`, `You(device: String? = null)`, `UploadReply(path: String)`. There is no voice reply type: the phone never posts audio to hostd (design decision 6; the page does that with the WAV the bridge hands it). `Wire.json` = `Json { ignoreUnknownKeys = true; explicitNulls = false }`. Unknown JSON keys are ignored so hostd can grow without breaking the app.

- [ ] **Step 1: Test** `WireTest.kt`:

```kotlin
package ai.porthole.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WireTest {
    @Test fun notifyParses() {
        val e = Wire.parseEvent("""{"type":"notify","id":7,"itemId":"i1","title":"t","body":"b","options":[{"index":0,"label":"Yes"},{"index":1,"label":"No"}],"at":"2026-10-13T10:00:00Z","extra":1}""")
        assertEquals(ServerEvent.Notify(7, "i1", "t", "b", listOf(NotifyOption(0, "Yes"), NotifyOption(1, "No"))), e)
    }
    @Test fun inboxParses() {
        val item = """{"id":"a","key":"k","sessionId":"tmux:t:main:0.0","machine":"testdesk","project":"p","kind":"omp","column":"needs-you","title":"T","body":"B","question":{"qid":"q","pid":1,"text":"Go?","options":["Yes","No"],"multi":false,"count":2,"open":true,"outcome":null},"contextLeft":null,"createdAt":1,"updatedAt":2,"doneAt":null,"archivedAt":null}"""
        val e = Wire.parseEvent("""{"type":"inbox","items":[$item]}""") as ServerEvent.Inbox
        assertEquals("needs-you", e.items[0].column)
        assertEquals(listOf("Yes", "No"), e.items[0].question!!.options)
    }
    @Test fun unknownTypeIsKept() = assertEquals(ServerEvent.Unknown("hello"), Wire.parseEvent("""{"type":"hello"}"""))
    @Test fun sessionsKeepsTree() = assertTrue(Wire.parseEvent("""{"type":"sessions","tree":{"machine":"m"}}""") is ServerEvent.Sessions)
    @Test fun ackAndBodies() {
        assertEquals("""{"type":"ack","id":7}""", Wire.ack(7))
        assertEquals("""{"optionIndexes":[1]}""", Wire.answerBody(listOf(1)))
        assertEquals("""{"keys":["Esc"]}""", Wire.keysBody(listOf("Esc")))
    }
    @Test fun repliesParse() {
        assertEquals(AnswerReply("refused", "question closed"), Wire.parseAnswer("""{"status":"refused","reason":"question closed"}"""))
        assertEquals(AnswerReply("refused", null), Wire.parseAnswer("""{"status":"refused","reason":null}"""))
        assertEquals(AnswerReply("sent", null), Wire.parseAnswer("""{"status":"sent"}"""))
        assertEquals(72.0, Wire.parseUsage("""{"windows":[{"id":"5h","usedPercent":72,"resetsAt":"x","status":"ok"}],"readAt":1}""").windows[0].usedPercent!!, 0.0)
        assertEquals("bencell", Wire.parseMachineInfo("""{"name":"bendesk-omarchy","version":"1","authMode":"tailscale","you":{"device":"bencell","via":"serve"},"features":{}}""").you!!.device)
        assertEquals("/tmp/x.png", Wire.parseUpload("""{"path":"/tmp/x.png"}""").path)
    }
}
```

- [ ] **Step 2: Implement** `Wire.kt` with the interfaces above. `parseEvent` reads the `type` string from the `JsonObject` and decodes the rest per type (`notify` → `Notify` from fields `id`, `itemId`, `title`, `body`, `options`; `inbox` → `items`; `sessions` → `tree`; anything else → `Unknown(type)`). A malformed message throws `SerializationException`; callers (B1) drop it and log one line.
- [ ] **Step 3: Commit.**

```bash
git add android/shared/src/main/kotlin/ai/porthole/shared/Wire.kt android/shared/src/test/kotlin/ai/porthole/shared/WireTest.kt && git commit -m "shared: hostd wire shapes" && git push
```

## Task A2: Origins, navigation policy, bridge allowlist, routes, machines list

**Interfaces:** `@Serializable data class Machine(val name: String, val origin: String)`. `object Origins { fun normalize(input: String): String? }`: returns `https://<lowercase host>` when the input is `https://<host>.ts.net` with optional trailing `/`, optional `:443`, and nothing else; returns `null` for any other scheme, port, path, query, fragment, user info, or a host not ending in `.ts.net`. `object BridgeAllowlist { fun originRules(machines: List<Machine>): Set<String>; fun allows(sourceOrigin: String?, isMainFrame: Boolean, machines: List<Machine>): Boolean }`: rules are the normalised origins (exactly what `WebViewCompat.addWebMessageListener` takes, e.g. `https://bendesk-omarchy.tailafe04c.ts.net`); `allows` is true only for a main frame whose normalised origin is in the rules. `enum class Nav { STAY, CUSTOM_TAB, BLOCK }`, `object NavPolicy { fun decide(url: String, machines: List<Machine>): Nav }`. `object Routes { fun events(origin, device, since: Long): String /* wss://host/v1/events?device=…&since=… */; fun answer(origin, itemId); fun keys(origin, sessionId); fun usage(origin); fun machine(origin); fun uploads(origin); fun openLink(origin, route): String; fun parseOpenLink(uri, machines): String?; fun segment(s: String): String /* percent-encodes all but A-Z a-z 0-9 - . _ ~ */ }` (there is no `voice(origin)`: the phone never posts audio to hostd). `object MachineList { val defaults: List<Machine>; fun add(list, name, originInput): Result<List<Machine>>; fun rename(list, oldName, newName): Result<List<Machine>>; fun remove(list, name): List<Machine>; fun encode(list): String; fun decode(text): List<Machine> }`. Names: 1-32 characters of `a-z 0-9 -`, unique; origins unique. `defaults` = `bendesk-omarchy` → `https://bendesk-omarchy.tailafe04c.ts.net` and `benacer-omarchy` → the laptop origin T0 step 5 reported (G-5; if T0 found no laptop peer, the desktop only).

- [ ] **Step 1: Tests.** `OriginsTest.kt`, `NavPolicyTest.kt`, `MachineListTest.kt`, and `BridgeAllowlistTest.kt` (this one is SPEC 8 P4.2's "pages from unknown origins get no bridge"):

```kotlin
package ai.porthole.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeAllowlistTest {
    private val ms = listOf(Machine("desk", "https://desk.example.ts.net"), Machine("lap", "https://LAP.example.ts.net/"))

    @Test fun rulesAreExactNormalisedOrigins() =
        assertEquals(setOf("https://desk.example.ts.net", "https://lap.example.ts.net"), BridgeAllowlist.originRules(ms))

    @Test fun configuredMainFrameGetsBridge() {
        assertTrue(BridgeAllowlist.allows("https://desk.example.ts.net", true, ms))
        assertTrue(BridgeAllowlist.allows("https://lap.example.ts.net:443", true, ms))
    }

    @Test fun unknownOriginsGetNoBridge() {
        for (o in listOf(
            "https://evil.example.ts.net", "http://desk.example.ts.net", "https://desk.example.ts.net:8443",
            "https://desk.example.ts.net.evil.com", "https://xdesk.example.ts.net", "https://desk.example.ts.net@evil.com",
            "null", "", "file://", "content://ai.porthole.app.files", "about:blank", "data:text/html,x",
        )) assertFalse(o, BridgeAllowlist.allows(o, true, ms))
        assertFalse(BridgeAllowlist.allows(null, true, ms))
    }

    @Test fun subframesGetNoBridgeEvenFromAllowedOrigin() = assertFalse(BridgeAllowlist.allows("https://desk.example.ts.net", false, ms))

    @Test fun invalidConfiguredOriginsAddNoRule() =
        assertEquals(emptySet<String>(), BridgeAllowlist.originRules(listOf(Machine("x", "https://*.ts.net"), Machine("y", "http://y.ts.net"))))

    @Test fun normalizeRefusesWildcardsAndPaths() {
        assertNull(Origins.normalize("https://*.example.ts.net"))
        assertNull(Origins.normalize("https://desk.example.ts.net/x"))
        assertNull(Origins.normalize("https://desk.example.ts.net?q"))
        assertEquals("https://desk.example.ts.net", Origins.normalize("https://DESK.example.ts.net:443/"))
    }
}
```

`NavPolicyTest`: a configured origin with any path or hash → `STAY`; `https://desk.example.ts.net:8443/` (a preview) → `CUSTOM_TAB`; `https://example.com/` → `CUSTOM_TAB`; `http://desk.example.ts.net/`, `intent://x`, `javascript:alert(1)`, `file:///sdcard/x`, `content://x` → `BLOCK`. `MachineListTest`: defaults contain the desktop origin; `add` normalises the origin, refuses a duplicate name, a duplicate origin, a bad name (`"Desk Top"`), and an `http:` origin (each a `Result.failure` with a message the C2 form shows); `rename` refuses a taken name; `remove` of an unknown name returns the same list; `decode(encode(list)) == list`; `decode("garbage")` returns `defaults`. A `Routes` case inside `OriginsTest`: `Routes.events("https://desk.example.ts.net", "bencell", 12)` == `"wss://desk.example.ts.net/v1/events?device=bencell&since=12"`, `Routes.keys(o, "tmux:t:main:0.0")` == `"https://desk.example.ts.net/v1/sessions/tmux%3At%3Amain%3A0.0/keys"`, `Routes.answer(o, "a b")` ends `/v1/inbox/a%20b/answer`.
`Routes` also builds and checks the watch's "Open on phone" link (`Routes.openLink(origin, route)` and `Routes.parseOpenLink(uri, machines)`). `Routes.openLink("https://desk.example.ts.net", "#/chat/desk/tmux%3Ax%3A0")` == `"porthole://open?origin=https%3A%2F%2Fdesk.example.ts.net&route=%23%2Fchat%2Fdesk%2Ftmux%253Ax%253A0"`. `Routes.parseOpenLink(uri, machines)` returns the URL to load (`"https://desk.example.ts.net/#/chat/desk/tmux%3Ax%3A0"`) or `null`. The scheme must be `porthole`, the host `open`, the `origin` must normalise (`Origins.normalize`) to a configured machine, and the `route` must be exactly `#/inbox` or `#/chat/<part>/<part>` where each part is non-empty and made only of `A-Za-z0-9._~%-` (the routes the built page has: `web/src/lib/route.js`; `#/inbox/<itemId>` is not a route and would land on the plain inbox). Tests in `OriginsTest`: the round trip above; an unconfigured origin, `route=%23%2Fterm%2Fa%2Fb`, `route=%23%2Fchat%2Fa%2F..%2Fb`, `route=javascript%3Aalert(1)`, a `file:` scheme and host `evil` each return `null`.
- [ ] **Step 2: Implement** the six files. `Origins.normalize` parses with `java.net.URI`, requires `scheme == "https"`, `userInfo == null`, `port in (-1, 443)`, `rawPath in ("", "/")`, `rawQuery == null`, `rawFragment == null`, host matching `^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$` after lowercasing (this refuses `*`). `NavPolicy.decide`: parse with `URI` (unparseable → `BLOCK`); `https` and `Origins.normalize("https://" + host + (if (port == -1) "" else ":$port"))` in the rules → `STAY`; other `https` → `CUSTOM_TAB`; else `BLOCK`.
- [ ] **Step 3: Commit.**

```bash
git add android/shared/src/main/kotlin/ai/porthole/shared/Origins.kt android/shared/src/main/kotlin/ai/porthole/shared/NavPolicy.kt android/shared/src/main/kotlin/ai/porthole/shared/BridgeAllowlist.kt android/shared/src/main/kotlin/ai/porthole/shared/Routes.kt android/shared/src/main/kotlin/ai/porthole/shared/Machine.kt android/shared/src/main/kotlin/ai/porthole/shared/MachineList.kt android/shared/src/test/kotlin/ai/porthole/shared/OriginsTest.kt android/shared/src/test/kotlin/ai/porthole/shared/NavPolicyTest.kt android/shared/src/test/kotlin/ai/porthole/shared/BridgeAllowlistTest.kt android/shared/src/test/kotlin/ai/porthole/shared/MachineListTest.kt && git commit -m "shared: origin rules, bridge allowlist, nav policy, routes, machines list" && git push
```

## Task A3: Reconnect backoff (`Backoff.kt`)

**Interfaces:** `class Backoff(private val capMs: Long = 15_000) { fun nextDelayMs(): Long; fun reset(); fun nudge(): Long /* resets and returns 0: Android reported a network change, retry now (SPEC 4.13) */ }`.

- [ ] **Step 1: Test** `BackoffTest.kt` (SPEC 8 P4.2, the reconnect backoff):

```kotlin
package ai.porthole.shared

import org.junit.Assert.assertEquals
import org.junit.Test

class BackoffTest {
    @Test fun doublesFromOneSecondAndCapsAtFifteen() {
        val b = Backoff()
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 15_000L, 15_000L, 15_000L), List(7) { b.nextDelayMs() })
    }
    @Test fun resetAfterSuccessStartsAgainAtOne() {
        val b = Backoff(); repeat(5) { b.nextDelayMs() }; b.reset()
        assertEquals(1_000L, b.nextDelayMs())
    }
    @Test fun nudgeRetriesNowThenRestartsTheSchedule() {
        val b = Backoff(); repeat(4) { b.nextDelayMs() }
        assertEquals(0L, b.nudge())
        assertEquals(1_000L, b.nextDelayMs())
    }
    @Test fun manyFailuresNeverOverflow() {
        val b = Backoff(); repeat(10_000) { b.nextDelayMs() }
        assertEquals(15_000L, b.nextDelayMs())
    }
}
```

- [ ] **Step 2: Implement:** `nextDelayMs() = minOf(1_000L shl minOf(attempt, 4), capMs).also { if (attempt < 30) attempt++ }`; `reset()` sets `attempt = 0`; `nudge()` resets and returns `0`.
- [ ] **Step 3: Commit.**

```bash
git add android/shared/src/main/kotlin/ai/porthole/shared/Backoff.kt android/shared/src/test/kotlin/ai/porthole/shared/BackoffTest.kt && git commit -m "shared: reconnect backoff 1,2,4..15 s" && git push
```

## Task A6: WAV header and silence detector (`Audio.kt`)

**Interfaces:** `object Wav { const val SAMPLE_RATE = 16_000; const val MAX_BYTES = 25L * 1024 * 1024; const val MAX_RECORDING_MS = 600_000L; fun header(dataBytes: Long): ByteArray /* 44 bytes, PCM, 1 channel, 16 bit */ ; fun maxDataBytes(): Long = MAX_BYTES - 44; fun maxRecordingDataBytes(): Long = SAMPLE_RATE * 2L * MAX_RECORDING_MS / 1000 /* 19_200_000 */ }`. `MAX_BYTES` is the most the app ever puts in one WAV file; `MAX_RECORDING_MS` is design decision 10's 10-minute recording cap (16 kHz × 2 bytes × 600 s = 19.2 MB, inside the 25 MB file limit). `class SilenceDetector(sampleRate: Int = 16_000, private val thresholdRms: Double = 500.0, private val silenceMs: Long = 2_000) { fun feed(samples: ShortArray, count: Int): Boolean /* true = stop now */ }`: returns true only after speech (a block with RMS ≥ threshold) was heard and then `silenceMs` of continuous blocks below threshold followed.

- [ ] **Step 1: Test** `AudioTest.kt`:

```kotlin
package ai.porthole.shared

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioTest {
    @Test fun headerIsCanonical16kMono16bit() {
        val h = ByteBuffer.wrap(Wav.header(32_000)).order(ByteOrder.LITTLE_ENDIAN)
        assertArrayEquals("RIFF".toByteArray(), ByteArray(4) { h.get(it) })
        assertEquals(36 + 32_000, h.getInt(4))
        assertArrayEquals("WAVEfmt ".toByteArray(), ByteArray(8) { h.get(8 + it) })
        assertEquals(16, h.getInt(16)); assertEquals(1, h.getShort(20).toInt()); assertEquals(1, h.getShort(22).toInt())
        assertEquals(16_000, h.getInt(24)); assertEquals(32_000, h.getInt(28))
        assertEquals(2, h.getShort(32).toInt()); assertEquals(16, h.getShort(34).toInt())
        assertArrayEquals("data".toByteArray(), ByteArray(4) { h.get(36 + it) })
        assertEquals(32_000, h.getInt(40))
        assertEquals(44, Wav.header(0).size)
    }
    @Test fun limitIs25MegabytesIncludingHeader() = assertEquals(25L * 1024 * 1024 - 44, Wav.maxDataBytes())
    @Test fun recordingCapIsTenMinutesOf16kMono() {
        assertEquals(19_200_000L, Wav.maxRecordingDataBytes())
        assertTrue(Wav.maxRecordingDataBytes() <= Wav.maxDataBytes())
    }

    private fun block(level: Short) = ShortArray(1_600) { if (it % 2 == 0) level else (-level).toShort() } // 100 ms

    @Test fun silenceBeforeSpeechNeverStops() {
        val d = SilenceDetector()
        repeat(50) { assertFalse(d.feed(block(10), 1_600)) }
    }
    @Test fun twoSecondsOfSilenceAfterSpeechStops() {
        val d = SilenceDetector()
        assertFalse(d.feed(block(4_000), 1_600))
        repeat(19) { assertFalse(d.feed(block(10), 1_600)) }
        assertTrue(d.feed(block(10), 1_600))
    }
    @Test fun speechResetsTheSilenceClock() {
        val d = SilenceDetector()
        d.feed(block(4_000), 1_600); repeat(15) { d.feed(block(10), 1_600) }
        assertFalse(d.feed(block(4_000), 1_600))
        repeat(19) { assertFalse(d.feed(block(10), 1_600)) }
        assertTrue(d.feed(block(10), 1_600))
    }
}
```

- [ ] **Step 2: Implement** `Audio.kt` (little-endian `ByteBuffer`; RMS over `count` samples; silence clock in samples: `silentSamples += count`, stop when `silentSamples >= sampleRate * silenceMs / 1000`).
- [ ] **Step 3: Commit.**

```bash
git add android/shared/src/main/kotlin/ai/porthole/shared/Audio.kt android/shared/src/test/kotlin/ai/porthole/shared/AudioTest.kt && git commit -m "shared: 16 kHz mono WAV header, 25 MB limit, silence auto-stop" && git push
```

## Task A4: Bridge protocol (`BridgeProtocol.kt`)

**Interfaces** (matches the P3 plan's bridge adapter, `web/src/net/bridge.js` and the real calls in `web/src`: requests `{id, method, args}`, replies `{id, ok:true, result}` / `{id, ok:false, error}`, events `{event, data}`): `object BridgeProtocol { val METHODS: Set<String> /* machines, speak, stopSpeaking, startRecording, stopRecording, pickFile, openExternal: exactly seven, no openSettings */; const val MAX_MESSAGE_CHARS = 262_144; fun parse(text: String): Parsed; fun ok(id: JsonElement, result: JsonElement): String; fun error(id: JsonElement, message: String): String; fun event(name: String, data: JsonElement): String }`. `sealed interface Parsed { data class Call(val id: JsonElement, val method: String, val args: JsonObject) : Parsed; data class Bad(val id: JsonElement?, val reason: String) : Parsed }`. Argument readers, each returning `Result<T>` and shaped by what the page really sends: `speakArgs(args): Result<List<String>>` (`{utterances}`: 1 or more non-empty strings; the total size in UTF-8 bytes of all of them at most 100 000, the page's own limit; no per-string cap and no count cap, `Speaker` splits long text), `autoStopArg(args): Boolean` (`startRecording({autoStop})`, absent or non-boolean → `false`; there is no `origin` argument and no `recordArgs`), `pickArgs(args): Result<String>` (`{source}` must be `camera`, `photo` or `file`; `clipboard` and anything else are refused; there is no `origin` argument, the machine comes from the verified `sourceOrigin` in C1), `externalArgs(args): Result<ExternalTarget>` (`{url}`; `sealed interface ExternalTarget { data class Https(val url: String); data object NotificationSettings }`: the exact string `porthole://notification-settings` → `NotificationSettings`, an `https:` URL with a host (parsed by `java.net.URI`) → `Https`, everything else refused). There is no `settingsArgs` (design decisions 5 and 6).

- [ ] **Step 1: Test** `BridgeProtocolTest.kt`: a `machines` call parses to `Call`; a method not in `METHODS` (`readFile`, `eval`, `openSettings`, `""`) parses to `Bad(id, "Bridge method not allowed: <name>")` (the same words the P3 adapter uses; for `""` the name part is empty); `METHODS` has exactly the seven names; non-JSON, a JSON array, missing `method`, and a message over `MAX_MESSAGE_CHARS` (262 144 characters) parse to `Bad`, while a 70 kB message is accepted; `ok`/`error`/`event` produce exactly `{"id":1,"ok":true,"result":[]}`, `{"id":1,"ok":false,"error":"x"}`, `{"event":"network","data":{"online":true}}`; `speakArgs` accepts 21 short utterances and refuses an empty list, an empty string, and strings whose total is 100 001 UTF-8 bytes (a 100 000-byte total passes; multi-byte characters count by bytes); `autoStopArg` reads `{"autoStop":true}` and defaults to `false` for `{}` and `{"autoStop":"yes"}`; `pickArgs` accepts `camera`, `photo`, `file` and refuses `clipboard`, `""` and a missing `source`; `externalArgs` returns `NotificationSettings` for `porthole://notification-settings`, `Https` for `https://example.com/a`, and refuses `http://x`, `javascript:x`, `intent://x`, `porthole://other`, `porthole://notification-settings/x`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Commit.**

```bash
git add android/shared/src/main/kotlin/ai/porthole/shared/BridgeProtocol.kt android/shared/src/test/kotlin/ai/porthole/shared/BridgeProtocolTest.kt && git commit -m "shared: native bridge protocol and argument checks" && git push
```

## Task A5: Notification plan, ack ledger, answer outcome

**Interfaces:** `data class NotifyPlan(val tag: String, val id: Int, val title: String, val body: String, val subText: String, val answers: List<NotifyOption>, val itemId: String, val notifyId: Long)`; `object NotifyPlanner { fun plan(n: ServerEvent.Notify, machine: Machine): NotifyPlan }`: `tag = machine.origin`, `id = n.itemId.hashCode()`, title cut to 80 characters and body to 200 (SPEC 4.7; cut at a character boundary, ending with `…` when cut), `subText = machine.name`, `answers = if (n.options.size in 2..3) n.options.take(2) else emptyList()`. `@Serializable data class ShownNotify(val id: Long, val itemId: String)`; `@Serializable data class LedgerState(val highest: Long = 0, val shown: List<ShownNotify> = emptyList(), val unacked: List<Long> = emptyList(), val needsYou: List<String> = emptyList())`; `enum class Arrival { FRESH, DUPLICATE, COUNTER_RESET }`; `class NotifyLedger(var state: LedgerState) { fun arrival(id: Long, itemId: String): Arrival; fun markShown(id: Long, itemId: String); fun markAcked(id: Long); fun since(): Long = state.highest; fun pendingAcks(): List<Long>; fun reset(); fun noteNeedsYou(itemId: String); fun onInbox(needsYouIds: Set<String>): List<String> }` (`shown` keeps the newest 200 pairs; `needsYou` keeps the newest 200 item ids). `arrival` is `FRESH` when `id > highest`, `DUPLICATE` when `id <= highest` and the pair `(id, itemId)` is in `shown`, otherwise `COUNTER_RESET` (design decision 8; the one cost is that a redelivery of a pair older than the newest 200 would show again, and only unacked recent ids are redelivered). `reset()` clears `highest`, `shown`, `unacked` and `needsYou`. `noteNeedsYou(itemId)` records "this item's notification was shown while the item was in `needs-you`" (design decision 7). `onInbox(needsYouIds)` takes the item ids that are `needs-you` and unarchived in the newest `inbox` message and returns the item ids whose notifications must be cancelled: those in `state.needsYou` that are not in `needsYouIds` (answered elsewhere and now `working`, or gone); they are removed from `state.needsYou`, and every `shown` item id that is in `needsYouIds` is added to it, so a notification shown just before its inbox row arrived is also tracked. An item that was never recorded as `needs-you` (a `turnFinished` notice) is never returned. `sealed interface AnswerOutcome { data class Sent(val label: String); data class Refused(val reason: String); data object Gone; data class Failed(val message: String) }` with `fun AnswerOutcome.Companion.from(code: Int, body: String?, label: String): AnswerOutcome` (200 + `status:"sent"` → `Sent`; 409 → `Refused(reason ?: "not sent")`, so a `{"status":"refused"}` body without a reason also works; 404 → `Gone`; anything else, including a network exception mapped to code `-1` → `Failed`) and `fun AnswerOutcome.text(): String` ("Sent: Yes", "Not sent: question closed", "This question is gone", "Couldn't send. Open Porthole to try again").

- [ ] **Step 1: Tests.** `NotifyPlannerTest.kt`:

```kotlin
package ai.porthole.shared

import org.junit.Assert.assertEquals
import org.junit.Test

class NotifyPlannerTest {
    private val m = Machine("desk", "https://desk.example.ts.net")
    private fun n(opts: Int, title: String = "t") =
        ServerEvent.Notify(1, "item-1", title, "b", List(opts) { NotifyOption(it, "o$it") })

    @Test fun twoOrThreeOptionsGiveAtMostTwoAnswerButtons() {
        assertEquals(listOf("o0", "o1"), NotifyPlanner.plan(n(2), m).answers.map { it.label })
        assertEquals(listOf("o0", "o1"), NotifyPlanner.plan(n(3), m).answers.map { it.label })
    }
    @Test fun otherCountsGiveOpenOnly() {
        for (k in listOf(0, 1, 4, 6)) assertEquals(emptyList<NotifyOption>(), NotifyPlanner.plan(n(k), m).answers)
    }
    @Test fun textIsCutToSpecLimits() {
        val p = NotifyPlanner.plan(n(0, "x".repeat(200)), m)
        assertEquals(80, p.title.length); assertEquals('…', p.title.last())
    }
    @Test fun sameItemReplacesItsNotification() {
        assertEquals(NotifyPlanner.plan(n(2), m).id, NotifyPlanner.plan(n(3), m).id)
        assertEquals("https://desk.example.ts.net", NotifyPlanner.plan(n(2), m).tag)
    }
}
```

`NotifyLedgerTest.kt`: a new id is `FRESH`; after `markShown(5, "a")` it is `DUPLICATE` for `(5, "a")`, `since()` is 5 and `pendingAcks()` is `[5]`; after `markAcked(5)` `pendingAcks()` is empty and `(5, "a")` stays `DUPLICATE`; 250 ids keep only the newest 200 pairs in `shown` while `highest` stays the maximum; a lower id after a higher one does not lower `since()`. Counter reset: after `markShown(900, "a")`, `arrival(1, "b")` is `COUNTER_RESET`, so is `arrival(1, "a")` (same item, new counter), and `arrival(900, "b")` is `COUNTER_RESET` while `arrival(900, "a")` is `DUPLICATE`; `reset()` then `since()` is 0, `pendingAcks()` is empty, and `arrival(1, "b")` is `FRESH`. Cancel rule: `markShown(1, "q")` then `noteNeedsYou("q")`; `onInbox(setOf("q"))` returns `[]`; `onInbox(emptySet())` returns `["q"]` once and `[]` the second time; `markShown(2, "t")` for a turn-finished notice never noted: `onInbox(emptySet())` never returns `"t"`; `markShown(3, "r")` with no `noteNeedsYou`, then `onInbox(setOf("r"))` (the row arrived after the notify) and `onInbox(emptySet())` returns `["r"]`. `AnswerOutcomeTest.kt`: the four mappings and their texts above, and a `409` with body `{"status":"refused"}` gives `Refused("not sent")`.
- [ ] **Step 2: Implement** the three files.
- [ ] **Step 3: Commit.**

```bash
git add android/shared/src/main/kotlin/ai/porthole/shared/NotifyPlanner.kt android/shared/src/main/kotlin/ai/porthole/shared/NotifyLedger.kt android/shared/src/main/kotlin/ai/porthole/shared/AnswerOutcome.kt android/shared/src/test/kotlin/ai/porthole/shared/NotifyPlannerTest.kt android/shared/src/test/kotlin/ai/porthole/shared/NotifyLedgerTest.kt android/shared/src/test/kotlin/ai/porthole/shared/AnswerOutcomeTest.kt && git commit -m "shared: notification plan, ack ledger, answer outcome" && git push
```

## Task A7: Watch state, answers, paths, complication text

**Interfaces:** `object WatchPaths { const val STATE = "/porthole/state"; const val ANSWER = "/porthole/answer"; const val ANSWER_RESULT = "/porthole/answer-result"; const val REFRESH = "/porthole/refresh"; const val PHONE_CAPABILITY = "porthole_phone" }`. `@Serializable data class WatchItem(val origin: String, val machine: String, val itemId: String, val sessionId: String, val project: String, val title: String, val question: String?, val options: List<String>, val multi: Boolean, val updatedAt: Long)`; `@Serializable data class WatchUsage(val machine: String, val windowId: String, val usedPercent: Double, val resetsAt: String?)`; `@Serializable data class WatchState(val updatedAt: Long, val items: List<WatchItem>, val usage: List<WatchUsage>)` with `fun encode(): ByteArray` and `companion fun decode(bytes: ByteArray): WatchState?` (null on bad bytes). `@Serializable sealed interface WatchAnswer { val requestId: String; Option(requestId, origin, itemId, optionIndexes: List<Int>); Stop(requestId, origin, sessionId) }` and `@Serializable data class WatchAnswerResult(val requestId: String, val ok: Boolean, val message: String)`, both with `encode()`/`decode()`. `object WatchRules { const val MAX_ITEMS = 30; const val MAX_BYTES = 90_000; fun build(now: Long, inbox: Map<Machine, List<InboxItem>>, usage: Map<Machine, Usage>): WatchState }`: keeps `column == "needs-you" && archivedAt == null`, newest `updatedAt` first, at most 30, question text cut to 300 characters, options copied only when `!multi` (multi-select answers on the watch are Open-on-phone only, SPEC 4.14 "answer with one tap"), usage windows with a non-null `usedPercent`; then drops items from the end until `encode().size <= MAX_BYTES`. `object ComplicationText { data class Short(val text: String, val title: String, val description: String); data class Ranged(val value: Float, val text: String, val description: String); fun waiting(state: WatchState?): Short; fun usage(state: WatchState?): Ranged? }`: `waiting` → `Short("3", "waiting", "3 waiting")` (`"0"` when null state); `usage` → highest `usedPercent` clamped 0-100, `"72%"`, `"Highest Claude usage 72 percent"`, or `null` when there are no windows (the data source then sends `NoDataComplicationData`).

- [ ] **Step 1: Tests.** `WatchRulesTest.kt`: from two machines' inboxes (mixed columns, one archived, one multi-select), only needs-you unarchived items remain, newest first, with the multi item's `options` empty; 40 items give 30; one item with a 100 kB body still encodes under 90 000 bytes (question cut). `WatchStateTest.kt`: `decode(encode(s)) == s`; `decode("x".toByteArray()) == null`; both `WatchAnswer` kinds round-trip with their `requestId`. `ComplicationTextTest.kt`: `waiting` of 3 items is `Short("3","waiting","3 waiting")`, of null is `"0"`; `usage` picks 72 over 40, clamps 130 to 100, and is null with no windows.
- [ ] **Step 2: Implement** the five files (sealed-class JSON uses kotlinx's default `type` discriminator; this exact shape replaces the `{origin, sessionId, stop:true}` sketch in design decision 11).
- [ ] **Step 3: Commit.**

```bash
git add android/shared/src/main/kotlin/ai/porthole/shared/WatchState.kt android/shared/src/main/kotlin/ai/porthole/shared/WatchAnswer.kt android/shared/src/main/kotlin/ai/porthole/shared/WatchPaths.kt android/shared/src/main/kotlin/ai/porthole/shared/ComplicationText.kt android/shared/src/main/kotlin/ai/porthole/shared/WatchRules.kt android/shared/src/test/kotlin/ai/porthole/shared/WatchStateTest.kt android/shared/src/test/kotlin/ai/porthole/shared/ComplicationTextTest.kt android/shared/src/test/kotlin/ai/porthole/shared/WatchRulesTest.kt && git commit -m "shared: watch state, answers, data paths, complication text" && git push
```

---

## Group B: phone services (`:app`, Robolectric tests on the JVM)

B tasks use Robolectric (`@RunWith(RobolectricTestRunner::class)`, `@Config(sdk = [35])`, G-8) for Android classes and a plain JVM for anything that only needs OkHttp's `MockWebServer`. Run pattern:

```bash
android/gw --offline :app:testDebugUnitTest --tests 'ai.porthole.app.<pkg>.<TestClass>'
```

Each task: tests → see fail → implement → see pass → commit (files by name, then `git push`). Paths below are under `android/app/src/main/kotlin/ai/porthole/app/` and `android/app/src/test/kotlin/ai/porthole/app/`.

## Task B1: Network layer (`net/`)

**Interfaces:** `class Http(val client: OkHttpClient)` built once in `PortholeApp` with `connectTimeout 10 s`, `readTimeout 30 s`, `pingInterval 25 s` (keeps the WebSocket alive through Tailscale and lets OkHttp notice a dead link), no cookie jar, and one application interceptor that adds the headers SPEC 4.16 and 5.4 require from native code: `X-Porthole: 1` on every HTTP request, and `Origin: <scheme://host of the request URL>` on every request including the WebSocket upgrade (for `wss://` the `Origin` is the matching `https://` origin). No other auth: Tailscale identity is the auth. `class HostClient(http: Http) { suspend fun machine(m: Machine): Result<MachineInfo>; suspend fun answer(m, itemId, indexes): AnswerOutcome; suspend fun keys(m, sessionId, keys): Result<Unit>; suspend fun usage(m): Result<Usage>; suspend fun inbox(m): Result<List<InboxItem>> /* GET /v1/inbox */ ; suspend fun upload(m, name, mime, body: RequestBody): Result<UploadReply> }`. There is no `voice` call: the page posts recordings to `/v1/voice` itself (design decision 6). `class EventsSocket(http, machine, device, ledger: NotifyLedger, scope, onEvent: (ServerEvent) -> Unit, onState: (Online) -> Unit)` with `fun start(); fun stop(); fun nudge()`: opens `Routes.events(origin, device, ledger.since())`, sends `Wire.ack(id)` for each `notify` after `onEvent` returns (also for a duplicate the ledger already saw), resends `ledger.pendingAcks()` on every open, reconnects with `Backoff`, `nudge()` cancels the pending delay. `object Scheduler` is the one place that owns `delay` so tests use `kotlinx-coroutines-test` virtual time. `class MachineStore(ctx)` keeps `MachineList.encode` in `SharedPreferences("machines")`, exposes `StateFlow<List<Machine>>`, plus the device name per machine (`MachineInfo.you.device`, fetched once and cached; fallback `bencell`, design decision 9). `object Graph` is the hand-made dependency holder (no DI library), initialised in `PortholeApp.onCreate`. `object Intents` holds every action string and extra key (`ai.porthole.app.ANSWER`, `EXTRA_ORIGIN`, `EXTRA_ITEM`, `EXTRA_INDEX`, `EXTRA_LABEL`, `EXTRA_NOTIFY_ID`).

- [ ] **Step 1: Tests.** `HostClientTest.kt` (MockWebServer): `answer` POSTs `{"optionIndexes":[1]}` to `/v1/inbox/item-1/answer` with `Content-Type: application/json` and maps 200/409/404/500 and a closed socket to the four `AnswerOutcome`s; `keys` posts `{"keys":["Esc"]}` to the percent-encoded session path; `upload` posts multipart field `file`; every request carries `X-Porthole: 1` and an `Origin` equal to the server's own origin, and none carries `Authorization` or `Cookie`. `EventsSocketTest.kt` (MockWebServer WebSocket + virtual time): the upgrade request carries the exact `Origin`; connects with `since=0`, then after a `notify` id 7 the server receives `{"type":"ack","id":7}`; the server closing the socket triggers reconnects at 1 s, 2 s, 4 s virtual time; the reconnect URL carries `since=7`; an un-acked id (ack send failed) is resent first on the next open; `nudge()` during a 4 s wait reconnects at once; a malformed message is dropped without closing the socket. `MachineStoreTest.kt` (Robolectric): defaults on first run, add/remove persist across a new `MachineStore` instance, device fallback is `bencell`.
- [ ] **Step 2: Implement** `Http.kt`, `HostClient.kt`, `EventsSocket.kt`, `Scheduler.kt`, `MachineStore.kt`, `Graph.kt`, `Intents.kt`, `PortholeApp.kt` (register `PortholeApp` as `android:name` in the T1 manifest, already present).
- [ ] **Step 3: Commit** the eight main files and three test files by name; push.

## Task B2: Always-on events service, notifications, answers from the shade

**Interfaces:** `class Notifier(ctx)`: creates channels `needs-you` (importance high, the only channel that makes noise) and `connection` (importance low, the foreground-service notification "Porthole is connected: 2 machines", with actions Machines and Battery per design decision 5), `fun show(plan: NotifyPlan)` (an Open action first, then one action per `plan.answers`; content intent also opens), `fun confirm(plan, text)` (replaces the same tag/id with the outcome text and only the Open action), `fun cancel(origin, itemId)`. Notifications are not `setLocalOnly` (design decision 7). Answer actions are `PendingIntent.getBroadcast(…, FLAG_IMMUTABLE)` to `AnswerReceiver`, request code `(notifyId * 4 + index).toInt()` so each action is distinct. Open (the Open action and the content intent) starts `MainActivity` with the `porthole://open` link from `Routes.openLink(origin, route)` (C1 handles it), where `route` is `#/chat/<machine>/<sessionId>` (each part encoded the same way as the page's route) when the item is in the machine's last known inbox, and `#/inbox` when it is not: the built page has no `#/inbox/<itemId>` route. `class NotifyFlow(ledger, notifier, machine)`: `fun onNotify(n)` → `ledger.arrival(n.id, n.itemId)`: `DUPLICATE` → ack only, nothing shown; `COUNTER_RESET` → `ledger.reset()` first (design decision 8), then the same as `FRESH`; `FRESH` → `notifier.show(NotifyPlanner.plan(n, machine))`, `ledger.markShown(n.id, n.itemId)`, and `ledger.noteNeedsYou(n.itemId)` when the machine's last inbox holds that item in `needs-you`. `fun onInbox(items)` → `ledger.onInbox(needsYouIds)` (the ids of items in `needs-you`) returns the item ids to cancel, and `notifier.cancel(origin, itemId)` runs for each; a turn-finished notice is never cancelled this way (design decision 7). `class LedgerStore(ctx)` persists one `LedgerState` per origin as JSON in `SharedPreferences("ledger")`. `class ConnectionHub` owns one `EventsSocket` per machine, starts/stops them when `MachineStore` changes, exposes `StateFlow<Map<String, Online>>` for the bridge `network` event and the watch relay, and the latest inbox per machine. `class EventsService : LifecycleService` (foreground type `remoteMessaging`, design decision 1): `startForeground` within 5 s with the `connection` notification, runs `ConnectionHub`, stops itself only from the settings screen. `class AnswerHandler(host, notifier)`: `suspend fun answer(machine, itemId, index, label, plan)` → `notifier.confirm(plan, outcome.text())`. `class AnswerReceiver : BroadcastReceiver` uses `goAsync()` and a 20 s `withTimeout` around `AnswerHandler` [INFERENCE: `goAsync` work may run about 30 s before Android kills it; 20 s leaves margin]. `class BootReceiver` handles `BOOT_COMPLETED` and `MY_PACKAGE_REPLACED` via `BootPolicy.startFromBoot(ctx)`, which starts `EventsService` with `startForegroundService`; that `remoteMessaging` may start from boot is G-6 (T0 step 4, then proved on the phone in E2 step 4h). `class NetworkWatcher(ctx, hub)`: `ConnectivityManager.registerDefaultNetworkCallback` → `onAvailable` calls `hub.nudge()`.

- [ ] **Step 1: Tests.** `NotifyFlowTest.kt` (Robolectric, `ShadowNotificationManager`, fake ledger store): a 2-option notify posts one notification on `needs-you` with Open plus two answer actions and the title cut to 80; the same id twice posts once but is acked both times; a 5-option notify has only Open; a second machine's item with the same itemId gets its own notification (tag differs). Cancel rule: a question notify, then an `inbox` where the item is `needs-you` (nothing cancelled), then an `inbox` where it is `working` (answered elsewhere) cancels it; an `inbox` without the item cancels it; a `turnFinished` notice (item `working` in the inbox, never `needs-you`) stays after every `inbox` message. Counter reset: after a notify with id 900, a notify with id 1 for another item is shown and the ledger restarts (`since` becomes 1). Open route: a notify whose item is in the last inbox opens `#/chat/<machine>/<sessionId>`; one that is not opens `#/inbox`. `NotifierTest.kt` (Robolectric): both channels exist with the importances above; `confirm` leaves only Open. `AnswerHandlerTest.kt` (MockWebServer + Robolectric): 200 → the notification text becomes "Sent: Yes"; 409 `question closed` → "Not sent: question closed"; server down → "Couldn't send. Open Porthole to try again". `EventsServiceTest.kt` (Robolectric `ServiceController`): `onStartCommand` calls `startForeground` with type `FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING` on the `connection` channel. `BootReceiverTest.kt`: `BOOT_COMPLETED` and `MY_PACKAGE_REPLACED` each start `EventsService`; another action does nothing. `LedgerStoreTest.kt`: state survives a new instance.
- [ ] **Step 2: Implement** `Notifier.kt`, `NotifyFlow.kt`, `LedgerStore.kt`, `ConnectionHub.kt`, `EventsService.kt`, `AnswerHandler.kt`, `AnswerReceiver.kt`, `BootReceiver.kt` (with `BootPolicy`), `NetworkWatcher.kt` under `events/`. Manifest entries were added in T1.
- [ ] **Step 3: Commit** the nine main files and six test files by name; push.

## Task B3: Voice: record and speak

**Interfaces:** `class WavFileWriter(file: File, maxDataBytes: Long = Wav.maxRecordingDataBytes()) : Closeable { fun write(samples: ShortArray, count: Int): Boolean /* false once maxDataBytes reached */ ; override fun close() /* rewrites the 44-byte header with the real length via RandomAccessFile */ }`. In `Recorder.kt`: `interface Mic { fun read(buf: ShortArray): Int; fun stop() }` and `AudioRecordMic` (16 kHz, `CHANNEL_IN_MONO`, `ENCODING_PCM_16BIT`, `MediaRecorder.AudioSource.VOICE_RECOGNITION`) so tests feed a fake; `class Recorder(mic: Mic, dir: File) { suspend fun record(autoStop: Boolean, stopSignal: StateFlow<Boolean>): Recording }` with `data class Recording(val file: File, val reason: String /* "stopped"|"silence"|"limit"|"background" */)`; it stops on `stopSignal`, on `SilenceDetector` (when `autoStop`), or at the 10-minute cap (`Wav.maxRecordingDataBytes()` = 19 200 000 bytes of audio, reason `limit`), writing into `cacheDir/voice/`. The file goes back to the bridge, which returns it as `{wav}` (C1); this task has no upload code, no unsent store and no `/v1/voice` call (design decision 6). `interface TtsEngine { fun speak(text: String, id: String); fun stop(); var listener: ((id: String, done: Boolean) -> Unit)? }`, `AndroidTts : TtsEngine` wraps `TextToSpeech` with `QUEUE_ADD` and `KEY_PARAM_STREAM = STREAM_MUSIC`. `class Speaker(engine, maxChars: Int = 4_000) { suspend fun speak(utterances: List<String>): Boolean /* true = finished, false = stopped */ ; fun stop() }`: any utterance longer than `maxChars` is split at a space (or hard at `maxChars`) so the engine never gets more than its maximum input length; it requests transient audio focus (`AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK`) while speaking.

- [ ] **Step 1: Tests.** `WavFileWriterTest.kt`: write 1 s of samples, close, file is 44 + 32 000 bytes with header lengths matching; with `maxDataBytes = 1_000` writing past it returns false. `RecorderTest.kt` (fake `Mic`, virtual time): stop signal ends with reason `stopped`; speech then 2 s silence ends with `silence` when `autoStop`; silence alone never ends it when `autoStop` is false; a fake mic fed past the cap (the test passes a small `maxDataBytes`) ends with reason `limit` and a file of exactly the cap. `SpeakerTest.kt` (fake engine): three utterances reach the engine in order and `speak` returns true after the third finishes; an utterance of 9 000 characters reaches the engine as pieces of at most 4 000 characters that join back to the original text; `stop()` calls `engine.stop()` and `speak` returns false.
- [ ] **Step 2: Implement** the five files under `voice/` (`WavFileWriter.kt`, `Recorder.kt`, `TtsEngine.kt`, `AndroidTts.kt`, `Speaker.kt`). `RECORD_AUDIO` is requested at the moment of the first `startRecording` bridge call (C1), never at launch.
- [ ] **Step 3: Commit** files by name; push.

## Task B4: Share into Porthole, pick files

**Interfaces:** `class Uploads(host) { suspend fun send(m: Machine, uri: Uri, resolver: ContentResolver): Result<UploadReply> }`: reads the display name and MIME type from the resolver, streams through `LimitedInputStream(input, UPLOAD_MAX_BYTES = 50L * 1024 * 1024)` (SPEC 4.8: 50 MB per file) which throws `TooLarge` past the limit, never reads the whole file into memory. `object ShareIntents { fun uris(intent: Intent): List<Uri>; fun text(intent: Intent): String? }` covers `ACTION_SEND` and `ACTION_SEND_MULTIPLE` (`EXTRA_STREAM`, `EXTRA_TEXT`, `ClipData`). `class ShareActivity` (exported, intent filters from T1): asks which machine when more than one (a plain list dialog), uploads each URI, then opens `MainActivity` on that machine and posts the `share` bridge event `{path, name, machine, origin}` once per file (design decision 6) so the compose box fills in. `class Pickers(activity)` backs the bridge's `pickFile({source})` with exactly three sources: `camera` = `ActivityResultContracts.TakePicture` (into a `FileProvider` URI under `cacheDir/camera/`), `photo` = `PickVisualMedia`, `file` = `OpenDocument("*/*")`. There is no clipboard source (the page pastes inside `composer.js`). `fun pick(source: String, m: Machine): {path, name}?` sends the chosen URI through `Uploads` to the machine `m` that `BridgeMethods` resolved from the verified `sourceOrigin`, and returns `null` when the user cancels.

- [ ] **Step 1: Tests.** `LimitedInputStreamTest.kt`: exactly the limit passes, one byte more throws `TooLarge`. `ShareIntentsTest.kt` (Robolectric): single stream, multiple streams, text only, `ClipData` only. `UploadsTest.kt` (MockWebServer + Robolectric content provider; the limit is a constructor parameter so the test uses 1 kB): the multipart body carries the display name and MIME; a too-large stream fails with "Too big: 50 MB limit" and the server receives no complete request.
- [ ] **Step 2: Implement** the five files under `share/`.
- [ ] **Step 3: Commit** files by name; push.

---

## Group C: phone UI shell and watch relay

## Task C1: WebView shell and native bridge (`web/`)

**Interfaces:** `class MainActivity : ComponentActivity` holds one `WebView` (design decision 4: `loadUrl(origin)` when switching machines, so only one machine's page is loaded at a time), handles back via `OnBackPressedDispatcher` (WebView history first), keeps the last machine in preferences, and stops any recording in `onStop` (design decision 10). It also handles `ACTION_VIEW` `porthole://open?...` in `onCreate` and `onNewIntent` (the T1 intent filter): `Routes.parseOpenLink(intent.dataString, machines)` gives the URL, which is loaded; a `null` result is ignored and the app opens as normal. `object WebViewSetup { fun apply(wv: WebView) }`: `javaScriptEnabled = true`, `domStorageEnabled = true`, `allowFileAccess = false`, `allowContentAccess = false`, `setGeolocationEnabled(false)`, `mixedContentMode = MIXED_CONTENT_NEVER_ALLOW`, `safeBrowsingEnabled = true`, `setSupportMultipleWindows(false)`, `WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)`; never `addJavascriptInterface`. `class PortholeWebClient(machines) : WebViewClientCompat` uses `NavPolicy.decide` in `shouldOverrideUrlLoading` (`CUSTOM_TAB` → `CustomTabsIntent`, `BLOCK` → return true and do nothing), shows an offline page with a Retry button on main-frame `onReceivedError`, and refuses every `onReceivedSslError` (`handler.cancel()`). `class BridgeHost(webView, machines, methods)`: when `WebViewFeature.isFeatureSupported(WEB_MESSAGE_LISTENER)` is false the app shows "Update Android System WebView" and installs no bridge; otherwise it calls `WebViewCompat.addWebMessageListener(webView, "PortholeNative", BridgeAllowlist.originRules(machines), listener)` and re-registers (remove then add) whenever the machines list changes. The listener re-checks `BridgeAllowlist.allows(sourceOrigin.toString(), isMainFrame, machines)`, resolves the calling `Machine` from that verified `sourceOrigin`, parses with `BridgeProtocol.parse`, runs the method on the main dispatcher with that `Machine`, and replies with `replyProxy.postMessage(...)`. Events (`network`, `share`, `recordingStopped`) go through `class EventOutbox(send: (String) -> Unit)` in `web/EventOutbox.kt`: `emit(name, data)` sends at once when the current main frame has posted a message (it has a `replyProxy`), otherwise queues; `onMessage(proxy)` stores the proxy, marks the frame ready and flushes the queue in order; `onNewFrame()` (main-frame `onPageStarted`, and `MainActivity.onCreate`) marks it not ready again. This is needed because `ShareActivity` relaunches `MainActivity` and the fresh page has not posted anything yet, so there is no proxy to send the `share` event to. For `network` only the newest queued value is kept. `class BridgeMethods(...)` implements the seven methods of `BridgeProtocol.METHODS` with exactly the shapes in design decision 6: `machines` → `[{name, origin}]`; `speak` → `{finished}`; `stopSpeaking` → `null`; `startRecording` → `null` (asks `RECORD_AUDIO` the first time); `stopRecording` → `{wav}` (base64 of the WAV file, then the file is deleted); `pickFile({source})` → `{path, name}` or `null`, uploading to the machine of the calling origin; `openExternal` → `null` (an `https:` URL opens a Custom Tab; the exact URL `porthole://notification-settings` starts `Settings.ACTION_APP_NOTIFICATION_SETTINGS` with `EXTRA_APP_PACKAGE`; any other URL is refused). There is no `openSettings` (design decisions 5 and 6). A recording that ends by itself emits `recordingStopped({wav})` through the outbox.

- [ ] **Step 1: Tests.** `BridgeMethodsTest.kt` (Robolectric, fakes for `Speaker`, `Recorder`, `Uploads`): each method's success reply shape and its argument refusal. `stopRecording` returns `{"wav":"<base64>"}` whose decoded bytes start with `RIFF` and `WAVE`, and the recording file is gone afterwards. `speak` with 21 short utterances succeeds, `speak` with 101 000 bytes in total is refused. `pickFile({source:"photo"})` hands the fake `Uploads` the machine of the calling origin (two machines, two callers, each upload goes to its own caller), and `pickFile({source:"clipboard"})` is refused. `openExternal({url:"porthole://notification-settings"})` starts an `ACTION_APP_NOTIFICATION_SETTINGS` intent for `ai.porthole.app`; an `https://` URL starts a Custom Tab; `porthole://other`, `http://x` and `javascript:alert(1)` are refused. An unknown method, including `openSettings`, → `Bridge method not allowed: openSettings`. `EventOutboxTest.kt` (JVM): a `share` emitted before any message is not sent; after `onMessage` it is sent exactly once and in order with a second queued event; after `onNewFrame` the next emit queues again; two queued `network` values deliver only the newest. `PortholeWebClientTest.kt` (Robolectric): `shouldOverrideUrlLoading` returns false for a configured origin and true for `intent://`, `file://`, and a preview port (with a Custom Tab intent started for the last); `onReceivedSslError` calls `cancel`. `WebViewSetupTest.kt` (Robolectric): the settings above. `MainActivityTest.kt` (Robolectric): an `ACTION_VIEW` intent for `porthole://open?origin=...&route=...` loads the matching `https://<machine>/#/chat/...` URL; a link with an unknown origin loads nothing new. The real-WebView origin check is an on-device step in E2 (Robolectric has no real WebView).
- [ ] **Step 2: Implement** the six files under `web/` (`MainActivity.kt`, `WebViewSetup.kt`, `PortholeWebClient.kt`, `BridgeHost.kt`, `BridgeMethods.kt`, `EventOutbox.kt`).
- [ ] **Step 3: Commit** files by name; push.

## Task C2: Native settings screens (`settings/`)

**Interfaces:** Compose Material 3 screens (the Compose BOM pinned in T1): `MachinesActivity` (list, add, rename, remove, "Test connection" which calls `HostClient.machine` and shows the name and `you.device`), `MachineForm` (a composable plus a pure validation wrapper over `MachineList`, shows its error text), `BatteryGuideActivity` (explains, then fires `Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` for the package and shows the current `PowerManager.isIgnoringBatteryOptimizations` result; T1's manifest already holds the permission), `SettingsTheme` (follows the system dark/light setting). There is no screen for unsent recordings: the page keeps a recording it could not send (design decision 6). Plain-language words throughout ("Your computers", "Keep Porthole running"), kept in `res/values/settings_strings.xml`.

- [ ] **Step 1: Tests.** `MachineFormTest.kt` (Robolectric + `createComposeRule`): invalid origin shows "Use the https address ending in .ts.net"; a valid add appears in `MachineStore`. `BatteryGuideActivityTest.kt`: the button fires `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` with `package:ai.porthole.app` (G-1).
- [ ] **Step 2: Implement** the four files plus `res/values/settings_strings.xml` (C2's own file; T1's `strings.xml` is not touched).
- [ ] **Step 3: Commit** files by name; push.

## Task C3: Phone-to-watch relay (`relay/`)

**Interfaces:** `object RelayLogic { fun shouldPush(prev: WatchState?, next: WatchState): Boolean /* items or usage changed; never on updatedAt alone */ ; fun answerToCall(a: WatchAnswer, machines): Call? }`. `class WatchRelay(ctx, hub, host, machines)`: on every inbox change and every 5 minutes for usage (only while a watch node is connected: `CapabilityClient`/`NodeClient`), builds `WatchRules.build`, and when `shouldPush` puts it with `DataClient.putDataItem(PutDataRequest.create(WatchPaths.STATE).setData(bytes).setUrgent())`. `class RelayListenerService : WearableListenerService` handles `MessageClient` messages on `WatchPaths.ANSWER` (calls `HostClient.answer` or `keys(["Esc"])` for `Stop`, replies on `ANSWER_RESULT` to the sender node with the `AnswerOutcome.text()`) and `WatchPaths.REFRESH` (pushes now). `res/values/wear.xml` declares `<string-array name="android_wear_capabilities"><item>porthole_phone</item></string-array>`. The two-line edit to `EventsService` (start `WatchRelay` with the hub, stop it in `onDestroy`) is C3's, agreed in the ownership table.

- [ ] **Step 1: Tests.** `RelayLogicTest.kt` (JVM): same items with a new `updatedAt` → no push; a new item → push; an `Option` answer for an unknown origin → `null`. `RelayListenerServiceTest.kt` (Robolectric with a fake `HostClient` and a fake `MessageClient` wrapper interface `WearMessages` so Play services is not needed in tests): an `ANSWER` message calls `answer` once and replies with the outcome text and the same `requestId`; a `Stop` sends `Esc`.
- [ ] **Step 2: Implement** `RelayLogic.kt`, `WatchRelay.kt`, `WearMessages.kt`, `RelayListenerService.kt`, `res/values/wear.xml`, and the two-line `EventsService` edit. The `RelayListenerService` manifest entry (`MESSAGE_RECEIVED`, `pathPrefix="/porthole"`) already exists from T1.
- [ ] **Step 3: Commit** files by name; push.

---

## Group D: Galaxy Watch6 app (`:wear`, Wear Compose)

Run pattern: `android/gw --offline :wear:testDebugUnitTest --tests 'ai.porthole.wear.<pkg>.<TestClass>'`. Paths under `android/wear/src/main/kotlin/ai/porthole/wear/` and the matching `src/test/` folder. Every Play-services call goes through a small interface so Robolectric tests need no Play services.

## Task D1: Watch data (`data/`)

**Interfaces:** In `AnswerSender.kt`: `interface WearLink { suspend fun phoneNodeId(): String?; suspend fun send(nodeId: String, path: String, bytes: ByteArray): Boolean }` and `PlayWearLink(ctx)` with `CapabilityClient.getCapability(WatchPaths.PHONE_CAPABILITY, FILTER_REACHABLE)` and `MessageClient.sendMessage`; `class AnswerSender(link, pending: PendingAnswers) { suspend fun answer(a: WatchAnswer): WatchAnswerResult; suspend fun refresh() }` (no phone node → `ok=false` "Phone not connected", nothing sent). `class PendingAnswers(clock)`: holds one `CompletableDeferred` per `requestId`, completes it from `ANSWER_RESULT`, times out after 15 s with `ok=false` "Phone didn't answer". `class StateRepository(ctx)`: keeps the last state bytes in a file so complications show something after a watch restart, exposes `StateFlow<WatchState?>` and `fun isStale(now) /* older than 15 min: screens show "Updated N min ago" (SPEC 4.14) */`; bad bytes are ignored. `class WearDataListenerService : WearableListenerService` (manifest entry from T1) receives `/porthole/state` data changes (→ `StateRepository`, then `ComplicationUpdates.requestAll(ctx)`) and `/porthole/answer-result` messages (→ `PendingAnswers`). `object ComplicationUpdates { fun requestAll(ctx) }` calls `ComplicationDataSourceUpdateRequester` for both D3 services.

- [ ] **Step 1: Tests.** `PendingAnswersTest.kt` (virtual time): a matching result within 15 s completes the answer; a result for another `requestId` is ignored; nothing within 15 s gives "Phone didn't answer". `AnswerSenderTest.kt` (fake `WearLink`): no phone node gives "Phone not connected" and sends nothing; an answer is sent on `/porthole/answer` with the encoded `WatchAnswer`. `StateRepositoryTest.kt` (Robolectric): state survives a new instance; bad bytes are ignored; `isStale` true after 15 minutes.
- [ ] **Step 2: Implement** `StateRepository.kt`, `PendingAnswers.kt`, `AnswerSender.kt`, `WearDataListenerService.kt`, `ComplicationUpdates.kt` under `data/`.
- [ ] **Step 3: Commit** files by name; push.

## Task D2: Watch screens (`ui/`)

**Interfaces:** Wear Compose Material 3 (pinned in T1). `WearActivity` (manifest entry from T1) sets `WearApp`, which hosts `SwipeDismissableNavHost` with four routes: `inbox` (`TransformingLazyColumn` of waiting items: machine, project, title; header shows "Updated 3 min ago" when stale and "Phone not connected" when the last send found no phone; a Usage chip at the bottom), `item/{itemId}` (question text, one `Button` per option when `options` is non-empty, "Stop" for the session behind a "Stop this session?" confirm, and "Open on phone" which calls `RemoteActivityHelper.startRemoteActivity` with an `ACTION_VIEW` intent in category `BROWSABLE` whose data is `InboxModel.openOnPhoneUri(item)` = `Routes.openLink(item.origin, "#/chat/" + encodeURIComponent(item.machine) + "/" + encodeURIComponent(item.sessionId))`, i.e. a `porthole://open?...` link that the phone's `MainActivity` intent filter (T1) handles; an `https` URL would open Chrome instead, because only the `porthole` scheme is registered; **GUESS:** `WatchItem.machine` equals the machine part of the page's `#/chat/<machine>/<sessionId>` route (the name `/v1/machine` reports), checked on the device in E3 step 5g), `usage` (each machine's windows as a percent and reset time), and `result` (the answer result for 3 s, then back). The waiting complication opens `inbox`, the usage complication opens `usage` (design decision 12). `InboxModel` is the plain class the screens read: it turns `StateRepository` + `AnswerSender` into screen state, so tests need no Compose. Text sizes come from the theme only, so the watch's font-size setting applies.

- [ ] **Step 1: Tests.** `InboxModelTest.kt` (JVM, fakes): three items list newest first; empty state reads "Nothing waiting"; stale state carries the "Updated" line; tapping option 1 calls `answer(Option(..., [1]))` once and moves to `result`; a multi-select item offers no option buttons; Stop goes through the confirm; `openOnPhoneUri` of an item on `https://desk.example.ts.net` for session `tmux:t:main:0.0` equals the `Routes.openLink` value for `#/chat/desk/tmux%3At%3Amain%3A0.0` and starts with `porthole://open?`. `ItemScreenTest.kt` (Robolectric + `createComposeRule`, `@Config(sdk = [35])`, G-8): a 2-option item shows two option buttons, Stop and Open on phone.
- [ ] **Step 2: Implement** `InboxModel.kt`, `WearApp.kt`, `InboxScreen.kt`, `ItemScreen.kt`, `UsageScreen.kt`, `WearActivity.kt` under `ui/`.
- [ ] **Step 3: Commit** files by name; push.

## Task D3: Complications (`complications/`)

**Interfaces:** `class WaitingComplicationService : SuspendingComplicationDataSourceService` (type `SHORT_TEXT`) returns `ShortTextComplicationData` from `ComplicationText.waiting(repo.state.value)` with a tap action opening `WearActivity` on `inbox`; `class UsageComplicationService : SuspendingComplicationDataSourceService` (type `RANGED_VALUE`, min 0, max 100) from `ComplicationText.usage`, tap opens `usage`, `NoDataComplicationData` when null; both implement `getPreviewData` (P5.1). `ComplicationBuilders.kt` holds the two pure builders both services and tests call. The manifest entries (types, `UPDATE_PERIOD_SECONDS = 0`, the bind permission) already exist from T1; updates are pushed by `ComplicationUpdates` (D1).

- [ ] **Step 1: Tests.** `ComplicationPreviewTest.kt` (Robolectric `@Config(sdk = [35])`, G-8): both services' `getPreviewData` are non-null for their type; with a stored state of 3 items the waiting complication's text is "3" and content description "3 waiting"; the usage complication with no windows returns `NoDataComplicationData`, with 72 % a ranged value 72 of 100.
- [ ] **Step 2: Implement** the three files under `complications/`.
- [ ] **Step 3: Commit** files by name; push.

---

## Group E: verification and the two device stops

## Task E1: Full build, all tests, evidence, P3 coordination

- [ ] **Step 1: Build and test everything offline** (the one time the whole suite runs; the orchestrator runs this, not the builders):

```bash
android/gw --offline :shared:test :app:testDebugUnitTest :wear:testDebugUnitTest :app:assembleDebug :wear:assembleDebug :app:lintDebug :wear:lintDebug
```

Expected: `BUILD SUCCESSFUL`, test reports under `android/*/build/reports/tests/`, and the two APKs `android/app/build/outputs/apk/debug/app-debug.apk` and `android/wear/build/outputs/apk/debug/wear-debug.apk`. Lint errors fail the build (the Android Gradle plugin's default `abortOnError = true`; T1 sets nothing); warnings are listed in the report but do not block.
- [ ] **Step 2: Mutation spot-check** (SPEC 8 P4.2 tests must be real): temporarily change `BridgeAllowlist.allows` to `return true`, run `BridgeAllowlistTest`, see it fail, revert with `git checkout -- android/shared/src/main/kotlin/ai/porthole/shared/BridgeAllowlist.kt` (that single file, which only this task touched in this step). Same for `Backoff.nextDelayMs` returning a constant 1 000.
- [ ] **Step 3: Record evidence** in `docs/superpowers/evidence/p4-p5-build.md` (the evidence file in the ownership table): the command, the `BUILD SUCCESSFUL` line, test counts per module, the two APK sizes and SHA-256 sums (`sha256sum`), and the mutation results.
- [ ] **Step 4: P3 coordination.** P3 is built and `web/src` already matches the bridge in design decision 6, so nothing is required of P3. Message the P3 owner (or Main) only with the one optional addition: a method `openSettings({page: "machines"|"battery"})` in `web/src/net/bridge.js` `ALLOWED`, if Ben wants the shared screens to reach the two native screens (Needs Ben item 6). Without it the phone works; the native screens stay reachable from the "Porthole is connected" notification and the launcher shortcuts. Optionally also ask the P2 (hostd) owner whether `server/src/notify.ts` could seed its counter from the clock instead of 1 after a missing `notify.json`; the app handles a reset either way (design decision 8).
- [ ] **Step 5: Commit** `docs/superpowers/evidence/p4-p5-build.md`; push.

## Task E2: STOP, then install on the Pixel 7 Pro and run the P4.3 checklist

**Do not start until Ben says yes in the conversation** (Needs Ben item 4). This changes his phone.

- [ ] **Step 1: Read-only check** that the phone is the one expected: `adb devices -l` shows one device, model `Pixel_7_Pro`.
- [ ] **Step 2: Install** (keeps data when upgrading; never uninstall):

```bash
/home/cymatic/Android/Sdk/platform-tools/adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

- [ ] **Step 3: Ben does the on-phone steps** (the agent gives them one at a time): open Porthole, allow notifications, open "Keep Porthole running" and choose Unrestricted (Needs Ben item 3), check the desktop machine connects ("Test connection" shows `bendesk-omarchy` and the phone's device name). Read-only confirm: `adb shell dumpsys deviceidle whitelist` lists `ai.porthole.app` (G-1 name).
- [ ] **Step 4: SPEC 8 P4.3 checklist**, each item recorded in `docs/superpowers/evidence/p4-p5-build.md` with the time and what was seen. Setup (the agent, desktop): start the throwaway session on its own tmux socket, a scratch `omp` run on the cheap haiku model (the only paid part of this checklist; every message in it costs a few cents at most, so keep it to the messages listed here), for example `tmux -L porthole-test new-session -d -s scratch-omp 'omp --model <haiku model id>'`, with the real model id read from `omp --help` or the model list, not guessed. **GUESS:** hostd only lists sessions on tmux sockets it scans, so the scratch socket folder may need hostd's override setting; check `server/src` for the socket setting and say what was used. Never touch Ben's real sessions. The items: (a) a needs-you notification from the scratch session arrives with the screen off and the app swiped away; (b) answering Yes from the notification shade reaches the session (checked with `tmux -L porthole-test capture-pane`); (c) a closed question answered from the shade shows "Not sent: question closed"; (d) voice, two messages in the scratch session's chat view in the WebView: one typed and sent, one spoken (record, auto-stop on silence, the transcript appears in the compose box and is sent; voxtype on the desktop transcribes locally and for free); (e) speak a reply and Stop; (f) share a screenshot from Photos into Porthole, the path lands in the compose box; (g) airplane mode for 2 minutes, then off: reconnect within 15 s and the missed notification arrives once; (h) reboot the phone: the service comes back without opening the app (proves G-6); (i) switch Wi-Fi to mobile data in the middle of the session (Ben turns Wi-Fi off, the phone stays on Tailscale over mobile data): the chat view reconnects, the events socket reconnects within 15 s, and a message sent afterwards reaches the session; (j) read-only check that Thalamus's chat view opens in the WebView and shows its sessions, and the agent sends nothing into any Thalamus session; (k) allowlist proof in the debug build through `chrome://inspect` on the desktop: `PortholeNative` is present on the machine's origin (`https://<machine>.ts.net`), absent in an iframe from `https://<machine>.ts.net:8443/` (a different origin), and a navigation to another origin (for example `https://example.com`) leaves the WebView for a Custom Tab, which has no bridge.
- [ ] **Step 5: 24-hour battery check:** after a day, Ben reads Settings → Battery → Porthole; the agent reads `adb shell dumpsys batterystats ai.porthole.app` (read-only). Target from SPEC 4.13: under 3 % a day. Recorded in the build log.
- [ ] **Step 6: Commit** the build log; push.

## Task E3: STOP, then pair and install on the Galaxy Watch6

**Do not start until Ben says yes and gives the pairing code** (Needs Ben item 5). This changes his watch.

- [ ] **Step 1: Ben turns on** Developer options → ADB debugging → Wireless debugging on the watch, then taps "Pair new device" and reads out the IP, port, and 6-digit code.
- [ ] **Step 2: Pair and connect** (the agent fills the real IP, ports, and code Ben read out; nothing is guessed):

```bash
/home/cymatic/Android/Sdk/platform-tools/adb pair 192.168.1.50:37000
```

The address above is an example only (**GUESS**, replace with what the watch shows); `adb pair` then prompts for the code, so the code never goes into shell history. Then `adb connect` to the watch's separate "IP address & port" line.
- [ ] **Step 3: Read-only checks** (in this task `<watch>` stands for the serial `adb devices` lists for the watch after `adb connect`): `adb -s <watch> shell getprop ro.build.version.sdk` and `getprop ro.build.version.release` confirm G-2 (the Wear OS version Ben read in T0); if the SDK is below the `:wear` `minSdk` from T1 (30), stop and tell Ben.
- [ ] **Step 4: Install** with `adb -s <watch> install -r android/wear/build/outputs/apk/debug/wear-debug.apk`. The phone app must already be installed (E2) because the watch finds the phone through the `porthole_phone` capability and both carry `applicationId` `ai.porthole.app` with the same debug key (G-4).
- [ ] **Step 5: SPEC 8 P5.2 checklist**, recorded in the evidence file: (a) the list shows the same waiting items as the phone within 30 s; (b) one tap on an option answers the scratch session and the phone's notification disappears; (c) Stop sends Esc after the confirm; (d) the waiting-count and usage complications can be added to a watch face and update when a new item arrives; (e) the phone's notification also appears on the watch with its answer buttons (design decision 7); (f) with the phone in airplane mode the watch says "Phone not connected" and keeps the last list marked with its age; (g) "Open on phone" on an item opens the phone's Porthole on that item's chat view (`#/chat/<machine>/<sessionId>`), which settles the GUESS in D2 about the machine part of the route.
- [ ] **Step 6: Turn off wireless debugging** on the watch (Ben, one tap) and commit the build log; push.

---

## Needs Ben (collected for the orchestrator)

1. **App package and name.** Plan uses `ai.porthole.app` for both the phone and the watch app (the Data Layer needs the same id, G-4), shown as "Porthole" (G-1). The package name cannot change after install without losing data. Recommendation: keep it.
2. **Wear OS version on the Watch6.** Unverified (G-2); T0 step 1 asks Ben to read it off the watch (Settings → About watch → Software information), E3 step 3 confirms it. The plan supports Wear OS 3 or newer (SDK 30 minimum), which covers every Watch6 software version.
3. **"Keep Porthole running" (battery Unrestricted).** Needed so notifications arrive with the screen off (SPEC 4.13). Ben taps it once in E2. Alternative: leave Optimized and accept late notifications.
4. **OK to install on the Pixel 7 Pro** (E2). Needed before any change to the phone.
5. **OK to install on the Watch6, plus reading out the pairing code** (E3).
6. **Optional P3 bridge addition** `openSettings` (E1 step 4). Recommendation: skip it for now; the native Machines and Battery screens stay reachable from the notification and launcher shortcuts, and adding it later is a one-line change in P3 plus a one-method change in C1.

## Self-review

- **Spec coverage:** 4.7 notifications (A5, B2), 4.8 voice (A6, B3), 4.12 identity and origins (A2, B1, C1), 4.13 always-on and battery (A3, B2, C2, E2), 4.14 watch (A7, C3, D1-D3, E3), 4.16 sharing (B4), 5.2/5.4 API shapes (A1, B1), 7 safety rules (Global Constraints, E2/E3 stops), 8 P4.1-P4.3 and P5.1-P5.2 (T0, T1, E1-E3), 10 open questions (Needs Ben).
- **Placeholders:** none in code; the only example value is the watch pairing address in E3, labelled **GUESS** and replaced by what the watch shows.
- **Type consistency:** `Machine`, `ServerEvent.Notify`, `NotifyPlan`, `AnswerOutcome`, `WatchState`, `WatchAnswer`, `WatchPaths` are defined once in `:shared` and used by name in B, C, D.
- **Ownership:** every file belongs to exactly one task (see the ownership table); the one shared edit (`EventsService`, two lines) is assigned to C3.
- **Unverified facts:** G-1 to G-9 each have a first-task check (T0, T1, E2, or E3).
- **Bridge match:** design decision 6, `BridgeProtocol` (A4), `BridgeMethods` (C1), the voice/share tasks (B3, B4) and the E2 checklist were rewritten against the calls `web/src` makes today (`web/src/net/bridge.js` `ALLOWED`, seven methods, `stopRecording` and `recordingStopped` return `{wav}`, `pickFile({source})`, no `openSettings`, no native `/v1/voice` call). The only optional P3 change left is `openSettings` (Needs Ben 6).
