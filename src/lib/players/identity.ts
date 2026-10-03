/**
 * When is a player row in another tournament the same person?
 *
 * A player is a row per tournament (players.tournament_id, team_id); the same
 * person entered in three tournaments is three rows with three codes. When one
 * code is claimed, the other rows are linked too, but only where that is safe:
 *
 *  1. Both rows point at the same persistent profile (player_profile_id), which
 *     an organiser or the friendly-session flow matched on purpose; or
 *  2. the names match (ignoring case, accents, punctuation and spacing) AND they
 *     share a strong contact: the same E.164 phone or the same email.
 *
 * A shared phone alone is not enough: at junior events one parent's phone is
 * often entered for two siblings. A name and nation alone are not enough either:
 * "Mohamed Ahmed, Egypt" is many different people. Rows that fail the rule keep
 * their own codes, which the player can enter one by one.
 *
 * Pure module.
 */

export interface PersonKey {
  id: string;
  full_name: string;
  player_profile_id?: string | null;
  phone?: string | null;
  email?: string | null;
}

/** Lower case, accents and punctuation removed, single spaces. */
export function normalizePersonName(name: string): string {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const clean = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export function samePerson(a: PersonKey, b: PersonKey): boolean {
  if (a.id === b.id) return true;
  if (a.player_profile_id && a.player_profile_id === b.player_profile_id) return true;
  const sameName = normalizePersonName(a.full_name) !== "" && normalizePersonName(a.full_name) === normalizePersonName(b.full_name);
  if (!sameName) return false;
  const phone = clean(a.phone) !== "" && clean(a.phone) === clean(b.phone);
  const email = clean(a.email) !== "" && clean(a.email) === clean(b.email);
  return phone || email;
}

/** The other rows a claim of `target` may link, from candidates that share any key with it. */
export function linkedRows<T extends PersonKey>(target: PersonKey, candidates: T[]): T[] {
  return candidates.filter((c) => c.id !== target.id && samePerson(target, c));
}
