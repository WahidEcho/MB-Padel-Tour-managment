# Email: Move Score branding, Supabase Auth templates, Resend

Every email we send uses one layout: Move Score header (Rally M lockup on navy, ball-yellow rule), the
message, an optional code box and button, and the signature "Move Score is made by Move Beyond"
(mbeg.org, info@mbeg.org, privacy link, "© Move Beyond. All rights reserved.").

| What | Where |
|---|---|
| Layout (header, button, code box, footer, plain-text part) | `src/lib/email/layout.ts` |
| Supabase Auth templates (source) | `src/lib/email/authTemplates.ts` |
| Supabase Auth templates (generated, paste into the dashboard) | `supabase/email-templates/*.html`, `subjects.json` |
| Our own emails (player codes, confirmations, new tournament, announcements) | `src/lib/messaging/render.ts`, `templates.ts` |
| Hosted logos | `public/email/` → `https://tour.mbeg.org/email/…` |
| Tests (escaping, signature, plain text, templates match the files) | `src/lib/email/email.test.ts`, `src/lib/messaging/messaging.test.ts` |

The logos load from the live site, so deploy this branch before the templates go live, otherwise the
header shows its alt text ("Move Score") instead of the lockup. Without images the email still reads well.

## 1. Supabase SMTP (Resend)

Supabase → Project `dwyztzywuscljqklhqij` → Authentication → Emails → **SMTP Settings** → Enable custom SMTP:

| Field | Value |
|---|---|
| Sender email | `no-reply@mbeg.org` |
| Sender name | `Move Score` |
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | the Resend API key (a key with sending access; a dedicated "Supabase Auth" key is easiest to rotate) |
| Minimum interval between emails | keep the default (60 s per user) |

mbeg.org is already verified in Resend (SPF/DKIM), so no DNS work is needed for `no-reply@mbeg.org`.
After enabling custom SMTP, raise Authentication → Rate Limits → "Rate limit for sending emails" (the
built-in mailer's 2/hour cap no longer applies; 30–100/hour is sensible).

Supabase's SMTP has no reply-to setting, so the auth emails say "Questions? Write to info@mbeg.org" in
the footer.

## 2. Templates in the Supabase dashboard

Authentication → Emails → **Templates**. For each template, set the subject and paste the whole file
into "Message body" (Source view), then Save.

| Dashboard template | Subject | File | Link type |
|---|---|---|---|
| Confirm signup | Confirm your Move Score account | `confirm-signup.html` | `email` |
| Invite user | You're invited to Move Score | `invite.html` | `invite` |
| Magic link | Your Move Score sign-in link | `magic-link.html` | `magiclink` |
| Change email address | Confirm your new Move Score email | `change-email.html` | `email_change` |
| Reset password | Reset your Move Score password | `reset-password.html` | `recovery` |
| Reauthentication | Your Move Score verification code | `reauthentication.html` | (code only) |

(`subjects.json` holds the same list.)

How the links work: each button goes to
`{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=<type>`. The app's pages
(`/movescore/auth/confirm`, `/movescore/auth/reset`) read `token_hash` and `type` and call
`verifyOtp({ token_hash, type })` on the server. So:

- Calls that send these emails must pass the page as the redirect (`emailRedirectTo` for sign-up and
  email change, `redirectTo` for `resetPasswordForEmail`), e.g.
  `https://tour.mbeg.org/movescore/auth/confirm`.
- That URL must be allowed in Authentication → URL Configuration → Redirect URLs
  (`https://tour.mbeg.org/movescore/auth/**`). If it is not, Supabase falls back to the Site
  URL and the link lands on the home page.
- Confirm signup, magic link, reset password and change email also show the six-digit `{{ .Token }}` as
  "Or enter this code in the app"; reauthentication is the code alone.

Variables used: `{{ .RedirectTo }}`, `{{ .TokenHash }}`, `{{ .Token }}`, `{{ .Email }}`,
`{{ .NewEmail }}` (change email). The test fails if any other `{{ … }}` sneaks in.

Outlook desktop: the layout keeps to 600 px through an `<!--[if mso]>` wrapper. If a template engine
strips HTML comments the email still works; Outlook desktop just shows it full width.

## 3. Our own emails (Resend API)

Sent by `src/lib/messaging/transport.ts`:

| Env var | Default | What |
|---|---|---|
| `RESEND_API_KEY` | (required) | Resend API key |
| `RESEND_FROM_EMAIL` | `no-reply@mbeg.org` | sender address (verified domain) |
| `RESEND_FROM_NAME` | `Move Score` | sender name |
| `RESEND_REPLY_TO` | `info@mbeg.org` | where replies go |

So with no overrides the From line is `Move Score <no-reply@mbeg.org>` and replies go to info@mbeg.org.
If Vercel still has `RESEND_FROM_NAME=Move Beyond` or another `RESEND_FROM_EMAIL`, remove them (or set
them to the values above).

## 4. Changing or rebuilding the templates

1. Edit the copy in `src/lib/email/authTemplates.ts` (or the layout in `layout.ts`).
2. `npx tsx scripts/email/build-auth-templates.ts` rewrites `supabase/email-templates/`.
3. `npx vitest run src/lib/email` (fails if the files are stale).
4. Paste the changed files into the dashboard again.

Previews: `npx tsx scripts/email/build-auth-templates.ts --samples "<showcase>/email/html"` writes every
email with example values (logos from a local copy of `public/email/`); then `node shoot.cjs` in
`showcase/email/` renders them at 600 px, light and dark, into `png/` and an `index.html` gallery
(puppeteer-core from `showcase/app-store/work/node_modules`, Chrome from /Applications).

Logos were made from `move-score-app/assets/brand/icon.png` (96 and 192 px) and the showcase's
`ms-A-lockup-horizontal-dark.png` (cropped, flattened onto navy #01041A, 480 and 960 px wide).
