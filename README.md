# Time Together — Android + web with Firebase

A first implementation of shared timers using Firebase Authentication, Cloud Firestore,
and basic Firebase Hosting. The Android fork is based on Simple Time Tracker v1.59,
commit `ec82d9afa4c26f03f0a73eb7deac2d3ddf73254b`.

## Current state

The web app, Firebase rules and indexes are deployed. Email/password Authentication and
the London Firestore database are active on Firebase's Spark plan. The Android debug APK
is configured for the same project and ready for installation; the final physical-phone
sync check is still pending. An unconfigured source build shows a setup message rather
than inventing records or claiming to be connected.

Live web app: https://time-together-sayak-20260905.web.app

Firebase project: `time-together-sayak-20260905`

## First version

- Email/password login using the same account on Android and the web.
- One active timer across devices; starting another activity closes the previous session.
- Online start, stop, and switch with server timestamps and atomic database transactions.
- Activity names, colours, session notes and new completed sessions are shared. Activities can
  be renamed or deleted on the web; their historical sessions remain intact.
- The web displays the latest 100 sessions and exports all history as JSON.
- Android's regular timer cards use the shared backend when sync is enabled. Firestore
  sessions are projected into its existing Room database for the native history/statistics UI.
- Repeated requests, stale stops, concurrent starts, and access from another account are tested.
- Firestore rules deny access outside the signed-in user's subtree, arbitrary historical
  records, deletion, and partial transitions that would leave inconsistent active timers.

Start/stop actions require a connection. Timers continue to accrue elapsed time when an
app is closed because their timestamps are stored on the server. The Android app listens
while a screen is open, and catches up when reopened. Widgets/notifications can therefore
display an older state while Android is suspended. Immediate background refresh is future work.

This version does **not** sync historical record edits/deletes, tags, goals, Pomodoro,
retroactive tracking, fixed-duration activities, or existing local history. Native edits
to projected cloud history are local only and may be replaced during the next sync;
avoid editing cloud sessions through the original native edit screens. Existing Android
activities are copied on import; later web renames are mirrored and web deletions archive
the corresponding Android activity without removing its historical records.

The fork has its own package ID (`com.razeeman.util.simpletimetracker.sync`, plus `.debug`
for the debug APK), so it installs alongside the original app. Do not uninstall the original
app to test this version. The Android installation is pinned to the first sync account to
avoid mixing accounts in its native local database.

## Local development

Use Node 24 LTS and Java 21+ for the current Firebase emulator. The Android build uses Java 17.

```sh
cd /Users/sayak/Projects/simple_time_tracker_sync
npm ci
npm run dev
```

Without Firebase configuration, the page clearly shows that setup is pending.
To exercise login and timers locally, run `npm run demo` instead. It starts the Firebase
Auth and Firestore emulators with project `demo-timer-sync`; use a made-up account/password,
not your real Google password. Demo records are temporary, and no live project is accessed.
Two browser profiles can sign into the same emulator account to exercise sync.

## Connect a free Firebase project

1. Sign in at https://console.firebase.google.com/ and create a project on **Spark**.
   Google Analytics is not needed. Do not link a Cloud Billing account for this version.
2. Under Authentication, enable the **Email/Password** sign-in provider.
3. Create the default **Cloud Firestore Standard edition** database in production mode.
   Choose the region intentionally (e.g. London `europe-west2`); the database location
   cannot simply be changed afterward.
4. Register a **web app**. Copy its Firebase configuration values into
   `firebase.config.json`, using `firebase.config.example.json` as the template.
5. Register an **Android app** for `com.razeeman.util.simpletimetracker.sync.debug`.
   Copy that app's mobile SDK app ID into `androidAppId` in the same JSON file.
   For a separately signed release APK, register the package without `.debug`.
6. Run `npm run configure`. This writes `.env.local`, `.firebaserc`, and the Android
   Firebase configuration asset. Firebase client configuration identifies the project;
   it is not an administrator credential. Never put service-account keys in the app.
7. Sign the Firebase CLI into your Google account and deploy:

```sh
npm run login
npm run deploy
```

The deploy command uploads only the Firestore rules/indexes and static Hosting files.
It does not deploy Cloud Functions, App Hosting, Cloud Storage, or enable billing.
Firebase will print the actual deployed URL. Add that domain to Authentication's
authorized domains if it is not already present. Add `localhost` only for live-project
local development; Firebase may not authorize it automatically for new projects.

## Android build and first use

The Firebase libraries are pinned to BoM 33.7.0 to fit the upstream Kotlin 1.9 toolchain.
The native project has been aligned to Java 17. It requires Android SDK platform 35.

```sh
cd /Users/sayak/Projects/simple_time_tracker_sync/android
JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home ./gradlew :app:assembleBaseDebug --console=plain
```

The APK is written under `android/app/build/outputs/apk/base/debug/`.
Rebuild after configuring Firebase. An APK built before configuration cannot connect.

Open **Time Together**, sign in with the same email/password as the web, and enable sync.
Create activities on the web, or use **Open local app / restore backup** before enabling
sync to restore an existing Simple Time Tracker backup. Stop any local running timers,
then choose **Import this phone's activities**. Only activity definitions are uploaded.
Tap **Open timers** to use the familiar native timer cards.

## Validation

```sh
npm run build
npm test
```

On this Mac, the emulator test command is:

```sh
JAVA_HOME=/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home npm test
```

The test suite uses isolated emulator accounts and includes denied operations on purpose.
`PERMISSION_DENIED` log messages in passing negative tests are expected.

Before calling live sync operational, verify: start on Android and stop on the web;
start on the web and stop on Android; start competing activities on both devices;
close/reopen Android; try a disconnected action; and verify a second account cannot
see the first account's records. Keep a JSON export of important history.

## Source and licensing

Upstream: https://github.com/Razeeman/Android-SimpleTimeTracker/tree/v1.59
The phone app is GPL-3.0-or-later; the upstream Wear OS component has its own MPL-2.0 notice.
The added web app and integration code are distributed under GPL-3.0-or-later as well.
See `android/LICENSE.md` and `android/README.md`. Preserve these notices with any distribution.

## Architecture

`users/{uid}/activities/{id}` stores current activity definitions.
`users/{uid}/sessions/{id}` stores `activityId`, a name/colour snapshot, a note, start/end timestamps.
`users/{uid}/state/timer` stores the active session ID and monotonically increasing revision.
Every start/stop transaction changes the session and shared state together. Server rules
validate both halves with `getAfter()`. A bounded retry handles a racing commit surfaced
as a rules rejection, using the original request identity. No timer tick writes are made.

`web/cloud.ts` and Android's `FirebaseTimerSync.kt` implement the same protocol.
`TimerSyncBridge` connects the native start/stop mediators without Firebase dependencies
in the domain module. Cloud projection writes bypass that bridge to avoid feedback loops.
