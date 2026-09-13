/**
 * Cup + Plate end-to-end, against the live Supabase project.
 *
 * Four groups of four, played out, then both brackets drawn from the same group
 * stage and published together. Checks the things that would lose data or
 * mislabel a match, not just the happy path — above all that regenerating or
 * resetting one tier leaves the other tier's live draw untouched, which is the
 * one mistake in this feature that cannot be undone at an event.
 *
 * Creates and deletes its own tournament.
 *
 * Run: npx tsx --env-file=.env.local scripts/e2e/cup-plate.ts
 */
import { db } from "../../src/lib/supabase";
import { awardPoint, initialScoreState } from "../../src/lib/scoring/engine";
import {
  deleteBracketCascade,
  finalizeMatch,
  generateBracket,
  generateGroupMatches,
  groupDrawLock,
  NOT_A_TOURNAMENT_MESSAGE,
  publishBracket,
  regenerateGroupStage,
  resetTournamentLiveData,
  retractKnockout,
  summarizeBrackets,
  upsertSnapshotFromState,
} from "../../src/lib/ops";
import {
  addEntryForProfile,
  createFriendlySession,
  generateSessionGroupStage,
  generateSessionKnockout,
  setFixedPairs,
} from "../../src/lib/friendly/ops";
import { getTournament } from "../../src/lib/data";
import { getBrackets, getBracketSlots, getMatches, getStandings, getTeams } from "../../src/lib/data";
import { podiumFromMatches } from "../../src/components/WinnerDisplay";
import { DEFAULT_SCORING_CONFIG, type Match, type Team } from "../../src/lib/types";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function play(match: Match, winner: "A" | "B") {
  let state = initialScoreState("A");
  const loser = winner === "A" ? "B" : "A";
  for (let g = 0; g < 2; g++) for (let p = 0; p < 4; p++) state = awardPoint(state, loser, DEFAULT_SCORING_CONFIG);
  for (let g = 0; g < 6; g++) for (let p = 0; p < 4; p++) state = awardPoint(state, winner, DEFAULT_SCORING_CONFIG);
  if (!state.matchOver) throw new Error("engine did not finish the match");
  await upsertSnapshotFromState(match, state, 32);
  await finalizeMatch(match, {
    status: "completed",
    winnerTeamId: winner === "A" ? match.team_a_id! : match.team_b_id!,
    actorRole: "e2e",
  });
}

interface GroupStageFingerprint {
  groupMatchIds: string[];
  knockoutMatchIds: string[];
  statuses: string;
  bracketIds: string;
  slots: number;
  standings: string;
  snapshots: number;
}

/** Everything a refused regeneration must leave exactly as it was. */
async function groupStageFingerprint(tid: string): Promise<GroupStageFingerprint> {
  const matches = await getMatches(tid);
  const brackets = await getBrackets(tid);
  const { count: slots } = await db()
    .from("bracket_slots")
    .select("id", { count: "exact", head: true })
    .eq("tournament_id", tid);
  const { count: snapshots } = await db()
    .from("match_score_snapshots")
    .select("match_id", { count: "exact", head: true })
    .eq("tournament_id", tid);
  const standings = await getStandings(tid);
  return {
    groupMatchIds: matches.filter((m) => m.stage === "group").map((m) => m.id).sort(),
    knockoutMatchIds: matches.filter((m) => m.stage !== "group").map((m) => m.id).sort(),
    statuses: matches.map((m) => `${m.id}:${m.status}:${m.winner_team_id ?? ""}`).sort().join("|"),
    bracketIds: brackets.map((b) => b.id).sort().join(","),
    slots: slots ?? 0,
    standings: standings.map((st) => `${st.team_id}:${st.status}:${st.played}:${st.points}`).sort().join("|"),
    snapshots: snapshots ?? 0,
  };
}

function sameFingerprint(a: GroupStageFingerprint, b: GroupStageFingerprint): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A friendly session runs on a hidden tournament row. The group-stage guard must
 * not dead-end a session switching from knockout to groups, must never delete a
 * played session match, and the tournament tools must refuse that row.
 */
async function sessionGuards() {
  const suffix = Date.now();
  const { data: profiles, error } = await db()
    .from("player_profiles")
    .insert([1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ public_name: `E2E Guard ${suffix} P${n}`, approval_status: "approved" })))
    .select("id");
  if (error || !profiles) throw new Error(error?.message ?? "no profiles");
  const profileIds = profiles.map((p) => p.id as string);
  let backingId: string | null = null;

  try {
    const session = await createFriendlySession({
      name: `E2E Guard ${suffix}`,
      seasonId: null,
      startsAt: null,
      durationMinutes: null,
      courtCount: 2,
      pairingMode: "fixed",
      rankingModel: "win_points",
      setsToWinMatch: 1,
      gamesToWinSet: 6,
      maxPlayers: null,
      registrationDeadline: null,
      actorRole: "e2e",
    });
    backingId = session.tournament_id as string;
    for (const id of profileIds) await addEntryForProfile(session.id, id, "e2e");
    await setFixedPairs(
      session.id,
      [
        [profileIds[0], profileIds[1]],
        [profileIds[2], profileIds[3]],
        [profileIds[4], profileIds[5]],
        [profileIds[6], profileIds[7]],
      ],
      "e2e",
    );
    check("session setup: the backing row is not a tournament", (await getTournament(backingId))?.kind === "friendly_session");

    // Knockout first, untouched, then switch to a group stage.
    await generateSessionKnockout(session.id, "e2e");
    check("session setup: a knockout bracket exists", (await getBrackets(backingId)).length === 1);
    await generateSessionGroupStage(session.id, 1, "e2e");
    const switched = (await getMatches(backingId)).filter((m) => m.stage === "friendly");
    check("an untouched session knockout can still be switched to a group stage", (await getBrackets(backingId)).length === 0);
    check(
      "…and the session gets its group fixtures",
      switched.length === 6 && switched.every((m) => Boolean(m.group_id) && !m.bracket_id),
      `${switched.length} matches`,
    );
    // With no bracket left, only the kind check can lock the draw here.
    check(
      "a session's group draw is locked from the tournament tools even with no bracket",
      (await groupDrawLock(backingId)) === NOT_A_TOURNAMENT_MESSAGE,
    );

    // Knockout again; one semi-final played, the rest not yet. Then try to switch.
    await generateSessionKnockout(session.id, "e2e");
    const final = (await getMatches(backingId)).find(
      (m) => m.stage === "friendly" && m.bracket_id && m.team_a_id && m.team_b_id,
    )!;
    await play(final, "A");
    const ledgerCount = async () =>
      (await db().from("player_score_ledger").select("id", { count: "exact", head: true }).eq("session_id", session.id)).count ?? 0;
    const ledgerBefore = await ledgerCount();
    check("session setup: the played knockout banked points", ledgerBefore > 0, String(ledgerBefore));
    const unstarted = (await getMatches(backingId)).filter((m) => m.status === "scheduled").map((m) => m.id);
    check("setup: the knockout also has matches not yet played", unstarted.length > 0, String(unstarted.length));
    const ids = async (table: "groups" | "group_teams") =>
      ((await db().from(table).select("id").eq("tournament_id", backingId!)).data ?? []).map((r) => r.id as string).sort().join(",");
    const matchIdsBefore = (await getMatches(backingId)).map((m) => m.id).sort().join(",");
    const bracketsBefore = (await getBrackets(backingId)).map((b) => b.id).join(",");
    const groupsBefore = await ids("groups");
    const groupTeamsBefore = await ids("group_teams");

    let refusal = "";
    try {
      await generateSessionGroupStage(session.id, 1, "e2e");
    } catch (e) {
      refusal = e instanceof Error ? e.message : String(e);
    }
    check(
      "a session knockout with a played match cannot be switched to groups",
      refusal.includes("knockout has matches that were already played"),
      refusal || "no refusal",
    );
    check(
      "…and the refusal comes before anything is deleted",
      (await getMatches(backingId)).map((m) => m.id).sort().join(",") === matchIdsBefore &&
        (await getBrackets(backingId)).map((b) => b.id).join(",") === bracketsBefore &&
        (await ids("groups")) === groupsBefore &&
        (await ids("group_teams")) === groupTeamsBefore,
    );
    const stillThere = new Set((await getMatches(backingId)).map((m) => m.id));
    check("…including the knockout matches not yet played", unstarted.every((id) => stillThere.has(id)));
    check("…and the points it banked are still there", (await ledgerCount()) === ledgerBefore);

    // The tournament tools refuse the backing row outright.
    const resetSession = await resetTournamentLiveData(backingId, "e2e");
    check(
      "resetting live data is refused on a friendly session's backing tournament",
      !resetSession.ok && resetSession.reason === "not_a_tournament",
      resetSession.ok ? "went ahead" : resetSession.reason,
    );
    const regenSession = await regenerateGroupStage(backingId, "e2e");
    check("regenerating the group stage from the tournament tools is refused there too", !regenSession.ok && regenSession.reason === "not_a_tournament");
    check("…and so is changing the group draw", (await groupDrawLock(backingId)) === NOT_A_TOURNAMENT_MESSAGE);
    const final2 = (await getMatches(backingId)).find((m) => m.id === final.id);
    check(
      "…leaving the session's played match and its points untouched",
      final2?.status === "completed" && (await ledgerCount()) === ledgerBefore &&
        (await getMatches(backingId)).map((m) => m.id).sort().join(",") === matchIdsBefore,
    );
  } finally {
    if (backingId) await db().from("tournaments").delete().eq("id", backingId);
    await db().from("player_profiles").delete().in("id", profileIds);
    const { count: leftoverLedger } = await db()
      .from("player_score_ledger")
      .select("id", { count: "exact", head: true })
      .in("player_profile_id", profileIds);
    check("session cleanup removed its ledger rows", (leftoverLedger ?? 0) === 0, String(leftoverLedger));
  }
}

async function main() {
  console.log("— Cup + Plate end-to-end —");
  const slug = `cup-plate-${Date.now()}`;

  const { data: tournament, error } = await db()
    .from("tournaments")
    .insert({
      name: "E2E Cup + Plate",
      slug,
      sport: "padel",
      status: "active",
      is_demo: true,
      format_config: {
        type: "group_knockout",
        qualifyPerGroup: 2,
        thirdPlaceMatch: true,
        tiers: {
          cup: { thirdPlaceMatch: true, podiumDepth: 4 },
          plate: { enabled: true, perGroup: 2, thirdPlaceMatch: false, podiumDepth: 2 },
        },
      },
    })
    .select()
    .single();
  if (error || !tournament) throw new Error(error?.message ?? "no tournament");
  const tid = tournament.id as string;

  try {
    // ---------- setup: 4 courts, 16 teams, 4 groups of 4 ----------
    await db()
      .from("courts")
      .insert([1, 2, 3, 4].map((n) => ({ tournament_id: tid, court_name: `Court ${n}`, court_order: n })));

    const { data: teamRows } = await db()
      .from("teams")
      .insert(
        Array.from({ length: 16 }, (_, i) => ({
          tournament_id: tid,
          team_name: `Team ${i + 1}`,
          seed_number: i + 1,
          check_in_status: "checked_in",
        })),
      )
      .select();
    const teams = (teamRows ?? []) as Team[];
    check("16 teams created", teams.length === 16, String(teams.length));

    const { data: groupRows } = await db()
      .from("groups")
      .insert(
        ["A", "B", "C", "D"].map((letter, i) => ({
          tournament_id: tid,
          group_name: `Group ${letter}`,
          group_order: i,
          status: "published",
        })),
      )
      .select();
    const groups = groupRows ?? [];
    await db()
      .from("group_teams")
      .insert(
        teams.map((t, i) => ({
          tournament_id: tid,
          group_id: groups[Math.floor(i / 4)].id,
          team_id: t.id,
          position: (i % 4) + 1,
        })),
      );

    await generateGroupMatches(tid, "e2e");
    let matches = await getMatches(tid);
    check("24 group matches generated", matches.length === 24, String(matches.length));

    // Play every group match so the seed order decides the table: inside a group
    // the lower seed always wins, giving a predictable 1,2,3,4.
    const seedOf = new Map(teams.map((t) => [t.id, t.seed_number ?? 0]));
    for (const m of matches) {
      const aSeed = seedOf.get(m.team_a_id!) ?? 0;
      const bSeed = seedOf.get(m.team_b_id!) ?? 0;
      await play(m, aSeed < bSeed ? "A" : "B");
    }

    // ---------- qualification ----------
    const standings = await getStandings(tid);
    const groupA = standings
      .filter((s) => s.group_id === groups[0].id)
      .sort((a, b) => a.rank - b.rank);
    check(
      "group statuses read qualified, qualified, plate, plate",
      groupA.map((s) => s.status).join(",") === "qualified,qualified,plate,plate",
      groupA.map((s) => s.status).join(","),
    );
    check(
      "nobody is eliminated while a Plate is running",
      standings.every((s) => s.status !== "eliminated"),
      standings.filter((s) => s.status === "eliminated").length + " eliminated",
    );

    // ---------- draw both tiers ----------
    await generateBracket(tid, "e2e", "cup");
    await generateBracket(tid, "e2e", "plate");
    const brackets = await getBrackets(tid);
    check("two brackets exist, Cup first", brackets.map((b) => b.tier).join(",") === "cup,plate", brackets.map((b) => b.tier).join(","));
    check("each bracket is named", brackets.every((b) => ["Cup", "Plate"].includes(b.bracket_name)), brackets.map((b) => b.bracket_name).join(","));

    const cup = brackets.find((b) => b.tier === "cup")!;
    const plate = brackets.find((b) => b.tier === "plate")!;
    const cupSlots = await getBracketSlots(cup.id);
    const plateSlots = await getBracketSlots(plate.id);

    const teamsIn = (slots: { team_id: string | null }[]) =>
      new Set(slots.map((s) => s.team_id).filter(Boolean) as string[]);
    const cupTeams = teamsIn(cupSlots);
    const plateTeams = teamsIn(plateSlots);
    check("Cup has 8 entrants", cupTeams.size === 8, String(cupTeams.size));
    check("Plate has 8 entrants", plateTeams.size === 8, String(plateTeams.size));
    check(
      "the two tiers are disjoint",
      [...cupTeams].every((id) => !plateTeams.has(id)),
      [...cupTeams].filter((id) => plateTeams.has(id)).length + " shared",
    );

    const rankOf = new Map(standings.map((s) => [s.team_id, s.rank]));
    check(
      "Cup took ranks 1-2 and Plate took ranks 3-4",
      [...cupTeams].every((id) => (rankOf.get(id) ?? 9) <= 2) &&
        [...plateTeams].every((id) => (rankOf.get(id) ?? 0) >= 3),
      `cup ranks ${[...cupTeams].map((id) => rankOf.get(id)).sort().join("")}, plate ranks ${[...plateTeams].map((id) => rankOf.get(id)).sort().join("")}`,
    );

    // The Plate must get the same cross-group draw as the Cup, not flat seeding.
    const groupOf = new Map(standings.map((s) => [s.team_id, s.group_id]));
    const plateFirstRound = plateSlots
      .filter((s) => s.round_name === "QF")
      .sort((a, b) => a.slot_order - b.slot_order);
    const plateOpponentsDiffer = [0, 2, 4, 6].every((i) => {
      const a = plateFirstRound[i]?.team_id;
      const b = plateFirstRound[i + 1]?.team_id;
      return a && b && groupOf.get(a) !== groupOf.get(b);
    });
    check("Plate first round is a cross-group draw", plateOpponentsDiffer);

    check("Plate has no third-place match, as configured", !plateSlots.some((s) => s.round_name === "TP"));
    check("Cup has a third-place match", cupSlots.some((s) => s.round_name === "TP"));

    // ---------- publish both, side by side ----------
    await db().from("brackets").update({ status: "approved" }).eq("tournament_id", tid);
    await publishBracket(tid, "e2e", { courtStrategy: "parallel" });
    matches = await getMatches(tid);
    const knockout = matches.filter((m) => m.stage !== "group");
    check("every knockout match knows its bracket", knockout.every((m) => Boolean(m.bracket_id)), `${knockout.filter((m) => !m.bracket_id).length} without`);

    const plateMatches = knockout.filter((m) => m.bracket_id === plate.id);
    const cupMatches = knockout.filter((m) => m.bracket_id === cup.id);
    check("Plate rounds are labelled so they cannot be confused with the Cup", plateMatches.every((m) => (m.round_name ?? "").startsWith("Plate")), plateMatches.map((m) => m.round_name).join(","));
    check("Cup rounds keep their plain names", cupMatches.every((m) => !(m.round_name ?? "").startsWith("Plate")));

    const cupQf = cupMatches.filter((m) => m.stage === "quarter_final").sort((a, b) => a.match_order - b.match_order);
    const plateQf = plateMatches.filter((m) => m.stage === "quarter_final").sort((a, b) => a.match_order - b.match_order);
    check("both tiers have 4 quarter-finals", cupQf.length === 4 && plateQf.length === 4, `${cupQf.length}/${plateQf.length}`);

    // Parallel: the two tiers interleave, so the Cup's last quarter-final is not
    // ordered before every Plate quarter-final.
    const interleaved = plateQf[0].match_order < cupQf[3].match_order;
    check("parallel interleaves the tiers rather than queueing one behind the other", interleaved, `cup QF4 at ${cupQf[3].match_order}, plate QF1 at ${plateQf[0].match_order}`);

    const allQf = [...cupQf, ...plateQf];
    check("all 8 quarter-finals are spread over the 4 courts", new Set(allQf.map((m) => m.court_id)).size === 4, String(new Set(allQf.map((m) => m.court_id)).size));

    const semisAfterQuarters =
      Math.max(...allQf.map((m) => m.match_order)) <
      Math.min(...knockout.filter((m) => m.stage === "semi_final").map((m) => m.match_order));
    check("no semi-final is ordered before a quarter-final", semisAfterQuarters);

    // ---------- the important one: one tier's teardown spares the other ----------
    const plateMatchIdsBefore = new Set(plateMatches.map((m) => m.id));
    const plateSlotCountBefore = (await getBracketSlots(plate.id)).length;

    await generateBracket(tid, "e2e", "cup");

    const afterRedraw = await getMatches(tid);
    const plateStillThere = afterRedraw.filter((m) => plateMatchIdsBefore.has(m.id));
    check(
      "redrawing the Cup leaves every Plate match intact",
      plateStillThere.length === plateMatchIdsBefore.size,
      `${plateStillThere.length}/${plateMatchIdsBefore.size} survived`,
    );
    check(
      "redrawing the Cup leaves the Plate's slots intact",
      (await getBracketSlots(plate.id)).length === plateSlotCountBefore,
    );
    check(
      "redrawing the Cup did delete the Cup's own matches",
      afterRedraw.filter((m) => m.bracket_id === cup.id).length === 0,
      String(afterRedraw.filter((m) => m.bracket_id === cup.id).length),
    );
    check("the group stage is untouched", afterRedraw.filter((m) => m.stage === "group").length === 24, String(afterRedraw.filter((m) => m.stage === "group").length));

    // ---------- sequential, on a fresh Cup ----------
    // A redraw replaces the bracket row, so its id changes: anything holding one
    // has to re-read it. (This test held a stale id and silently checked an
    // empty set until it was fixed.)
    const cup2 = (await getBrackets(tid)).find((b) => b.tier === "cup")!;
    check("a redraw produces a new bracket row", cup2.id !== cup.id);
    await db().from("brackets").update({ status: "approved" }).eq("id", cup2.id);
    await publishBracket(tid, "e2e", { courtStrategy: "sequential" });
    const seqCupQf = (await getMatches(tid))
      .filter((m) => m.bracket_id === cup2.id && m.stage === "quarter_final")
      .sort((a, b) => a.match_order - b.match_order);
    check(
      "sequential publishes the Cup round as one contiguous block",
      seqCupQf.length === 4 && seqCupQf[3].match_order - seqCupQf[0].match_order === 3,
      seqCupQf.map((m) => m.match_order).join(","),
    );

    // ---------- a reopened result retracts the advance ----------
    const freshCupQf = seqCupQf;
    await play(freshCupQf[0], "A");
    const slotsAfterWin = await getBracketSlots(cup2.id);
    const sfSlot = slotsAfterWin.find((s) => s.round_name === "SF" && s.slot_order === 0);
    check("winning a quarter-final fills the semi-final slot", Boolean(sfSlot?.team_id), String(sfSlot?.team_id));

    const retraction = await retractKnockout({ ...freshCupQf[0], winner_team_id: freshCupQf[0].team_a_id });
    check("reopening is allowed while the next round has not started", retraction.ok);
    const slotsAfterRetract = await getBracketSlots(cup2.id);
    check(
      "reopening empties the semi-final slot again",
      !slotsAfterRetract.find((s) => s.round_name === "SF" && s.slot_order === 0)?.team_id,
    );

    // Now start the semi-final and try again: it must refuse rather than rewrite
    // a match already in progress.
    await play(freshCupQf[0], "A");
    const sfMatch = (await getMatches(tid)).find((m) => m.bracket_id === cup2.id && m.stage === "semi_final");
    if (sfMatch) {
      await db().from("matches").update({ status: "live" }).eq("id", sfMatch.id);
      const refused = await retractKnockout({ ...freshCupQf[0], winner_team_id: freshCupQf[0].team_a_id });
      check("reopening is refused once the next round has started", !refused.ok && refused.reason === "downstream_started", String(refused.reason));
      await db().from("matches").update({ status: "scheduled" }).eq("id", sfMatch.id);
    }

    // ---------- each tier gets its own podium ----------
    const allMatches = await getMatches(tid);
    const teamsById = new Map((await getTeams(tid)).map((t) => [t.id, t]));
    const cupPodium = podiumFromMatches(allMatches, teamsById, { tier: "cup", bracketId: cup2.id, depth: 4 });
    const platePodium = podiumFromMatches(allMatches, teamsById, { tier: "plate", bracketId: plate.id, depth: 2 });
    check(
      "each tier's podium reads only its own matches",
      cupPodium.tier === "cup" && platePodium.tier === "plate",
    );
    // Neither final has been played, so both podiums are empty rather than
    // borrowing the other tier's result.
    check("an unfinished tier has an empty podium, not the other tier's", cupPodium.places.length === 0 && platePodium.places.length === 0);

    // ---------- a disqualified entrant is not drafted ----------
    const fourth = standings.find((s) => s.group_id === groups[1].id && s.rank === 4);
    if (fourth) {
      await db().from("teams").update({ team_status: "disqualified" }).eq("id", fourth.team_id);
      await generateBracket(tid, "e2e", "plate");
      const redrawnPlate = (await getBrackets(tid)).find((b) => b.tier === "plate")!;
      const redrawnTeams = teamsIn(await getBracketSlots(redrawnPlate.id));
      check("a disqualified team is left out of the redraw", !redrawnTeams.has(fourth.team_id), String(redrawnTeams.size) + " entrants");
      check("the redrawn Plate gives the odd field a bye", (await getBracketSlots(redrawnPlate.id)).some((s) => s.is_bye));
      await db().from("teams").update({ team_status: "active" }).eq("id", fourth.team_id);
    }

    // ---------- teardown by tier ----------
    const plateNow = (await getBrackets(tid)).find((b) => b.tier === "plate")!;
    const { matchesDeleted } = await deleteBracketCascade(plateNow.id);
    const leftover = await getMatches(tid);
    check("resetting the Plate removes only its matches", leftover.every((m) => m.bracket_id !== plateNow.id), `${matchesDeleted} deleted`);
    check("the Cup survives the Plate being reset", leftover.some((m) => m.bracket_id === cup2.id));
    check("the Plate's slots are gone with it", (await getBracketSlots(plateNow.id)).length === 0);

    // ---------- regenerating the group stage under a drawn knockout ----------
    // Both tiers exist again: the Cup published with a played match, the Plate a draft.
    await generateBracket(tid, "e2e", "plate");
    const before = await groupStageFingerprint(tid);
    const beforeBrackets = await summarizeBrackets(tid);
    check(
      "setup: both tiers exist, the Cup with a played knockout match",
      beforeBrackets.map((b) => b.tier).join(",") === "cup,plate" && beforeBrackets[0].played > 0,
      beforeBrackets.map((b) => `${b.tier}:${b.status}:${b.played}/${b.matches}`).join(" "),
    );

    const refused = await regenerateGroupStage(tid, "e2e");
    check(
      "regenerating the group stage is refused while brackets exist",
      !refused.ok && refused.reason === "brackets_exist",
      refused.ok ? "went ahead" : refused.reason,
    );
    check(
      "the refusal tells the organiser to reset the brackets first, naming both",
      !refused.ok && refused.message.includes("Reset the brackets on the Bracket page first") && refused.message.includes("both brackets (Cup and Plate)"),
      refused.ok ? "" : refused.message,
    );
    check("a refusal changes nothing", sameFingerprint(before, await groupStageFingerprint(tid)));

    let backstopThrew = false;
    try {
      await generateGroupMatches(tid, "e2e");
    } catch {
      backstopThrew = true;
    }
    check("the low-level generator refuses too, for every other caller", backstopThrew);
    check("…and that refusal changes nothing either", sameFingerprint(before, await groupStageFingerprint(tid)));

    check("the group draw is locked while a bracket exists", Boolean(await groupDrawLock(tid)));

    const stale = await regenerateGroupStage(tid, "e2e", { confirmBrackets: [beforeBrackets[0]] });
    check(
      "a confirmation that names only the Cup cannot delete the Plate",
      !stale.ok && stale.reason === "brackets_changed",
      stale.ok ? "went ahead" : stale.reason,
    );
    check("a stale confirmation changes nothing", sameFingerprint(before, await groupStageFingerprint(tid)));

    // The organiser confirms while the Plate is an untouched draft; before the
    // submit lands, someone publishes it. Same bracket ids, but it now owns
    // matches — the confirmation described something that no longer exists.
    const plateId = beforeBrackets.find((b) => b.tier === "plate")!.id;
    await db().from("brackets").update({ status: "approved" }).eq("id", plateId);
    await publishBracket(tid, "e2e", { courtStrategy: "parallel" });
    const published = await summarizeBrackets(tid);
    check(
      "setup: the Plate is now published under the same id",
      published.find((b) => b.id === plateId)?.status === "published" && (published.find((b) => b.id === plateId)?.matches ?? 0) > 0,
    );
    const afterPublish = await groupStageFingerprint(tid);
    const outdated = await regenerateGroupStage(tid, "e2e", { confirmBrackets: beforeBrackets });
    check(
      "a confirmation given while the Plate was a draft cannot delete it once published",
      !outdated.ok && outdated.reason === "brackets_changed",
      outdated.ok ? "went ahead" : outdated.reason,
    );
    check("…and that refusal changes nothing", sameFingerprint(afterPublish, await groupStageFingerprint(tid)));

    // Confirmed against the brackets exactly as they are now.
    const current = await summarizeBrackets(tid);
    const knockoutBefore = current.reduce((n, b) => n + b.matches, 0);
    const replaced = await regenerateGroupStage(tid, "e2e", { confirmBrackets: current });
    check(
      "a confirmed regeneration deletes both brackets and their knockout matches",
      replaced.ok && replaced.bracketsDeleted === 2 && replaced.knockoutMatchesDeleted === knockoutBefore,
      replaced.ok ? `${replaced.bracketsDeleted} brackets, ${replaced.knockoutMatchesDeleted}/${knockoutBefore} matches` : replaced.reason,
    );
    const afterMatches = await getMatches(tid);
    check("no bracket is left", (await getBrackets(tid)).length === 0);
    check(
      "no knockout match is left",
      afterMatches.every((m) => m.stage === "group" && !m.bracket_id),
      `${afterMatches.filter((m) => m.stage !== "group").length} knockout`,
    );
    check(
      "the group stage is regenerated from scratch",
      afterMatches.length === 24 &&
        afterMatches.every((m) => m.status === "scheduled" && !m.winner_team_id) &&
        afterMatches.every((m) => !afterPublish.groupMatchIds.includes(m.id)),
      `${afterMatches.length} matches`,
    );
    const { count: oldSnapshots } = await db()
      .from("match_score_snapshots")
      .select("match_id", { count: "exact", head: true })
      .in("match_id", [...afterPublish.groupMatchIds, ...afterPublish.knockoutMatchIds]);
    check("the deleted matches' scores went with them", (oldSnapshots ?? 0) === 0, String(oldSnapshots));
    const freshStandings = await getStandings(tid);
    check(
      "standings are recalculated, so no team still reads as qualified from deleted results",
      freshStandings.length === 16 && freshStandings.every((st) => st.played === 0 && st.status === "pending"),
      [...new Set(freshStandings.map((st) => `${st.status}/${st.played}`))].join(" "),
    );
    const { count: auditRows } = await db()
      .from("audit_logs")
      .select("id", { count: "exact", head: true })
      .eq("tournament_id", tid)
      .eq("action", "BRACKETS_DELETED_FOR_GROUP_REGENERATION");
    check("deleting the brackets is audited", (auditRows ?? 0) === 1, String(auditRows));
    check("with no bracket left, the draw is unlocked", (await groupDrawLock(tid)) === null);
    const again = await regenerateGroupStage(tid, "e2e");
    check("with no bracket left, regenerating needs no confirmation", again.ok);

    // ---------- the live-data reset still works on a real tournament ----------
    const toPlay = (await getMatches(tid))[0];
    await play(toPlay, "A");
    const reset = await resetTournamentLiveData(tid, "e2e");
    const afterReset = await getMatches(tid);
    check(
      "resetting a tournament's live data still works",
      reset.ok && afterReset.every((m) => m.status === "scheduled" && !m.winner_team_id),
      reset.ok ? `${afterReset.filter((m) => m.status !== "scheduled").length} not scheduled` : reset.reason,
    );

    await sessionGuards();
  } finally {
    await db().from("tournaments").delete().eq("id", tid);
    const { count: leftoverMatches } = await db()
      .from("matches")
      .select("id", { count: "exact", head: true })
      .eq("tournament_id", tid);
    check("cleanup removed everything", (leftoverMatches ?? 0) === 0, String(leftoverMatches));
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
