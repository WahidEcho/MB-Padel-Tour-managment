/**
 * Player phone numbers in E.164 ("+201001234567"), Egypt by default.
 *
 * Builds on the friendly sessions' normaliser (src/lib/friendly/mobile.ts) and
 * adds the checks a number needs before a WhatsApp link is built from it: an
 * Egyptian mobile is +20 then 10, 11, 12 or 15 and eight more digits; an
 * Egyptian landline is +20 then 8 or 9 digits; anything else must at least look
 * like an international number (8 to 15 digits, no leading zero).
 *
 * Pure module: no database, no framework, shared with the native app.
 */
import { DEFAULT_COUNTRY_CODE, normalizeMobile } from "../friendly/mobile";

/** "+201001234567", or null when the input is not a usable phone number. */
export function toE164(input: string | null | undefined, defaultCountryCode: string = DEFAULT_COUNTRY_CODE): string | null {
  if (!input || !String(input).trim()) return null;
  // Letters mean it is not a phone number (an email pasted in the wrong box, say).
  if (/[a-z@]/i.test(String(input))) return null;
  const n = normalizeMobile(String(input), defaultCountryCode);
  if (!n) return null;
  const digits = n.slice(1);
  if (digits.startsWith("0") || digits.length < 8 || digits.length > 15) return null;
  if (digits.startsWith("20")) {
    const national = digits.slice(2);
    if (national.startsWith("1")) return /^1[0125]\d{8}$/.test(national) ? n : null;
    return /^[2-9]\d{7,8}$/.test(national) ? n : null;
  }
  return n;
}

/** The digits wa.me wants: E.164 without the plus. */
export function whatsAppDigits(e164: string): string {
  return e164.replace(/\D/g, "");
}

/** +20 100 123 4567 for an Egyptian mobile; other numbers as stored. */
export function displayPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  const m = /^\+20(1\d{2})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+20 ${m[1]} ${m[2]} ${m[3]}` : e164;
}
