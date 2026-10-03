/**
 * The Supabase Auth email templates (Authentication → Emails in the Supabase
 * dashboard), built from the same layout as every other Move Score email.
 * `scripts/email/build-auth-templates.ts` writes them to supabase/email-templates/;
 * a test keeps those files in step with this module. See docs/email.md.
 *
 * Values in {{ … }} are Supabase's Go-template variables, filled in by Supabase
 * when it sends. Links go to {{ .RedirectTo }} with the token hash, so the app's
 * pages (/movescore/auth/confirm, /movescore/auth/reset) verify it server-side
 * with verifyOtp({ token_hash, type }). The six-digit {{ .Token }} is shown as a
 * fallback code where Supabase provides one.
 */
import { brandedEmailHtml, type BrandedEmailInput } from "./layout";

export type AuthTemplateId = "confirm-signup" | "magic-link" | "reset-password" | "change-email" | "invite" | "reauthentication";

export interface AuthTemplate {
  id: AuthTemplateId;
  /** The template's name in Supabase → Authentication → Emails. */
  dashboardName: string;
  subject: string;
  /** The verifyOtp type carried in the link (none for reauthentication). */
  type: "email" | "magiclink" | "recovery" | "email_change" | "invite" | null;
  email: BrandedEmailInput;
}

/** The link in each email: the app's redirect URL plus the token hash and its type. */
export function authLink(type: string): string {
  return `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=${type}`;
}

const AUTH_REASON = "You're getting this because someone used this address on Move Score.";
const CODE_LABEL = "Or enter this code in the app";

export const AUTH_TEMPLATES: AuthTemplate[] = [
  {
    id: "confirm-signup",
    dashboardName: "Confirm signup",
    subject: "Confirm your Move Score account",
    type: "email",
    email: {
      title: "Confirm your Move Score account",
      heading: "Confirm your email",
      preheader: "One tap and your Move Score account is ready.",
      body: "Welcome to Move Score: live tennis and padel scores, your matches and your player profile in one app.\n\nTap the button to confirm {{ .Email }} and finish setting up your account.",
      button: { label: "Confirm email", url: authLink("email") },
      linkFallback: true,
      code: { label: CODE_LABEL, value: "{{ .Token }}" },
      codeAfterButton: true,
      note: "If you didn't create a Move Score account, you can ignore this email.",
      reason: AUTH_REASON,
    },
  },
  {
    id: "magic-link",
    dashboardName: "Magic link",
    subject: "Your Move Score sign-in link",
    type: "magiclink",
    email: {
      title: "Your Move Score sign-in link",
      heading: "Sign in to Move Score",
      preheader: "Your sign-in link and code. They work once and expire soon.",
      body: "Tap the button to sign in as {{ .Email }}. The link works once and expires soon.",
      button: { label: "Sign in", url: authLink("magiclink") },
      linkFallback: true,
      code: { label: CODE_LABEL, value: "{{ .Token }}" },
      codeAfterButton: true,
      note: "If you didn't ask to sign in, you can ignore this email. Nobody can sign in without this link or code.",
      reason: AUTH_REASON,
    },
  },
  {
    id: "reset-password",
    dashboardName: "Reset password",
    subject: "Reset your Move Score password",
    type: "recovery",
    email: {
      title: "Reset your Move Score password",
      heading: "Reset your password",
      preheader: "Choose a new password for your Move Score account.",
      body: "We got a request to reset the password for {{ .Email }}. Tap the button to choose a new one. The link works once and expires soon.",
      button: { label: "Choose a new password", url: authLink("recovery") },
      linkFallback: true,
      code: { label: CODE_LABEL, value: "{{ .Token }}" },
      codeAfterButton: true,
      note: "If you didn't ask for this, you can ignore this email: your password stays the same.",
      reason: AUTH_REASON,
    },
  },
  {
    id: "change-email",
    dashboardName: "Change email address",
    subject: "Confirm your new Move Score email",
    type: "email_change",
    email: {
      title: "Confirm your new Move Score email",
      heading: "Confirm your new email",
      preheader: "Confirm the change of email on your Move Score account.",
      body: "You asked to change the email on your Move Score account from {{ .Email }} to {{ .NewEmail }}.\n\nTap the button to confirm the change.",
      button: { label: "Confirm new email", url: authLink("email_change") },
      linkFallback: true,
      code: { label: CODE_LABEL, value: "{{ .Token }}" },
      codeAfterButton: true,
      note: "If you didn't ask for this, don't tap the button and write to info@mbeg.org.",
      reason: AUTH_REASON,
    },
  },
  {
    id: "invite",
    dashboardName: "Invite user",
    subject: "You're invited to Move Score",
    type: "invite",
    email: {
      title: "You're invited to Move Score",
      heading: "You're invited to Move Score",
      preheader: "Accept your invitation and set up your Move Score account.",
      body: "You've been invited to join Move Score with {{ .Email }}: live tennis and padel scores, your matches and your player profile in one app.\n\nTap the button to accept and set up your account.",
      button: { label: "Accept invitation", url: authLink("invite") },
      linkFallback: true,
      note: "If you weren't expecting this, you can ignore this email.",
      reason: AUTH_REASON,
    },
  },
  {
    id: "reauthentication",
    dashboardName: "Reauthentication",
    subject: "Your Move Score verification code",
    type: null,
    email: {
      title: "Your Move Score verification code",
      heading: "Confirm it's you",
      preheader: "Your Move Score verification code.",
      body: "Enter this code in Move Score to confirm it's you. It expires soon.",
      code: { label: "Verification code", value: "{{ .Token }}" },
      note: "If you didn't ask for this, someone may know your password: change it and write to info@mbeg.org.",
      reason: AUTH_REASON,
    },
  },
];

export function authTemplateHtml(t: AuthTemplate): string {
  return brandedEmailHtml(t.email);
}

/** supabase/email-templates/subjects.json */
export function authSubjects(): Record<AuthTemplateId, { dashboardTemplate: string; subject: string; file: string }> {
  return Object.fromEntries(
    AUTH_TEMPLATES.map((t) => [t.id, { dashboardTemplate: t.dashboardName, subject: t.subject, file: `${t.id}.html` }]),
  ) as Record<AuthTemplateId, { dashboardTemplate: string; subject: string; file: string }>;
}
