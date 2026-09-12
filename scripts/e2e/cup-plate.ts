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
  publishBracket,
  retractKnockout,
  upsertSnapshotFromState,
} from "../../src/lib/ops";
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
