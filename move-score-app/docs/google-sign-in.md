# Google sign-in: what to configure outside the code

Google sign-in runs through **Supabase Auth's Google provider** inside the app's own browser sheet
(iOS: ASWebAuthenticationSession; Android: Custom Tabs; web preview: a popup). Safari or Chrome never
open. The app uses PKCE: it keeps the code verifier and sends only its challenge. The server trades
the returned code for a session, so the app holds no Supabase key and no Google client id.

```
App ──► GET  /api/mobile/v1/auth/oauth/google?redirect_to=movescore://auth/callback&code_challenge=…
        (server checks the request, then 302 →)
        https://dwyztzywuscljqklhqij.supabase.co/auth/v1/authorize?provider=google&…&code_challenge_method=s256
        → Google account chooser and consent
        → https://dwyztzywuscljqklhqij.supabase.co/auth/v1/callback
        → movescore://auth/callback?code=…     (the sheet closes; the app has the URL)
App ──► POST /api/mobile/v1/auth/session { provider: "google", code, codeVerifier }
        → Move Score session (same as Apple), then the phone is linked to the account
```

The Google button appears when `GET /api/mobile/v1/config` returns `"signIn": { "google": true }`.
The server reads that from Supabase Auth's public settings (`/auth/v1/settings`), so the button shows
up within about 2 minutes of the provider being switched on (config cache 60 s plus the server's 60 s
cache). You do not need a new app build.

---

## 1. Google Cloud console (the project that owns Move Score's OAuth)

**APIs & Services → OAuth consent screen** (Google Auth Platform → Branding / Audience / Data access)

| Setting | Value |
|---|---|
| App name | `Move Score` |
| User support email | your support address |
| App logo | optional. A logo triggers Google's brand verification. |
| Application home page | `https://tour.mbeg.org/movescore` |
| Privacy policy | `https://tour.mbeg.org/movescore/privacy` |
| Terms of service | `https://tour.mbeg.org/movescore/terms` |
| Authorized domains | `mbeg.org` (the home page and policy links above; verify it in Google Search Console if asked) and `dwyztzywuscljqklhqij.supabase.co` (Google stores it as `supabase.co`) |
| Scopes | `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`. No sensitive scopes. |
| Audience / publishing status | **In production**. In "Testing" only listed test users can sign in. |

**APIs & Services → Credentials → Create credentials → OAuth client ID**

| Field | Value |
|---|---|
| Application type | **Web application** |
| Name | `Move Score – Supabase` |
| Authorized JavaScript origins | none needed |
| Authorized redirect URIs | `https://dwyztzywuscljqklhqij.supabase.co/auth/v1/callback` |

Copy the **Client ID** and **Client secret** for step 2.

You do **not** need iOS or Android OAuth clients, a Play signing SHA-1, or an iOS URL scheme. Those were
only for the native Google Sign-In SDK, which the app no longer uses.

## 2. Supabase dashboard (project `dwyztzywuscljqklhqij`)

**Authentication → Sign In / Providers → Google**

| Field | Value |
|---|---|
| Enable Sign in with Google | **on** |
| Client ID (for OAuth) | the Web client ID from step 1 |
| Client Secret (for OAuth) | the Web client secret from step 1 |
| Skip nonce checks | off (only matters for native ID tokens, which are not used) |
| Allow users without an email | off |
| Callback URL (shown, read-only) | `https://dwyztzywuscljqklhqij.supabase.co/auth/v1/callback`. Must match step 1 exactly. |

**Authentication → URL Configuration → Redirect URLs**: add these exact entries.

| Entry | For |
|---|---|
| `movescore://auth/callback` | Store, TestFlight, staging and development builds. All of them use the `movescore` scheme. |
| `exp://**` | Expo Go / `expo start` on a phone (`exp://192.168.x.x:8081/--/auth/callback`). Optional. |
| `http://localhost:8081/auth/callback` | The web preview (`npx expo start --web`). Optional. Add one entry per port you use. |

Leave **Site URL** as it is. If a redirect is not on this list, Supabase sends people to the Site URL, and
the sheet then never returns to the app.

Apple stays as it is today. On iPhone the app uses native Sign in with Apple (key `79HZJ4KZ56`,
`APPLE_CLIENT_ID` = the bundle id) and sends the identity token to the server. Nothing about Apple
changes for this feature.

## 3. Vercel (server environment)

There are **no new variables**. The server uses the existing `SUPABASE_URL` and `SUPABASE_KEY` to read
provider settings and to exchange the code. The exchange works with both the legacy key and the new
secret key, so the planned switch to the secret key does not affect it.

## 4. EAS / app build environment

There is **nothing to add**. You can delete these if they were ever set, because the app no longer reads them:
`GOOGLE_WEB_CLIENT_ID`, `GOOGLE_IOS_CLIENT_ID`, `GOOGLE_IOS_URL_SCHEME`. The app's `movescore` scheme is
already in `app.config.ts`.

---

## Check it after configuring

1. `curl -s https://tour.mbeg.org/api/mobile/v1/config | grep -o '"signIn":{[^}]*}'`
   should print `"google":true` (allow about 2 minutes).
2. Open this URL in a desktop browser. Any 43-character challenge works for this test:
   `https://tour.mbeg.org/api/mobile/v1/auth/oauth/google?redirect_to=movescore%3A%2F%2Fauth%2Fcallback&code_challenge=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
   You should get Google's account chooser for "Move Score". After you choose an account, the browser tries
   to open `movescore://auth/callback?code=…`, which shows that Supabase accepted the redirect. If you get
   `error=provider_disabled`, the provider is still off.
3. On a phone, go to Account and tap "Sign in with Google". The sheet opens
   over the app. The account card should then show your Google name, email and picture.

## What people see

- **iOS** shows a system prompt before the sheet: "“Move Score” Wants to Use “tour.mbeg.org” to
  Sign In". Apple requires this for shared-cookie sign-in sheets, so the app cannot hide it.
- **Google's consent screen** says "to continue to dwyztzywuscljqklhqij.supabase.co". To show your own
  domain, set up a Supabase custom domain (paid add-on, for example `auth.mbeg.org`). Then use
  `https://auth.mbeg.org/auth/v1/callback` as the redirect URI in step 1.
- If someone cancels, at Google or by closing the sheet, the app returns to Account without an error.

## Testing without Google

The local stand-in (`LOCALDB_PORT=54334 npm run localdb`) emulates Supabase Auth: settings, PKCE authorize,
token, refresh, JWKS and user deletion. Its `/authorize` stands in for Google and the consent screen. The
gate `npm run e2e:mobile-signin` (with `BASE_URL` and `SUPABASE_URL` pointing at your dev server and stand-in)
runs the whole round trip, including wrong-verifier, replay and foreign-redirect refusals.
Set `LOCALDB_AUTH_GOOGLE=off` to see the button hidden.

## Not included

- **Apple on Android or web.** There is no Apple button there today. To add one, Apple needs a Services ID
  plus a web-OAuth secret in Supabase's Apple provider. After that, the same browser flow works by adding
  `"apple"` to `BROWSER_SIGN_IN_PROVIDERS` in `src/lib/mobile/oauth.ts`.
- **Email / magic-link sign-in.** The app has none. If it is added, start it with PKCE and redirect to
  `movescore://auth/callback`. That is the same return path and callback screen, so the link opens the app
  and finishes there.
