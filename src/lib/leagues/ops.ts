/**
 * League mutations for the admin console (Phase 7): leagues, divisions,
 * members, invite codes, nights from the night template, season fixtures and
 * tournaments counting toward a division.
 *
 * Callers resolve the organisation from the row first (src/lib/guard.ts with
 * { league }, { division }, { leagueMember }, { fixture }); these functions
 * trust the ids they are given. The database refuses a division, session or
 * tournament of another organisation regardless (migration 0025 triggers).
 *
 * Server-only.
 */
import { randomBytes } from "node:crypto";
import { db } from "../supabase";
import { audit } from "../audit";
import { createFriendlySession } from "../friendly/ops";
import { matchedElsewhere } from "../orgs/personFields";
import { ensureOrgPlayer } from "../orgs/scope";
import { zonedToIso } from "../tennis/ties";
import { newTournamentMatchDayRules } from "../matchday/rules";
import { formatLeagueInviteCode, generateLeagueInviteCode, hashLeagueInviteCode } from "./inviteCode";
import { statusAfterApproval, normalizeJoinModes } from "./join";
import { isPlayedStatus, pairingKey, seasonEntrants, seasonPlan, type SeasonEntrant } from "./fixtures";
import { dayLabel, isIsoDate, leagueFee, leagueSlug, nightTemplate } from "./settings";
import {
  getDivisions,
  getFixtures,
  getLeague,
  getMembers,
  leaguePaymentsEnabled,
  recomputeLeague,
  todayIn,
  type DivisionRow,
  type LeagueRow,
  type MemberRow,
} from "./server";

/* ---------------- leagues ---------------- */

export async function createLeague(input: {
  organizationId: string;
  name: string;
  kind: "nights" | "season";
  sport: string;
  timezone?: string;
  createdBy?: string | null;
  actorRole: string;
}): Promise<LeagueRow> {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new Error("Give the league a name.");
  const { data, error } = await db()
    .from("leagues")
    .insert({
      organization_id: input.organizationId,
      slug: leagueSlug(name, randomBytes(4).toString("hex").slice(0, 5)),
      name,
      kind: input.kind,
      sport: input.sport,
      timezone: input.timezone || "Africa/Cairo",
      // Its nights and season sessions run on match-day rules: a new league starts with
      // the same defaults a new tournament gets.
      match_day_rules: newTournamentMatchDayRules(input.sport),
      created_by: input.createdBy ?? null,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Could not create the league.");
  const id = (data as { id: string }).id;
  await db().from("league_divisions").insert({ league_id: id, name: "Division 1", sort_order: 1 });
  await audit({ organization_id: input.organizationId, actor_role: input.actorRole, action: "LEAGUE_CREATED", entity_type: "league", entity_id: id, new_value: { name, kind: input.kind } });
  return (await getLeague(id))!;
}

/** Saves league fields (already sanitised by the caller). Points-affecting changes recompute. */
export async function updateLeague(leagueId: string, patch: Record<string, unknown>, actorRole: string): Promise<void> {
  const before = await getLeague(leagueId);
  if (!before) throw new Error("League not found.");
  const { error } = await db()
    .from("leagues")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", leagueId);
  if (error) throw new Error(error.message);
  await audit({ organization_id: before.organization_id, actor_role: actorRole, action: "LEAGUE_UPDATED", entity_type: "league", entity_id: leagueId, new_value: { fields: Object.keys(patch) } });
  if ("points_rules" in patch || "timezone" in patch) await recomputeLeague(leagueId);
}

/** A fresh invite code: returned once (formatted), only its hash is stored. Never audited in clear. */
export async function resetInviteCode(leagueId: string, actorRole: string): Promise<string> {
  const league = await getLeague(leagueId);
  if (!league) throw new Error("League not found.");
  const code = generateLeagueInviteCode();
  const hash = hashLeagueInviteCode(code);
  if (!hash) throw new Error("Could not make a code.");
  await db().from("leagues").update({ invite_code_hash: hash, invite_code_set_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", leagueId);
  await audit({ organization_id: league.organization_id, actor_role: actorRole, action: "LEAGUE_INVITE_CODE_SET", entity_type: "league", entity_id: leagueId });
  return formatLeagueInviteCode(code);
}

export async function clearInviteCode(leagueId: string, actorRole: string): Promise<void> {
  const league = await getLeague(leagueId);
  if (!league) return;
  await db().from("leagues").update({ invite_code_hash: null, invite_code_set_at: null, updated_at: new Date().toISOString() }).eq("id", leagueId);
  await audit({ organization_id: league.organization_id, actor_role: actorRole, action: "LEAGUE_INVITE_CODE_CLEARED", entity_type: "league", entity_id: leagueId });
}

/* ---------------- divisions ---------------- */

export async function addDivision(leagueId: string, name: string, actorRole: string): Promise<void> {
  const league = await getLeague(leagueId);
  if (!league) throw new Error("League not found.");
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new Error("Name the division.");
  const divisions = await getDivisions(leagueId);
  if (divisions.some((d) => d.name.toLowerCase() === clean.toLowerCase())) throw new Error("A division already has that name.");
  const { error } = await db().from("league_divisions").insert({ league_id: leagueId, name: clean, sort_order: divisions.length + 1 });
  if (error) throw new Error(error.message);
  await audit({ organization_id: league.organization_id, actor_role: actorRole, action: "LEAGUE_DIVISION_ADDED", entity_type: "league", entity_id: leagueId, new_value: { name: clean } });
}

export async function renameDivision(divisionId: string, name: string, actorRole: string): Promise<void> {
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new Error("Name the division.");
  const { data } = await db().from("league_divisions").select("league_id").eq("id", divisionId).maybeSingle();
  if (!data) throw new Error("Division not found.");
  const { error } = await db().from("league_divisions").update({ name: clean }).eq("id", divisionId);
  if (error) throw new Error(/duplicate|unique/i.test(error.message) ? "A division already has that name." : error.message);
  await audit({ actor_role: actorRole, action: "LEAGUE_DIVISION_RENAMED", entity_type: "league", entity_id: (data as { league_id: string }).league_id, new_value: { name: clean } });
}

/** Removes a division that has no nights, fixtures or tournaments yet (its members keep their place, without a division). */
export async function deleteDivision(divisionId: string, actorRole: string): Promise<void> {
  const { data } = await db().from("league_divisions").select("id, league_id").eq("id", divisionId).maybeSingle();
  if (!data) throw new Error("Division not found.");
  const leagueId = (data as { league_id: string }).league_id;
  const { count } = await db().from("league_fixtures").select("id", { count: "exact", head: true }).eq("division_id", divisionId);
  if ((count ?? 0) > 0) throw new Error("This division has nights or fixtures. Remove those first.");
  const divisions = await getDivisions(leagueId);
  if (divisions.length <= 1) throw new Error("A league keeps at least one division.");
  await db().from("league_divisions").delete().eq("id", divisionId);
  await audit({ actor_role: actorRole, action: "LEAGUE_DIVISION_REMOVED", entity_type: "league", entity_id: leagueId });
}

/* ---------------- members ---------------- */

export type MemberDecision = "approve" | "remove" | "restore" | "paid";

/** The organiser approves, removes or restores a member, or records that they paid at the venue. */
export async function decideMember(memberId: string, decision: MemberDecision, actor: { role: string; userId?: string | null }): Promise<MemberRow> {
  const { data } = await db().from("league_members").select("*").eq("id", memberId).maybeSingle();
  const m = data as MemberRow | null;
  if (!m) throw new Error("Member not found.");
  const league = await getLeague(m.league_id);
  if (!league) throw new Error("League not found.");
  const { data: o } = await db().from("organizations").select("slug").eq("id", league.organization_id).maybeSingle();
  const fee = leagueFee(league.fee);
  const join = { joinModes: normalizeJoinModes(league.join_modes), membershipFee: fee.membership, paymentsEnabled: leaguePaymentsEnabled((o as { slug: string } | null)?.slug) };
  let patch: Record<string, unknown>;
  switch (decision) {
    case "approve":
    case "restore": {
      const status = statusAfterApproval(join);
      const paidMode = join.joinModes.includes("paid") && fee.membership !== null;
      patch = { status, pay_at_venue: paidMode && !join.paymentsEnabled };
      break;
    }
    case "remove":
      patch = { status: "removed" };
      break;
    case "paid":
      patch = { pay_at_venue: false, paid_until: todayIn(league.timezone).slice(0, 4) + "-12-31" };
      break;
  }
  await db()
    .from("league_members")
    .update({ ...patch, decided_at: new Date().toISOString(), decided_by: actor.userId ?? null, updated_at: new Date().toISOString() })
    .eq("id", memberId);
  if (decision === "approve" || decision === "restore") await ensureOrgPlayer(league.organization_id, m.player_profile_id, "league", "approved");
  await audit({ organization_id: league.organization_id, actor_role: actor.role, action: `LEAGUE_MEMBER_${decision.toUpperCase()}`, entity_type: "league_member", entity_id: memberId, new_value: patch });
  return { ...m, ...(patch as Partial<MemberRow>) };
}

export async function setMemberDivision(memberId: string, divisionId: string | null, actorRole: string): Promise<void> {
  const { data } = await db().from("league_members").select("league_id").eq("id", memberId).maybeSingle();
  if (!data) throw new Error("Member not found.");
  const { error } = await db().from("league_members").update({ division_id: divisionId, updated_at: new Date().toISOString() }).eq("id", memberId);
  if (error) throw new Error(/division/i.test(error.message) ? "That division is not part of this league." : error.message);
  await audit({ actor_role: actorRole, action: "LEAGUE_MEMBER_DIVISION", entity_type: "league_member", entity_id: memberId, new_value: { division_id: divisionId } });
}

export async function setMemberPartner(memberId: string, partnerProfileId: string | null, actorRole: string): Promise<void> {
  await db().from("league_members").update({ partner_profile_id: partnerProfileId, updated_at: new Date().toISOString() }).eq("id", memberId);
  await audit({ actor_role: actorRole, action: "LEAGUE_MEMBER_PARTNER", entity_type: "league_member", entity_id: memberId, new_value: { partner: Boolean(partnerProfileId) } });
}

/** The organiser adds one of the organisation's players (active at once). */
export async function addMember(leagueId: string, profileId: string, divisionId: string | null, actorRole: string): Promise<void> {
  const league = await getLeague(leagueId);
  if (!league) throw new Error("League not found.");
  const { data: existing } = await db().from("league_members").select("id").eq("league_id", leagueId).eq("player_profile_id", profileId).maybeSingle();
  const row = { league_id: leagueId, player_profile_id: profileId, division_id: divisionId, status: "active", source: "admin", updated_at: new Date().toISOString() };
  const { error } = existing
    ? await db().from("league_members").update(row).eq("id", (existing as { id: string }).id)
    : await db().from("league_members").insert(row);
  if (error) throw new Error(error.message);
  await audit({ organization_id: league.organization_id, actor_role: actorRole, action: "LEAGUE_MEMBER_ADDED", entity_type: "league", entity_id: leagueId, new_value: { division_id: divisionId } });
}

/* ---------------- nights ---------------- */

/** Display names for profiles, as this organisation may show them (src/lib/orgs/personFields.ts). */
async function namesFor(orgId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const names = new Map<string, string>();
  for (let i = 0; i < unique.length; i += 200) {
    const { data } = await db().from("player_profiles").select("id, public_name").in("id", unique.slice(i, i + 200));
    for (const p of (data ?? []) as { id: string; public_name: string }[]) names.set(p.id, p.public_name);
  }
  for (const [id, typed] of await matchedElsewhere(orgId, unique)) names.set(id, typed);
  return names;
}

/** The hidden tournament of a league session: the league's sport, match-day rules, day and a clean name. */
async function dressSessionTournament(tournamentId: string, league: LeagueRow, name: string, date: string | null): Promise<void> {
  const rules =
    league.match_day_rules && typeof league.match_day_rules === "object" && Object.keys(league.match_day_rules as object).length
      ? league.match_day_rules
      : newTournamentMatchDayRules(league.sport);
  await db()
    .from("tournaments")
    .update({
      name,
      sport: league.sport,
      timezone: league.timezone,
      ...(date ? { starts_on: date, ends_on: date } : {}),
      match_day_rules: rules,
      updated_at: new Date().toISOString(),
    })
    .eq("id", tournamentId);
}

/**
 * A night: a new friendly session made from the league's night template, on a
 * date, in a division. The division's active members are entered (approved), so
 * the organiser can build the night's table straight away.
 */
export async function createNight(divisionId: string, date: string, actorRole: string): Promise<{ sessionId: string; slug: string }> {
  if (!isIsoDate(date)) throw new Error("Pick the night's date.");
  const { data: d } = await db().from("league_divisions").select("id, league_id, name").eq("id", divisionId).maybeSingle();
  const division = d as DivisionRow | null;
  if (!division) throw new Error("Division not found.");
  const league = (await getLeague(division.league_id))!;
  const fixtures = await getFixtures(league.id);
  if (fixtures.some((f) => f.kind === "night" && f.division_id === divisionId && f.date === date)) throw new Error("This division already has a night on that date.");
  const tpl = nightTemplate(league.night_template);
  const divisions = await getDivisions(league.id);
  const name = `${league.name}${divisions.length > 1 ? ` · ${division.name}` : ""} · ${dayLabel(date)}`;
  const session = await createFriendlySession({
    name,
    seasonId: null,
    startsAt: zonedToIso(`${date}T${tpl.startTime}`, league.timezone),
    durationMinutes: tpl.durationMinutes,
    registrationMode: "individual",
    scoringMode: tpl.scoringMode,
    courtCount: tpl.courts,
    pairingMode: tpl.pairingMode,
    rankingModel: tpl.rankingModel,
    setsToWinMatch: tpl.setsToWinMatch,
    gamesToWinSet: tpl.gamesToWinSet,
    maxPlayers: tpl.maxPlayers,
    registrationDeadline: null,
    organizationId: league.organization_id,
    actorRole,
  });
  const sessionId = (session as { id: string }).id;
  const tournamentId = (session as { tournament_id: string }).tournament_id;
  await dressSessionTournament(tournamentId, league, name, date);
  const { error } = await db().from("league_fixtures").insert({ league_id: league.id, division_id: divisionId, kind: "night", session_id: sessionId, date });
  if (error) throw new Error(error.message);
  const members = (await getMembers(league.id)).filter((m) => m.status === "active" && m.division_id === divisionId);
  if (members.length) {
    await db()
      .from("friendly_entries")
      .upsert(
        members.map((m) => ({ session_id: sessionId, player_profile_id: m.player_profile_id, source: "admin", approval: "approved" })),
        { onConflict: "session_id,player_profile_id", ignoreDuplicates: true },
      );
  }
  await db().from("friendly_sessions").update({ status: "open", updated_at: new Date().toISOString() }).eq("id", sessionId);
  await audit({ organization_id: league.organization_id, actor_role: actorRole, action: "LEAGUE_NIGHT_CREATED", entity_type: "league", entity_id: league.id, new_value: { date, division_id: divisionId, session_id: sessionId, entries: members.length } });
  const { data: t } = await db().from("tournaments").select("slug").eq("id", tournamentId).maybeSingle();
  return { sessionId, slug: (t as { slug: string } | null)?.slug ?? "" };
}

/** Moves a night or fixture to another date (its results then count in that date's month). */
export async function setFixtureDate(fixtureId: string, date: string, actorRole: string): Promise<void> {
  if (!isIsoDate(date)) throw new Error("Pick a date.");
  const { data } = await db().from("league_fixtures").select("id, league_id, kind, session_id, match_id").eq("id", fixtureId).maybeSingle();
  const f = data as { id: string; league_id: string; kind: string; session_id: string | null; match_id: string | null } | null;
  if (!f) throw new Error("Fixture not found.");
  const league = (await getLeague(f.league_id))!;
  await db().from("league_fixtures").update({ date, updated_at: new Date().toISOString() }).eq("id", fixtureId);
  const tpl = nightTemplate(league.night_template);
  if (f.kind === "match" && f.match_id) {
    await db().from("matches").update({ scheduled_time: zonedToIso(`${date}T${tpl.startTime}`, league.timezone) }).eq("id", f.match_id).in("status", ["scheduled", "ready"]);
  }
  if (f.kind === "night" && f.session_id) {
    const { data: s } = await db().from("friendly_sessions").select("tournament_id").eq("id", f.session_id).maybeSingle();
    await db().from("friendly_sessions").update({ starts_at: zonedToIso(`${date}T${tpl.startTime}`, league.timezone) }).eq("id", f.session_id);
    if (s) await db().from("tournaments").update({ starts_on: date, ends_on: date }).eq("id", (s as { tournament_id: string }).tournament_id);
  }
  await audit({ organization_id: league.organization_id, actor_role: actorRole, action: "LEAGUE_FIXTURE_DATE", entity_type: "league", entity_id: league.id, new_value: { fixture_id: fixtureId, date } });
  await recomputeLeague(league.id);
}

/* ---------------- season fixtures ---------------- */

async function ensureSeasonSession(league: LeagueRow, division: DivisionRow, actorRole: string): Promise<{ sessionId: string; tournamentId: string }> {
  if (division.season_session_id) {
    const { data } = await db().from("friendly_sessions").select("id, tournament_id").eq("id", division.season_session_id).maybeSingle();
    if (data) return { sessionId: (data as { id: string }).id, tournamentId: (data as { tournament_id: string }).tournament_id };
  }
  const tpl = nightTemplate(league.night_template);
  const divisions = await getDivisions(league.id);
  const name = `${league.name}${divisions.length > 1 ? ` · ${division.name}` : ""} · Season`;
  const session = await createFriendlySession({
    name,
    seasonId: null,
    startsAt: null,
    durationMinutes: null,
    registrationMode: "individual",
    scoringMode: tpl.scoringMode,
    courtCount: tpl.courts,
    pairingMode: "fixed",
    rankingModel: "win_points",
    setsToWinMatch: tpl.setsToWinMatch,
    gamesToWinSet: tpl.gamesToWinSet,
    maxPlayers: null,
    registrationDeadline: null,
    organizationId: league.organization_id,
    actorRole,
  });
  const sessionId = (session as { id: string }).id;
  const tournamentId = (session as { tournament_id: string }).tournament_id;
  await dressSessionTournament(tournamentId, league, name, null);
  await db().from("friendly_sessions").update({ status: "scheduled", updated_at: new Date().toISOString() }).eq("id", sessionId);
  await db().from("league_divisions").update({ season_session_id: sessionId }).eq("id", division.id);
  return { sessionId, tournamentId };
}

/** The team (and pair) an entrant plays as in the season session, made on first use. */
async function entrantTeam(
  sessionId: string,
  tournamentId: string,
  e: SeasonEntrant,
  names: Map<string, string>,
  cache: Map<string, { teamId: string; pairId: string }>,
): Promise<{ teamId: string; pairId: string }> {
  const key = [...e.profiles].sort().join("|");
  const hit = cache.get(key);
  if (hit) return hit;
  const { data: pairs } = await db().from("friendly_pairs").select("id, team_id, player_one_profile_id, player_two_profile_id").eq("session_id", sessionId);
  const found = ((pairs ?? []) as { id: string; team_id: string; player_one_profile_id: string; player_two_profile_id: string | null }[]).find(
    (p) => [p.player_one_profile_id, p.player_two_profile_id].filter(Boolean).sort().join("|") === key,
  );
  if (found) {
    const r = { teamId: found.team_id, pairId: found.id };
    cache.set(key, r);
    return r;
  }
  const label = e.profiles.map((p) => names.get(p) ?? "Player").join(" & ");
  const { data: team, error } = await db().from("teams").insert({ tournament_id: tournamentId, team_name: label }).select("id").single();
  if (error || !team) throw new Error(error?.message ?? "team");
  const teamId = (team as { id: string }).id;
  await db().from("players").insert(e.profiles.map((p, i) => ({ tournament_id: tournamentId, team_id: teamId, player_order: i + 1, full_name: names.get(p) ?? "Player", player_profile_id: p })));
  const { data: pair, error: pe } = await db()
    .from("friendly_pairs")
    .insert({ session_id: sessionId, team_id: teamId, player_one_profile_id: e.profiles[0], player_two_profile_id: e.profiles[1] ?? null, label })
    .select("id")
    .single();
  if (pe || !pair) throw new Error(pe?.message ?? "pair");
  const r = { teamId, pairId: (pair as { id: string }).id };
  cache.set(key, r);
  return r;
}

export interface FixturesOutcome {
  created: number;
  removed: number;
  kept: number;
  rounds: number;
}

/**
 * (Re)generates a season division's fixtures: a dated round robin of its active
 * members. Fixtures already played (or under way) are kept; every unplayed one is
 * removed and the pairings still to play are planned again on `dates` (round n on
 * the n-th date, then weekly).
 */
export async function generateSeasonFixtures(divisionId: string, dates: string[], actorRole: string): Promise<FixturesOutcome> {
  const { data: d } = await db().from("league_divisions").select("id, league_id, name, sort_order, season_session_id").eq("id", divisionId).maybeSingle();
  const division = d as DivisionRow | null;
  if (!division) throw new Error("Division not found.");
  const league = (await getLeague(division.league_id))!;
  if (league.kind !== "season") throw new Error("Fixtures are for season leagues. Nights leagues add nights instead.");
  const members = (await getMembers(league.id)).filter((m) => m.status === "active" && m.division_id === divisionId);
  const entrants = seasonEntrants(members.map((m) => ({ id: m.id, profileId: m.player_profile_id, partnerProfileId: m.partner_profile_id })));
  if (entrants.length < 2) throw new Error("A division needs at least two active members (or pairs) for fixtures.");

  const { sessionId, tournamentId } = await ensureSeasonSession(league, division, actorRole);
  const fixtures = (await getFixtures(league.id)).filter((f) => f.division_id === divisionId && f.kind === "match");
  const matchIds = fixtures.map((f) => f.match_id!).filter(Boolean);
  const statuses = new Map<string, string>();
  for (let i = 0; i < matchIds.length; i += 200) {
    const { data } = await db().from("matches").select("id, status").in("id", matchIds.slice(i, i + 200));
    for (const m of (data ?? []) as { id: string; status: string }[]) statuses.set(m.id, m.status);
  }
  const played = fixtures.filter((f) => isPlayedStatus(statuses.get(f.match_id!)));
  const unplayed = fixtures.filter((f) => !isPlayedStatus(statuses.get(f.match_id!)));
  const unplayedMatches = unplayed.map((f) => f.match_id!).filter(Boolean);
  if (unplayedMatches.length) {
    await db().from("friendly_match_participants").delete().in("match_id", unplayedMatches);
    await db().from("matches").delete().in("id", unplayedMatches).in("status", ["scheduled", "ready"]);
  }
  // Fixtures whose match is gone go with it (cascade); any left are cleared here.
  if (unplayed.length) await db().from("league_fixtures").delete().in("id", unplayed.map((f) => f.id));

  const skip = new Set(played.filter((f) => f.home_member_id && f.away_member_id).map((f) => pairingKey(f.home_member_id!, f.away_member_id!)));
  const lastRound = played.reduce((n, f) => Math.max(n, f.round ?? 0), 0);
  const today = todayIn(league.timezone);
  const plan = seasonPlan(entrants, dates.filter(isIsoDate), { skip, fallbackStart: today, firstRound: lastRound + 1 });

  const names = await namesFor(league.organization_id, entrants.flatMap((e) => e.profiles));
  const tpl = nightTemplate(league.night_template);
  const { count: existingCount } = await db().from("matches").select("id", { count: "exact", head: true }).eq("tournament_id", tournamentId);
  let order = (existingCount ?? 0) + 1;
  const cache = new Map<string, { teamId: string; pairId: string }>();
  for (const p of plan) {
    const a = await entrantTeam(sessionId, tournamentId, p.home, names, cache);
    const b = await entrantTeam(sessionId, tournamentId, p.away, names, cache);
    const { data: m, error } = await db()
      .from("matches")
      .insert({
        tournament_id: tournamentId,
        stage: "friendly",
        round_name: `R${p.round}`,
        match_order: order++,
        team_a_id: a.teamId,
        team_b_id: b.teamId,
        scheduled_time: zonedToIso(`${p.date}T${tpl.startTime}`, league.timezone),
        status: "scheduled",
      })
      .select("id")
      .single();
    if (error || !m) throw new Error(error?.message ?? "match");
    const matchId = (m as { id: string }).id;
    await db().from("friendly_match_participants").insert({
      match_id: matchId,
      session_id: sessionId,
      pair_a_id: a.pairId,
      pair_b_id: b.pairId,
      team_a_player_one: p.home.profiles[0],
      team_a_player_two: p.home.profiles[1] ?? null,
      team_b_player_one: p.away.profiles[0],
      team_b_player_two: p.away.profiles[1] ?? null,
      round_number: p.round,
    });
    const { error: fe } = await db().from("league_fixtures").insert({
      league_id: league.id,
      division_id: divisionId,
      kind: "match",
      session_id: sessionId,
      match_id: matchId,
      home_member_id: p.home.memberId,
      away_member_id: p.away.memberId,
      round: p.round,
      date: p.date,
    });
    if (fe) throw new Error(fe.message);
  }
  const rounds = new Set(plan.map((p) => p.round)).size;
  await audit({
    organization_id: league.organization_id,
    actor_role: actorRole,
    action: fixtures.length ? "LEAGUE_FIXTURES_REGENERATED" : "LEAGUE_FIXTURES_GENERATED",
    entity_type: "league",
    entity_id: league.id,
    new_value: { division_id: divisionId, created: plan.length, removed: unplayed.length, kept: played.length, rounds },
  });
  return { created: plan.length, removed: unplayed.length, kept: played.length, rounds };
}

/* ---------------- tournaments counting toward a division ---------------- */

/**
 * A tournament counts toward one division (or none). Its results count on the
 * tournament's start date (or today, when it has none). Recomputes the leagues
 * it leaves and joins.
 */
export async function setCountsToward(tournamentId: string, divisionId: string | null, actorRole: string): Promise<void> {
  const { data: t } = await db().from("tournaments").select("id, organization_id, counts_toward, starts_on").eq("id", tournamentId).maybeSingle();
  const tr = t as { id: string; organization_id: string; counts_toward: string | null; starts_on: string | null } | null;
  if (!tr) throw new Error("Tournament not found.");
  const leaguesBefore = new Set<string>();
  const { data: old } = await db().from("league_fixtures").select("league_id").eq("tournament_id", tournamentId);
  for (const r of (old ?? []) as { league_id: string }[]) leaguesBefore.add(r.league_id);
  const { error } = await db().from("tournaments").update({ counts_toward: divisionId }).eq("id", tournamentId);
  if (error) throw new Error(/own organisation/.test(error.message) ? "That league belongs to another organisation." : error.message);
  await db().from("league_fixtures").delete().eq("tournament_id", tournamentId);
  let leagueId: string | null = null;
  if (divisionId) {
    const { data: d } = await db().from("league_divisions").select("league_id").eq("id", divisionId).maybeSingle();
    leagueId = (d as { league_id: string } | null)?.league_id ?? null;
    if (leagueId) {
      const league = (await getLeague(leagueId))!;
      const { error: fe } = await db()
        .from("league_fixtures")
        .insert({ league_id: leagueId, division_id: divisionId, kind: "tournament", tournament_id: tournamentId, date: tr.starts_on ?? todayIn(league.timezone) });
      if (fe) throw new Error(fe.message);
    }
  }
  await audit({ tournament_id: tournamentId, actor_role: actorRole, action: "TOURNAMENT_COUNTS_TOWARD", entity_type: "tournament", entity_id: tournamentId, new_value: { division_id: divisionId } });
  for (const id of new Set([...leaguesBefore, ...(leagueId ? [leagueId] : [])])) await recomputeLeague(id);
}

export async function deleteNight(fixtureId: string, actorRole: string): Promise<void> {
  const { data } = await db().from("league_fixtures").select("id, league_id, kind, session_id").eq("id", fixtureId).maybeSingle();
  const f = data as { id: string; league_id: string; kind: string; session_id: string | null } | null;
  if (!f || f.kind !== "night" || !f.session_id) throw new Error("Night not found.");
  const { data: s } = await db().from("friendly_sessions").select("tournament_id").eq("id", f.session_id).maybeSingle();
  const tid = (s as { tournament_id: string } | null)?.tournament_id;
  if (tid) {
    const { count } = await db().from("matches").select("id", { count: "exact", head: true }).eq("tournament_id", tid).not("status", "in", "(scheduled,ready)");
    if ((count ?? 0) > 0) throw new Error("This night has matches played. It stays in the league's history.");
  }
  await db().from("league_fixtures").delete().eq("id", fixtureId);
  if (tid) await db().from("tournaments").delete().eq("id", tid);
  await audit({ actor_role: actorRole, action: "LEAGUE_NIGHT_REMOVED", entity_type: "league", entity_id: f.league_id });
  await recomputeLeague(f.league_id);
}
