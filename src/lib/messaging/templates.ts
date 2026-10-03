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

export type TransactionalTemplate = "access_code" | "confirmation" | "new_tournament" | "announcement";

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
      body: "Hi {first_name},\n\nHere is your personal player code. Open the Move Score app, choose \"I'm a player\" and enter it to link your matches and profile.\n\nKeep it to yourself — it works once.\n\nGet the app: {app_link}",
      code: "{code}",
      cta: { label: "Open Move Score", url: "{app_link}" },
    }),
    whatsapp: { name: "mb_access_code", language: "en", params: ["first_name", "code", "app_link"] },
    text: () => "Hi {first_name}, your Move Score player code is {code}. Open the app ({app_link}), choose \"I'm a player\" and enter it. Keep it private.",
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
  announcement: {
    email: () => ({ title: "{title}", body: "{message}", cta: null }),
    whatsapp: { name: "mb_announcement", language: "en", params: ["first_name", "title", "message"] },
    text: () => "{title}\n\n{message}",
  },
};

export function transactionalEmail(template: TransactionalTemplate, vars: Vars): EmailContent {
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
