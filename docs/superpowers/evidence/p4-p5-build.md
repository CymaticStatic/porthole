# P4 / P5 Android + Wear build evidence (Task E1)

Date: 2026-10-13. Branch `feat/p2-hostd`. All numbers below come from real command output of this run.

## 1. Build and tests

Planned command (E1 step 1), run once exactly as written:

```
flock -w 1700 /home/cymatic/.cache/porthole-gradle.lock /home/cortex/00-system/porthole/repo/android/gw --offline --console=plain :shared:test :app:testDebugUnitTest :wear:testDebugUnitTest :app:assembleDebug :wear:assembleDebug :app:lintDebug :wear:lintDebug
```

Result: **BUILD FAILED in 5s** at configuration time (first attempt, history), before any task ran, because the lint tool is not in the offline Gradle cache. It was resolved by one online lint run (section 4); the final offline run of this same command succeeded (section 8):

```
> Could not resolve all files for configuration ':app:androidLintTool'.
   > Could not resolve com.android.tools.lint:lint-gradle:32.4.1.
     Required by:
         project ':app'
      > No cached version of com.android.tools.lint:lint-gradle:32.4.1 available for offline mode.
```

`~/.gradle/caches/modules-2/files-2.1/com.android.tools.lint/` held only `lint-model` and `lint-typedef-remover`; `lint-gradle` was absent. Lint was therefore not run in this first attempt.

Second run, identical command minus `:app:lintDebug :wear:lintDebug`:

```
flock -w 1700 /home/cymatic/.cache/porthole-gradle.lock /home/cortex/00-system/porthole/repo/android/gw --offline --console=plain :shared:test :app:testDebugUnitTest :wear:testDebugUnitTest :app:assembleDebug :wear:assembleDebug
```

Output tail:

```
> Task :wear:mergeLibDexDebug
> Task :wear:validateSigningDebug
> Task :wear:writeDebugAppMetadata
> Task :wear:writeDebugSigningConfigVersions

> Task :wear:stripDebugDebugSymbols
Unable to strip the following libraries, packaging them as they are: libandroidx.graphics.path.so. Run with --info option to learn more.

> Task :app:mergeExtDexDebug
> Task :wear:dexBuilderDebug
> Task :wear:mergeProjectDexDebug
> Task :wear:mergeExtDexDebug
> Task :shared:compileTestJava NO-SOURCE
> Task :shared:testClasses UP-TO-DATE
> Task :shared:test UP-TO-DATE
> Task :app:packageDebug
> Task :app:assembleDebug
> Task :app:createDebugApkListingFileRedirect
> Task :wear:packageDebug
> Task :wear:assembleDebug
> Task :wear:createDebugApkListingFileRedirect

BUILD SUCCESSFUL in 5m 48s
98 actionable tasks: 37 executed, 61 up-to-date
Configuration cache entry stored.
```

`BUILD SUCCESSFUL in 5m 48s`. Note: `:shared:test` was UP-TO-DATE in this run (it had already passed earlier with the same inputs), so its XML results are from that earlier execution; `:shared:test` was executed fresh again in section 5. `:app:testDebugUnitTest` and `:wear:testDebugUnitTest` ran in this build.

## 2. Test counts (JUnit XML)

Columns: tests / failures / errors / skipped.

### shared (`android/shared/build/test-results/test`)

| Class | T | F | E | S |
|---|---|---|---|---|
| ai.porthole.shared.AnswerOutcomeTest | 6 | 0 | 0 | 0 |
| ai.porthole.shared.AudioTest | 9 | 0 | 0 | 0 |
| ai.porthole.shared.BackoffTest | 5 | 0 | 0 | 0 |
| ai.porthole.shared.BridgeAllowlistTest | 7 | 0 | 0 | 0 |
| ai.porthole.shared.BridgeProtocolTest | 15 | 0 | 0 | 0 |
| ai.porthole.shared.ComplicationTextTest | 6 | 0 | 0 | 0 |
| ai.porthole.shared.MachineListTest | 8 | 0 | 0 | 0 |
| ai.porthole.shared.NavPolicyTest | 4 | 0 | 0 | 0 |
| ai.porthole.shared.NotifyLedgerTest | 12 | 0 | 0 | 0 |
| ai.porthole.shared.NotifyPlannerTest | 8 | 0 | 0 | 0 |
| ai.porthole.shared.OriginsTest | 7 | 0 | 0 | 0 |
| ai.porthole.shared.WatchRulesTest | 11 | 0 | 0 | 0 |
| ai.porthole.shared.WatchStateTest | 7 | 0 | 0 | 0 |
| ai.porthole.shared.WireTest | 11 | 0 | 0 | 0 |
| **shared total** | **116** | **0** | **0** | **0** |

### app (`android/app/build/test-results/testDebugUnitTest`)

| Class | T | F | E | S |
|---|---|---|---|---|
| ai.porthole.app.MachineStoreTest | 11 | 0 | 0 | 0 |
| ai.porthole.app.events.AnswerHandlerTest | 13 | 0 | 0 | 0 |
| ai.porthole.app.events.BootReceiverTest | 3 | 0 | 0 | 0 |
| ai.porthole.app.events.ConnectionHubTest | 12 | 0 | 0 | 0 |
| ai.porthole.app.events.EventsServiceTest | 10 | 0 | 0 | 0 |
| ai.porthole.app.events.LedgerStoreTest | 7 | 0 | 0 | 0 |
| ai.porthole.app.events.NotifierTest | 11 | 0 | 0 | 0 |
| ai.porthole.app.events.NotifyFlowTest | 18 | 0 | 0 | 0 |
| ai.porthole.app.net.EventsSocketTest | 14 | 0 | 0 | 0 |
| ai.porthole.app.net.HostClientTest | 17 | 0 | 0 | 0 |
| ai.porthole.app.relay.RelayListenerServiceTest | 11 | 0 | 0 | 0 |
| ai.porthole.app.relay.RelayLogicTest | 9 | 0 | 0 | 0 |
| ai.porthole.app.relay.WatchRelayTest | 11 | 0 | 0 | 0 |
| ai.porthole.app.settings.BatteryGuideActivityTest | 3 | 0 | 0 | 0 |
| ai.porthole.app.settings.MachineFormTest | 15 | 0 | 0 | 0 |
| ai.porthole.app.share.LimitedInputStreamTest | 8 | 0 | 0 | 0 |
| ai.porthole.app.share.PickersTest | 7 | 0 | 0 | 0 |
| ai.porthole.app.share.ShareFlowTest | 7 | 0 | 0 | 0 |
| ai.porthole.app.share.ShareIntentsTest | 14 | 0 | 0 | 0 |
| ai.porthole.app.share.UploadsTest | 12 | 0 | 0 | 0 |
| ai.porthole.app.voice.RecorderTest | 18 | 0 | 0 | 0 |
| ai.porthole.app.voice.SpeakerTest | 16 | 0 | 0 | 0 |
| ai.porthole.app.voice.WavFileWriterTest | 7 | 0 | 0 | 0 |
| ai.porthole.app.web.BridgeHostTest | 9 | 0 | 0 | 0 |
| ai.porthole.app.web.BridgeMethodsTest | 22 | 0 | 0 | 0 |
| ai.porthole.app.web.EventOutboxTest | 9 | 0 | 0 | 0 |
| ai.porthole.app.web.MainActivityTest | 13 | 0 | 0 | 0 |
| ai.porthole.app.web.PortholeWebClientTest | 9 | 0 | 0 | 0 |
| ai.porthole.app.web.WebViewSetupTest | 1 | 0 | 0 | 0 |
| **app total** | **317** | **0** | **0** | **0** |

### wear (`android/wear/build/test-results/testDebugUnitTest`)

| Class | T | F | E | S |
|---|---|---|---|---|
| ai.porthole.wear.complications.ComplicationPreviewTest | 12 | 0 | 0 | 0 |
| ai.porthole.wear.data.AnswerSenderTest | 7 | 0 | 0 | 0 |
| ai.porthole.wear.data.PendingAnswersTest | 5 | 0 | 0 | 0 |
| ai.porthole.wear.data.StateRepositoryTest | 9 | 0 | 0 | 0 |
| ai.porthole.wear.ui.InboxModelTest | 24 | 0 | 0 | 0 |
| ai.porthole.wear.ui.ItemScreenTest | 6 | 0 | 0 | 0 |
| **wear total** | **63** | **0** | **0** | **0** |

Grand total: 496 tests, 0 failures, 0 errors, 0 skipped.

## 3. APKs

| File | Size (bytes) | SHA-256 |
|---|---|---|
| `android/app/build/outputs/apk/debug/app-debug.apk` | 34169347 | `7844eb773c983c74b8f3541a1c4809434a868744a08421fb8feaa58b248be6ee` |
| `android/wear/build/outputs/apk/debug/wear-debug.apk` | 38005594 | `7d1d32639a50ff53898187b2ca272a7fb1a7e944a6b99cd17ee542a6fa1684ce` |

Rebuilt 2026-10-13 12:38 MDT after the `androidx.fragment:fragment:1.8.9` lint fix (section 4). The app APK changed (was 34001034 bytes, sha256 `19a7202e...490783e`); the wear APK is unchanged. Debug-signed. Nothing was installed on any phone or watch.

## 4. Lint

History: the first attempt (section 1) failed offline because `lint-gradle:32.4.1` was not in the Gradle cache. It was resolved by one online lint run (Maven artifacts into the home-folder Gradle cache only; nothing installed on any device).

**Run 1 (online, no `--offline`):**

```
flock -w 1700 /home/cymatic/.cache/porthole-gradle.lock /home/cortex/00-system/porthole/repo/android/gw --console=plain :app:lintDebug :wear:lintDebug
```

Result: `BUILD FAILED in 4m 30s`, `:app:lintDebug FAILED`: `Lint found 5 errors, 20 warnings` in app. `:wear:lintDebug` passed (0 errors, 8 warnings). All 5 errors were the same id, `InvalidFragmentVersionForActivityResult` ("Upgrade Fragment version to at least 1.3.0"):

- `app/src/main/kotlin/ai/porthole/app/web/MainActivity.kt:70`
- `app/src/main/kotlin/ai/porthole/app/web/MainActivity.kt:71`
- `app/src/main/kotlin/ai/porthole/app/share/Pickers.kt:34`
- `app/src/main/kotlin/ai/porthole/app/share/Pickers.kt:37`
- `app/src/main/kotlin/ai/porthole/app/share/Pickers.kt:38`

Cause (checked with `:app:dependencyInsight`): `androidx.fragment:fragment:1.0.0 -> 1.1.0` is pulled in transitively by `com.google.android.gms:play-services-base:18.5.0` (from `play-services-wearable:20.0.1`). Activity 1.13.0 is on the classpath, and `registerForActivityResult` is the call lint flags when the resolved Fragment is older than 1.3.0. The source calls themselves are fine, so this was fixed in the build, not suppressed.

**Fix (smallest correct change; no lint.xml, baseline or `@SuppressLint`):**

- `android/gradle/libs.versions.toml`: added version `fragment = "1.8.9"` and library `fragment = { group = "androidx.fragment", name = "fragment", version.ref = "fragment" }`.
- `android/app/build.gradle.kts`: added `implementation(libs.fragment)` (with a comment saying why).

This needed one more small online resolve (the 1.8.9 artifact was not cached); the second run therefore also ran online, still limited to the home-folder Gradle cache.

**Run 2 (online, after the fix):** same command as run 1. `BUILD SUCCESSFUL in 4m 11s`, `:app:lintDebug` and `:wear:lintDebug` passed.

**Lint summary line (from `lint-results-debug.txt`):** app `0 errors, 20 warnings`; wear `0 errors, 8 warnings`. Warnings do not block. Categories:

| Module | Warning categories (count) |
|---|---|
| app | UseKtx (10), RequiresFeature (2), MissingOnRenderProcessGone (2), OldTargetApi (1), BatteryLife (1), DataExtractionRules (1), StaticFieldLeak (1), UnusedResources (1), MonochromeLauncherIcon (1) |
| wear | UnusedResources (5), DataExtractionRules (1), MonochromeLauncherIcon (1), UseKtx (1) |

Warnings are NOT fixed here (out of scope). Notable ones to look at: `RequiresFeature` (`BridgeHost.kt:31,33`: `addWebMessageListener`/`removeWebMessageListener` without a `WebViewFeature.isFeatureSupported` check) and `MissingOnRenderProcessGone` (`PortholeWebClient.kt:54,60`), both relevant to the WebView safety items in section 7.

**Final offline run** of the full planned command, with lint, is in section 8.

## 5. Mutation spot-checks (SPEC 8 P4.2)

`android/shared/src` is untracked in git, so `git checkout --` was not usable. Each file was copied to `/tmp/p45-e1-<name>.bak` before the mutation and restored with `cp -p` afterwards.

**(a) `BridgeAllowlist.allows` body replaced by `return true`.**
Command: `flock ... android/gw --offline --console=plain :shared:test --tests ai.porthole.shared.BridgeAllowlistTest`
Before the mutation: `BridgeAllowlistTest` 7 tests, 0 failures. After the mutation: **BUILD FAILED**, `7 tests completed, 3 failed`:
- `BridgeAllowlistTest > subframesGetNoBridgeEvenFromAllowedOrigin` (BridgeAllowlistTest.kt:29)
- `BridgeAllowlistTest > unknownOriginsGetNoBridge` (BridgeAllowlistTest.kt:25)
- `BridgeAllowlistTest > noMachinesMeansNoBridgeAnywhere` (BridgeAllowlistTest.kt:35)

Restored; `diff /tmp/p45-e1-BridgeAllowlist.bak <file>` printed nothing (byte-identical).

**(b) `Backoff.nextDelayMs()` replaced by constant `1_000L`.**
Command: `flock ... android/gw --offline --console=plain :shared:test --tests ai.porthole.shared.BackoffTest`
Before the mutation: `BackoffTest` 5 tests, 0 failures. After the mutation: **BUILD FAILED**, `5 tests completed, 3 failed`:
- `BackoffTest > customCapIsHonoured` (BackoffTest.kt:26)
- `BackoffTest > manyFailuresNeverOverflow` (BackoffTest.kt:22)
- `BackoffTest > doublesFromOneSecondAndCapsAtFifteen` (BackoffTest.kt:9)

Restored; `diff /tmp/p45-e1-Backoff.bak <file>` printed nothing (byte-identical).

**Final check after both reverts:** `cmp` of both files against their backups: identical. `flock ... android/gw --offline --console=plain :shared:test` => `BUILD SUCCESSFUL in 9s` (`:shared:test` executed, not cached); XML totals 116 tests, 0 failures, 0 errors, 0 skipped.

## 6. P3 coordination (E1 step 4, reported by the manager)

- `bun test web/test/unit` from the repo root: `157 pass, 0 fail, 1342 expect() calls, Ran 157 tests across 23 files.` (run by the manager; not re-run here).
- P3 share buffering is committed in `eef897f`: `web/src/net/bridge.js` (`queuedShares`), `web/test/unit/bridge.test.js`, the picker string 'Choose a chat for this file' in `web/src/lib/copy.js` and `web/src/views/shell.js`, and the e2e test `web/test/e2e/share.test.ts`.

## 7. Not covered here

This is JVM unit-test, build and mutation evidence only. Unverified until E2/E3 on real devices:
- boot-time foreground service start (real `BOOT_COMPLETED`, OEM battery restrictions);
- safe browsing behaviour in the real WebView;
- the real WebView origin check (`addWebMessageListener` origin rules; only the pure `BridgeAllowlist` logic is tested here);
- complication rendering on a real watch face (only `getPreviewData` and data logic are tested under Robolectric);
- audio focus handling;
- text-to-speech output and microphone capture on hardware;

Android lint is no longer in this list: it now passes with 0 errors (sections 4 and 8). Of its 28 warnings, `RequiresFeature` and `MissingOnRenderProcessGone` are open items for the WebView safety check on a real device.

## 8. Final full planned command (offline, after the lint fix)

Run once, exactly as planned in E1 step 1, after the lint cache was filled (section 4):

```
flock -w 1700 /home/cymatic/.cache/porthole-gradle.lock /home/cortex/00-system/porthole/repo/android/gw --offline --console=plain :shared:test :app:testDebugUnitTest :wear:testDebugUnitTest :app:assembleDebug :wear:assembleDebug :app:lintDebug :wear:lintDebug
```

Output tail:

```
> Task :wear:lintDebug
> Task :app:testDebugUnitTest
> Task :app:lintDebug
> Task :app:packageDebug
> Task :app:assembleDebug
> Task :app:createDebugApkListingFileRedirect
> Task :wear:packageDebug
> Task :wear:assembleDebug
> Task :wear:createDebugApkListingFileRedirect

BUILD SUCCESSFUL in 4m 37s
116 actionable tasks: 67 executed, 49 up-to-date
Configuration cache entry stored.
```

This proves lint now runs offline. Test totals from the JUnit XML after this run: shared 14 classes, 116 tests; app 29 classes, 317 tests; wear 6 classes, 63 tests; 496 tests, 0 failures, 0 errors, 0 skipped (identical to section 2). APKs: see section 3 (rebuilt after the `androidx.fragment` change; the wear APK is byte-identical to the earlier build).

## 9. Phone tweaks (2026-10-13): `openSettings`, background switch, read-aloud failure, fresh device name

Changes: bridge method `openSettings({screen:"machines"|"battery"})` (shared `BridgeProtocol`, `BridgeMethods`, page `ALLOWED`, a 'Phone settings' group on the Settings page, shown only when the native bridge exists); a 'Stay connected in the background' switch on the Machines screen (`BackgroundPref`; off stops `EventsService` and `EventsService.start` refuses to start it, which covers the app opening and `BootReceiver`; `NetworkWatcher` only lives inside the service, so it is gone with it); a failed text-to-speech utterance now gives a bridge error reply and the page shows "Couldn't read this aloud."; 'Test connection' always fetches `/v1/machine` and overwrites the kept device name (`MachineStore.testConnection`).

Command (same as section 8): `BUILD SUCCESSFUL in 1m 14s` (second run; the first run found two stale tests, `BridgeHostTest` used `openSettings` as its example of an unknown method and `MachineFormTest` needed to scroll to the second computer now that the switch sits above the list, both fixed).

Test totals from the JUnit XML: shared 14 classes, 118 tests; app 29 classes, 336 tests; wear 6 classes, 63 tests; 517 tests, 0 failures, 0 errors, 0 skipped. Lint: `:app:lintDebug` and `:wear:lintDebug` pass (0 errors). Web: `bun run typecheck:web` clean; `bun run test:web` 163 pass, 0 fail; e2e `settings.test.ts` 3 pass, `talk.test.ts` 1 pass.

New APKs (nothing installed from here):

```
72dfa104e098601bebbe70b1562a29f8f8f2520e5125de27286438877e64d03c  android/app/build/outputs/apk/debug/app-debug.apk  (34820362 bytes)
2f064286f57b9ae37fb07ddfe32f38af8a5469d806ab96d2dcf2ccd532c304b8  android/wear/build/outputs/apk/debug/wear-debug.apk  (38186476 bytes)
```

## 10. E2 on the Pixel 7 Pro (2026-10-13, Ben with the phone; agent read-only over adb)

Install 12:40 and update 13:13 (`adb -s 2B151FDH300C01 install -r`, app sha256 `72dfa104…`). Notifications allowed; battery Unrestricted (`dumpsys deviceidle whitelist` shows `user,ai.porthole.app,10345`); Test connection showed "Connected to bendesk-omarchy. This phone shows up there as bencell" (`bencell` is the phone's Tailscale name; Ben chose to keep it).

Scratch session for P4.3: `tmux -L porthole-test` session `scratch-p43`, omp pid 964286, `--no-extensions -e porthole-events.ts -e live-inbox.ts --model haiku`; hostd lists it as `tmux:porthole-test:scratch-p43:1.1` with no socket override (hostd already scans every socket in `/tmp/tmux-<uid>`).

- **(a) pass, 14:02.** App swiped away, screen off. Question "Porthole test 1: did the phone buzz?" (asked 14:02:15) arrived on the phone and, bridged by Wear OS, on the Galaxy Watch6 (Ben).
- **(b) pass, 14:02:37, answered from the watch.** Ben tapped Yes on the bridged notification on the watch (the watch app is not installed yet, so this was the phone's own notification action). The scratch pane showed `(o) Yes` at 14:02:37 and the phone notification became "Sent: Yes" with only Open. This also covers P5.2 (e): the phone's notification appears on the watch with its answer buttons, and they work.
- **(g) not yet run, 14:10-15:40.** First attempt was invalid: on the Pixel, airplane mode left Wi-Fi on (`dumpsys connectivity` showed `WIFI CONNECTED` with `airplane_mode_on=1`), so the phone never went offline. Seen on the way: question 2, answered on the desktop at 14:10, made the phone remove its notification (the cancel rule works). Question 3 was delivered (hostd's queue for `bencell` was empty, so it was acked) but was not on the phone at 15:37; Ben was asked whether he swiped it. Question 4 (15:38) arrived normally.
- **Paused 2026-10-13 ~15:45 at Ben's request.** The scratch session was closed. Items c, d, e, f, g, h, i, j and k are still to run. The next run needs a new scratch session, and for (g) both airplane mode and Wi-Fi must be off.
