/**
 * End-to-end smoke test against the live Supabase project.
 * Simulates a full 12-team tournament: setup → groups → matches → scoring →
 * standings → bracket → knockout → champion → clone. Cleans up afterwards.
 *
 * Run: npx tsx --env-file=.env.local scripts/smoke.ts
 */
import { db } from "../src/lib/supabase";
import { awardPoint, initialScoreState } from "../src/lib/scoring/engine";
import { generateDraw, groupName } from "../src/lib/draws";
import {
  cloneTournament,
  finalizeMatch,
  generateBracket,
  generateGroupMatches,
  publishBracket,
  upsertSnapshotFromState,
} from "../src/lib/ops";
import { getBracket, getMatches, getStandings, getTeams } from "../src/lib/data";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/types";
import type { Match } from "../src/lib/types";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function playMatch(match: Match, winner: "A" | "B", asWalkover = false) {
  if (asWalkover) {
    await finalizeMatch(match, {
      status: "walkover",
      winnerTeamId: winner === "A" ? match.team_a_id! : match.team_b_id!,
      actorRole: "smoke",
    });
    return;
  }
  let state = initialScoreState("A");
  const loser = winner === "A" ? "B" : "A";
  // Loser takes 2 games, winner takes the set 6-2
  for (let g = 0; g < 2; g++) for (let p = 0; p < 4; p++) state = awardPoint(state, loser, DEFAULT_SCORING_CONFIG);
  for (let g = 0; g < 6; g++) for (let p = 0; p < 4; p++) state = awardPoint(state, winner, DEFAULT_SCORING_CONFIG);
  if (!state.matchOver) throw new Error("engine did not finish the match");
  await upsertSnapshotFromState(match, state, 32);
  await finalizeMatch(match, {
    status: "completed",
    winnerTeamId: winner === "A" ? match.team_a_id! : match.team_b_id!,
    actorRole: "smoke",
  });
}

async function main() {
  console.log("— Move Beyond smoke test —");

  // 1. Tournament setup
  const { data: tournament, error } = await db()
    .from("tournaments")
    .insert({
      name: "SMOKE TEST Tournament",
      slug: `smoke-${Date.now()}`,
      is_demo: true,
      scoring_config: DEFAULT_SCORING_CONFIG,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  const tid = tournament.id as string;
  await db().from("courts").insert([
    { tournament_id: tid, court_name: "Court 1", court_order: 1 },
    { tournament_id: tid, court_name: "Court 2", court_order: 2 },
  ]);

  // 2. Teams
  const teamIds: string[] = [];
  for (let i = 1; i <= 12; i++) {
    const { data: team } = await db()
      .from("teams")
      .insert({ tournament_id: tid, team_name: `Smoke Team ${String(i).padStart(2, "0")}`, check_in_status: "checked_in" })
      .select()
      .single();
    teamIds.push(team!.id);
    await db().from("players").insert([
      { tournament_id: tid, team_id: team!.id, player_order: 1, full_name: `Player ${i}A` },
      { tournament_id: tid, team_id: team!.id, player_order: 2, full_name: `Player ${i}B` },
    ]);
  }
  check("12 teams created", teamIds.length === 12);

  // 3. Groups + matches
  const { data: groups } = await db()
    .from("groups")
    .insert(Array.from({ length: 4 }, (_, i) => ({
      tournament_id: tid,
      group_name: groupName(i),
      group_order: i + 1,
      status: "published",
    })))
    .select();
  const draw = generateDraw(teamIds, 4);
  await db().from("group_teams").insert(
    draw.groups.flatMap((ids, gi) =>
      ids.map((teamId, pos) => ({ tournament_id: tid, group_id: groups![gi].id, team_id: teamId, position: pos + 1 }))
    )
  );
  const matchCount = await generateGroupMatches(tid, "smoke");
  check("group matches generated (4 groups × 3)", matchCount === 12, `got ${matchCount}`);

  // 4. Play group stage (one match as walkover)
  let matches = await getMatches(tid);
  const groupMatches = matches.filter((m) => m.stage === "group");
  for (const [i, m] of groupMatches.entries()) {
    await playMatch(m, "A", i === 0);
  }
  matches = await getMatches(tid);
  check(
    "all group matches finished",
    matches.filter((m) => m.stage === "group").every((m) => ["completed", "walkover"].includes(m.status))
  );

  // 5. Standings
  const standings = await getStandings(tid);
  check("standings rows = 12", standings.length === 12, `got ${standings.length}`);
  check("8 teams qualified", standings.filter((s) => s.status === "qualified").length === 8);
  const walkoverWinner = standings.find((s) => s.team_id === groupMatches[0].team_a_id);
  check("walkover counted as 6-0 win", (walkoverWinner?.games_won ?? 0) >= 6);

  // 6. Bracket
  await generateBracket(tid, "smoke");
  let bracket = await getBracket(tid);
  check("bracket draft created", bracket?.status === "draft");
  await db().from("brackets").update({ status: "approved" }).eq("id", bracket!.id);
  await publishBracket(tid, "smoke");
  bracket = await getBracket(tid);
  check("bracket published", bracket?.status === "published");

  matches = await getMatches(tid);
  const qf = matches.filter((m) => m.stage === "quarter_final");
  check("4 quarter-finals created", qf.length === 4, `got ${qf.length}`);

  // 7. Knockout rounds — winners advance automatically
  for (let round = 0; round < 5; round++) {
    matches = await getMatches(tid);
    const playable = matches.filter(
      (m) => m.stage !== "group" && m.team_a_id && m.team_b_id && !m.winner_team_id
    );
    if (playable.length === 0) break;
    for (const m of playable) await playMatch(m, "A");
  }
  matches = await getMatches(tid);
  const final = matches.find((m) => m.stage === "final");
  const tp = matches.find((m) => m.stage === "third_place");
  check("final played with champion", Boolean(final?.winner_team_id));
  check("third-place match played", Boolean(tp?.winner_team_id));

  // 8. Clone
  const clone = await cloneTournament(
    tid,
    {
      newName: "SMOKE clone",
      copyTeams: true,
      copyPhotos: true,
      copyGroups: true,
      copySchedule: true,
      copyBranding: true,
      copyScoring: true,
      copyCourts: true,
    },
    "smoke"
  );
  const cloneTeams = await getTeams(clone.id);
  const cloneMatches = await getMatches(clone.id);
  check("clone has 12 teams", cloneTeams.length === 12, `got ${cloneTeams.length}`);
  check("clone teams reset to not_arrived", cloneTeams.every((t) => t.check_in_status === "not_arrived"));
  check(
    "clone schedule copied as scheduled with no winners",
    cloneMatches.length === 12 && cloneMatches.every((m) => m.status === "scheduled" && !m.winner_team_id),
    `got ${cloneMatches.length}`
  );

  // 9. Cleanup
  await db().from("tournaments").delete().in("id", [tid, clone.id]);
  const { data: leftover } = await db().from("teams").select("id").in("tournament_id", [tid, clone.id]);
  check("cleanup removed cascade data", (leftover ?? []).length === 0);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Smoke test crashed:", e);
  process.exit(1);
});
