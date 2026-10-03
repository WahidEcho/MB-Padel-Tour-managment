/**
 * Phone numbers for messaging, in E.164 ("+201001234567"). Builds on the player
 * profile normaliser (Egypt by default) and adds what sending needs: a sanity
 * check that the number can be a mobile, and WhatsApp's digits-only form.
 *
 * Pure module.
 */
import { normalizeMobile } from "../friendly/mobile";

export const DEFAULT_COUNTRY_CODE = "20";

/** "+201001234567", or null when the input is not a usable phone number. */
export function toE164(raw: string | null | undefined, defaultCountryCode = DEFAULT_COUNTRY_CODE): string | null {
  if (!raw) return null;
  const n = normalizeMobile(String(raw), defaultCountryCode);
  if (!n) return null;
  // E.164 allows 8 to 15 digits after the "+"; anything shorter is a typo.
  const digits = n.slice(1);
  if (digits.length < 8 || digits.length > 15) return null;
  // An Egyptian number must be a mobile (+20 10/11/12/15 + 8 digits) to reach WhatsApp or SMS.
  if (digits.startsWith("20") && !/^20(10|11|12|15)\d{8}$/.test(digits)) return null;
  return n;
}

/** WhatsApp Cloud API wants the number without "+". */
export function waRecipient(e164: string): string {
  return e164.replace(/^\+/, "");
}

/** "+20 100 ••• 4567" style mask for screens that do not need the full number. */
export function maskPhone(e164: string | null): string {
  if (!e164) return "—";
  if (e164.length <= 7) return e164;
  return `${e164.slice(0, 6)}•••${e164.slice(-4)}`;
}
