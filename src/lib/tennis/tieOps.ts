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
import { MAX_DELAY_MINUTES, RUBBER_GAP_MINUTES, RUBBER_LABELS, lineupFor, retiredInTie, rubberPlan, shiftTime, tieOutcome } from "./ties";
import { changedRubbers, checkLineup, issueText, needsReason, rubberEditable, unaccepted, warningsForChange, type LineupIssue } from "./lineupRules";
import { calculateTieStandings } from "./tieStandings";
import { placementPlan, type DrawLots, type PlannedTie } from "./placement";

/** The singles of a placement play-off below the main draw (Reg 51): two sets and a match tie-break. */
export const SHORT_SINGLES = { setsToWinMatch: 2, matchTiebreak: true, matchTiebreakPoints: 10 } as const;

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
/** What a draw did besides the ties: coach codes made for the event's teams (owner's decision, 20 Oct 2026). */
export interface DrawReport {
  coachCodesCreated?: number;
}

export async function generateGroupTies(tournamentId: string, actorRole: string, report?: DrawReport): Promise<number> {
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
  // The draw is confirmed: every team of the event gets its coach code (idempotent; a team
  // with a working code gets nothing). Never fails the draw.
  if (tieRows.length) {
    const { coachCodesOnDraw } = await import("../coaches/autoCodes");
    const codes = await coachCodesOnDraw(tournamentId, actorRole);
    if (report) report.coachCodesCreated = codes.created;
  }
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
      db().from("matches").select("id, tie_id, team_a_id, team_b_id, status, winner_team_id, rubber_type, stage").eq("tournament_id", tournamentId).not("tie_id", "is", null),
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
    const rulesFor = (r: Pick<Match, "id" | "rubber_type">) =>
      scoringConfigForMatch(tournament, { stage: "group", id: r.id }, null, { doubles: r.rubber_type === "D" });
    const standings = calculateTieStandings(tournamentId, group.id, members, groupTies, (rubbers ?? []) as Match[], snapBy, disqualified, walkover, rulesFor);
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

/** What a desk operation answers. */
export type OpResult = { ok: true } | { ok: false; message: string };

export type LineupRefusalCode = "not_here" | "side_unknown" | "problems" | "under_way" | "warnings" | "reason";

export type LineupResult =
  | { ok: true; changed: RubberType[]; accepted: LineupIssue[]; lateChange: boolean }
  | { ok: false; code: LineupRefusalCode; message: string; problems?: LineupIssue[]; warnings?: LineupIssue[] };

/** One answer for an unknown tie and another tournament's (the same words as rowGuards' ownershipRefusal). */
export const TIE_NOT_HERE = "That tie is not part of this tournament. Reload the page.";

export const REASON_NEEDED = "The line-ups are locked. A change now needs a reason; it is recorded as a late change (ITF Reg. 46).";

/** A side's line-up as its rubbers hold it now. */
export function lineupOfRubbers(rubbers: Pick<Match, "rubber_type" | "team_a_player_ids" | "team_b_player_ids">[], side: "A" | "B"): Lineup {
  const field = side === "A" ? "team_a_player_ids" : "team_b_player_ids";
  const of = (type: RubberType) => rubbers.find((r) => r.rubber_type === type)?.[field] ?? null;
  const d = of("D");
  return { S1: of("S1")?.[0] ?? null, S2: of("S2")?.[0] ?? null, D: d?.length ? [...d] : [null, null] };
}

/** A side's retired players (Reg 50) and the rubbers still to play, for checkLineup. */
export function tieContext(rubbers: Pick<Match, "rubber_type" | "status" | "winner_team_id" | "team_a_player_ids" | "team_b_player_ids">[], tie: Pick<Tie, "team_a_id">, side: "A" | "B") {
  const retired = retiredInTie(
    rubbers.map((r) => ({
      status: r.status,
      winner: r.winner_team_id ? (r.winner_team_id === tie.team_a_id ? "A" : "B") : null,
      playersA: r.team_a_player_ids,
      playersB: r.team_b_player_ids,
    })),
    side,
  );
  const open = rubbers.filter((r) => rubberEditable(r.status) || r.status === "live" || r.status === "paused").map((r) => r.rubber_type as RubberType);
  return { retired, open };
}

/**
 * A captain's nominations for one side of a tie. Problems refuse it (lineupRules.ts);
 * warnings (the order of merit, Reg 43; a retired player named again, Reg 50) let it
 * through only when `accept` names them (keys `A:<key>` or `<key>`), and are recorded
 * with it. Free until the line-ups are locked; after that every change of a named
 * player needs a stated reason and is audited as a late change, except naming the
 * doubles pair for the first time after the singles (Reg 43). A rubber already under
 * way never changes its players. `dryRun` checks without writing.
 */
export async function setLineup(
  tournamentId: string,
  tieId: string,
  side: "A" | "B",
  lineup: Lineup,
  actorRole: string,
  opts: { lateChangeReason?: string; accept?: readonly string[]; dryRun?: boolean; via?: string } = {},
): Promise<LineupResult> {
  // By the tie's id and the tournament it must belong to: a tie of another
  // tournament (or organisation) and an unknown id get the same answer.
  const { data: tie } = await db().from("ties").select("*").eq("id", tieId).eq("tournament_id", tournamentId).maybeSingle();
  if (!tie) return { ok: false, code: "not_here", message: TIE_NOT_HERE };
  const t = tie as Tie;
  const teamId = side === "A" ? t.team_a_id : t.team_b_id;
  if (!teamId) return { ok: false, code: "side_unknown", message: "That side of the tie is not known yet." };
  const { data: players } = await db().from("players").select("id, full_name, player_order").eq("team_id", teamId).order("player_order");
  const squad = ((players ?? []) as { id: string; full_name: string }[]).map((p) => ({ id: p.id, name: p.full_name }));
  const next: Lineup = { S1: lineup.S1 || null, S2: lineup.S2 || null, D: (lineup.D ?? []).map((x) => x || null) };

  const rubbers = await tieRubbers(tieId);
  const current = lineupOfRubbers(rubbers, side);
  const check = checkLineup(next, squad, tieContext(rubbers, t, side));
  if (check.problems.length) return { ok: false, code: "problems", message: check.problems.map(issueText).join(" "), problems: check.problems };

  const field = side === "A" ? "team_a_player_ids" : "team_b_player_ids";
  for (const r of rubbers) {
    const ids = lineupFor(r.rubber_type as RubberType, next);
    const same = JSON.stringify(r[field] ?? []) === JSON.stringify(ids ?? []);
    if (!same && !rubberEditable(r.status)) {
      return { ok: false, code: "under_way", message: `${RUBBER_LABELS[r.rubber_type as RubberType]} is already under way; its players cannot change.` };
    }
  }
  const changed = changedRubbers(current, next);
  const warnings = warningsForChange(check, changed);
  const pending = unaccepted(warnings, opts.accept, side);
  if (pending.length) {
    return { ok: false, code: "warnings", message: `${pending.map(issueText).join(" ")} Accept the exception to save it.`, warnings: pending };
  }
  const locked = Boolean(t.lineup_locked_at);
  const reason = opts.lateChangeReason?.trim() || null;
  if (needsReason(locked, current, next) && !reason) return { ok: false, code: "reason", message: REASON_NEEDED };
  const lateChange = needsReason(locked, current, next);
  if (opts.dryRun || changed.length === 0) return { ok: true, changed, accepted: warnings, lateChange };

  for (const r of rubbers) {
    if (rubberEditable(r.status)) {
      await db().from("matches").update({ [field]: lineupFor(r.rubber_type as RubberType, next), updated_at: new Date().toISOString() }).eq("id", r.id);
    }
  }
  await audit({
    tournament_id: t.tournament_id,
    actor_role: actorRole,
    action: !locked ? "LINEUP_SET" : lateChange ? "LINEUP_LATE_CHANGE" : "DOUBLES_NAMED",
    entity_type: "tie",
    entity_id: tieId,
    old_value: { side, lineup: current },
    new_value: {
      side,
      lineup: next,
      reason,
      via: opts.via ?? null,
      accepted: warnings.map((w) => ({ code: w.code, reg: w.reg, key: w.key, message: w.message })),
    },
  });
  // National team coaches (migration 0037): this side's coaches hear their own line-up (only theirs).
  const { notifyCoachLineup } = await import("../notify/hooks");
  await notifyCoachLineup(tieId, side, lateChange);
  return { ok: true, changed, accepted: warnings, lateChange };
}

/**
 * Locks both line-ups. Refused until both singles have their players on both
 * sides; the doubles may still be to be named.
 */
export async function lockLineups(tournamentId: string, tieId: string, actorRole: string): Promise<OpResult> {
  const { data: own } = await db().from("ties").select("id").eq("id", tieId).eq("tournament_id", tournamentId).maybeSingle();
  if (!own) return { ok: false, message: TIE_NOT_HERE };
  const rubbers = await tieRubbers(tieId);
  const missing = rubbers.filter((r) => r.rubber_type !== "D" && !(r.team_a_player_ids?.length && r.team_b_player_ids?.length));
  if (missing.length) {
    return { ok: false, message: `Both captains must name their singles players first (${missing.map((r) => RUBBER_LABELS[r.rubber_type as RubberType]).join(", ")} missing).` };
  }
  const { data: tie } = await db()
    .from("ties")
    .update({ lineup_locked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", tieId)
    .eq("tournament_id", tournamentId)
    .select("tournament_id")
    .single();
  await audit({ tournament_id: tie?.tournament_id ?? null, actor_role: actorRole, action: "LINEUPS_LOCKED", entity_type: "tie", entity_id: tieId });
  const { notifyLineups } = await import("../notify/hooks");
  await notifyLineups(tieId);
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
  // The doubles is played whatever the singles did (an event may opt out for its placement ties).
  const playDead = tie.stage === "group" || tournament.format_config?.ties?.playDeadRubbersInPlacement !== false;
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
    if (winnerId) {
      const { notifyTieDecided } = await import("../notify/hooks");
      await notifyTieDecided(tieId);
    }
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
export async function drawPlacement(
  tournamentId: string,
  actorRole: string,
  lots: Record<string, DrawLots> = {},
): Promise<PlacementResult> {
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
    plan = placementPlan(groupList.length, [...sizes][0], lots);
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
    return rubberRows(tournament, t, t.team_a_id && t.team_b_id ? label : t.round_name, firstOrder + i * 3).map((r) => ({ ...r, id: randomUUID() }));
  });
  const { error: mErr } = await db().from("matches").insert(rubbers);
  if (mErr) return { ok: false, message: mErr.message };

  // Singles below the main draw play two sets and a match tie-break (Reg 51).
  const fullSingles = new Map<string, boolean>(plan.map((p) => [idOf.get(p.key)!, p.fullSingles]));
  const short = rubbers.filter((r) => r.rubber_type !== "D" && !fullSingles.get(r.tie_id)).map((r) => r.id);
  await db()
    .from("tournaments")
    .update({
      scoring_config: { ...tournament.scoring_config, matchRules: { ...tournament.scoring_config?.matchRules, ...Object.fromEntries(short.map((id) => [id, SHORT_SINGLES])) } },
      format_config: { ...tournament.format_config, ties: { ...tournament.format_config?.ties, placementLots: lots } },
    })
    .eq("id", tournamentId);

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
  await dropMatchRules(tournamentId, new Set(((rubbers ?? []) as Pick<Match, "id" | "tie_id">[]).filter((r) => r.tie_id && placementIds.has(r.tie_id)).map((r) => r.id)));
  await audit({ tournament_id: tournamentId, actor_role: actorRole, action: "PLACEMENT_RESET", entity_type: "tournament", entity_id: tournamentId });
  return { ok: true, ties: 0 };
}

/** Forgets the per-match rules of rubbers that no longer exist. */
async function dropMatchRules(tournamentId: string, ids: Set<string>) {
  const tournament = await tournamentOf(tournamentId);
  const own = tournament.scoring_config?.matchRules;
  if (!own || !Object.keys(own).some((id) => ids.has(id))) return;
  const kept = Object.fromEntries(Object.entries(own).filter(([id]) => !ids.has(id)));
  await db().from("tournaments").update({ scoring_config: { ...tournament.scoring_config, matchRules: kept } }).eq("id", tournamentId);
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
  const placement = (await getTies(tournamentId)).filter((t) => t.stage === "placement").map((t) => t.id);
  if (placement.length) {
    const { data } = await db().from("matches").select("id").in("tie_id", placement);
    await dropMatchRules(tournamentId, new Set(((data ?? []) as { id: string }[]).map((r) => r.id)));
  }
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
  const { notifyTieScheduled } = await import("../notify/hooks");
  for (const row of ties ?? []) {
    await db().from("ties").update({ scheduled_time: shiftTime(row.scheduled_time as string, m) }).eq("id", row.id);
    await notifyTieScheduled(row.id as string, { court_id: courtId, scheduled_time: row.scheduled_time as string });
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
  tournamentId: string,
  tieId: string,
  courtId: string | null,
  at: string | null,
  actorRole: string,
): Promise<OpResult> {
  const { data: tie } = await db()
    .from("ties")
    .select("id, tournament_id, status, court_id, scheduled_time")
    .eq("id", tieId)
    .eq("tournament_id", tournamentId)
    .maybeSingle();
  if (!tie) return { ok: false, message: TIE_NOT_HERE };
  if (tie.status === "completed") return { ok: false, message: "That tie is finished." };
  if (courtId) {
    const { data: court } = await db().from("courts").select("id").eq("id", courtId).eq("tournament_id", tie.tournament_id).single();
    if (!court) return { ok: false, message: "That court is not in this event." };
  }
  await db().from("ties").update({ court_id: courtId, scheduled_time: at }).eq("id", tieId).eq("tournament_id", tournamentId);
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
  if (tie.court_id !== courtId || tie.scheduled_time !== at) {
    const { notifyTieScheduled } = await import("../notify/hooks");
    await notifyTieScheduled(tieId, tie.scheduled_time || tie.court_id ? { court_id: tie.court_id, scheduled_time: tie.scheduled_time } : null);
  }
  return { ok: true };
}
