/**
 * Mobile number normalisation.
 *
 * The normalised form is the identity key for a player profile, so it has to be
 * stable: the same person typing "0100 123 4567", "+201001234567" and
 * "00201001234567" must land on one profile, or duplicate profiles accumulate
 * and their fire streaks fragment.
 *
 * Deliberately conservative — it canonicalises rather than validates hard, and
 * returns null when it cannot make sense of the input so the caller can ask the
 * user rather than storing something wrong.
 *
 * Pure module: no database, no framework.
 */

/** Default country for bare national numbers. Egypt. */
export const DEFAULT_COUNTRY_CODE = "20";

/** Longest sensible E.164 subscriber number, excluding the leading "+". */
const MAX_DIGITS = 15;
const MIN_DIGITS = 7;

/**
 * Canonicalise a phone number to "+<countrycode><subscriber>".
 * Returns null if the input cannot be interpreted as a phone number.
 */
export function normalizeMobile(
  input: string,
  defaultCountryCode: string = DEFAULT_COUNTRY_CODE
): string | null {
  if (!input) return null;

  // Arabic-Indic digits are common on Egyptian keyboards.
  const westernised = input.replace(/[٠-٩۰-۹]/g, (d) => {
    const code = d.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });

  const trimmed = westernised.trim();
  const hadPlus = trimmed.startsWith("+");
  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  if (hadPlus) {
    // Already international.
  } else if (digits.startsWith("00")) {
    // 00 is the other international prefix.
    digits = digits.slice(2);
  } else if (digits.startsWith("0")) {
    // National trunk prefix: drop the 0 and prepend the country code.
    digits = defaultCountryCode + digits.replace(/^0+/, "");
  } else if (!digits.startsWith(defaultCountryCode)) {
    // A bare national number with no trunk prefix.
    digits = defaultCountryCode + digits;
  }

  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null;
  return `+${digits}`;
}

/** Do two raw inputs refer to the same number? */
export function isSameMobile(a: string, b: string): boolean {
  const na = normalizeMobile(a);
  const nb = normalizeMobile(b);
  return na !== null && na === nb;
}

/**
 * Masked form for admin screens where the full number is not needed.
 * Never send raw numbers to public pages at all — this is for reducing
 * incidental exposure, not a security boundary.
 */
export function maskMobile(normalized: string | null): string {
  if (!normalized) return "—";
  if (normalized.length <= 5) return normalized;
  return `${normalized.slice(0, 4)}•••${normalized.slice(-3)}`;
}
