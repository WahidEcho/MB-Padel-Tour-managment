/**
 * Short referee codes (owner's decision, 22 Oct 2026): court and master-referee codes are
 * 4 characters, 2 letters and 2 digits in random positions ("K7P3"), easy to read out and
 * type on court. They only ever sign in together with the referee's own PIN (a court or
 * master code never works without one, src/lib/auth/staff.ts), so the code says which court
 * and the PIN says who. Look-alikes are left out (no O/0, I/1/L); typing is case-insensitive.
 *
 * Installed apps (1.0.2) only accept a court QR whose code is 12–20 characters
 * (parseCourtLink), so the QR carries the short code in a longer form, "K7P3-COURT-CODE",
 * which the server reads back as "K7P3". Pure: shared by the server, the web and the app.
 */
export const SHORT_CODE_LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ";
export const SHORT_CODE_DIGITS = "23456789";
export const SHORT_CODE_LENGTH = 4;
/** What follows the short code inside a court QR link. */
export const SHORT_CODE_QR_SUFFIX = "COURT-CODE";

/** True for exactly 2 letters and 2 digits from the short-code sets (upper case, no separators). */
export function isShortCode(s: string): boolean {
  if (s.length !== SHORT_CODE_LENGTH) return false;
  let letters = 0;
  let digits = 0;
  for (const ch of s) {
    if (SHORT_CODE_LETTERS.includes(ch)) letters++;
    else if (SHORT_CODE_DIGITS.includes(ch)) digits++;
    else return false;
  }
  return letters === 2 && digits === 2;
}

/** "K7P3" → "K7P3-COURT-CODE" (the form printed in a court QR). */
export function shortCodeQrForm(code: string): string {
  return `${code}-${SHORT_CODE_QR_SUFFIX}`;
}

/**
 * The short code inside a typed or scanned value, compacted (upper case, separators dropped):
 * "k7p3" → "K7P3", "K7P3COURTCODE" → "K7P3"; null for anything else.
 */
export function shortCodeOf(compact: string): string | null {
  const suffix = SHORT_CODE_QR_SUFFIX.replace(/-/g, "");
  const s = compact.endsWith(suffix) && compact.length === SHORT_CODE_LENGTH + suffix.length ? compact.slice(0, SHORT_CODE_LENGTH) : compact;
  return isShortCode(s) ? s : null;
}
