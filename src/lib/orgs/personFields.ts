/**
 * Whose eyes a player's person fields are for.
 *
 * A player profile is the person's own: their mobile, email, birth year, gender,
 * photo and messaging consents. Several organisations can have the same player
 * (organization_players), and one of them must not be able to collect another's
 * players' contact details by typing a known mobile number into its own public
 * registration form: that form finds the existing profile by the number, which
 * proves nothing about who typed it.
 *
 * So an organisation sees (and can message) a profile's person fields only when
 *   - it created the profile, or the player was otherwise added or confirmed with it
 *     (organization_players.source is anything but 'matched'), or
 *   - no other organisation has the player at all.
 * Otherwise the fields are masked in every admin list, detail page and export,
 * the profile is left out of the "all players" audience, and the organisation's
 * forms never write those fields. Platform admins (Move Beyond) see everything.
 * The player's own transactional messages (their registration being confirmed)
 * are unaffected: they reveal nothing to the organisation.
 *
 * Later, an approved entry confirmed by the player in the app (OTP) records the
 * link as 'link', and the fields become visible to that organisation.
 *
 * Server-only.
 */
import { db } from "../supabase";
import { isUuid } from "./roles";
import type { PlayerProfile } from "../types";

/** How a player came to an organisation (organization_players.source; migration 0023). */
export type OrgPlayerSource = "backfill" | "admin" | "registration" | "matched" | "tournament" | "league" | "link";

/** The rule itself, for one profile: its source with this organisation, and how many other organisations have it. */
export function personFieldsVisibleFor(source: OrgPlayerSource | string | null | undefined, otherOrgs: number): boolean {
  if (!source) return false; // not this organisation's player at all
  return source !== "matched" || otherOrgs === 0;
}

/** The profile ids among `ids` whose person fields this organisation may see. */
export async function visiblePersonFields(orgId: string, ids: string[], opts: { platformAdmin?: boolean } = {}): Promise<Set<string>> {
  const wanted = [...new Set(ids.filter(isUuid))];
  const out = new Set<string>();
  if (wanted.length === 0) return out;
  const source = new Map<string, string>();
  for (let i = 0; i < wanted.length; i += 200) {
    const { data } = await db()
      .from("organization_players")
      .select("player_profile_id, source")
      .eq("organization_id", orgId)
      .in("player_profile_id", wanted.slice(i, i + 200));
    for (const r of (data ?? []) as { player_profile_id: string; source: string }[]) source.set(r.player_profile_id, r.source);
  }
  if (opts.platformAdmin) {
    for (const id of wanted) out.add(id);
    return out;
  }
  const matched = [...source].filter(([, s]) => s === "matched").map(([id]) => id);
  const elsewhere = new Set<string>();
  for (let i = 0; i < matched.length; i += 200) {
    const { data } = await db()
      .from("organization_players")
      .select("player_profile_id")
      .neq("organization_id", orgId)
      .in("player_profile_id", matched.slice(i, i + 200));
    for (const r of (data ?? []) as { player_profile_id: string }[]) elsewhere.add(r.player_profile_id);
  }
  for (const [id, s] of source) if (personFieldsVisibleFor(s, elsewhere.has(id) ? 1 : 0)) out.add(id);
  return out;
}

/** Person fields blanked out; `person_hidden` tells the page why they are empty. */
export function maskPersonFields<T extends Pick<PlayerProfile, "mobile_normalized" | "email" | "birth_year" | "gender" | "photo_url" | "portrait_url">>(p: T): T & { person_hidden: true } {
  return { ...p, mobile_normalized: null, email: null, birth_year: null, gender: null, photo_url: null, portrait_url: null, person_hidden: true };
}
