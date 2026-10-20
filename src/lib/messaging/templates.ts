/**
 * What gets sent: WhatsApp template variable mapping for announcements, and the
 * transactional message catalogue used by sendTransactional. Pure module.
 */
import { fillVars, renderEmail, type EmailContent, type EmailInput, type Vars } from "./render";
import type { TemplateSend } from "./whatsapp";

/** Where a WhatsApp template variable takes its value from, per recipient. */
export type ParamField = "name" | "first_name" | "title" | "message" | "code" | "tournament" | "link" | "app_link" | "custom";

export interface ParamSource {
  field: ParamField;
  /** For 'custom': fixed text, merge fields allowed. */
  text?: string;
}

export const PARAM_FIELDS: { value: ParamField; label: string }[] = [
  { value: "first_name", label: "First name" },
  { value: "name", label: "Full name" },
  { value: "title", label: "Announcement title" },
  { value: "message", label: "Announcement message" },
  { value: "code", label: "Access code" },
  { value: "tournament", label: "Tournament name" },
  { value: "link", label: "Link" },
  { value: "app_link", label: "App link" },
  { value: "custom", label: "Custom text…" },
];

export interface WaTemplateChoice {
  name: string;
  language: string;
  params: ParamSource[];
  headerImageUrl?: string | null;
  /** One per dynamic URL button, with the button's index in the template. */
  buttons?: { index: number; source: ParamSource }[];
}

export function resolveParam(src: ParamSource, ctx: { title: string; body: string; vars: Vars }): string {
  switch (src.field) {
    case "title":
      return fillVars(ctx.title, ctx.vars);
    case "message":
      return fillVars(ctx.body, ctx.vars);
    case "custom":
      return fillVars(src.text ?? "", ctx.vars);
    default:
      return fillVars(`{${src.field}}`, ctx.vars);
  }
}

/** The template send for one recipient of an announcement. */
export function announcementTemplate(choice: WaTemplateChoice, ctx: { title: string; body: string; vars: Vars }): TemplateSend {
  return {
    name: choice.name,
    language: choice.language,
    bodyParams: choice.params.map((p) => resolveParam(p, ctx)),
    headerImageUrl: choice.headerImageUrl || null,
    buttonParams: (choice.buttons ?? []).map((b) => ({ index: b.index, value: resolveParam(b.source, ctx) })),
  };
}

/** A sensible starting mapping for a template with `n` body variables. */
export function defaultParams(n: number, kind: "announcement" | "access_codes" | "new_tournament" = "announcement"): ParamSource[] {
  const order: ParamField[] =
    kind === "access_codes" ? ["first_name", "code", "app_link"] : kind === "new_tournament" ? ["first_name", "tournament", "message", "link"] : ["first_name", "title", "message"];
  return Array.from({ length: n }, (_, i) => ({ field: order[i] ?? "custom", text: "" }));
}

/* ---------------- transactional catalogue ---------------- */

export type TransactionalTemplate = "access_code" | "confirmation" | "new_tournament" | "announcement" | "staff_invite" | "login_code" | "registration" | "staff_alert";

interface CatalogueEntry {
  email: (vars: Vars) => EmailInput;
  /** The approved WhatsApp template this maps to, and its variables in order. */
  whatsapp: { name: string; language: string; params: ParamField[]; buttons?: { index: number; field: ParamField }[] };
  /** Free-form WhatsApp text, used only when the 24-hour window is open. */
  text: (vars: Vars) => string;
}

/**
 * Template names below are the ones docs/messaging.md asks to submit to Meta.
 * Until Meta approves them, WhatsApp sends of these fail with 132001 (recorded
 * on the delivery row), while email works straight away.
 */
export const TRANSACTIONAL: Record<TransactionalTemplate, CatalogueEntry> = {
  access_code: {
    email: () => ({
      title: "Your Move Score player code",
      body: "Hi {first_name},\n\nHere is your personal Move Score player code{tournament_suffix}. Get the app, sign in, open Account, tap Player code and enter it: you'll see your matches, and you can add your photo and phone number.\n\nKeep it to yourself: it links your player profile to your account.\n\nGet the app: {app_link}",
      code: "{code}",
      codeLabel: "Your player code",
      cta: { label: "Open Move Score", url: "{app_link}" },
    }),
    whatsapp: { name: "mb_access_code", language: "en", params: ["first_name", "code", "app_link"] },
    text: () => "Hi {first_name}, your Move Score player code is {code}. Get the app ({app_link}), sign in, open Account, tap Player code and enter it. Keep it to yourself.",
  },
  confirmation: {
    email: () => ({
      title: "{title}",
      body: "Hi {first_name},\n\n{message}",
      cta: null,
    }),
    whatsapp: { name: "mb_confirmation", language: "en", params: ["first_name", "message"] },
    text: () => "Hi {first_name}, {message}",
  },
  new_tournament: {
    email: () => ({
      title: "{tournament}: registration is open",
      body: "Hi {first_name},\n\n{message}",
      cta: { label: "See the tournament", url: "{link}" },
    }),
    whatsapp: { name: "mb_new_tournament", language: "en", params: ["first_name", "tournament", "message", "link"] },
    text: () => "Hi {first_name}, {tournament} is open for registration. {message} {link}",
  },
  // Email only (src/lib/orgs/invites.ts). The link is single-use and is never
  // stored with the delivery (sendTransactional's `redact`).
  staff_invite: {
    email: () => ({
      title: "Join {organization} on Move Score",
      body: "Hi,\n\n{inviter} invited you to join {organization} on Move Score as {role}.\n\nOpen the link below and sign in with this email address ({email}), with Google or with your Move Score email and password. The link works once and expires in 7 days.\n\nIf you were not expecting this, ignore this email: nothing happens unless you open the link and sign in.",
      cta: { label: "Accept the invitation", url: "{link}" },
    }),
    whatsapp: { name: "mb_staff_invite", language: "en", params: ["title", "link"] },
    text: () => "{inviter} invited you to join {organization} on Move Score as {role}: {link}",
  },
  // The phone one-time code sent by email, only after the player said yes in the app
  // (src/lib/players/phoneLink.ts). Sent by sendOneTimeCode, which never stores the code.
  // On WhatsApp the code goes through the authentication template (otp.ts), not this entry.
  login_code: {
    email: () => ({
      title: "Your Move Score code",
      body: "Hi {first_name},\n\nHere is the code you asked for in the Move Score app. Enter it there to link the entries recorded with your phone number to your account. It works for 10 minutes.\n\nIf you didn't ask for it, ignore this email: nothing changes unless the code is entered.",
      code: "{code}",
      codeLabel: "Your code",
      cta: null,
    }),
    whatsapp: { name: "mb_login_code", language: "en", params: ["code"], buttons: [{ index: 0, field: "code" }] },
    text: () => "Your Move Score code is {code}. It works for 10 minutes.",
  },
  // Registration notices (src/lib/registration/server.ts). Email only, and only to a
  // verified address: an app account's confirmed email, or a web guest's address once
  // its emailed link was opened. The one exception is that link itself, sent once to
  // the typed address and never stored (redacted). No name the registrant typed is
  // ever put in it: the words are the server's own and the event's name.
  registration: {
    email: () => ({ title: "{title}", body: "Hello,\n\n{message}", cta: { label: "{cta_label}", url: "{link}" } }),
    whatsapp: { name: "mb_registration", language: "en", params: ["title", "link"] },
    text: () => "{title}: {link}",
  },
  // Security notices to an organisation's owners and admins (src/lib/referees/server.ts:
  // too many wrong referee PINs). Email only; the words are the server's own.
  staff_alert: {
    email: () => ({ title: "{title}", body: "Hello,\n\n{message}", cta: { label: "{cta_label}", url: "{link}" } }),
    whatsapp: { name: "mb_registration", language: "en", params: ["title", "link"] },
    text: () => "{title}: {link}",
  },
  announcement: {
    email: () => ({ title: "{title}", body: "{message}", cta: null }),
    whatsapp: { name: "mb_announcement", language: "en", params: ["first_name", "title", "message"] },
    text: () => "{title}\n\n{message}",
  },
};

export function transactionalEmail(template: TransactionalTemplate, given: Vars): EmailContent {
  const vars: Vars = { ...given, tournament_suffix: given.tournament ? ` for ${given.tournament}` : "" };
  const input = TRANSACTIONAL[template].email(vars);
  // Two passes: catalogue placeholders such as {message} may themselves hold merge fields.
  const once = (s: string) => fillVars(fillVars(s, vars), vars);
  return renderEmail(
    { ...input, title: once(input.title), body: once(input.body), code: input.code ? once(input.code) : null, cta: input.cta ? { label: once(input.cta.label), url: once(input.cta.url) } : null },
    {},
  );
}

export function transactionalWhatsApp(template: TransactionalTemplate, vars: Vars): TemplateSend {
  const t = TRANSACTIONAL[template].whatsapp;
  const v = (f: ParamField) => resolveParam({ field: f }, { title: vars.title ?? "", body: vars.message ?? "", vars });
  return {
    name: t.name,
    language: t.language,
    bodyParams: t.params.map(v),
    buttonParams: (t.buttons ?? []).map((b) => ({ index: b.index, value: v(b.field) })),
  };
}

export function transactionalText(template: TransactionalTemplate, vars: Vars): string {
  return fillVars(TRANSACTIONAL[template].text(vars), vars);
}
