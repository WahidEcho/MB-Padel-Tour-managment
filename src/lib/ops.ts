import { db } from "./supabase";
import { audit, slugify } from "./audit";
import { roundRobin } from "./roundrobin";
import { calculateStandings, applyQualification, isFinished, type MatchResultInput } from "./standings";
import { scoringConfigForMatch } from "./scoring/rules";
import { DEFAULT_FOCAL } from "./portrait";
import {
  advanceTarget,
  buildBracketPlan,
  groupStageLockedMessage,
  planBracketTeardown,
  planGroupRegeneration,
  playedRefusalMessage,
  type BracketTeardown,
  type BracketFingerprint,
  type BracketSummary,
  orderKnockoutMatches,
  orderedRoundNames,
  stageForRound,
  thirdPlaceFor,
  tierSizes,
  type CourtStrategy,
  type PlannedMatch,
  type Qualifier,
} from "./bracket";
import {
  getBracket,
  getBrackets,
  getBracketSlots,
  getCourts,
  getGroups,
  getGroupTeams,
  getMatches,
  getSnapshots,
  getStandings,
  getTeams,
  getTournament,
} from "./data";
import type {
  CompletedSet,
  BracketSlot,
  BracketTier,
  Match,
  MatchSnapshot,
  Standing,
  Team,
  Tournament,
} from "./types";
import { DEFAULT_SCORING_CONFIG, DEFAULT_TENNIS_SCORING_CONFIG } from "./types";
import { ensureMainScreen } from "./screens";
import { NOT_A_TOURNAMENT_MESSAGE, ownershipRefusal, tournamentRowRefusal } from "./rowGuards";
import { endLease, endLeasesForTournament } from "./scoringControl";

/* ------------------------------------------------------------------ */
/* Group match generation                                              */
/* ------------------------------------------------------------------ */

/**
 * Every bracket of a tournament, with what deleting it would take.
 *
 * Matches are counted the same two ways deleteBracketCascade finds them, so the
 * numbers an organiser confirms are the numbers that get deleted.
 */
export async function summarizeBrackets(tournamentId: string): Promise<BracketSummary[]> {
  const brackets = await getBrackets(tournamentId);
  if (brackets.length === 0) return [];
  const ids = brackets.map((b) => b.id);
  const [{ data: slots }, { data: owned }] = await Promise.all([
    db().from("bracket_slots").select("bracket_id, match_id").in("bracket_id", ids),
    db().from("matches").select("id, bracket_id, status").eq("tournament_id", tournamentId),
  ]);
  const statusById = new Map(((owned ?? []) as { id: string; status: string }[]).map((m) => [m.id, m.status]));
  return brackets.map((b) => {
    const matchIds = new Set<string>([
      ...((slots ?? []) as { bracket_id: string; match_id: string | null }[])
        .filter((r) => r.bracket_id === b.id && r.match_id)
        .map((r) => r.match_id as string),
      ...((owned ?? []) as { id: string; bracket_id: string | null }[]).filter((m) => m.bracket_id === b.id).map((m) => m.id),
    ]);
    const played = [...matchIds].filter((id) => {
      const status = statusById.get(id);
      return status !== undefined && status !== "scheduled" && status !== "ready";
    }).length;
    return { id: b.id, tier: b.tier, status: b.status, matches: matchIds.size, played };
  });
}

/**
 * Regenerates the round-robin fixtures for every group.
 *
 * Refuses while any knockout bracket exists. Both the Cup and the Plate are drawn
 * from group standings, so replacing the group matches underneath them leaves a
 * bracket seeded from results that no longer exist, with nothing on any page to
 * say so. The check runs before anything is deleted, so a refusal changes
 * nothing. Callers that mean to replace the brackets tear them down first —
 * `regenerateGroupStage` behind an explicit confirmation, or a friendly
 * session's own preflight — and this stays the backstop for every other path.
 */
export async function generateGroupMatches(tournamentId: string, actorRole: string) {
  // A team competition's group stage is ties of rubbers, not single matches.
  const owner = await getTournament(tournamentId);
  const { isTieFormat, generateGroupTies } = await import("./tennis/tieOps");
  if (isTieFormat(owner)) return generateGroupTies(tournamentId, actorRole);
  const [groups, groupTeams, courts, brackets] = await Promise.all([
    getGroups(tournamentId),
    getGroupTeams(tournamentId),
    getCourts(tournamentId),
    getBrackets(tournamentId),
  ]);
  if (groups.length === 0) throw new Error("No groups created yet");
  if (brackets.length > 0) throw new Error(groupStageLockedMessage(brackets));

  // Regenerating replaces all existing group-stage matches (and their events)
  const { error: deleteError } = await db()
    .from("matches")
    .delete()
    .eq("tournament_id", tournamentId)
    .eq("stage", "group");
  if (deleteError) throw new Error(deleteError.message);

  type Pending = {
    group_id: string;
    round: number;
    team_a_id: string;
    team_b_id: string;
    round_name: string;
  };
  const all: Pending[] = [];
  for (const group of groups) {
    const teamIds = groupTeams.filter((gt) => gt.group_id === group.id).map((gt) => gt.team_id);
    for (const pairing of roundRobin(teamIds)) {
      all.push({
        group_id: group.id,
        round: pairing.round,
        team_a_id: pairing.teamA,
        team_b_id: pairing.teamB,
        round_name: `${group.group_name} Round ${pairing.round}`,
      });
    }
  }

  // Interleave by round across groups so courts run in parallel
  all.sort((a, b) => a.round - b.round);
  const rows = all.map((m, i) => ({
    tournament_id: tournamentId,
    stage: "group",
    group_id: m.group_id,
    round_name: m.round_name,
    match_order: i + 1,
    court_id: courts.length > 0 ? courts[i % courts.length].id : null,
    team_a_id: m.team_a_id,
    team_b_id: m.team_b_id,
    status: "scheduled",
  }));
  const { error } = await db().from("matches").insert(rows);
  if (error) throw new Error(error.message);

  await audit({
    tournament_id: tournamentId,
    actor_role: actorRole,
    action: "MATCHES_GENERATED",
    entity_type: "tournament",
    entity_id: tournamentId,
    new_value: { count: rows.length },
  });
  return rows.length;
}

export type GroupStageResult =
  | { ok: true; matchesCreated: number; bracketsDeleted: number; knockoutMatchesDeleted: number }
  /** A bracket exists and nobody confirmed deleting it. Nothing was changed. */
  | { ok: false; reason: "brackets_exist"; message: string; brackets: BracketSummary[] }
  /** The confirmation named different brackets from the ones that exist now. Nothing was changed. */
  | { ok: false; reason: "brackets_changed"; message: string; brackets: BracketSummary[] }
  /** A friendly session's hidden backing row; its format is changed from the session page. */
  | { ok: false; reason: "not_a_tournament"; message: string };

// Defined with the other admin-tool refusals; re-exported for existing importers.
export { NOT_A_TOURNAMENT_MESSAGE };

/**
 * Regenerates a tournament's group stage from the tournament admin pages.
 *
 * Returns a refusal rather than throwing, because a thrown server-action message
 * is replaced by a generic one in production and the organiser would never learn
 * why nothing happened. With `confirmBrackets` matching the brackets exactly as
 * they are now, both are deleted (with every knockout match they own) and the group
 * stage is regenerated; standings are then recomputed so neither the leaderboard
 * nor a later draw reads qualification from the deleted results.
 */
export async function regenerateGroupStage(
  tournamentId: string,
  actorRole: string,
  opts: { confirmBrackets?: BracketFingerprint[] | null; publishGroups?: boolean } = {},
): Promise<GroupStageResult> {
  const tournament = await getTournament(tournamentId);
  if (!tournament) throw new Error("Tournament not found");
  if (tournament.kind !== "tournament") {
    return { ok: false, reason: "not_a_tournament", message: NOT_A_TOURNAMENT_MESSAGE };
  }

  const brackets = await summarizeBrackets(tournamentId);
  const plan = planGroupRegeneration(brackets, opts.confirmBrackets);
  if (plan.kind === "refuse") {
    return { ok: false, reason: "brackets_exist", message: groupStageLockedMessage(brackets), brackets };
  }
  if (plan.kind === "changed") {
    return {
      ok: false,
      reason: "brackets_changed",
      message:
        "The brackets changed since this page was loaded — one was drawn, redrawn, reset, published or played. Nothing was deleted. Check the list and confirm again.",
      brackets,
    };
  }

  // Checked before any bracket is deleted, so a tournament with no groups is not
  // left with its knockout gone and nothing to replace it.
  if ((await getGroups(tournamentId)).length === 0) throw new Error("No groups created yet");

  let knockoutMatchesDeleted = 0;
  if (plan.kind === "replace") {
    for (const id of plan.bracketIds) {
      knockoutMatchesDeleted += (await deleteBracketCascade(id)).matchesDeleted;
    }
    await audit({
      tournament_id: tournamentId,
      actor_role: actorRole,
      action: "BRACKETS_DELETED_FOR_GROUP_REGENERATION",
      entity_type: "tournament",
      entity_id: tournamentId,
      old_value: { brackets },
      new_value: { knockout_matches_deleted: knockoutMatchesDeleted },
    });
  }

  if (opts.publishGroups) {
    await db().from("groups").update({ status: "published" }).eq("tournament_id", tournamentId);
  }
  const matchesCreated = await generateGroupMatches(tournamentId, actorRole);
  // The old standings describe results that were just deleted. Left in place,
  // the leaderboard keeps showing them and a fresh draw would seed from them.
  await recalcStandings(tournamentId);

  return {
    ok: true,
    matchesCreated,
    bracketsDeleted: plan.kind === "replace" ? plan.bracketIds.length : 0,
    knockoutMatchesDeleted,
  };
}

/**
 * Whether the group draw may be changed right now: creating or recreating
 * groups, or saving a new assignment of teams to groups.
 *
 * Recreating groups deletes their standings through the database's cascade, and
 * moving a team between groups rewrites them on the next recalculation — either
 * way a drawn knockout ends up seeded from standings that no longer exist. Null
 * when the draw is free to change.
 */
export async function groupDrawLock(tournamentId: string): Promise<string | null> {
  const tournament = await getTournament(tournamentId);
  if (!tournament) return "Tournament not found.";
  if (tournament.kind !== "tournament") return NOT_A_TOURNAMENT_MESSAGE;
  const brackets = await getBrackets(tournamentId);
  if (brackets.length > 0) return groupStageLockedMessage(brackets);
  const { count } = await db()
    .from("ties")
    .select("id", { count: "exact", head: true })
    .eq("tournament_id", tournamentId)
    .eq("stage", "placement");
  return (count ?? 0) > 0
    ? "The placement draws have been made from these groups. Reset the placement draws before changing the groups."
    : null;
}

export type AdminOpResult = { ok: true } | { ok: false; message: string };

/**
 * Deletes a tournament and, through the database's cascades, everything in it.
 *
 * Tournaments only. `friendly_sessions.tournament_id` cascades, so deleting a
 * session's hidden row from the tournament tools would delete the whole session —
 * its entries, pairs, matches and the points its players earned.
 */
export async function deleteTournamentRow(tournamentId: string, actorRole: string): Promise<AdminOpResult> {
  const refusal = await tournamentRowRefusal(tournamentId);
  if (refusal) return { ok: false, message: refusal };
  const { data: t } = await db().from("tournaments").select("name, is_demo").eq("id", tournamentId).single();
  const { error } = await db().from("tournaments").delete().eq("id", tournamentId).eq("kind", "tournament");
  if (error) return { ok: false, message: error.message };
  await audit({
    actor_role: actorRole,
    action: "TOURNAMENT_DELETED",
    entity_type: "tournament",
    entity_id: tournamentId,
    old_value: t,
  });
  return { ok: true };
}

/**
 * Deletes a manually created match of a tournament.
 *
 * Refuses a session's row, a match of a different tournament than the one named,
 * and a match that belongs to a bracket: `bracket_slots.match_id` is ON DELETE SET
 * NULL, so deleting one leaves the draw looking intact while advancement is
 * silently dead. Resetting that tier is the supported way.
 */
export async function deleteManualMatch(tournamentId: string, matchId: string, actorRole: string): Promise<AdminOpResult> {
  const refusal = (await tournamentRowRefusal(tournamentId)) ?? (await ownershipRefusal(tournamentId, "matches", matchId));
  if (refusal) return { ok: false, message: refusal };

  const [{ data: match }, { count: slotRefs }] = await Promise.all([
    db().from("matches").select("bracket_id").eq("id", matchId).maybeSingle(),
    db().from("bracket_slots").select("id", { count: "exact", head: true }).eq("match_id", matchId),
  ]);
  if ((match as { bracket_id: string | null } | null)?.bracket_id || (slotRefs ?? 0) > 0) {
    return {
      ok: false,
      message: "That match is part of a knockout bracket. Deleting it would break advancement — reset that bracket instead.",
    };
  }

  const { error } = await db().from("matches").delete().eq("id", matchId).eq("tournament_id", tournamentId);
  if (error) return { ok: false, message: error.message };
  await audit({ tournament_id: tournamentId, actor_role: actorRole, action: "MATCH_DELETED", entity_type: "match", entity_id: matchId });
  return { ok: true };
}

/**
 * Demo and training reset (spec §24): wipes live data, keeps setup.
 *
 * Tournaments only. A friendly session's backing row keeps its whole history as
 * `stage = 'friendly'` matches, which this reset's non-group delete would match —
 * taking every played match's ledger rows with it through the cascade, while fire
 * streaks and ranking snapshots are left counting points that no longer exist.
 */
export async function resetTournamentLiveData(
  tournamentId: string,
  actorRole: string,
): Promise<{ ok: true } | { ok: false; reason: "not_a_tournament" | "not_found"; message: string }> {
  const tournament = await getTournament(tournamentId);
  if (!tournament) return { ok: false, reason: "not_found", message: "Tournament not found." };
  if (tournament.kind !== "tournament") {
    return { ok: false, reason: "not_a_tournament", message: NOT_A_TOURNAMENT_MESSAGE };
  }

  const id = tournamentId;
  // Placement ties take their rubbers with them; group ties go back to 0-0.
  const { resetTies } = await import("./tennis/tieOps");
  await resetTies(id);
  await db().from("matches").delete().eq("tournament_id", id).neq("stage", "group");
  await db()
    .from("matches")
    .update({
      status: "scheduled",
      winner_team_id: null,
      serving_team_id: null,
      is_pending_sync: false,
      started_at: null,
      ended_at: null,
    })
    .eq("tournament_id", id);
  // The delete above already cascaded away every non-group match's lease; the
  // group matches it reset above survive with theirs still attached otherwise.
  await endLeasesForTournament(id);
  await db().from("match_score_snapshots").delete().eq("tournament_id", id);
  await db().from("score_events").delete().eq("tournament_id", id);
  await db().from("standings_snapshots").delete().eq("tournament_id", id);
  await db().from("brackets").delete().eq("tournament_id", id);
  await db().from("teams").update({ check_in_status: "not_arrived", team_status: "active" }).eq("tournament_id", id);
  await audit({
    tournament_id: id,
    actor_role: actorRole,
    action: "TOURNAMENT_DATA_RESET",
    entity_type: "tournament",
    entity_id: id,
  });
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Standings                                                           */
/* ------------------------------------------------------------------ */

export async function recalcStandings(tournamentId: string) {
  const tournament = await getTournament(tournamentId);
  if (!tournament) throw new Error("Tournament not found");
  const { isTieFormat, recalcTieStandings } = await import("./tennis/tieOps");
  if (isTieFormat(tournament)) return recalcTieStandings(tournamentId);
  const [groups, groupTeams, matches, snapshots, existing] = await Promise.all([
    getGroups(tournamentId),
    getGroupTeams(tournamentId),
    getMatches(tournamentId),
    getSnapshots(tournamentId),
    getStandings(tournamentId),
  ]);
  const { data: teams } = await db()
    .from("teams")
    .select("id, team_status")
    .eq("tournament_id", tournamentId);
  const disqualified = new Set((teams ?? []).filter((t) => t.team_status === "disqualified").map((t) => t.id));
  const snapByMatch = new Map(snapshots.map((s) => [s.match_id, s]));
  const overrides = new Map(
    existing.filter((s) => s.manual_status_override).map((s) => [`${s.group_id}|${s.team_id}`, s.status])
  );
  // Group matches may carry their own walkover score, so resolve the group
  // stage's rules rather than reading the tournament default directly.
  const groupRules = scoringConfigForMatch(tournament, { stage: "group" });
  const walkoverGames = parseInt(groupRules.walkoverScore?.split("-")[0] ?? "6", 10) || 6;
  const { qualifyPerGroup, platePerGroup } = tierSizes(tournament.format_config);

  const rows: Standing[] = [];
  for (const group of groups) {
    const teamIds = groupTeams.filter((gt) => gt.group_id === group.id).map((gt) => gt.team_id);
    const groupMatches = matches.filter((m) => m.group_id === group.id && m.stage === "group");
    const results: MatchResultInput[] = groupMatches.map((m) => ({
      match: m,
      snapshot: snapByMatch.get(m.id) ?? null,
    }));
    const standings = calculateStandings(tournamentId, group.id, teamIds, results, disqualified, walkoverGames);
    const groupComplete = groupMatches.length > 0 && groupMatches.every((m) => isFinished(m.status));
    applyQualification(standings, qualifyPerGroup, groupComplete, platePerGroup);
    for (const s of standings) {
      const override = overrides.get(`${s.group_id}|${s.team_id}`);
      if (override) {
        s.status = override as Standing["status"];
        s.manual_status_override = true;
      }
    }
    rows.push(...standings);
  }

  await db().from("standings_snapshots").delete().eq("tournament_id", tournamentId);
  if (rows.length > 0) {
    const { error } = await db().from("standings_snapshots").insert(rows);
    if (error) throw new Error(error.message);
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Bracket teardown                                                    */
/* ------------------------------------------------------------------ */

/**
 * Deletes one bracket and only the matches that belong to it.
 *
 * The single place a bracket is torn down, because getting the order wrong
 * destroys data silently. Two foreign keys decide it:
 *
 *   bracket_slots.bracket_id -> brackets   ON DELETE CASCADE
 *   bracket_slots.match_id   -> matches    ON DELETE SET NULL
 *
 * So the match ids must be read FIRST. Delete the bracket before reading them
 * and its slots cascade away, taking the only record of which matches were its —
 * leaving orphaned knockout matches in the schedule with nothing pointing at
 * them.
 *
 * Matches are found two ways on purpose: through the slots, and through
 * matches.bracket_id. A draft bracket has slots with no match ids yet, and a
 * republished one can have matches whose slot rows were re-pointed, so either
 * source alone misses cases.
 *
 * What this deliberately does NOT do is delete by `tournament_id` and
 * `stage <> 'group'`, which is what every call site used to do. With two
 * brackets that wipes the other tier's live draw.
 */
export async function deleteBracketCascade(bracketId: string): Promise<{ matchesDeleted: number }> {
  const [{ data: slots }, { data: owned }] = await Promise.all([
    db().from("bracket_slots").select("match_id").eq("bracket_id", bracketId),
    db().from("matches").select("id").eq("bracket_id", bracketId),
  ]);

  const matchIds = [
    ...new Set([
      ...((slots ?? []) as { match_id: string | null }[]).map((r) => r.match_id).filter((id): id is string => Boolean(id)),
      ...((owned ?? []) as { id: string }[]).map((r) => r.id),
    ]),
  ];

  if (matchIds.length > 0) {
    // Cascades to score_events, match_score_snapshots, friendly_match_participants
    // and player_score_ledger, which is why this is scoped so tightly.
    const { error } = await db().from("matches").delete().in("id", matchIds);
    if (error) throw new Error(error.message);
  }

  const { error: bracketError } = await db().from("brackets").delete().eq("id", bracketId);
  if (bracketError) throw new Error(bracketError.message);

  return { matchesDeleted: matchIds.length };
}

/* ------------------------------------------------------------------ */
/* Knockout bracket                                                    */
/* ------------------------------------------------------------------ */

/**
 * Draws one tier's knockout from the finished group stage.
 *
 * Cup takes the teams that qualified — 1st and 2nd in each group by default.
 * Plate takes the places below them, so a team knocked out of the Cup still has
 * a tournament to play. Selection reads the status `recalcStandings` wrote
 * (`qualified` / `plate`), so a manual override on the standings page is
 * honoured rather than silently recomputed here, and a disqualified or withdrawn
 * team is never drafted into either.
 */
export async function generateBracket(
  tournamentId: string,
  actorRole: string,
  tier: BracketTier = "cup",
  /**
   * How many played knockout matches a redraw may delete. Zero by default, so a
   * redraw can never take a played match's score with it unless the caller has
   * an explicit confirmation naming that count (see redrawBracket).
   */
  opts: { allowPlayed?: number } = {},
) {
  const tournament = await getTournament(tournamentId);
  if (!tournament) throw new Error("Tournament not found");
  const [groups, standings, teams] = await Promise.all([
    getGroups(tournamentId),
    getStandings(tournamentId),
    getTeams(tournamentId),
  ]);
  const { qualifyPerGroup, platePerGroup } = tierSizes(tournament.format_config);
  if (tier === "plate" && platePerGroup < 1) {
    throw new Error("Turn the Plate bracket on in tournament settings first.");
  }
  const playable = new Set(teams.filter((t) => t.team_status === "active").map((t) => t.id));

  const qualifiers: Qualifier[] = [];
  for (const [gi, group] of groups.entries()) {
    const groupRows = standings
      .filter((s) => s.group_id === group.id)
      .sort((a, b) => a.rank - b.rank);
    for (const row of groupRows) {
      if (row.status === "disqualified" || !playable.has(row.team_id)) continue;
      const inTier =
        tier === "cup"
          ? row.status === "qualified" || (row.status === "pending" && row.rank <= qualifyPerGroup)
          : row.status === "plate" ||
            (row.status === "pending" &&
              row.rank > qualifyPerGroup &&
              row.rank <= qualifyPerGroup + platePerGroup);
      if (inTier) qualifiers.push({ teamId: row.team_id, groupOrder: gi, rank: row.rank });
    }
  }
  if (qualifiers.length < 2) {
    throw new Error(
      tier === "plate"
        ? "Not enough teams for a Plate bracket. Check the group standings and the Plate size in settings."
        : "Not enough qualified teams to build a bracket",
    );
  }

  // Replace this tier's bracket only. The other tier may be mid-play.
  const existing = await getBracket(tournamentId, tier);
  if (existing) {
    await assertTeardownAllowed(tournamentId, existing.id, "redraw", opts.allowPlayed ?? 0);
    await deleteBracketCascade(existing.id);
  }

  const plan = buildBracketPlan(qualifiers, thirdPlaceFor(tournament.format_config, tier));
  const { data: bracket, error } = await db()
    .from("brackets")
    .insert({
      tournament_id: tournamentId,
      status: "draft",
      tier,
      bracket_name: tier === "plate" ? "Plate" : "Cup",
    })
    .select()
    .single();
  if (error) throw new Error(error.message);

  const slotRows = plan.flatMap((round) =>
    round.slots.map((s) => ({
      bracket_id: bracket.id,
      tournament_id: tournamentId,
      round_name: round.roundName,
      slot_order: s.slotOrder,
      team_id: s.teamId,
      source_type: s.sourceType,
      source_ref: s.sourceRef,
      is_bye: s.isBye,
    }))
  );
  const { error: slotError } = await db().from("bracket_slots").insert(slotRows);
  if (slotError) throw new Error(slotError.message);

  await audit({
    tournament_id: tournamentId,
    actor_role: actorRole,
    action: "BRACKET_GENERATED",
    entity_type: "bracket",
    entity_id: bracket.id,
    new_value: { tier, qualifiers: qualifiers.length },
  });
  return bracket.id as string;
}

/**
 * Refuses to tear a bracket down if more of its matches have been played than the
 * caller was allowed to delete. The backstop under every redraw and reset: the
 * count is read again immediately before the delete, so a match played between a
 * confirmation and the write is never deleted on that confirmation.
 */
export async function assertTeardownAllowed(
  tournamentId: string,
  bracketId: string,
  action: BracketTeardown,
  allowPlayed: number,
): Promise<void> {
  const summary = (await summarizeBrackets(tournamentId)).find((b) => b.id === bracketId);
  if (summary && summary.played > allowPlayed) throw new Error(playedRefusalMessage(action, summary));
}

export type BracketOpResult =
  | { ok: true; message: string }
  | {
      ok: false;
      reason: "played" | "changed" | "published" | "not_found" | "not_a_tournament";
      message: string;
    };

const TIER_TITLE: Record<BracketTier, string> = { cup: "Cup", plate: "Plate" };

/**
 * The Bracket page's tools are tournament-only. A friendly session's knockout is
 * drawn and redrawn from the session page, which checks for played matches with
 * the session's own rules; from here a reset would delete its played matches and
 * the points they banked.
 */
async function bracketToolRefusal(tournamentId: string): Promise<BracketOpResult | null> {
  const refusal = await tournamentRowRefusal(tournamentId);
  if (!refusal) return null;
  return {
    ok: false,
    reason: refusal === NOT_A_TOURNAMENT_MESSAGE ? "not_a_tournament" : "not_found",
    message: refusal,
  };
}

function changedMessage(tier: BracketTier): string {
  return `The ${TIER_TITLE[tier]} changed since this page was loaded — it was redrawn, published, or a match was played. Nothing was deleted. Check it and confirm again.`;
}

/**
 * Redraws one tier from the Bracket page (or draws it for the first time).
 *
 * Returns a refusal rather than throwing, so the organiser reads why — a thrown
 * server-action message is replaced by a generic one in production. Played
 * matches are deleted only on a confirmation matching the bracket exactly as it
 * is now.
 */
export async function redrawBracket(
  tournamentId: string,
  actorRole: string,
  tier: BracketTier,
  opts: { confirm?: BracketFingerprint | null } = {},
): Promise<BracketOpResult> {
  const refused = await bracketToolRefusal(tournamentId);
  if (refused) return refused;
  const tournament = await getTournament(tournamentId);
  if (!tournament) return { ok: false, reason: "not_found", message: "Tournament not found." };
  // Chess has no group stage, so no Plate: its one knockout is always the Cup.
  const chess = tournament.sport === "chess";
  const target: BracketTier = chess ? "cup" : tier;
  const current = (await summarizeBrackets(tournamentId)).find((b) => b.tier === target) ?? null;
  const plan = planBracketTeardown(current, opts.confirm);
  if (plan.kind === "refuse_played") return { ok: false, reason: "played", message: playedRefusalMessage("redraw", current!) };
  if (plan.kind === "changed") return { ok: false, reason: "changed", message: changedMessage(target) };

  const allowPlayed = plan.kind === "proceed" ? plan.allowPlayed : 0;
  if (chess) await generateKnockoutFromTeams(tournamentId, actorRole, { allowPlayed });
  else await generateBracket(tournamentId, actorRole, target, { allowPlayed });

  if (current) {
    await audit({
      tournament_id: tournamentId,
      actor_role: actorRole,
      action: current.played > 0 ? "BRACKET_REDRAWN_DELETING_PLAYED" : "BRACKET_REDRAWN",
      entity_type: "bracket",
      entity_id: current.id,
      old_value: { bracket: current },
    });
  }
  const name = TIER_TITLE[target];
  if (!current) return { ok: true, message: `Drew the ${name}.` };
  const deleted =
    current.matches === 0
      ? ""
      : ` Deleted ${current.matches} knockout match${current.matches === 1 ? "" : "es"}${current.played > 0 ? `, ${current.played} of them played` : ""}.`;
  return { ok: true, message: `Redrew the ${name} as a new draft.${deleted}` };
}

/** Deletes one tier and only its matches, from the Bracket page's Reset. */
export async function resetBracketTier(
  tournamentId: string,
  actorRole: string,
  tier: BracketTier,
  opts: { confirm?: BracketFingerprint | null } = {},
): Promise<BracketOpResult> {
  // Refused before the confirmation is even read: on a session's row no
  // confirmation makes a reset from here acceptable.
  const refused = await bracketToolRefusal(tournamentId);
  if (refused) return refused;
  const current = (await summarizeBrackets(tournamentId)).find((b) => b.tier === tier) ?? null;
  const plan = planBracketTeardown(current, opts.confirm);
  if (plan.kind === "none") {
    return { ok: false, reason: "not_found", message: `There is no ${TIER_TITLE[tier]} bracket to reset — it was already reset.` };
  }
  if (plan.kind === "refuse_played") return { ok: false, reason: "played", message: playedRefusalMessage("reset", current!) };
  if (plan.kind === "changed") return { ok: false, reason: "changed", message: changedMessage(tier) };

  await assertTeardownAllowed(tournamentId, current!.id, "reset", plan.allowPlayed);
  const { matchesDeleted } = await deleteBracketCascade(current!.id);
  await audit({
    tournament_id: tournamentId,
    actor_role: actorRole,
    action: "BRACKET_RESET",
    entity_type: "bracket",
    entity_id: current!.id,
    old_value: { tier, matchesDeleted, bracket: current },
  });
  return {
    ok: true,
    message: `Deleted the ${TIER_TITLE[tier]} bracket and ${matchesDeleted} knockout match${matchesDeleted === 1 ? "" : "es"}${current!.played > 0 ? `, ${current!.played} of them played` : ""}.`,
  };
}

/**
 * Approves a drawn bracket for publishing.
 *
 * Refuses a published one: publishing treats anything not marked published as
 * new, so an approved-again bracket would get a second set of matches.
 */
export async function approveBracket(tournamentId: string, actorRole: string, tier: BracketTier): Promise<BracketOpResult> {
  const refused = await bracketToolRefusal(tournamentId);
  if (refused) return refused;
  const bracket = await getBracket(tournamentId, tier);
  if (!bracket) return { ok: false, reason: "not_found", message: `There is no ${TIER_TITLE[tier]} bracket to approve.` };
  if (bracket.status === "published") {
    return {
      ok: false,
      reason: "published",
      message: `The ${TIER_TITLE[tier]} is already published, so it cannot be approved again. Redraw it to change the draw.`,
    };
  }
  // Conditional on the status, so a publish landing between the read and this
  // write is not overwritten back to 'approved'.
  const { data: updated, error } = await db()
    .from("brackets")
    .update({ status: "approved", approved_by: actorRole, approved_at: new Date().toISOString() })
    .eq("id", bracket.id)
    .neq("status", "published")
    .select("id");
  if (error) throw new Error(error.message);
  if (!updated || updated.length === 0) {
    return {
      ok: false,
      reason: "published",
      message: `The ${TIER_TITLE[tier]} was published a moment ago, so it cannot be approved again.`,
    };
  }
  await audit({ tournament_id: tournamentId, actor_role: actorRole, action: "BRACKET_APPROVED", entity_type: "bracket", entity_id: bracket.id });
  return { ok: true, message: `Approved the ${TIER_TITLE[tier]}. Publish it to create its matches.` };
}

/**
 * Chess (and other group-less sports): seed a knockout bracket directly from the
 * team/player list — no group stage. Reuses the same bracket plan + slots so the
 * editor, publish, and auto-advance paths all work unchanged.
 */
export async function generateKnockoutFromTeams(
  tournamentId: string,
  actorRole: string,
  /** As generateBracket: how many played knockout matches a redraw may delete. */
  opts: { allowPlayed?: number } = {},
) {
  const tournament = await getTournament(tournamentId);
  if (!tournament) throw new Error("Tournament not found");
  const teams = await getTeams(tournamentId);
  const entrants = teams
    .filter((t) => t.team_status !== "disqualified" && t.team_status !== "withdrawn")
    .sort((a, b) => (a.seed_number ?? 9999) - (b.seed_number ?? 9999));
  if (entrants.length < 2) throw new Error("Need at least 2 players to build a knockout");

  // One synthetic group so buildBracketPlan uses pure seed placement.
  const qualifiers: Qualifier[] = entrants.map((t, i) => ({
    teamId: t.id,
    groupOrder: 0,
    rank: t.seed_number ?? i + 1,
  }));

  const existing = await getBracket(tournamentId, "cup");
  if (existing) {
    await assertTeardownAllowed(tournamentId, existing.id, "redraw", opts.allowPlayed ?? 0);
    await deleteBracketCascade(existing.id);
  }

  const plan = buildBracketPlan(qualifiers, tournament.format_config?.thirdPlaceMatch ?? false);
  const { data: bracket, error } = await db()
    .from("brackets")
    .insert({ tournament_id: tournamentId, status: "draft" })
    .select()
    .single();
  if (error) throw new Error(error.message);

  const slotRows = plan.flatMap((round) =>
    round.slots.map((s) => ({
      bracket_id: bracket.id,
      tournament_id: tournamentId,
      round_name: round.roundName,
      slot_order: s.slotOrder,
      team_id: s.teamId,
      source_type: s.sourceType,
      source_ref: s.sourceRef,
      is_bye: s.isBye,
    }))
  );
  const { error: slotError } = await db().from("bracket_slots").insert(slotRows);
  if (slotError) throw new Error(slotError.message);

  await audit({
    tournament_id: tournamentId,
    actor_role: actorRole,
    action: "BRACKET_GENERATED",
    entity_type: "bracket",
    entity_id: bracket.id,
    new_value: { entrants: entrants.length, source: "team_list" },
  });
  return bracket.id as string;
}

/**
 * Turns drawn slots into real matches, for every tier at once.
 *
 * All unpublished tiers are published together because the court strategy cannot
 * be honoured otherwise: publishing the Cup and then the Plate means the Cup has
 * already taken every court and every low order number, so "both at once" would
 * silently degrade to "one after another". One call, one decision.
 *
 * Byes advance without a match, as before.
 */
export async function publishBracket(
  tournamentId: string,
  actorRole: string,
  opts: { courtStrategy?: CourtStrategy } = {},
) {
  const brackets = (await getBrackets(tournamentId)).filter((b) => b.status !== "published");
  if (brackets.length === 0) throw new Error("No bracket to publish");
  // A bracket that already owns matches has been published before, whatever its
  // status says now. Publishing it again inserts a second set of matches for the
  // same slots and re-points the slots at them, leaving the first set orphaned
  // on the schedule — so refuse before anything is written.
  const owned = (await summarizeBrackets(tournamentId)).filter(
    (b) => brackets.some((c) => c.id === b.id) && b.matches > 0,
  );
  if (owned.length > 0) {
    throw new Error(
      `${owned.map((b) => (b.tier === "plate" ? "The Plate" : "The Cup")).join(" and ")} already ${owned.length === 1 ? "has" : "have"} knockout matches, so ${owned.length === 1 ? "it was" : "they were"} published before. Redraw or reset ${owned.length === 1 ? "it" : "them"} instead of publishing again.`,
    );
  }
  const courts = await getCourts(tournamentId);
  const strategy = opts.courtStrategy ?? "parallel";

  const { data: maxOrderRow } = await db()
    .from("matches")
    .select("match_order")
    .eq("tournament_id", tournamentId)
    .order("match_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const baseOrder = (maxOrderRow?.match_order ?? 0) + 1;

  // Collect every pairing across every tier first, so courts and play order can
  // be decided for the whole knockout rather than one bracket at a time.
  type Pairing = PlannedMatch & {
    bracketId: string;
    roundSlotCount: number;
    a: BracketSlot;
    b: BracketSlot;
  };
  const pairings: Pairing[] = [];
  const byes: { bracketId: string; roundName: string; matchIndex: number; teamId: string }[] = [];

  for (const bracket of brackets) {
    const slots = await getBracketSlots(bracket.id);
    // Rounds must be walked in the order they are played; getBracketSlots sorts
    // by slot_order alone, and every round has a slot 0.
    for (const roundName of orderedRoundNames(slots.map((s) => s.round_name))) {
      const roundSlots = slots
        .filter((s) => s.round_name === roundName)
        .sort((a, b) => a.slot_order - b.slot_order);
      for (let i = 0; i < roundSlots.length; i += 2) {
        const a = roundSlots[i];
        const b = roundSlots[i + 1];
        if (!a || !b) continue;
        const matchIndex = i / 2;
        if (a.is_bye || b.is_bye) {
          const lucky = a.is_bye ? b : a;
          if (lucky.team_id) {
            byes.push({ bracketId: bracket.id, roundName, matchIndex, teamId: lucky.team_id });
          }
          continue;
        }
        pairings.push({
          bracketId: bracket.id,
          tier: bracket.tier,
          roundName,
          matchIndex,
          roundSlotCount: roundSlots.length,
          a,
          b,
        });
      }
    }
  }

  // Byes first: a lucky team must be in its next slot before that round's match
  // is created, or the match is built with an empty side.
  for (const bye of byes) {
    const target = advanceTarget(bye.roundName, bye.matchIndex);
    if (!target) continue;
    await db()
      .from("bracket_slots")
      .update({ team_id: bye.teamId, source_type: "bye_advance" })
      .eq("bracket_id", bye.bracketId)
      .eq("round_name", target.roundName)
      .eq("slot_order", target.slotOrder);
    await audit({
      tournament_id: tournamentId,
      actor_role: actorRole,
      action: "BYE_ADVANCE",
      entity_type: "team",
      entity_id: bye.teamId,
      new_value: { from: bye.roundName, to: target.roundName },
    });
  }

  const scheduled = orderKnockoutMatches(pairings, courts.length, strategy);
  const plateName = (roundName: string) => (roundName === "TP" ? "Plate TP" : `Plate ${roundName}`);

  for (const slot of scheduled) {
    const pairing = pairings.find(
      (p) => p.tier === slot.tier && p.roundName === slot.roundName && p.matchIndex === slot.matchIndex,
    );
    if (!pairing) continue;
    const { a, b } = pairing;
    // Re-read the slots: a bye may have filled this side a moment ago.
    const [{ data: freshA }, { data: freshB }] = await Promise.all([
      db().from("bracket_slots").select("team_id").eq("id", a.id).maybeSingle(),
      db().from("bracket_slots").select("team_id").eq("id", b.id).maybeSingle(),
    ]);
    const suffix = pairing.roundSlotCount > 2 ? String(slot.matchIndex + 1) : "";
    // The Plate's rounds are labelled so the two tiers can be told apart
    // anywhere a round name is shown raw — a referee queue, the admin table, a
    // court card. Two matches called "F" on one wall is the failure this avoids.
    const baseName = `${slot.roundName}${suffix}`;
    const { data: match, error } = await db()
      .from("matches")
      .insert({
        tournament_id: tournamentId,
        bracket_id: pairing.bracketId,
        stage: stageForRound(slot.roundName),
        round_name: slot.tier === "plate" ? plateName(baseName) : baseName,
        match_order: baseOrder + slot.order,
        court_id: slot.courtIndex === null ? null : courts[slot.courtIndex].id,
        team_a_id: (freshA?.team_id as string | null) ?? a.team_id,
        team_b_id: (freshB?.team_id as string | null) ?? b.team_id,
        status: "scheduled",
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    await db().from("bracket_slots").update({ match_id: match.id }).in("id", [a.id, b.id]);
  }

  for (const bracket of brackets) {
    await db()
      .from("brackets")
      .update({ status: "published", published_at: new Date().toISOString() })
      .eq("id", bracket.id);
    await audit({
      tournament_id: tournamentId,
      actor_role: actorRole,
      action: "BRACKET_PUBLISHED",
      entity_type: "bracket",
      entity_id: bracket.id,
      new_value: { tier: bracket.tier, courtStrategy: strategy },
    });
  }
}

/** Fill next-round slots/matches after a knockout match finishes. */
async function advanceKnockout(match: Match) {
  if (!match.winner_team_id) return;
  const { data: slotRows } = await db()
    .from("bracket_slots")
    .select("*")
    .eq("match_id", match.id)
    .order("slot_order");
  if (!slotRows || slotRows.length === 0) return;
  const bracketId = slotRows[0].bracket_id as string;
  const roundName = slotRows[0].round_name as string;
  const matchIndex = Math.floor(slotRows[0].slot_order / 2);

  const loserTeamId =
    slotRows.map((s) => s.team_id).find((t) => t && t !== match.winner_team_id) ?? null;

  async function fillSlot(targetRound: string, slotOrder: number, teamId: string, sourceType: string) {
    const { data: slot } = await db()
      .from("bracket_slots")
      .select("*")
      .eq("bracket_id", bracketId)
      .eq("round_name", targetRound)
      .eq("slot_order", slotOrder)
      .maybeSingle();
    if (!slot) return;
    await db().from("bracket_slots").update({ team_id: teamId, source_type: sourceType }).eq("id", slot.id);
    if (slot.match_id) {
      const field = slot.slot_order % 2 === 0 ? "team_a_id" : "team_b_id";
      await db().from("matches").update({ [field]: teamId }).eq("id", slot.match_id);
    }
  }

  const target = advanceTarget(roundName, matchIndex);
  if (target) await fillSlot(target.roundName, target.slotOrder, match.winner_team_id, "match_winner");
  if (roundName === "SF" && loserTeamId) {
    await fillSlot("TP", matchIndex, loserTeamId, "match_loser");
  }
}


/**
 * Undoes what advanceKnockout did, when a finished match is reopened.
 *
 * An UNDO past the end of a match sets it back to live, but until now nothing
 * took the winner back out of the next round: the bracket kept the retracted
 * team, the next match kept it as a side, and a venue screen showing the bracket
 * showed a pairing that was no longer true. If the next match has already
 * started, retracting silently would be worse than refusing — so this reports
 * that instead of corrupting the tree, and the caller turns it into a conflict
 * the referee can see.
 */
export async function retractKnockout(match: Match): Promise<{ ok: boolean; reason?: "downstream_started" }> {
  const { data: slotRows } = await db()
    .from("bracket_slots")
    .select("*")
    .eq("match_id", match.id)
    .order("slot_order");
  if (!slotRows || slotRows.length === 0) return { ok: true };
  const bracketId = slotRows[0].bracket_id as string;
  const roundName = slotRows[0].round_name as string;
  const matchIndex = Math.floor(slotRows[0].slot_order / 2);

  const targets = [advanceTarget(roundName, matchIndex)];
  // A semi-final also feeds the third-place match, with the loser.
  if (roundName === "SF") targets.push({ roundName: "TP", slotOrder: matchIndex });

  const slots: { id: string; slot_order: number; match_id: string | null }[] = [];
  for (const target of targets) {
    if (!target) continue;
    const { data: slot } = await db()
      .from("bracket_slots")
      .select("id, slot_order, match_id")
      .eq("bracket_id", bracketId)
      .eq("round_name", target.roundName)
      .eq("slot_order", target.slotOrder)
      .maybeSingle();
    if (slot) slots.push(slot as { id: string; slot_order: number; match_id: string | null });
  }

  // Check every downstream match before changing anything, so a refusal leaves
  // the bracket exactly as it was.
  const downstreamIds = slots.map((s) => s.match_id).filter((id): id is string => Boolean(id));
  if (downstreamIds.length > 0) {
    const { data: downstream } = await db().from("matches").select("id, status").in("id", downstreamIds);
    const started = (downstream ?? []).some(
      (m) => (m as { status: string }).status !== "scheduled" && (m as { status: string }).status !== "ready",
    );
    if (started) return { ok: false, reason: "downstream_started" };
  }

  for (const slot of slots) {
    await db()
      .from("bracket_slots")
      .update({ team_id: null, source_type: null })
      .eq("id", slot.id);
    if (slot.match_id) {
      const field = slot.slot_order % 2 === 0 ? "team_a_id" : "team_b_id";
      await db().from("matches").update({ [field]: null }).eq("id", slot.match_id);
    }
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Match finalization                                                  */
/* ------------------------------------------------------------------ */

export interface FinalizeOptions {
  status: "completed" | "walkover" | "disqualified" | "retired";
  winnerTeamId: string;
  actorRole: string;
  note?: string;
  pendingSync?: boolean;
}

/** Central completion path: updates the match, standings, and bracket. */
export async function finalizeMatch(match: Match, opts: FinalizeOptions) {
  const { error } = await db()
    .from("matches")
    .update({
      status: opts.status,
      winner_team_id: opts.winnerTeamId,
      ended_at: new Date().toISOString(),
      is_pending_sync: opts.pendingSync ?? false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", match.id);
  if (error) throw new Error(error.message);
  // A finished match is nobody's to score any more — its scoring lease, if any.
  await endLease(match.id);

  await audit({
    tournament_id: match.tournament_id,
    actor_role: opts.actorRole,
    action: `MATCH_${opts.status.toUpperCase()}`,
    entity_type: "match",
    entity_id: match.id,
    new_value: { winner_team_id: opts.winnerTeamId, note: opts.note ?? null },
  });

  if (match.tie_id) {
    // A rubber: its tie decides standings and advancement, not the match itself.
    const { applyTieResult } = await import("./tennis/tieOps");
    await applyTieResult(match.tie_id);
    return;
  }
  if (match.stage === "friendly") {
    // Friendly sessions award individual player points instead of team
    // standings. Imported lazily to keep the friendly module out of the
    // tournament code path.
    const { applyFriendlyResult } = await import("./friendly/ops");
    await applyFriendlyResult({ ...match, winner_team_id: opts.winnerTeamId }, opts);
    // A session drawn as a knockout also has to advance. Session matches carry
    // stage 'friendly' whatever their round, so this branch used to return
    // before advanceKnockout ever ran, leaving a session bracket a dead end
    // after round one: points banked correctly, next round's slots empty.
    // A no-op when no bracket slot references the match, which is every session
    // played as a rotation or a group stage.
    await advanceKnockout({ ...match, winner_team_id: opts.winnerTeamId });
  } else if (match.stage === "group") {
    await recalcStandings(match.tournament_id);
  } else {
    await advanceKnockout({ ...match, winner_team_id: opts.winnerTeamId });
  }
}

/* ------------------------------------------------------------------ */
/* Clone tournament                                                    */
/* ------------------------------------------------------------------ */

export interface CloneOptions {
  newName: string;
  copyTeams: boolean;
  copyPhotos: boolean;
  copyGroups: boolean;
  copySchedule: boolean;
  copyBranding: boolean;
  copyScoring: boolean;
  copyCourts: boolean;
}

export async function cloneTournament(sourceId: string, opts: CloneOptions, actorRole: string) {
  const source = await getTournament(sourceId);
  if (!source) throw new Error("Source tournament not found");

  const slug = `${slugify(opts.newName)}-${Math.random().toString(36).slice(2, 6)}`;
  const { data: created, error } = await db()
    .from("tournaments")
    .insert({
      name: opts.newName,
      slug,
      sport: source.sport,
      status: "draft",
      cloned_from_tournament_id: sourceId,
      branding_config: opts.copyBranding ? source.branding_config : {},
      scoring_config: opts.copyScoring
        ? source.scoring_config
        : {
            ...(source.sport === "tennis" ? DEFAULT_TENNIS_SCORING_CONFIG : DEFAULT_SCORING_CONFIG),
            requireResultConfirmation: source.sport !== "chess",
          },
      format_config: source.format_config,
      court_config: source.court_config,
      lower_third_text: opts.copyBranding ? source.lower_third_text : undefined,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  const newId = created.id as string;

  const courtIdMap = new Map<string, string>();
  if (opts.copyCourts) {
    const courts = await getCourts(sourceId);
    for (const c of courts) {
      const { data: nc } = await db()
        .from("courts")
        .insert({ tournament_id: newId, court_name: c.court_name, court_order: c.court_order })
        .select()
        .single();
      if (nc) courtIdMap.set(c.id, nc.id);
    }
  }

  const teamIdMap = new Map<string, string>();
  if (opts.copyTeams) {
    const { data: teams } = await db().from("teams").select("*, players(*)").eq("tournament_id", sourceId);
    for (const t of (teams ?? []) as Team[]) {
      const { data: nt } = await db()
        .from("teams")
        .insert({
          tournament_id: newId,
          team_name: t.team_name,
          phone: t.phone,
          notes: t.notes,
          seed_number: t.seed_number,
          check_in_status: "not_arrived",
          team_status: "active",
        })
        .select()
        .single();
      if (!nt) continue;
      teamIdMap.set(t.id, nt.id);
      const players = (t.players ?? []).map((p) => ({
        tournament_id: newId,
        team_id: nt.id,
        player_order: p.player_order,
        full_name: p.full_name,
        player_profile_id: p.player_profile_id ?? null,
        // The framing travels with the photo, or a copied portrait would be
        // re-cropped from the centre and lose the face it was aimed at.
        photo_url: opts.copyPhotos ? p.photo_url : null,
        portrait_url: opts.copyPhotos ? p.portrait_url : null,
        focal_x: opts.copyPhotos ? p.focal_x : DEFAULT_FOCAL[0],
        focal_y: opts.copyPhotos ? p.focal_y : DEFAULT_FOCAL[1],
      }));
      if (players.length > 0) await db().from("players").insert(players);
    }
  }

  const groupIdMap = new Map<string, string>();
  if (opts.copyGroups && opts.copyTeams) {
    const [groups, groupTeams] = await Promise.all([getGroups(sourceId), getGroupTeams(sourceId)]);
    for (const g of groups) {
      const { data: ng } = await db()
        .from("groups")
        .insert({
          tournament_id: newId,
          group_name: g.group_name,
          group_order: g.group_order,
          status: g.status,
        })
        .select()
        .single();
      if (ng) groupIdMap.set(g.id, ng.id);
    }
    const gtRows = groupTeams
      .filter((gt) => groupIdMap.has(gt.group_id) && teamIdMap.has(gt.team_id))
      .map((gt) => ({
        tournament_id: newId,
        group_id: groupIdMap.get(gt.group_id),
        team_id: teamIdMap.get(gt.team_id),
        position: gt.position,
        is_locked: gt.is_locked,
      }));
    if (gtRows.length > 0) await db().from("group_teams").insert(gtRows);
  }

  if (opts.copySchedule && opts.copyTeams) {
    const matches = (await getMatches(sourceId)).filter((m) => m.stage === "group");
    const rows = matches
      .filter((m) => m.team_a_id && m.team_b_id && teamIdMap.has(m.team_a_id) && teamIdMap.has(m.team_b_id))
      .map((m) => ({
        tournament_id: newId,
        stage: "group",
        group_id: m.group_id ? (groupIdMap.get(m.group_id) ?? null) : null,
        round_name: m.round_name,
        match_order: m.match_order,
        court_id: m.court_id ? (courtIdMap.get(m.court_id) ?? null) : null,
        scheduled_time: m.scheduled_time,
        team_a_id: teamIdMap.get(m.team_a_id!),
        team_b_id: teamIdMap.get(m.team_b_id!),
        status: "scheduled",
      }));
    if (rows.length > 0) await db().from("matches").insert(rows);
  }

  await ensureMainScreen(newId);
  await db().from("clone_logs").insert({
    source_tournament_id: sourceId,
    new_tournament_id: newId,
    options_json: opts as unknown as Record<string, unknown>,
    actor_role: actorRole,
  });
  await audit({
    tournament_id: newId,
    actor_role: actorRole,
    action: "TOURNAMENT_CLONED",
    entity_type: "tournament",
    entity_id: newId,
    old_value: { source_tournament_id: sourceId },
  });
  return created as Tournament;
}

/* ------------------------------------------------------------------ */
/* Snapshot helpers                                                    */
/* ------------------------------------------------------------------ */

export interface EngineStateLike {
  currentSet: number;
  teamA: { points: string; games: number; sets: number; tiebreakPoints: number };
  teamB: { points: string; games: number; sets: number; tiebreakPoints: number };
  isTiebreak: boolean;
  completedSets: CompletedSet[];
  servingTeam: "A" | "B" | null;
  winner: "A" | "B" | null;
  matchOver: boolean;
}

export interface SnapshotEventFacts {
  lastEventType?: string | null;
  lastEventTeamId?: string | null;
  /** The event number of the most recent UNDO applied, 0 if none. */
  lastUndoEventNumber?: number;
}

export async function upsertSnapshotFromState(
  match: Match,
  state: EngineStateLike,
  lastEventNumber: number,
  facts: SnapshotEventFacts = {},
) {
  // Optional so scripts and older callers keep compiling; a snapshot written
  // without them simply reads as "no undo seen", which is the safe default.
  const eventFacts = {
    last_event_type: facts.lastEventType ?? null,
    last_event_team_id: facts.lastEventTeamId ?? null,
    last_undo_event_number: facts.lastUndoEventNumber ?? 0,
  };
  // Non-padel (e.g. chess) state has no padel set/game fields — store the JSON and
  // leave the padel-specific columns at neutral defaults. Padel path is unchanged.
  const loose = state as unknown as { teamA?: unknown; fen?: string; games?: unknown };
  if (loose.teamA === undefined || loose.games !== undefined || loose.fen !== undefined) {
    const chessRow = {
      match_id: match.id,
      tournament_id: match.tournament_id,
      current_set_number: 1,
      team_a_point_label: "",
      team_b_point_label: "",
      team_a_games: 0,
      team_b_games: 0,
      team_a_sets: 0,
      team_b_sets: 0,
      is_tiebreak: false,
      tiebreak_team_a_points: 0,
      tiebreak_team_b_points: 0,
      serving_team_id: null,
      last_event_number: lastEventNumber,
      ...eventFacts,
      completed_sets: [],
      snapshot_json: state as unknown as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    };
    const { error } = await db().from("match_score_snapshots").upsert(chessRow, { onConflict: "match_id" });
    if (error) throw new Error(error.message);
    return chessRow as unknown as MatchSnapshot;
  }

  const servingTeamId =
    state.servingTeam === "A" ? match.team_a_id : state.servingTeam === "B" ? match.team_b_id : null;
  const row = {
    match_id: match.id,
    tournament_id: match.tournament_id,
    current_set_number: state.currentSet,
    team_a_point_label: state.teamA.points,
    team_b_point_label: state.teamB.points,
    team_a_games: state.teamA.games,
    team_b_games: state.teamB.games,
    team_a_sets: state.teamA.sets,
    team_b_sets: state.teamB.sets,
    is_tiebreak: state.isTiebreak,
    tiebreak_team_a_points: state.teamA.tiebreakPoints,
    tiebreak_team_b_points: state.teamB.tiebreakPoints,
    serving_team_id: servingTeamId,
    last_event_number: lastEventNumber,
    ...eventFacts,
    completed_sets: state.completedSets,
    snapshot_json: state as unknown as Record<string, unknown>,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db().from("match_score_snapshots").upsert(row, { onConflict: "match_id" });
  if (error) throw new Error(error.message);
  return row as unknown as MatchSnapshot;
}
