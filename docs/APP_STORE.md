# Atomis Crew — iOS App Store Guide

The worker portal ships as a native iOS app: a Capacitor shell (in `mobile/`)
whose WKWebView loads the live portal at `https://tstc.up.railway.app/w/home`.
Native features on top of the web app:

- **Push notifications via APNs** (shift reminders, safety bulletins) — web-push
  doesn't work inside WKWebView, so the server has a second delivery channel
  (`services/apns.js`, `worker_device_tokens` table, migration 303)
- **Face ID / Touch ID lock** on launch and after 5 min backgrounded
- Camera / photo / location permission strings for the docket, incident and
  clock-in flows

Because the UI is served from Railway, **most updates need no app release** —
deploying `main` updates the app instantly. Only native-shell changes
(plugins, icons, config) need a new build through App Review.

---

## 1. One-time setup (business / Apple side)

### 1.1 Apple Developer Program (~1–2 weeks lead time — start first)

1. Get a **D-U-N-S number** for T&S Traffic Control (free): check/request at
   <https://developer.apple.com/enroll/duns-lookup/>. Many AU companies already
   have one.
2. Enrol at <https://developer.apple.com/programs/enroll/> as an
   **Organization** (not Individual) using an Apple ID owned by the company.
   Cost: **US$99/year**. Apple phone-verifies the company.
3. Note your **Team ID** (10 characters, visible under Membership).

### 1.2 Mac build machine

- Install **Xcode** from the Mac App Store (~15 GB; not currently installed on
  this Mac — only Command Line Tools are present).
- After install: `sudo xcode-select -s /Applications/Xcode.app` and open Xcode
  once to accept the licence.
- No CocoaPods needed — the project uses Swift Package Manager.

### 1.3 APNs auth key (for server push)

1. <https://developer.apple.com/account/resources/authkeys/list> → **+** →
   check **Apple Push Notifications service (APNs)** → register.
2. Download the `.p8` file (one-time download — keep it safe) and note the
   **Key ID**.
3. Set Railway env vars on the ts-dashboard service:

   ```
   APNS_TEAM_ID=<Team ID>
   APNS_KEY_ID=<Key ID>
   APNS_KEY_BASE64=<base64 of the .p8 file>   # base64 -i AuthKey_XXXX.p8
   APNS_BUNDLE_ID=au.com.atomis.crew
   APNS_ENV=production                        # 'sandbox' for Xcode dev builds
   ```

   The APNs channel silently no-ops until these are set, so deploying the
   server changes early is safe.

---

## 2. Building the app

```bash
cd mobile
npm install
npx cap sync ios
npx cap open ios     # opens Xcode
```

In Xcode (first time only):

1. Select the **App** target → **Signing & Capabilities** → pick the T&S team.
   Automatic signing registers the `au.com.atomis.crew` App ID.
2. Confirm the **Push Notifications** capability is listed (the
   `App/App.entitlements` file is already wired in; Xcode flips
   `aps-environment` to `production` automatically when archiving).
3. Plug in an iPhone (or pick a simulator — push needs a real device) and Run.

Smoke test on device: log in with a worker PIN → accept the push permission
prompt → Profile → notifications → **Send Test Notification**. With
`APNS_ENV=sandbox` set on a dev/staging server, the dev build should receive it.

## 3. TestFlight (internal testing)

1. Xcode → **Product → Archive** → **Distribute App → App Store Connect**.
2. In [App Store Connect](https://appstoreconnect.apple.com): create the app
   (bundle id `au.com.atomis.crew`, name "Atomis Crew", primary language
   English (Australia)).
3. TestFlight tab → add internal testers (up to 100, instant) — good for the
   office + a few field crew before review.

## 4. App Store submission — **unlisted distribution**

Atomis Crew is for T&S crew only, so request **unlisted app distribution**:
the app gets a normal App Store link but never appears in search or charts.
Review is the standard process but Apple knows it's an internal-audience app,
which defuses "minimum functionality" (guideline 4.2) concerns about
web-content apps.

1. Fill in the App Store listing (still required): description, screenshots
   (6.9" and 6.5" iPhone sizes), support URL, privacy policy URL.
2. **App Review Information**: supply a demo worker account (a dedicated
   Employee ID + PIN on production seeded with a shift, so reviewers see real
   content past the login screen). Add review notes: "Employee-only operations
   app for T&S Traffic Control field crew. Accounts are provisioned by the
   employer — there is no self-signup." (This also exempts the app from the
   account-deletion requirement, 5.1.1(v).)
3. **Privacy nutrition label**: declares collection of name, employee ID,
   photos (user-initiated uploads), and location (clock in/out) — all linked
   to identity, none used for tracking.
4. Submit for review, and at the same time request unlisted distribution at
   <https://developer.apple.com/support/unlisted-app-distribution/> citing the
   app record.
5. On approval, distribute the App Store link to crew (e.g. from the worker
   login page or an SMS/email blast).

## 5. Releasing updates

- **Web changes** (views, routes, worker portal JS): just deploy `main` —
  the app picks them up on next launch. No review needed.
- **Native changes** (`mobile/`): bump `MARKETING_VERSION` /
  `CURRENT_PROJECT_VERSION` in Xcode, archive, upload, submit. Reviews for
  updates are typically <24 h.

## 6. Android later (optional)

The same server-side channel supports Android: register FCM tokens with
`platform: 'android'` via the existing `/w/notifications/push/device-token`
endpoint and add an FCM sender alongside `services/apns.js`. The Capacitor
project can add `@capacitor/android` at any time; alternatively the PWA can be
wrapped as a Trusted Web Activity (Bubblewrap) in about a day.

---

## Architecture notes (for future maintainers)

| Piece | File | Notes |
|---|---|---|
| APNs sender | `services/apns.js` | Dependency-free: node:http2 + ES256 JWT via node:crypto. Provider token cached 50 min. Dead tokens (Unregistered/BadDeviceToken/...) auto-pruned. |
| Token storage | `worker_device_tokens` (migration 303) | Parallel to `worker_push_subscriptions`; a crew member can have both. |
| Fan-out | `services/pushNotification.js` → `sendPushToCrew` | Sends web-push AND APNs per crew member; `sendPushToAllActiveCrew` unions both tables. Category mute prefs honoured for both channels. |
| Token registration | `routes/worker/notifications.js` → `POST /w/notifications/push/device-token` | Called by the shell after `PushNotifications.register()`. CSRF token required. |
| Shell bridge JS | `public/js/worker-native.js` | Only activates when `Capacitor.isNativePlatform()`. Push registration, notification-tap deep links, biometric lock. `worker.js` skips web-push when native. |
| iOS project | `mobile/ios/App` | SPM (no CocoaPods). Entitlements at `App/App.entitlements`. Loads `server.url` from `mobile/capacitor.config.json`. |
