# Android notifications (Firebase) — set-up

Why Android phones got no notifications (21 Oct 2026):

- The Android builds (the APK on tour.mbeg.org/app) were made without `google-services.json`. Without it an
  Android phone cannot get a push token, so the server never even learns the phone exists.
- Expo has no Firebase sending key (FCM V1) for the project, so even the one Android phone that did register
  (app 1.0.0) is refused: `InvalidCredentials` on every push.

Both need the owner's Google and Expo accounts. Do the steps in order; about 20 minutes.

## 1. Firebase project and the Android app

1. <https://console.firebase.google.com> → **Add project** (e.g. "Move Score"). Google Analytics is not needed.
2. In the project: **Add app → Android**.
   - Android package name: `org.mbeg.movescore` (exactly; the store/APK build).
   - Nickname: Move Score. The SHA-1 is not needed for notifications.
3. **Download `google-services.json`**. Skip the remaining wizard steps (the SDK lines are already in the app).

## 2. Put the file into the app builds (EAS)

From `move-score-app/`, signed in to the `move-beyond` Expo account:

```sh
npx eas-cli env:create --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json \
  --environment production --environment preview --visibility secret
```

Then delete the local copy (it is not secret, but it does not belong in git). `app.config.ts` reads the variable
as `android.googleServicesFile`; since 21 Oct 2026 a production Android build **stops** with a clear error if it is
missing, so a build without notifications can never be shipped again (`MS_ALLOW_NO_PUSH=1` overrides it for a
throwaway test build).

## 3. Give Expo the Firebase sending key (FCM V1)

1. Firebase → ⚙ **Project settings → Service accounts → Generate new private key** → a `.json` file downloads.
   This one **is** secret: never commit it or send it in chat.
2. Upload it to Expo, either:
   - <https://expo.dev> → move-beyond → Move Score → **Credentials → Android → org.mbeg.movescore →
     FCM V1 service account key → Add**, or
   - `npx eas-cli credentials -p android` → production → **Google Service Account** →
     **Manage your Google Service Account Key for Push Notifications (FCM V1)** → **Upload**.
3. Delete the downloaded key file from your computer once uploaded.

## 4. New Android build

```sh
npx eas-cli build --profile apk --platform android
```

Publish the APK as `MoveScore.apk` on the latest GitHub release of `WahidEcho/movescore-android` (the download page
tour.mbeg.org/app/android points there). Android only — the iPhone rule still holds: no App Store or TestFlight
uploads.

## 5. Check on a phone

1. Install the new APK over the old one, open it, and allow notifications (Account → Alerts on this phone).
2. Admin → Announcements → New → audience **Every app user**, channel **App push** → send a test.
3. The phone shows it. If not: Account → Alerts on this phone shows the reason, and on the server the delivery row in
   `notification_deliveries` has the error (`InvalidCredentials` = step 3 missing; no row at all for that phone = no
   token, step 2 missing or the old APK).

Already-installed Android phones get nothing until they install the new build: the old APK has no Firebase file.
