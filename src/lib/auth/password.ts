/**
 * Move Score password and email rules. Pure (no Node, browser or Next.js APIs):
 * the server enforces them and the app shows them as a live checklist, through
 * move-score-app/src/core.
 *
 * Supabase Auth stores passwords with bcrypt, which reads only the first 72
 * bytes, hence the upper limit (counted in bytes, so long non-ASCII passwords
 * are caught too). Set the same minimum and character rules in the Supabase
 * dashboard (Authentication → Providers → Email) so both places agree.
 */

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72;
export const EMAIL_MAX_LENGTH = 254;

export type PasswordRule = "length" | "lower" | "upper" | "digit" | "max" | "notEmail";

export interface PasswordCheck {
  rule: PasswordRule;
  label: string;
  ok: boolean;
}

const utf8Length = (s: string) => {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
};

/** Trimmed and lower-cased: how an email is compared and sent to Supabase. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** A plain, practical email check (one @, a dot in the domain, no spaces). */
export function isValidEmail(email: string): boolean {
  const e = normalizeEmail(email);
  if (!e || e.length > EMAIL_MAX_LENGTH) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(e);
}

/**
 * Every rule with whether the password meets it, in the order the app lists
 * them. `max` and `notEmail` only show as problems (the app hides them while met).
 */
export function passwordChecks(password: string, email?: string | null): PasswordCheck[] {
  const p = password ?? "";
  const e = email ? normalizeEmail(email) : "";
  return [
    { rule: "length", label: `At least ${PASSWORD_MIN_LENGTH} characters`, ok: p.length >= PASSWORD_MIN_LENGTH },
    { rule: "lower", label: "A lower-case letter", ok: /[a-z]/.test(p) },
    { rule: "upper", label: "An upper-case letter", ok: /[A-Z]/.test(p) },
    { rule: "digit", label: "A number", ok: /[0-9]/.test(p) },
    { rule: "max", label: `At most ${PASSWORD_MAX_BYTES} characters`, ok: utf8Length(p) <= PASSWORD_MAX_BYTES },
    { rule: "notEmail", label: "Not your email address", ok: !e || p.trim().toLowerCase() !== e },
  ];
}

/** Rules that are always listed (the others appear only when broken). */
export const LISTED_RULES: readonly PasswordRule[] = ["length", "lower", "upper", "digit"];

/** The first rule the password breaks, as a sentence, or null when it is fine. */
export function passwordProblem(password: string, email?: string | null): string | null {
  const bad = passwordChecks(password, email).find((c) => !c.ok);
  if (!bad) return null;
  switch (bad.rule) {
    case "length":
      return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
    case "lower":
      return "Add a lower-case letter.";
    case "upper":
      return "Add an upper-case letter.";
    case "digit":
      return "Add a number.";
    case "max":
      return `Use at most ${PASSWORD_MAX_BYTES} characters.`;
    case "notEmail":
      return "Your password can't be your email address.";
  }
}

export const isStrongPassword = (password: string, email?: string | null) => passwordProblem(password, email) === null;
