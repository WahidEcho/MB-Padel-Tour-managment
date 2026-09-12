import { db } from "./supabase";
import { audit, slugify } from "./audit";
import { roundRobin } from "./roundrobin";
import { calculateStandings, applyQualification, isFinished, type MatchResultInput } from "./standings";
import { scoringConfigForMatch } from "./scoring/rules";
import { DEFAULT_FOCAL } from "./portrait";
import { advanceTarget, buildBracketPlan, stageForRound, type Qualifier } from "./bracket";
import {
  getBracket,
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
import type { Match, MatchSnapshot, Standing, Team, Tournament } from "./types";

/* ------------------------------------------------------------------ */
/* Group match generation                                              */
/* ------------------------------------------------------------------ */

export async function generateGroupMatches(tournamentId: string, actorRole: string) {
  const [groups, groupTeams, courts] = await Promise.all([
    getGroups(tournamentId),
    getGroupTeams(tournamentId),
    getCourts(tournamentId),
  ]);
  if (groups.length === 0) throw new Error("No groups created yet");

  // Regenerating replaces all existing group-stage matches (and their events)
  await db().from("matches").delete().eq("tournament_id", tournamentId).eq("stage", "group");

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

/* ------------------------------------------------------------------ */
/* Standings                                                           */
/* ------------------------------------------------------------------ */

export async function recalcStandings(tournamentId: string) {
  const tournament = await getTournament(tournamentId);
  if (!tournament) throw new Error("Tournament not found");
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
  const qualifyPerGroup = tournament.format_config?.qualifyPerGroup ?? 2;

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
    applyQualification(standings, qualifyPerGroup, groupComplete);
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
/* Knockout bracket                                                    */
/* ------------------------------------------------------------------ */

export async function generateBracket(tournamentId: string, actorRole: string) {
  const tournament = await getTournament(tournamentId);
  if (!tournament) throw new Error("Tournament not found");
  const [groups, standings] = await Promise.all([getGroups(tournamentId), getStandings(tournamentId)]);
  const qualifyPerGroup = tournament.format_config?.qualifyPerGroup ?? 2;

  const qualifiers: Qualifier[] = [];
  for (const [gi, group] of groups.entries()) {
    const groupRows = standings
      .filter((s) => s.group_id === group.id)
      .sort((a, b) => a.rank - b.rank);
    for (const row of groupRows) {
      const qualified = row.status === "qualified" || (row.status === "pending" && row.rank <= qualifyPerGroup);
      if (qualified && row.status !== "disqualified") {
        qualifiers.push({ teamId: row.team_id, groupOrder: gi, rank: row.rank });
      }
    }
  }
  if (qualifiers.length < 2) throw new Error("Not enough qualified teams to build a bracket");

  // Replace any existing draft bracket (and its knockout matches)
  const existing = await getBracket(tournamentId);
  if (existing) {
    await db().from("matches").delete().eq("tournament_id", tournamentId).neq("stage", "group");
    await db().from("brackets").delete().eq("id", existing.id);
  }

  const plan = buildBracketPlan(qualifiers, tournament.format_config?.thirdPlaceMatch ?? true);
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
    new_value: { qualifiers: qualifiers.length },
  });
  return bracket.id as string;
}

/**
 * Chess (and other group-less sports): seed a knockout bracket directly from the
 * team/player list — no group stage. Reuses the same bracket plan + slots so the
 * editor, publish, and auto-advance paths all work unchanged.
 */
export async function generateKnockoutFromTeams(tournamentId: string, actorRole: string) {
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

  const existing = await getBracket(tournamentId);
  if (existing) {
    await db().from("matches").delete().eq("tournament_id", tournamentId).neq("stage", "group");
    await db().from("brackets").delete().eq("id", existing.id);
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
 * Publishing creates the knockout matches from the slots and auto-advances
 * lucky teams (byes) without a score (spec §5.3).
 */
export async function publishBracket(tournamentId: string, actorRole: string) {
  const bracket = await getBracket(tournamentId);
  if (!bracket) throw new Error("No bracket to publish");
  const slots = await getBracketSlots(bracket.id);
  const courts = await getCourts(tournamentId);

  const { data: maxOrderRow } = await db()
    .from("matches")
    .select("match_order")
    .eq("tournament_id", tournamentId)
    .order("match_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  let order = (maxOrderRow?.match_order ?? 0) + 1;

  const roundNames = [...new Set(slots.map((s) => s.round_name))];
  const byRound = (r: string) => slots.filter((s) => s.round_name === r).sort((a, b) => a.slot_order - b.slot_order);

  for (const roundName of roundNames) {
    const roundSlots = byRound(roundName);
    for (let i = 0; i < roundSlots.length; i += 2) {
      const a = roundSlots[i];
      const b = roundSlots[i + 1];
      const matchIndex = i / 2;
      if (a.is_bye || b.is_bye) {
        // Lucky team advances without a match
        const lucky = a.is_bye ? b : a;
        const target = advanceTarget(roundName, matchIndex);
        if (lucky.team_id && target) {
          await db()
            .from("bracket_slots")
            .update({ team_id: lucky.team_id, source_type: "bye_advance" })
            .eq("bracket_id", bracket.id)
            .eq("round_name", target.roundName)
            .eq("slot_order", target.slotOrder);
          await audit({
            tournament_id: tournamentId,
            actor_role: actorRole,
            action: "BYE_ADVANCE",
            entity_type: "team",
            entity_id: lucky.team_id,
            new_value: { from: roundName, to: target.roundName },
          });
        }
        continue;
      }
      const { data: match, error } = await db()
        .from("matches")
        .insert({
          tournament_id: tournamentId,
          stage: stageForRound(roundName),
          round_name: `${roundName}${roundSlots.length > 2 ? matchIndex + 1 : ""}`,
          match_order: order++,
          court_id: courts.length > 0 ? courts[matchIndex % courts.length].id : null,
          team_a_id: a.team_id,
          team_b_id: b.team_id,
          status: "scheduled",
        })
        .select()
        .single();
      if (error) throw new Error(error.message);
      await db().from("bracket_slots").update({ match_id: match.id }).in("id", [a.id, b.id]);
    }
  }

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
  });
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
      active_scoring_device_id: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", match.id);
  if (error) throw new Error(error.message);

  await audit({
    tournament_id: match.tournament_id,
    actor_role: opts.actorRole,
    action: `MATCH_${opts.status.toUpperCase()}`,
    entity_type: "match",
    entity_id: match.id,
    new_value: { winner_team_id: opts.winnerTeamId, note: opts.note ?? null },
  });

  if (match.stage === "friendly") {
    // Friendly sessions award individual player points instead of team
    // standings or bracket advancement. Imported lazily to keep the friendly
    // module out of the tournament code path.
    const { applyFriendlyResult } = await import("./friendly/ops");
    await applyFriendlyResult({ ...match, winner_team_id: opts.winnerTeamId }, opts);
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
      scoring_config: opts.copyScoring ? source.scoring_config : undefined,
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

  await db().from("screen_settings").insert({ tournament_id: newId, screen_key: "main" });
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
  completedSets: { teamAGames: number; teamBGames: number; tiebreak?: { a: number; b: number } }[];
  servingTeam: "A" | "B" | null;
  winner: "A" | "B" | null;
  matchOver: boolean;
}

export async function upsertSnapshotFromState(
  match: Match,
  state: EngineStateLike,
  lastEventNumber: number
) {
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
    completed_sets: state.completedSets,
    snapshot_json: state as unknown as Record<string, unknown>,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db().from("match_score_snapshots").upsert(row, { onConflict: "match_id" });
  if (error) throw new Error(error.message);
  return row as unknown as MatchSnapshot;
}
