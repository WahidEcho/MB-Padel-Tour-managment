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

/**
 * The rule for a profile reached through a row of this organisation's own (a
 * player in its tournament or session linked to the profile): its person fields
 * are hidden when this organisation does not vouch for the profile (it has no
 * organization_players row for it, or only a 'matched' one) while another
 * organisation does have it. A profile nobody else has stays visible.
 */
export function personFieldsHiddenFor(source: OrgPlayerSource | string | null | undefined, otherOrgs: number): boolean {
  return (!source || source === "matched") && otherOrgs > 0;
}

/**
 * The profiles among `ids` whose person fields (mobile, email, photo…) this
 * organisation must neither show nor use, though its own rows link to them:
 * team rosters and their photos (getTeams, the live courts hero), contact
 * fallbacks in audiences and "Send code". Platform admins: none.
 */
export async function hiddenPersonFields(orgId: string | null | undefined, ids: string[], opts: { platformAdmin?: boolean } = {}): Promise<Set<string>> {
  const out = new Set<string>();
  const wanted = [...new Set(ids.filter(isUuid))];
  if (opts.platformAdmin || wanted.length === 0) return out;
  const source = new Map<string, string>();
  if (isUuid(orgId)) {
    for (let i = 0; i < wanted.length; i += 200) {
      const { data } = await db()
        .from("organization_players")
        .select("player_profile_id, source")
        .eq("organization_id", orgId)
        .in("player_profile_id", wanted.slice(i, i + 200));
      for (const r of (data ?? []) as { player_profile_id: string; source: string }[]) source.set(r.player_profile_id, r.source);
    }
  }
  const candidates = wanted.filter((id) => !source.has(id) || source.get(id) === "matched");
  for (let i = 0; i < candidates.length; i += 200) {
    let q = db().from("organization_players").select("player_profile_id").in("player_profile_id", candidates.slice(i, i + 200));
    if (isUuid(orgId)) q = q.neq("organization_id", orgId);
    const { data } = await q;
    for (const r of (data ?? []) as { player_profile_id: string }[]) {
      if (personFieldsHiddenFor(source.get(r.player_profile_id), 1)) out.add(r.player_profile_id);
    }
  }
  return out;
}

/** What an organisation calls a profile it only matched, when nothing was typed on its form. */
export const UNNAMED_MATCHED = "Registered player";

/**
 * Person fields blanked out; `person_hidden` tells the page why they are empty.
 * The name too: the organisation sees the name typed on its own registration form
 * (organization_players.typed_name), never the profile's public name, so typing
 * a mobile number on a form can never turn it into the name of whose it is.
 */
export function maskPersonFields<T extends Pick<PlayerProfile, "public_name" | "mobile_normalized" | "email" | "birth_year" | "gender" | "photo_url" | "portrait_url">>(
  p: T,
  typedName?: string | null,
): T & { person_hidden: true } {
  return {
    ...p,
    public_name: typedName?.trim() || UNNAMED_MATCHED,
    mobile_normalized: null,
    email: null,
    birth_year: null,
    gender: null,
    photo_url: null,
    portrait_url: null,
    person_hidden: true,
  };
}

/**
 * The profiles among `ids` this organisation only matched by a typed mobile while
 * another organisation has them, with the name typed on its form. Everywhere the
 * organisation shows a name (its admin pages, the team names its sessions make,
 * its public session pages, rankings and screens), these show the typed name and
 * no photo. Platform admins: none.
 */
export async function matchedElsewhere(orgId: string | null | undefined, ids: string[], opts: { platformAdmin?: boolean } = {}): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = [...new Set(ids.filter(isUuid))];
  if (!isUuid(orgId) || opts.platformAdmin || wanted.length === 0) return out;
  const typed = new Map<string, string | null>();
  for (let i = 0; i < wanted.length; i += 200) {
    const { data } = await db()
      .from("organization_players")
      .select("player_profile_id, typed_name")
      .eq("organization_id", orgId)
      .eq("source", "matched")
      .in("player_profile_id", wanted.slice(i, i + 200));
    for (const r of (data ?? []) as { player_profile_id: string; typed_name: string | null }[]) typed.set(r.player_profile_id, r.typed_name);
  }
  const matched = [...typed.keys()];
  for (let i = 0; i < matched.length; i += 200) {
    const { data } = await db()
      .from("organization_players")
      .select("player_profile_id")
      .neq("organization_id", orgId)
      .in("player_profile_id", matched.slice(i, i + 200));
    for (const r of (data ?? []) as { player_profile_id: string }[]) out.set(r.player_profile_id, typed.get(r.player_profile_id)?.trim() || UNNAMED_MATCHED);
  }
  return out;
}
