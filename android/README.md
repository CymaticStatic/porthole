# Porthole Android (phone `app`, watch `wear`, pure Kotlin `shared`)

One Gradle project with three modules. `:shared` is pure Kotlin (JVM, no Android imports) and holds every rule worth a unit test. `:app` (phone) and `:wear` (Galaxy Watch6, Wear OS) are thin Android shells around it. Plan: `docs/superpowers/plans/2026-10-13-p4-p5-android-watch.md`.

## Prerequisites (desktop `bendesk-omarchy`, home folder only, no sudo)

- JDK 17: Temurin `17.0.20+101` at `/home/cymatic/.local/share/mise/installs/java/temurin-17.0.20+101`
- Android SDK at `/home/cymatic/Android/Sdk`: `platform-tools`, `platforms;android-36`, `platforms;android-37.0`, `build-tools;36.1.0`
- Gradle itself is not installed globally: the wrapper downloads Gradle 9.6.1 (sha256-pinned) into `~/.gradle`.
- Details: `/home/cortex/00-system/porthole/files/android-toolchain.md`

## Build

`./gw` runs the Gradle wrapper with `JAVA_HOME` and `ANDROID_HOME` set for that one command; nothing global is changed.

```bash
./gw :app:assembleDebug :wear:assembleDebug
```

After the first online sync (it downloads AGP, Kotlin and the libraries into `~/.gradle`), build offline:

```bash
./gw --offline :app:assembleDebug :wear:assembleDebug
```

Unit tests for the pure rules:

```bash
./gw --offline :shared:test
```

APKs land in `app/build/outputs/apk/debug/app-debug.apk` and `wear/build/outputs/apk/debug/wear-debug.apk`.

Installing on a device needs Ben's OK at that moment (SPEC 7); the commands are in plan tasks E2 and E3.

## Version pins

| Item | Version |
|---|---|
| Android Gradle plugin | 9.4.1 |
| Gradle (wrapper) | 9.6.1 |
| Kotlin (KGP, Compose compiler, serialization) | 2.4.21 |
| JDK | Temurin 17 |
| compileSdk / targetSdk | 37 / 36 |
| minSdk phone / watch | 34 / 30 |
| build tools | 36.1.0 |
| Compose BOM (phone settings screens only) | 2026.09.00 |
| androidx core-ktx / activity-compose / lifecycle | 1.19.1 / 1.13.0 / 2.11.0 |
| Wear Compose Material 3 / foundation / navigation | 1.7.1 |
| watchface-complications-data-source-ktx | 1.3.0 |
| play-services-wearable | 20.0.1 |
| androidx.webkit / androidx.browser | 1.17.1 / 1.10.0 |
| kotlinx-serialization-json / kotlinx-coroutines | 1.11.0 / 1.11.0 |
| OkHttp / mockwebserver3 | 5.5.0 |
| JUnit / androidx.test.ext:junit / Robolectric | 4.13.2 / 1.3.0 / 4.17 |

All pins live in `gradle/libs.versions.toml`.

## Decisions

**1. Foreground-service type `remoteMessaging`.** Android 14+ requires a type for every foreground service. The job is "keep a messaging connection to a remote server and show its messages", which is what `remoteMessaging` names. Rejected: `dataSync` (limited to 6 h per 24 h since Android 15, which breaks "always connected", and barred from starting at boot), `connectedDevice` (needs a Bluetooth/USB/NFC-style prerequisite the app does not have), `specialUse` (needs a Play-review justification; the fallback only if a device refuses `remoteMessaging`; switching is a 3-line manifest change).

**2. compileSdk 37, targetSdk 36, phone minSdk 34, wear minSdk 30.** compileSdk 37 because the current Compose, core and Wear Compose AARs declare `minCompileSdk=37`. targetSdk 36 keeps Android 17's target-37 behaviour changes off until they are read; the phone still runs on Android 17. Phone minSdk 34 (Android 14) is the first level where foreground-service types are enforced, so the code needs no older branches. Wear minSdk 30 covers every Watch6 software version. Build tools stay on 36.1.0 (AGP 9.4 needs 36.0.0 or newer).

**3. Kotlin 2.4.21, not AGP 9's bundled 2.2.10.** Libraries released in September 2026 carry Kotlin metadata newer than the 2.2 compiler reads. The root build declares the Kotlin JVM, Compose-compiler and serialization plugins at 2.4.21, which puts KGP 2.4.21 on the shared build classpath; AGP 9's built-in Kotlin uses the higher version.

**13. Phone build only on the desktop.** Both APKs are signed with the desktop's `~/.android/debug.keystore` (created on first build) and share the `applicationId` `ai.porthole.app`, so the Wearable Data Layer sees one package name and one signer (Google requires both to match). Building on the laptop would create a second debug key and break the phone-watch link, so build here.
