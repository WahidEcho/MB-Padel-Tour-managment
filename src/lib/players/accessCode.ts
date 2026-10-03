/**
 * Player access codes: the private code an organiser shares with each player
 * (WhatsApp, email) and the player types into the Move Score app to link their
 * account to their player record.
 *
 * Eight characters from 31 symbols without look-alikes (no 0/O, 1/I/L), so a
 * code read aloud or copied by hand survives: 31^8 ≈ 8.5 × 10^11 codes. With
 * claim attempts rate-limited per phone, account and network, guessing one is
 * not a practical attack.
 *
 * The database generates the same shape for every new player (column default
 * `gen_player_access_code()`, migration 0018); this module makes them for resets
 * and reads what people type. Pure module: no database, no framework, shared
 * with the native app through move-score-app/src/core.
 */

export const ACCESS_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const ACCESS_CODE_LENGTH = 8;

/** `randomInt(n)` must return a uniformly random integer in [0, n), e.g. crypto.randomInt. */
export function newAccessCode(randomInt: (n: number) => number): string {
  let s = "";
  for (let i = 0; i < ACCESS_CODE_LENGTH; i++) s += ACCESS_CODE_ALPHABET[randomInt(ACCESS_CODE_ALPHABET.length)];
  return s;
}

/**
 * What a person typed or pasted, as a bare code: upper case, without spaces,
 * dashes or dots, Arabic-Indic digits made western. "abcd-2345", " ABCD 2345 "
 * and "Your code: ABCD-2345" all read as ABCD2345 (the last only when the code
 * is the one 8-character run left after removing the words around it).
 */
export function normalizeAccessCode(input: string): string {
  const western = String(input ?? "").replace(/[٠-٩۰-۹]/g, (d) => {
    const code = d.charCodeAt(0);
    return String(code - (code >= 0x06f0 ? 0x06f0 : 0x0660));
  });
  const upper = western.toUpperCase();
  const compact = upper.replace(/[\s\-–—_.·]/g, "");
  if (compact.length === ACCESS_CODE_LENGTH) return compact;
  // A pasted message: pick the code out of it.
  const runs = upper.match(/[A-Z0-9]{4}[\s\-–—_.·]?[A-Z0-9]{4}/g) ?? [];
  const hits = runs.map((r) => r.replace(/[^A-Z0-9]/g, "")).filter(isValidAccessCode);
  return hits.length === 1 ? hits[0]! : compact;
}

export function isValidAccessCode(code: string): boolean {
  if (code.length !== ACCESS_CODE_LENGTH) return false;
  for (const ch of code) if (!ACCESS_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/** ABCD-2345: easier to read out and to check by eye. */
export function formatAccessCode(code: string): string {
  const c = normalizeAccessCode(code);
  return c.length === ACCESS_CODE_LENGTH ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}
