/**
 * GET /me/profile: the signed-in player's own history (Phase 1). Server-only.
 *
 * Tournaments come from the rows the account holds (player_claims), with the
 * organisation and the player's record in each; sessions and nights from the
 * player's profile (the friendly ledger); results and upcoming matches as on
 * /me/player. Leagues, league points and ranks arrive with leagues (Phase 7) and
 * are listed in `comingSoon` until then: never sample data.
 *
 * Only the account's own data: its profile's own mobile (and whether it was
 * confirmed with a one-time code), never another person's fields.
 */
import { db } from "../supabase";
import { sizedImageSrc } from "../portrait";
import { isDoneStatus, type MMyProfile, type MProfileSession, type MProfileTournament } from "../mobile/contract";
import { claimedRows, loadMyPlayer } from "./claims";
import { accountProfile, orgShares, orgsOfTournaments, syncProfileClaims } from "./link";

export async function loadMyProfile(userId: string): Promise<MMyProfile> {
  await syncProfileClaims(userId);
  const [profile, player, rows, orgs] = await Promise.all([accountProfile(userId), loadMyPlayer(userId), claimedRows(userId), orgShares(userId)]);
  const { data: extra } = profile
    ? await db().from("player_profiles").select("photo_url, portrait_url, phone_verified_at").eq("id", profile.id).maybeSingle()
    : { data: null };
  const ex = extra as { photo_url: string | null; portrait_url: string | null; phone_verified_at: string | null } | null;

  // Tournaments: one per tournament the account holds a row in, newest first.
  const orgOf = await orgsOfTournaments(rows.map((r) => r.tournament_id));
  const orgIds = [...new Set(orgOf.values())];
  const { data: orgRows } = orgIds.length ? await db().from("organizations").select("id, slug, name").in("id", orgIds) : { data: [] };
  const orgById = new Map(((orgRows ?? []) as { id: string; slug: string; name: string }[]).map((o) => [o.id, o]));
  const matches = player?.matches ?? [];
  const tournaments: MProfileTournament[] = (player?.entries ?? []).map((e) => {
    const org = orgById.get(orgOf.get(e.tournamentId) ?? "");
    const mine = matches.filter((m) => m.tournamentSlug === e.tournamentSlug);
    const done = mine.filter((m) => isDoneStatus(m.status));
    return {
      tournamentId: e.tournamentId,
      slug: e.tournamentSlug,
      name: e.tournamentName,
      sport: e.sport,
      teamName: e.teamName,
      organization: org ? { slug: org.slug, name: org.name } : null,
      played: done.length,
      won: done.filter((m) => m.mySide && m.winner && m.winner === (m.mySide === "A" ? m.a : m.b)).length,
    };
  });

  // Sessions and nights: the friendly ledger of the profile.
  let sessions: MProfileSession[] = [];
  if (profile) {
    const { data: ledger } = await db().from("player_score_ledger").select("session_id, match_id, component, points").eq("player_profile_id", profile.id).not("session_id", "is", null).limit(5000);
    const bySession = new Map<string, { matches: Set<string>; points: number }>();
    for (const l of (ledger ?? []) as { session_id: string; match_id: string; component: string; points: number }[]) {
      const s = bySession.get(l.session_id) ?? { matches: new Set<string>(), points: 0 };
      if (l.component === "base_win" || l.component === "games") s.matches.add(l.match_id);
      s.points += l.points;
      bySession.set(l.session_id, s);
    }
    const ids = [...bySession.keys()];
    if (ids.length) {
      const { data: ss } = await db().from("friendly_sessions").select("id, slug, name, starts_at, created_at, tournament_id").in("id", ids.slice(0, 500));
      const list = (ss ?? []) as { id: string; slug: string; name: string; starts_at: string | null; created_at: string; tournament_id: string }[];
      const sOrg = await orgsOfTournaments(list.map((x) => x.tournament_id));
      const missing = [...new Set([...sOrg.values()].filter((id) => !orgById.has(id)))];
      if (missing.length) {
        const { data } = await db().from("organizations").select("id, slug, name").in("id", missing);
        for (const o of (data ?? []) as { id: string; slug: string; name: string }[]) orgById.set(o.id, o);
      }
      sessions = list
        .map((x) => {
          const org = orgById.get(sOrg.get(x.tournament_id) ?? "");
          return {
            sessionId: x.id,
            slug: x.slug,
            name: x.name,
            date: x.starts_at ?? x.created_at,
            organization: org ? { slug: org.slug, name: org.name } : null,
            played: bySession.get(x.id)!.matches.size,
            points: bySession.get(x.id)!.points,
          };
        })
        .sort((a, b) => b.date.localeCompare(a.date));
    }
  }

  const photo = ex?.photo_url || ex?.portrait_url ? sizedImageSrc(ex?.photo_url || ex?.portrait_url, 512) : (player?.photoUrl ?? null);
  const results = matches.filter((m) => isDoneStatus(m.status));
  return {
    linked: Boolean(profile) || Boolean(player),
    name: player?.name ?? profile?.public_name ?? null,
    photoUrl: photo,
    phone: profile?.mobile_normalized && /^\+\d{8,15}$/.test(profile.mobile_normalized) ? profile.mobile_normalized : (player?.phone ?? null),
    phoneVerified: Boolean(ex?.phone_verified_at),
    tournaments,
    sessions,
    upcoming: matches.filter((m) => !isDoneStatus(m.status)),
    results,
    totals: {
      tournaments: tournaments.length,
      sessions: sessions.length,
      played: results.length + sessions.reduce((n, s) => n + s.played, 0),
      won: tournaments.reduce((n, t) => n + t.won, 0),
    },
    organizations: orgs.map((o) => ({ id: o.organizationId, slug: o.slug, name: o.name, sharing: o.sharing, canShare: o.canShare })),
    comingSoon: ["leagues", "points", "ranks"],
  };
}
