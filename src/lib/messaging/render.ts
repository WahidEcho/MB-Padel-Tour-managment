/**
 * Message text: merge fields and the branded email. Pure module.
 *
 * Merge fields are written {name}, {first_name}, {code}, {tournament}, {link},
 * {app_link}. A field the recipient has no value for renders as an empty string
 * (and `missingFields` tells the composer before anything is sent).
 */

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

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Escaped text with links made clickable and line breaks kept. */
export function textToHtml(text: string): string {
  const escaped = escapeHtml(text);
  const linked = escaped.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (url) => `<a href="${url}" style="color:#00aeef;">${url}</a>`);
  return linked
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px;line-height:1.55;">${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

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
  footer?: string;
}

const BRAND = "Move Beyond";

/**
 * A simple branded email: dark header with the wordmark, the message, an optional
 * button and code box, and a quiet footer. Inline styles only (mail clients drop
 * <style>), one column, works without images.
 */
export function renderEmail(input: EmailInput, vars: Vars = {}): EmailContent {
  const title = fillVars(input.title, vars).trim();
  const body = fillVars(input.body, vars).trim();
  const code = input.code ? fillVars(input.code, vars).trim() : "";
  const cta = input.cta?.url ? { label: fillVars(input.cta.label || "Open", vars), url: fillVars(input.cta.url, vars) } : null;
  const footer = input.footer ?? `You are receiving this because you are registered as a player with ${BRAND}.`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#f2f4f6;font-family:Arial,Helvetica,sans-serif;color:#111111;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4f6;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;">
<tr><td style="background:#0b0b0b;padding:20px 28px;">
<span style="color:#00aeef;font-size:13px;font-weight:bold;letter-spacing:3px;text-transform:uppercase;">${BRAND}</span>
</td></tr>
<tr><td style="padding:28px;">
<h1 style="margin:0 0 18px;font-size:22px;line-height:1.3;color:#111111;">${escapeHtml(title)}</h1>
${textToHtml(body)}
${code ? `<div style="margin:8px 0 20px;padding:16px;border-radius:12px;background:#f6f7f8;border:1px solid #e2e5e8;text-align:center;"><div style="font-size:11px;color:#5b6470;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px;">Your code</div><div style="font-size:28px;font-weight:bold;letter-spacing:4px;font-family:Menlo,Consolas,monospace;">${escapeHtml(code)}</div></div>` : ""}
${cta ? `<p style="margin:8px 0 4px;"><a href="${escapeHtml(cta.url)}" style="display:inline-block;background:#00aeef;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:12px;">${escapeHtml(cta.label)}</a></p>` : ""}
</td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid #e2e5e8;color:#5b6470;font-size:12px;line-height:1.5;">${escapeHtml(footer)}</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  const text = [title, "", body, code ? `\nYour code: ${code}` : "", cta ? `\n${cta.label}: ${cta.url}` : "", "", "—", footer]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n")
    .trim();

  return { subject: title, html, text };
}
