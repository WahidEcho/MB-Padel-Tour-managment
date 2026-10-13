/**
 * League invite codes (Phase 7). Server-only (node:crypto).
 *
 * Eight characters from the event codes' 31-symbol alphabet (no 0/O, 1/I/L),
 * shown as "K7QM-W3XT". Only an HMAC-SHA256 of the normalised code, keyed with the
 * server's EVENT_CODE_PEPPER and domain-separated from event codes and invites,
 * is stored (leagues.invite_code_hash); the code is shown once to the organiser
 * who set it and never written to a log or an audit row. Guesses are rate-limited
 * per account (src/lib/leagues/server.ts joinLeague).
 */
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { CODE_ALPHABET, eventCodePepper } from "../orgs/codes";
import { normalizeInviteCode } from "./join";

export const INVITE_CODE_LENGTH = 8;

export function generateLeagueInviteCode(): string {
  let out = "";
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** "K7QMW3XT" → "K7QM-W3XT". */
export function formatLeagueInviteCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

/** The stored form: HMAC-SHA256 (hex) under the pepper. Null when the input cannot be a code. */
export function hashLeagueInviteCode(input: unknown, pepper = eventCodePepper()): string | null {
  if (typeof input !== "string" || input.length > 40) return null;
  const code = normalizeInviteCode(input);
  if (code.length !== INVITE_CODE_LENGTH || [...code].some((c) => !CODE_ALPHABET.includes(c))) return null;
  return createHmac("sha256", pepper).update(`mb-league-invite:v1:${code}`).digest("hex");
}

/** Whether a typed code matches the stored hash (constant time). */
export function leagueInviteCodeMatches(input: unknown, storedHash: string | null | undefined, pepper?: string): boolean {
  if (!storedHash || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const h = hashLeagueInviteCode(input, pepper);
  if (!h) return false;
  return timingSafeEqual(Buffer.from(h, "hex"), Buffer.from(storedHash, "hex"));
}
