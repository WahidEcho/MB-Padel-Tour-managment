/**
 * Server operations for tennis team competitions: generating the group ties,
 * captains' line-ups, the tie result after every rubber, the group ranking and
 * the placement draws.
 *
 * The rubbers are ordinary `matches` rows, so everything that scores, shows or
 * finalises a match does so unchanged; `finalizeMatch` (and an undo that reopens
 * a finished rubber) call `applyTieResult`, which is the one place a tie's
 * score, its dropped dead rubbers and its nations' advancement are decided.
 */
import { randomUUID } from "crypto";
import { db } from "../supabase";
import { audit } from "../audit";
import { roundRobin } from "../roundrobin";
import { applyQualification } from "../standings";
import { scoringConfigForMatch } from "../scoring/rules";
import type { Court, Group, GroupTeam, Match, MatchSnapshot, RubberType, Team, Tie, Tournament } from "../types";
import { MAX_DELAY_MINUTES, RUBBER_GAP_MINUTES, RUBBER_LABELS, lineupFor, lineupProblems, rubberPlan, shiftTime, tieOutcome } from "./ties";
import { calculateTieStandings } from "./tieStandings";
import { placementPlan, type PlannedTie } from "./placement";

export function isTieFormat(t: Pick<Tournament, "format_config"> | null | undefined): boolean {
  return Boolean(t?.format_config?.ties);
}

export async function getTies(tournamentId: string): Promise<Tie[]> {
  const { data } = await db().from("ties").select("*").eq("tournament_id", tournamentId).order("tie_order");
  return (data ?? []) as Tie[];
}

async function tournamentOf(tournamentId: string): Promise<Tournament> {
  const { data } = await db().from("tournaments").select("*").eq("id", tournamentId).single();
  if (!data) throw new Error("Tournament not found");
  return data as Tournament;
}

async function tieRubbers(tieId: string): Promise<Match[]> {
  const { data } = await db().from("matches").select("*").eq("tie_id", tieId).order("rubber_no");
  return (data ?? []) as Match[];
}

const code = (t: Pick<Team, "team_name" | "nation_code"> | undefined) => t?.nation_code || t?.team_name || "TBD";

function rubberRows(
  tournament: Tournament,
  tie: { id: string; stage: "group" | "placement"; group_id: string | null; court_id: string | null; scheduled_time: string | null; team_a_id: string | null; team_b_id: string | null },
  label: string,
  firstOrder: number,
) {
  return rubberPlan(tournament.format_config?.ties).map((type: RubberType, i) => ({
    tournament_id: tournament.id,
    tie_id: tie.id,
    rubber_no: i + 1,
    rubber_type: type,
    stage: tie.stage === "group" ? "group" : "knockout",
    group_id: tie.group_id,
    round_name: `${label} · ${RUBBER_LABELS[type]}`,
    match_order: firstOrder + i,
    court_id: tie.court_id,
    scheduled_time: tie.scheduled_time,
    team_a_id: tie.team_a_id,
    team_b_id: tie.team_b_id,
    status: "scheduled",
  }));
}

/* ------------------------------------------------------------------ */
/* Group stage                                                         */
/* ------------------------------------------------------------------ */

/**
 * Replaces the group stage with ties: a round robin of nations in every group,
 * each tie with its three rubbers. Refused once the placement draws exist, for
 * the same reason a drawn bracket locks the padel group stage.
 */
export async function generateGroupTies(tournamentId: string, actorRole: string): Promise<number> {
  const tournament = await tournamentOf(tournamentId);
  const [{ data: groups }, { data: groupTeams }, { data: courts }, { data: teams }, placement] = await Promise.all([
    db().from("groups").select("*").eq("tournament_id", tournamentId).order("group_order"),
    db().from("group_teams").select("*").eq("tournament_id", tournamentId).order("position"),
    db().from("courts").select("*").eq("tournament_id", tournamentId).order("court_order"),
    db().from("teams").select("*").eq("tournament_id", tournamentId),
    db().from("ties").select("id", { count: "exact", head: true }).eq("tournament_id", tournamentId).eq("stage", "placement"),
  ]);
  if (!groups?.length) throw new Error("No groups created yet");
  if ((placement.count ?? 0) > 0) {
    throw new Error("The placement draws have been made, so the group stage is locked. Reset the placement draws first.");
  }
  const teamById = new Map(((teams ?? []) as Team[]).map((t) => [t.id, t]));

  // Rubbers go with their ties (on delete cascade); any old single matches too.
  await db().from("ties").delete().eq("tournament_id", tournamentId).eq("stage", "group");
  await db().from("matches").delete().eq("tournament_id", tournamentId).eq("stage", "group");

  type Pending = { group: Group; round: number; a: string; b: string };
  const pending: Pending[] = [];
  for (const group of (groups ?? []) as Group[]) {
    const ids = ((groupTeams ?? []) as GroupTeam[]).filter((gt) => gt.group_id === group.id).map((gt) => gt.team_id);
    for (const p of roundRobin(ids)) pending.push({ group, round: p.round, a: p.teamA, b: p.teamB });
  }
  // Interleaved by round across groups, as the padel group stage is.
  pending.sort((x, y) => x.round - y.round || x.group.group_order - y.group.group_order);

  const courtList = (courts ?? []) as Court[];
  const tieRows = pending.map((p, i) => ({
    id: randomUUID(),
    tournament_id: tournamentId,
    stage: "group" as const,
    group_id: p.group.id,
    round_no: p.round,
    round_name: `${p.group.group_name} · Round ${p.round}`,
    tie_order: i + 1,
    court_id: courtList.length ? courtList[i % courtList.length].id : null,
    scheduled_time: null,
    team_a_id: p.a,
    team_b_id: p.b,
  }));
  if (tieRows.length) {
    const { error } = await db().from("ties").insert(tieRows);
    if (error) throw new Error(error.message);
    const rubbers = tieRows.flatMap((t, i) =>
      rubberRows(tournament, t, `${t.round_name} · ${code(teamById.get(t.team_a_id))} v ${code(teamById.get(t.team_b_id))}`, i * 3 + 1),
    );
    const { error: mErr } = await db().from("matches").insert(rubbers);
    if (mErr) throw new Error(mErr.message);
  }
  await audit({
    tournament_id: tournamentId,
    actor_role: actorRole,
    action: "TIES_GENERATED",
    entity_type: "tournament",
    entity_id: tournamentId,
    new_value: { ties: tieRows.length, rubbers: tieRows.length * 3 },
  });
  await recalcTieStandings(tournamentId);
  return tieRows.length;
}

/** Group standings, ranked the ITF way, written where the padel standings are. */
export async function recalcTieStandings(tournamentId: string) {
  const tournament = await tournamentOf(tournamentId);
  const [{ data: groups }, { data: groupTeams }, { data: teams }, { data: ties }, { data: rubbers }, { data: snaps }, { data: existing }] =
    await Promise.all([
      db().from("groups").select("*").eq("tournament_id", tournamentId).order("group_order"),
      db().from("group_teams").select("*").eq("tournament_id", tournamentId),
      db().from("teams").select("id, team_name, seed_number, team_status").eq("tournament_id", tournamentId),
      db().from("ties").select("*").eq("tournament_id", tournamentId).eq("stage", "group"),
      db().from("matches").select("id, tie_id, team_a_id, team_b_id, status, winner_team_id").eq("tournament_id", tournamentId).not("tie_id", "is", null),
      db().from("match_score_snapshots").select("*").eq("tournament_id", tournamentId),
      db().from("standings_snapshots").select("group_id, team_id, status, manual_status_override").eq("tournament_id", tournamentId),
    ]);
  const snapBy = new Map(((snaps ?? []) as MatchSnapshot[]).map((s) => [s.match_id, s]));
  const teamRows = (teams ?? []) as (Pick<Team, "id" | "team_name" | "seed_number" | "team_status">)[];
  const disqualified = new Set(teamRows.filter((t) => t.team_status === "disqualified").map((t) => t.id));
  const overrides = new Map(
    ((existing ?? []) as { group_id: string; team_id: string; status: string; manual_status_override: boolean }[])
      .filter((s) => s.manual_status_override)
      .map((s) => [`${s.group_id}|${s.team_id}`, s.status]),
  );
  const walkover = parseInt(scoringConfigForMatch(tournament, { stage: "group" }).walkoverScore?.split("-")[0] ?? "6", 10) || 6;
  const qualify = tournament.format_config?.qualifyPerGroup ?? 2;

  const rows = [];
  for (const group of (groups ?? []) as Group[]) {
    const ids = ((groupTeams ?? []) as GroupTeam[]).filter((gt) => gt.group_id === group.id).map((gt) => gt.team_id);
    const groupTies = ((ties ?? []) as Tie[]).filter((t) => t.group_id === group.id);
    const members = teamRows.filter((t) => ids.includes(t.id));
    const standings = calculateTieStandings(tournamentId, group.id, members, groupTies, (rubbers ?? []) as Match[], snapBy, disqualified, walkover);
    const complete = groupTies.length > 0 && groupTies.every((t) => t.status === "completed");
    // Everyone plays on after the groups; "plate" reads as "to the lower draw".
    applyQualification(standings, qualify, complete, Math.max(0, ids.length - qualify));
    for (const s of standings) {
      const o = overrides.get(`${s.group_id}|${s.team_id}`);
      if (o) {
        s.status = o as typeof s.status;
        s.manual_status_override = true;
      }
    }
    rows.push(...standings);
  }
  await db().from("standings_snapshots").delete().eq("tournament_id", tournamentId);
  if (rows.length) {
    const { error } = await db().from("standings_snapshots").insert(rows);
    if (error) throw new Error(error.message);
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Line-ups                                                            */
/* ------------------------------------------------------------------ */

export interface Lineup {
  S1: string | null;
  S2: string | null;
  D: (string | null)[];
}

export type LineupResult = { ok: true } | { ok: false; message: string };

/**
 * A captain's nominations for one side of a tie. Free until the line-ups are
 * locked; after that only with a stated reason, which is audited as a late
 * change. A rubber already under way never changes its players.
 */
export async function setLineup(
  tieId: string,
  side: "A" | "B",
  lineup: Lineup,
  actorRole: string,
  opts: { lateChangeReason?: string } = {},
): Promise<LineupResult> {
  const { data: tie } = await db().from("ties").select("*").eq("id", tieId).single();
  if (!tie) return { ok: false, message: "Tie not found." };
  const t = tie as Tie;
  const teamId = side === "A" ? t.team_a_id : t.team_b_id;
  if (!teamId) return { ok: false, message: "That side of the tie is not known yet." };
  if (t.lineup_locked_at && !opts.lateChangeReason?.trim()) {
    return { ok: false, message: "The line-ups are locked. A change now needs a reason, and is recorded as a late change." };
  }
  const { data: players } = await db().from("players").select("id").eq("team_id", teamId);
  const problems = lineupProblems(lineup, ((players ?? []) as { id: string }[]).map((p) => p.id));
  if (problems.length) return { ok: false, message: problems.join(" ") };

  const rubbers = await tieRubbers(tieId);
  const field = side === "A" ? "team_a_player_ids" : "team_b_player_ids";
  for (const r of rubbers) {
    const ids = lineupFor(r.rubber_type as RubberType, lineup);
    const current = (r[field] ?? []) as string[];
    const same = JSON.stringify(current) === JSON.stringify(ids ?? []);
    if (!same && !["scheduled", "ready"].includes(r.status)) {
      return { ok: false, message: `${RUBBER_LABELS[r.rubber_type as RubberType]} is already under way; its players cannot change.` };
    }
  }
  for (const r of rubbers) {
    const ids = lineupFor(r.rubber_type as RubberType, lineup);
    if (["scheduled", "ready"].includes(r.status)) {
      await db().from("matches").update({ [field]: ids, updated_at: new Date().toISOString() }).eq("id", r.id);
    }
  }
  await audit({
    tournament_id: t.tournament_id,
    actor_role: actorRole,
    action: t.lineup_locked_at ? "LINEUP_LATE_CHANGE" : "LINEUP_SET",
    entity_type: "tie",
    entity_id: tieId,
    new_value: { side, lineup, reason: opts.lateChangeReason ?? null },
  });
  return { ok: true };
}

/** Locks both line-ups. Refused until every rubber has its players on both sides. */
export async function lockLineups(tieId: string, actorRole: string): Promise<LineupResult> {
  const rubbers = await tieRubbers(tieId);
  const missing = rubbers.filter((r) => !(r.team_a_player_ids?.length && r.team_b_player_ids?.length));
  if (missing.length) {
    return { ok: false, message: `Both captains must nominate every rubber first (${missing.map((r) => RUBBER_LABELS[r.rubber_type as RubberType]).join(", ")} missing).` };
  }
  const { data: tie } = await db()
    .from("ties")
    .update({ lineup_locked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", tieId)
    .select("tournament_id")
    .single();
  await audit({ tournament_id: tie?.tournament_id ?? null, actor_role: actorRole, action: "LINEUPS_LOCKED", entity_type: "tie", entity_id: tieId });
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* The tie result                                                      */
/* ------------------------------------------------------------------ */

export type TieResult =
  | { ok: true; tie: Tie }
  | { ok: false; reason: "downstream_started"; message: string };

/**
 * Recomputes a tie from its rubbers: the rubber score, the dead rubbers to drop
 * or bring back, the winner, and where the winner and loser go next. Safe to
 * call any number of times. When the result changes after the next tie has
 * started (an undo of the deciding rubber), nothing is changed and the refusal
 * says why — silently rewriting a tie in progress is worse than asking.
 */
export async function applyTieResult(tieId: string, opts: { dryRun?: boolean } = {}): Promise<TieResult> {
  const { data: tieRow } = await db().from("ties").select("*").eq("id", tieId).single();
  if (!tieRow) throw new Error("Tie not found");
  const tie = tieRow as Tie;
  const tournament = await tournamentOf(tie.tournament_id);
  const rubbers = await tieRubbers(tieId);
  const playDead = tie.stage === "group" || tournament.format_config?.ties?.playDeadRubbersInPlacement === true;
  const outcome = tieOutcome(
    rubbers.map((r) => ({
      id: r.id,
      status: r.status,
      winner: r.winner_team_id ? (r.winner_team_id === tie.team_a_id ? "A" : "B") : null,
    })),
    playDead,
  );
  const winnerId = outcome.winner === "A" ? tie.team_a_id : outcome.winner === "B" ? tie.team_b_id : null;
  const loserId = outcome.winner === "A" ? tie.team_b_id : outcome.winner === "B" ? tie.team_a_id : null;
  const winnerChanged = winnerId !== tie.winner_team_id;

  // Refuse before writing anything if advancement must move out of a tie that has started.
  if (winnerChanged && tie.winner_team_id) {
    const targets = [tie.winner_to_tie_id, tie.loser_to_tie_id].filter(Boolean) as string[];
    if (targets.length) {
      const { data: next } = await db().from("ties").select("id, status").in("id", targets);
      if (((next ?? []) as { status: string }[]).some((n) => n.status !== "scheduled")) {
        return {
          ok: false,
          reason: "downstream_started",
          message: "The next tie has already started, so this result cannot change. Correct the later tie first.",
        };
      }
    }
  }
  if (opts.dryRun) return { ok: true, tie };

  const now = new Date().toISOString();
  if (outcome.cancel.length) await db().from("matches").update({ status: "cancelled", updated_at: now }).in("id", outcome.cancel);
  if (outcome.restore.length) await db().from("matches").update({ status: "scheduled", updated_at: now }).in("id", outcome.restore);

  const patch = {
    rubbers_a: outcome.rubbersA,
    rubbers_b: outcome.rubbersB,
    status: outcome.status,
    winner_team_id: winnerId,
    ended_at: outcome.status === "completed" ? (tie.ended_at ?? now) : null,
    updated_at: now,
  };
  const { data: updated } = await db().from("ties").update(patch).eq("id", tieId).select("*").single();

  if (winnerChanged) {
    await placeInto(tie.winner_to_tie_id, tie.winner_to_side, winnerId);
    await placeInto(tie.loser_to_tie_id, tie.loser_to_side, loserId);
    await audit({
      tournament_id: tie.tournament_id,
      actor_role: "system",
      action: winnerId ? "TIE_DECIDED" : "TIE_REOPENED",
      entity_type: "tie",
      entity_id: tieId,
      new_value: { winner_team_id: winnerId, rubbers: `${outcome.rubbersA}-${outcome.rubbersB}` },
    });
  }
  if (tie.stage === "group") await recalcTieStandings(tie.tournament_id);
  return { ok: true, tie: updated as Tie };
}

/** Puts a nation (or nobody) on one side of a later tie and of all its rubbers. */
async function placeInto(tieId: string | null, side: "A" | "B" | null, teamId: string | null) {
  if (!tieId || !side) return;
  const field = side === "A" ? "team_a_id" : "team_b_id";
  const players = side === "A" ? "team_a_player_ids" : "team_b_player_ids";
  const now = new Date().toISOString();
  await db().from("ties").update({ [field]: teamId, lineup_locked_at: null, updated_at: now }).eq("id", tieId);
  // A different nation means different players: the nominations start again.
  await db().from("matches").update({ [field]: teamId, [players]: null, updated_at: now }).eq("tie_id", tieId);
}

/* ------------------------------------------------------------------ */
/* Placement draws                                                     */
/* ------------------------------------------------------------------ */

export type PlacementResult = { ok: true; ties: number } | { ok: false; message: string };

/**
 * Draws every placement tie from the final group standings: the top two of
 * each group into the 1st–8th draw, the rest into the lower draws, and every
 * later round waiting for its winners and losers. Refused while a group tie is
 * unfinished, and when the draws already exist.
 */
export async function drawPlacement(tournamentId: string, actorRole: string): Promise<PlacementResult> {
  const tournament = await tournamentOf(tournamentId);
  const [{ data: groups }, { data: ties }, { data: courts }, { data: teams }] = await Promise.all([
    db().from("groups").select("*").eq("tournament_id", tournamentId).order("group_order"),
    db().from("ties").select("*").eq("tournament_id", tournamentId).order("tie_order"),
    db().from("courts").select("*").eq("tournament_id", tournamentId).order("court_order"),
    db().from("teams").select("*").eq("tournament_id", tournamentId),
  ]);
  const all = (ties ?? []) as Tie[];
  if (all.some((t) => t.stage === "placement")) return { ok: false, message: "The placement draws have already been made." };
  const groupTies = all.filter((t) => t.stage === "group");
  if (!groupTies.length) return { ok: false, message: "There is no group stage to draw from." };
  const open = groupTies.filter((t) => t.status !== "completed");
  if (open.length) return { ok: false, message: `${open.length} group tie${open.length === 1 ? " is" : "s are"} not finished yet.` };

  const standings = await recalcTieStandings(tournamentId);
  const groupList = (groups ?? []) as Group[];
  const sizes = new Set(groupList.map((g) => standings.filter((s) => s.group_id === g.id).length));
  if (sizes.size !== 1) return { ok: false, message: "Every group needs the same number of nations for the placement draws." };
  let plan: PlannedTie[];
  try {
    plan = placementPlan(groupList.length, [...sizes][0]);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }

  const teamById = new Map(((teams ?? []) as Team[]).map((t) => [t.id, t]));
  const teamAt = (group: number, position: number) =>
    standings.find((s) => s.group_id === groupList[group].id && s.rank === position)?.team_id ?? null;
  const idOf = new Map(plan.map((p) => [p.key, randomUUID()]));
  const courtList = (courts ?? []) as Court[];
  const base = Math.max(0, ...all.map((t) => t.tie_order));
  const rows = plan.map((p, i) => ({
    id: idOf.get(p.key)!,
    tournament_id: tournamentId,
    stage: "placement" as const,
    group_id: null,
    draw_from: p.drawFrom,
    draw_to: p.drawTo,
    places_from: p.placesFrom,
    places_to: p.placesTo,
    round_no: p.roundNo,
    round_name: p.roundName,
    tie_order: base + i + 1,
    court_id: courtList.length ? courtList[i % courtList.length].id : null,
    scheduled_time: null,
    team_a_id: p.a.kind === "group" ? teamAt(p.a.group, p.a.position) : null,
    team_b_id: p.b.kind === "group" ? teamAt(p.b.group, p.b.position) : null,
    winner_to_tie_id: p.winnerTo ? idOf.get(p.winnerTo.key)! : null,
    winner_to_side: p.winnerTo?.side ?? null,
    loser_to_tie_id: p.loserTo ? idOf.get(p.loserTo.key)! : null,
    loser_to_side: p.loserTo?.side ?? null,
  }));
  // Later rounds are referenced before they exist, so insert without the links
  // first, then add them.
  const { error } = await db().from("ties").insert(rows.map((r) => ({ ...r, winner_to_tie_id: null, loser_to_tie_id: null })));
  if (error) return { ok: false, message: error.message };
  for (const r of rows) {
    if (r.winner_to_tie_id || r.loser_to_tie_id) {
      await db().from("ties").update({ winner_to_tie_id: r.winner_to_tie_id, loser_to_tie_id: r.loser_to_tie_id }).eq("id", r.id);
    }
  }
  const { data: maxMatch } = await db()
    .from("matches")
    .select("match_order")
    .eq("tournament_id", tournamentId)
    .order("match_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const firstOrder = ((maxMatch as { match_order: number } | null)?.match_order ?? 0) + 1;
  const rubbers = rows.flatMap((t, i) => {
    const label = `${t.round_name} · ${code(teamById.get(t.team_a_id ?? ""))} v ${code(teamById.get(t.team_b_id ?? ""))}`;
    return rubberRows(tournament, t, t.team_a_id && t.team_b_id ? label : t.round_name, firstOrder + i * 3);
  });
  const { error: mErr } = await db().from("matches").insert(rubbers);
  if (mErr) return { ok: false, message: mErr.message };

  await audit({
    tournament_id: tournamentId,
    actor_role: actorRole,
    action: "PLACEMENT_DRAWN",
    entity_type: "tournament",
    entity_id: tournamentId,
    new_value: { ties: rows.length },
  });
  return { ok: true, ties: rows.length };
}

/** Deletes the placement draws, if none of their rubbers has started. */
export async function resetPlacement(tournamentId: string, actorRole: string): Promise<PlacementResult> {
  const placementIds = new Set((await getTies(tournamentId)).filter((t) => t.stage === "placement").map((t) => t.id));
  const { data: rubbers } = await db().from("matches").select("id, tie_id, status").eq("tournament_id", tournamentId).not("tie_id", "is", null);
  const played = ((rubbers ?? []) as Pick<Match, "id" | "tie_id" | "status">[]).filter(
    (r) => r.tie_id && placementIds.has(r.tie_id) && !["scheduled", "ready", "cancelled"].includes(r.status),
  );
  if (played.length) {
    return { ok: false, message: `${played.length} placement rubber${played.length === 1 ? " has" : "s have"} been played; the draws cannot be reset.` };
  }
  await db().from("ties").delete().eq("tournament_id", tournamentId).eq("stage", "placement");
  await audit({ tournament_id: tournamentId, actor_role: actorRole, action: "PLACEMENT_RESET", entity_type: "tournament", entity_id: tournamentId });
  return { ok: true, ties: 0 };
}

/** The final places decided so far, 1st first. */
export async function finalPlacings(tournamentId: string): Promise<{ place: number; team_id: string }[]> {
  const ties = (await getTies(tournamentId)).filter((t) => t.stage === "placement" && t.places_from !== null && t.winner_team_id);
  const out: { place: number; team_id: string }[] = [];
  for (const t of ties) {
    const loser = t.winner_team_id === t.team_a_id ? t.team_b_id : t.team_a_id;
    out.push({ place: t.places_from!, team_id: t.winner_team_id! });
    if (loser) out.push({ place: t.places_to!, team_id: loser });
  }
  return out.sort((a, b) => a.place - b.place);
}

/**
 * Whether a finished rubber may be reopened by an undo: refused when doing so
 * would change who won its tie after the tie that nation went on to has started.
 */
export async function canReopenRubber(match: Pick<Match, "id" | "tie_id">): Promise<TieResult> {
  if (!match.tie_id) return { ok: true } as TieResult;
  const { data: tieRow } = await db().from("ties").select("*").eq("id", match.tie_id).single();
  const tie = tieRow as Tie | null;
  if (!tie?.winner_team_id) return { ok: true, tie: tie! };
  const rubbers = await tieRubbers(match.tie_id);
  const outcome = tieOutcome(
    rubbers.map((r) =>
      r.id === match.id
        ? { id: r.id, status: "live" as const, winner: null }
        : { id: r.id, status: r.status, winner: r.winner_team_id ? (r.winner_team_id === tie.team_a_id ? "A" : "B") : null },
    ),
    true,
  );
  const winnerId = outcome.winner === "A" ? tie.team_a_id : outcome.winner === "B" ? tie.team_b_id : null;
  if (winnerId === tie.winner_team_id) return { ok: true, tie };
  const targets = [tie.winner_to_tie_id, tie.loser_to_tie_id].filter(Boolean) as string[];
  if (!targets.length) return { ok: true, tie };
  const { data: next } = await db().from("ties").select("id, status").in("id", targets);
  if (((next ?? []) as { status: string }[]).some((n) => n.status !== "scheduled")) {
    return {
      ok: false,
      reason: "downstream_started",
      message: "This rubber decided its tie, and the next tie has already started, so it cannot be reopened. Correct the later tie first.",
    };
  }
  return { ok: true, tie };
}

/** A tie tournament's live data reset: placement draws gone, group ties back to 0-0, line-ups kept. */
export async function resetTies(tournamentId: string) {
  await db().from("ties").delete().eq("tournament_id", tournamentId).eq("stage", "placement");
  await db()
    .from("ties")
    .update({ status: "scheduled", rubbers_a: 0, rubbers_b: 0, winner_team_id: null, ended_at: null, updated_at: new Date().toISOString() })
    .eq("tournament_id", tournamentId);
}

/* ------------------------------------------------------------------ */
/* Order of play                                                       */
/* ------------------------------------------------------------------ */

export type DelayResult = { ok: true; ties: number; rubbers: number } | { ok: false; message: string };

/**
 * Pushes the rest of the order of play back — after rain, or a long match
 * before it — on one court or all of them. Moves every tie not yet started and
 * every rubber not yet started (including the later rubbers of a tie under way);
 * nothing already played or in play moves. A negative number brings play forward.
 */
export async function delayOrderOfPlay(
  tournamentId: string,
  minutes: number,
  courtId: string | null,
  actorRole: string,
): Promise<DelayResult> {
  const m = Math.round(minutes);
  if (!Number.isFinite(m) || m === 0 || Math.abs(m) > MAX_DELAY_MINUTES) {
    return { ok: false, message: `Give a delay of 1 to ${MAX_DELAY_MINUTES} minutes.` };
  }
  let tieQuery = db().from("ties").select("id, scheduled_time").eq("tournament_id", tournamentId).eq("status", "scheduled").not("scheduled_time", "is", null);
  let rubberQuery = db()
    .from("matches")
    .select("id, scheduled_time")
    .eq("tournament_id", tournamentId)
    .not("tie_id", "is", null)
    .in("status", ["scheduled", "ready"])
    .not("scheduled_time", "is", null);
  if (courtId) {
    tieQuery = tieQuery.eq("court_id", courtId);
    rubberQuery = rubberQuery.eq("court_id", courtId);
  }
  const [{ data: ties }, { data: rubbers }] = await Promise.all([tieQuery, rubberQuery]);
  const now = new Date().toISOString();
  for (const row of ties ?? []) {
    await db().from("ties").update({ scheduled_time: shiftTime(row.scheduled_time as string, m) }).eq("id", row.id);
  }
  for (const row of rubbers ?? []) {
    await db().from("matches").update({ scheduled_time: shiftTime(row.scheduled_time as string, m), updated_at: now }).eq("id", row.id);
  }
  await audit({
    tournament_id: tournamentId,
    actor_role: actorRole,
    action: "ORDER_OF_PLAY_DELAYED",
    entity_type: "court",
    entity_id: courtId,
    new_value: { minutes: m, ties: ties?.length ?? 0, rubbers: rubbers?.length ?? 0 },
  });
  return { ok: true, ties: ties?.length ?? 0, rubbers: rubbers?.length ?? 0 };
}

/**
 * Puts a tie on a court, not before a time. Its rubbers not yet started follow it
 * there, the first at the tie's time and each after about a rubber's length, so
 * the court TVs, the public order of play and a later delay all read one plan.
 * A rubber already on court stays where it is.
 */
export async function scheduleTie(
  tieId: string,
  courtId: string | null,
  at: string | null,
  actorRole: string,
): Promise<LineupResult> {
  const { data: tie } = await db().from("ties").select("id, tournament_id, status, court_id, scheduled_time").eq("id", tieId).single();
  if (!tie) return { ok: false, message: "That tie no longer exists." };
  if (tie.status === "completed") return { ok: false, message: "That tie is finished." };
  if (courtId) {
    const { data: court } = await db().from("courts").select("id").eq("id", courtId).eq("tournament_id", tie.tournament_id).single();
    if (!court) return { ok: false, message: "That court is not in this event." };
  }
  await db().from("ties").update({ court_id: courtId, scheduled_time: at }).eq("id", tieId);
  const { data: rubbers } = await db().from("matches").select("id, rubber_no").eq("tie_id", tieId).in("status", ["scheduled", "ready"]);
  const now = new Date().toISOString();
  for (const r of rubbers ?? []) {
    const time = at ? shiftTime(at, ((r.rubber_no as number) - 1) * RUBBER_GAP_MINUTES) : null;
    await db().from("matches").update({ court_id: courtId, scheduled_time: time, updated_at: now }).eq("id", r.id);
  }
  await audit({
    tournament_id: tie.tournament_id,
    actor_role: actorRole,
    action: "TIE_SCHEDULED",
    entity_type: "tie",
    entity_id: tieId,
    old_value: { court_id: tie.court_id, scheduled_time: tie.scheduled_time },
    new_value: { court_id: courtId, scheduled_time: at },
  });
  return { ok: true };
}
