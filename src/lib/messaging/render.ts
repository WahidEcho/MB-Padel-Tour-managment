/**
 * Message text: merge fields and the branded email. Pure module.
 *
 * Merge fields are written {name}, {first_name}, {code}, {tournament}, {link},
 * {app_link}. A field the recipient has no value for renders as an empty string
 * (and `missingFields` tells the composer before anything is sent).
 */

import { brandedEmail } from "../email/layout";

export type Vars = Record<string, string | null | undefined>;

export const MERGE_FIELDS: { key: string; label: string }[] = [
  { key: "name", label: "Full name" },
  { key: "first_name", label: "First name" },
  { key: "code", label: "Player access code" },
  { key: "tournament", label: "Tournament name" },
  { key: "link", label: "Tournament / announcement link" },
  { key: "app_link", label: "Move Score app link" },
];

const FIELD_RE = /\{([a-z_]+)\}/g;

export function firstName(full: string | null | undefined): string {
  return (full ?? "").trim().split(/\s+/)[0] ?? "";
}

/** Adds derived fields (first_name) to a recipient's values. */
export function withDerived(vars: Vars): Vars {
  return { ...vars, first_name: vars.first_name ?? firstName(vars.name) };
}

/** Announcement-wide values, overridden by the recipient's own where they have one. */
export function mergeVars(base: Vars, own: Vars): Vars {
  const out: Vars = { ...base };
  for (const [k, v] of Object.entries(own)) if (v != null && v !== "") out[k] = v;
  return out;
}

export function fillVars(text: string, vars: Vars): string {
  const v = withDerived(vars);
  return text.replace(FIELD_RE, (whole, key: string) => {
    if (!(key in v) && !MERGE_FIELDS.some((f) => f.key === key)) return whole;
    return v[key] ?? "";
  });
}

/** Merge fields used in `text` that `vars` has no value for. */
export function missingFields(text: string, vars: Vars): string[] {
  const v = withDerived(vars);
  const out = new Set<string>();
  for (const m of text.matchAll(FIELD_RE)) {
    const key = m[1]!;
    if (MERGE_FIELDS.some((f) => f.key === key) && !v[key]) out.add(key);
  }
  return [...out];
}

export { escapeHtml, textToHtml } from "../email/layout";

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export interface EmailInput {
  title: string;
  body: string;
  /** Optional button under the message. */
  cta?: { label: string; url: string } | null;
  /** Big, copyable code shown in its own box (access codes). */
  code?: string | null;
  /** Label above the code box (default "Your code"). */
  codeLabel?: string;
  /** Why the person gets this email (footer). */
  footer?: string;
}

/** Default footer line: why a player gets our emails. */
export const DEFAULT_EMAIL_REASON = "You're getting this because you're registered as a player in a tournament run on Move Score.";

/**
 * Our branded email (src/lib/email/layout.ts): Move Score header, the message,
 * an optional code box and button, and the Move Beyond signature. Merge fields
 * are filled first; everything the organiser typed is escaped.
 */
export function renderEmail(input: EmailInput, vars: Vars = {}): EmailContent {
  const title = fillVars(input.title, vars).trim();
  const body = fillVars(input.body, vars).trim();
  const code = input.code ? fillVars(input.code, vars).trim() : "";
  const cta = input.cta?.url ? { label: fillVars(input.cta.label || "Open", vars), url: fillVars(input.cta.url, vars) } : null;
  const reason = input.footer ?? DEFAULT_EMAIL_REASON;
  const { html, text } = brandedEmail({
    title,
    body,
    code: code ? { label: input.codeLabel || "Your code", value: code } : null,
    button: cta,
    reason,
  });
  return { subject: title, html, text };
}
