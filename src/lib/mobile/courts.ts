/**
 * GET /api/mobile/v1/courts/live: everything the app's live courts hero draws,
 * in one call. The featured event and every live tournament, in the Discover
 * order Move Beyond sets (src/lib/platform/discoverOrder.ts), then the league
 * nights on now whose showcase is on (Phase 8), each with its
 * courts, the matches and ties on them, the teams with their faces, the rules,
 * the red/blue identity and the open court calls. The phone turns that into a
 * scene per court (src/lib/tv/showcase.ts), on its own clock between polls.
 *
 * Public and shared by every phone (no cookies, no headers): the CDN keeps one
 * copy. Players are read with an explicit column list, as `getTeams` does:
 * never `phone`, `email`, `access_code` or a profile's `mobile_normalized`
 * (courts.test.ts holds that, and the shape, to account).
 */
import { db } from "../supabase";
import type { Match, MatchSnapshot, Team, Tie } from "../types";
import type { MCourtsEvent, MCourtsLive, MTournamentCard } from "./contract";
import { matchDayRules } from "../matchday/rules";
import { sportOf } from "../sports/registry";
import { showcaseOn, showcaseSubset } from "../tv/showcase";
import { resolvePortrait } from "../portrait";
import { profilesWithoutPhoto } from "../data";
import { memo } from "./http";
import { isPublicLeagueSession, leagueSessionTournamentIds } from "../leagues/server";
import { CARD_COLUMNS, MATCH_COLUMNS, SNAPSHOT_COLUMNS, getDiscover, getFlags, plateBrackets } from "./server";
import { toCard, toCourtCall, toCourtTeam, toMatch, toSides, toStageRules, toTie, type CallRow, type TournamentRow } from "./projection";

/** At most this many tournaments on the hero (a busy weekend has a handful). */
export const MAX_HERO_EVENTS = 12;

/** The public player columns, and the photo fields of a linked profile. Nothing else. */
export const COURT_TEAM_COLUMNS =
  "id, tournament_id, team_name, nation_code, iso2, team_status, players(id, team_id, player_order, full_name, photo_url, portrait_url, focal_x, focal_y, player_profile_id, player_profiles(photo_url, portrait_url, focal_x, focal_y))";
const COURT_COLUMNS = "id, tournament_id, court_name, court_order, is_active";
const TIE_COLUMNS =
  "id, tournament_id, stage, group_id, round_no, round_name, tie_order, court_id, scheduled_time, team_a_id, team_b_id, status, rubbers_a, rubbers_b, winner_team_id, places_from, places_to, lineup_locked_at";
const CALL_COLUMNS = "match_id, tournament_id, court_id, called_at, deadline_at, extensions, a_present_at, b_present_at";
const HERO_TOURNAMENT_COLUMNS = `${CARD_COLUMNS}, scoring_config`;

const EMPTY = (): MCourtsLive => ({ generatedAt: new Date().toISOString(), events: [] });

/** Featured tournaments first (in their groups' order), then the live ones, each once. */
export function heroCandidates(featured: { tournaments: MTournamentCard[] }[], live: MTournamentCard[]): { card: MTournamentCard; featured: boolean }[] {
  const seen = new Set<string>();
  const out: { card: MTournamentCard; featured: boolean }[] = [];
  for (const [list, isFeatured] of [[featured.flatMap((g) => g.tournaments), true], [live, false]] as const) {
    for (const card of list) {
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      out.push({ card, featured: isFeatured });
    }
  }
  return out;
}

type HeroRow = TournamentRow & { match_day_rules?: unknown };
type TeamRow = Pick<Team, "id" | "team_name" | "nation_code" | "iso2" | "players"> & { tournament_id: string };

async function heroTournaments(ids: string[]): Promise<HeroRow[]> {
  const query = (columns: string) => db().from("tournaments").select(columns).in("id", ids);
  let { data, error } = await query(`${HERO_TOURNAMENT_COLUMNS}, match_day_rules`);
  // Before migration 0022 there are no match-day rules: every showcase reads as off.
  if (error && /match_day_rules/.test(error.message)) ({ data, error } = await query(HERO_TOURNAMENT_COLUMNS));
  return ((error ? [] : data) ?? []) as unknown as HeroRow[];
}

async function openCalls(ids: string[]): Promise<(CallRow & { tournament_id: string })[]> {
  // match_calls arrives with migration 0022 and stays empty until the match-day engine calls a match.
  const { data, error } = await db().from("match_calls").select(CALL_COLUMNS).in("tournament_id", ids).eq("status", "called");
  return error ? [] : ((data ?? []) as unknown as (CallRow & { tournament_id: string })[]);
}

/**
 * League nights on now (Phase 8): the hidden session of a public league's night
 * (visibility 'everyone': this feed is shared by every phone) with a match on court. They follow the tournaments on the hero; each still
 * needs its own showcase switch (the league's match-day rules) to be shown.
 */
export async function liveLeagueNights(): Promise<MTournamentCard[]> {
  const nightIds = await leagueSessionTournamentIds();
  if (!nightIds.size) return [];
  const { data: onCourt } = await db().from("matches").select("tournament_id").eq("stage", "friendly").in("status", ["live", "paused"]).limit(3000);
  const live = new Map<string, number>();
  for (const r of (onCourt ?? []) as { tournament_id: string }[]) {
    if (nightIds.has(r.tournament_id)) live.set(r.tournament_id, (live.get(r.tournament_id) ?? 0) + 1);
  }
  const ids = [...live.keys()].slice(0, MAX_HERO_EVENTS * 2);
  if (!ids.length) return [];
  const [{ data: rows }, { data: teams }] = await Promise.all([
    db().from("tournaments").select(CARD_COLUMNS).in("id", ids).eq("kind", "friendly_session").eq("status", "active").eq("public_access_enabled", true),
    db().from("teams").select("tournament_id").in("tournament_id", ids),
  ]);
  const teamCount = new Map<string, number>();
  for (const r of (teams ?? []) as { tournament_id: string }[]) teamCount.set(r.tournament_id, (teamCount.get(r.tournament_id) ?? 0) + 1);
  const cards: MTournamentCard[] = [];
  for (const r of (rows ?? []) as unknown as TournamentRow[]) {
    if (await isPublicLeagueSession(r.id)) cards.push(toCard(r, live.get(r.id) ?? 0, teamCount.get(r.id) ?? 0));
  }
  return cards.sort((a, b) => b.liveCount - a.liveCount || a.name.localeCompare(b.name));
}

export function getCourtsLive(includeDemo: boolean): Promise<MCourtsLive> {
  return memo(`courts:${includeDemo}`, 1_500, async () => {
    const flags = await getFlags();
    if (flags.live_courts === false) return EMPTY();
    const discover = await getDiscover(includeDemo);
    // Tournaments in the Discover order, then league nights on now.
    const candidates = heroCandidates(discover.featured, [...discover.live, ...(await liveLeagueNights())]).filter(
      ({ card }) => card.status === "active" && sportOf(card.sport).supports.showcase,
    );
    if (!candidates.length) return EMPTY();

    const now = Date.now();
    const rows = new Map((await heroTournaments(candidates.map((c) => c.card.id))).map((r) => [r.id, r]));
    const eligible = candidates
      .filter(({ card }) => {
        const row = rows.get(card.id);
        return Boolean(row) && showcaseOn(row!, matchDayRules(row!.match_day_rules, row!), card.liveCount, now);
      })
      .slice(0, MAX_HERO_EVENTS);
    if (!eligible.length) return EMPTY();
    const ids = eligible.map((e) => e.card.id);
    const tieIds = eligible.filter((e) => Boolean(rows.get(e.card.id)?.format_config?.ties)).map((e) => e.card.id);
    const cutoff = new Date(now - 6 * 60_000).toISOString();

    const [courtsRes, onCourt, justDone, rubbers, tiesRes, teamsRes, calls, plate] = await Promise.all([
      db().from("courts").select(COURT_COLUMNS).in("tournament_id", ids).eq("is_active", true).order("court_order"),
      // In play and waiting; finished in the last few minutes; every rubber of a tie (for tie scores).
      db().from("matches").select(MATCH_COLUMNS).in("tournament_id", ids).in("status", ["scheduled", "ready", "live", "paused", "pending_sync"]).limit(3000),
      db().from("matches").select(MATCH_COLUMNS).in("tournament_id", ids).in("status", ["completed", "walkover", "retired", "disqualified"]).gte("ended_at", cutoff).limit(500),
      tieIds.length ? db().from("matches").select(MATCH_COLUMNS).in("tournament_id", tieIds).not("tie_id", "is", null).neq("status", "cancelled").limit(3000) : Promise.resolve({ data: [] }),
      tieIds.length ? db().from("ties").select(TIE_COLUMNS).in("tournament_id", tieIds).not("court_id", "is", null).order("tie_order") : Promise.resolve({ data: [] }),
      db().from("teams").select(COURT_TEAM_COLUMNS).in("tournament_id", ids),
      openCalls(ids),
      plateBrackets(ids),
    ]);

    const courtsOf = groupBy((courtsRes.data ?? []) as { id: string; tournament_id: string; court_name: string; court_order: number }[]);
    const byId = new Map<string, Match & { tournament_id: string }>();
    for (const res of [onCourt, justDone, rubbers]) for (const m of (res.data ?? []) as unknown as (Match & { tournament_id: string })[]) byId.set(m.id, m);
    const matchesOf = groupBy([...byId.values()].sort((a, b) => a.match_order - b.match_order));
    const tiesOf = groupBy((tiesRes.data ?? []) as unknown as (Tie & { tournament_id: string })[]);
    const teamsOf = groupBy((teamsRes.data ?? []) as unknown as TeamRow[]);
    // Per event: the linked profiles its organisation may not show a photo of (src/lib/orgs/personFields.ts).
    const noPhoto = new Map<string, Set<string>>();
    await Promise.all(
      ids.map(async (tid) => {
        const profileIds = (teamsOf.get(tid) ?? []).flatMap((tm) => (tm.players ?? []).map((pl) => pl.player_profile_id));
        noPhoto.set(tid, await profilesWithoutPhoto(tid, profileIds));
      }),
    );
    const callsOf = groupBy(calls);

    // What each event's cards need, then the scores of just those matches.
    const plans = eligible.map(({ card, featured }) => {
      const t = rows.get(card.id)!;
      const courts = (courtsOf.get(card.id) ?? []).map((c) => ({ id: c.id, name: c.court_name, order: c.court_order }));
      const ties = (tiesOf.get(card.id) ?? []).map(toTie);
      const lean = (matchesOf.get(card.id) ?? []).map((m) => toMatch(m, null));
      const eventCalls = (callsOf.get(card.id) ?? []).map(toCourtCall);
      const subset = showcaseSubset(
        courts.map((c) => c.id),
        ties,
        lean,
        eventCalls,
        now,
      );
      return { card, featured, t, courts, ties, subset, calls: eventCalls };
    });
    const wanted = plans.flatMap((p) => [...p.subset.matchIds]);
    const snaps = wanted.length ? await db().from("match_score_snapshots").select(SNAPSHOT_COLUMNS).in("match_id", wanted) : { data: [] };
    const snapOf = new Map(((snaps.data ?? []) as unknown as MatchSnapshot[]).map((s) => [s.match_id, s]));

    const events: MCourtsEvent[] = [];
    for (const p of plans) {
      const matches = (matchesOf.get(p.card.id) ?? []).filter((m) => p.subset.matchIds.has(m.id)).map((m) => toMatch(m, snapOf.get(m.id) ?? null));
      const ties = p.ties.filter((x) => p.subset.tieIds.has(x.id));
      if (!matches.length && !ties.length) continue;
      const teamIds = new Set([...matches.flatMap((m) => [m.a, m.b]), ...ties.flatMap((x) => [x.a, x.b])].filter(Boolean) as string[]);
      const showPhotos = p.t.app_skin?.showPhotos === true;
      const card = toCard(p.t, p.card.liveCount, p.card.teamCount);
      const matchIds = new Set(matches.map((m) => m.id));
      events.push({
        tournament: {
          id: card.id,
          slug: card.slug,
          name: card.name,
          sport: card.sport,
          timezone: card.timezone,
          eventGroupId: card.eventGroupId,
          isTies: Boolean(p.t.format_config?.ties),
          showPhotos,
          featured: p.featured,
          // Discover's card already carries the organisation's branding defaults.
          skin: p.card.skin ?? card.skin,
          imAtCourt: (() => {
            const md = matchDayRules(p.t.match_day_rules, p.t);
            return md.courtCall.on && md.extras.imAtCourt;
          })(),
        },
        rules: toStageRules(p.t, plate.get(p.card.id) ?? []),
        sides: toSides(p.t.branding_config),
        courts: p.courts,
        teams: (teamsOf.get(p.card.id) ?? []).filter((tm) => teamIds.has(tm.id)).map((tm) => toCourtTeam(withProfilePhotos(tm, noPhoto.get(p.card.id)), showPhotos)),
        ties,
        matches,
        calls: p.calls.filter((c) => matchIds.has(c.matchId)),
      });
    }
    return { generatedAt: new Date().toISOString(), events };
  });
}

/** A linked profile's photo wins field by field (src/lib/portrait.ts); the embed itself is dropped. */
function withProfilePhotos(t: TeamRow, hidden?: Set<string>): TeamRow {
  return {
    ...t,
    players: (t.players ?? []).map((p) => {
      const { player_profiles: linked, ...row } = p as typeof p & { player_profiles?: Parameters<typeof resolvePortrait>[1] };
      // A profile the event's organisation does not vouch for lends it no photo.
      const profile = row.player_profile_id && hidden?.has(row.player_profile_id) ? null : linked;
      const r = resolvePortrait(row, profile);
      return { ...row, photo_url: r.photoUrl, portrait_url: r.portraitUrl, focal_x: r.focalX, focal_y: r.focalY };
    }),
  };
}

function groupBy<T extends { tournament_id: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) out.set(r.tournament_id, [...(out.get(r.tournament_id) ?? []), r]);
  return out;
}
