import Link from "next/link";
import { getBracket, getBracketSlots, getMatches, getStandings, getTeams, teamMap } from "@/lib/data";
import BracketView, { orderedRounds } from "@/components/BracketView";
import BracketSlotsEditor from "@/components/BracketSlotsEditor";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import { approveAction, generateAction, publishAction, resetBracket, saveSlots } from "./actions";

export const dynamic = "force-dynamic";

export default async function BracketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [bracket, teams, standings, matches] = await Promise.all([
    getBracket(id),
    getTeams(id),
    getStandings(id),
    getMatches(id),
  ]);
  const tm = teamMap(teams);
  const slots = bracket ? await getBracketSlots(bracket.id) : [];
  const matchMap = new Map(matches.map((m) => [m.id, m]));
  const qualifiedCount = standings.filter((s) => s.status === "qualified").length;

  const firstRound = slots.length > 0 ? orderedRounds(slots.filter((s) => s.round_name !== "TP"))[0] : null;
  const firstRoundSlots = slots
    .filter((s) => s.round_name === firstRound)
    .sort((a, b) => a.slot_order - b.slot_order);
  const oddTeams = firstRoundSlots.filter((s) => s.is_bye).length > 0;

  // Final results
  const finalMatch = matches.find((m) => m.stage === "final");
  const tpMatch = matches.find((m) => m.stage === "third_place");
  const champion = finalMatch?.winner_team_id ? tm.get(finalMatch.winner_team_id) : null;
  const runnerUp =
    finalMatch?.winner_team_id && finalMatch.team_a_id && finalMatch.team_b_id
      ? tm.get(finalMatch.winner_team_id === finalMatch.team_a_id ? finalMatch.team_b_id : finalMatch.team_a_id)
      : null;
  const third = tpMatch?.winner_team_id ? tm.get(tpMatch.winner_team_id) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">
          Knockout bracket{" "}
          {bracket && (
            <span className={`badge ${bracket.status === "published" ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}`}>
              {bracket.status}
            </span>
          )}
        </h2>
        <div className="flex flex-wrap gap-2">
          <form action={generateAction}>
            <input type="hidden" name="tournament_id" value={id} />
            <ConfirmSubmit
              className="btn-secondary text-xs"
              message={bracket ? "Regenerate the bracket from current standings? Existing knockout matches are deleted." : "Generate bracket from current group standings?"}
            >
              {bracket ? "Regenerate from standings" : "Generate bracket"}
            </ConfirmSubmit>
          </form>
          {bracket && bracket.status === "draft" && (
            <form action={approveAction}>
              <input type="hidden" name="tournament_id" value={id} />
              <button className="btn-secondary text-xs">Approve bracket</button>
            </form>
          )}
          {bracket && bracket.status === "approved" && (
            <form action={publishAction}>
              <input type="hidden" name="tournament_id" value={id} />
              <ConfirmSubmit className="btn-primary text-xs" message="Publish the bracket and create the knockout matches? Lucky teams (byes) advance automatically.">
                Publish bracket + create matches
              </ConfirmSubmit>
            </form>
          )}
          {bracket && (
            <form action={resetBracket}>
              <input type="hidden" name="tournament_id" value={id} />
              <ConfirmSubmit className="btn-secondary text-xs text-danger" message="Delete the bracket and all knockout matches?">
                Reset bracket
              </ConfirmSubmit>
            </form>
          )}
        </div>
      </div>

      {!bracket && (
        <div className="card p-8 text-center text-muted">
          <p>{qualifiedCount} team(s) currently qualified from groups.</p>
          <p className="mt-1 text-sm">
            Generate the bracket once the group stage is (nearly) done. You can edit every pairing before publishing.
          </p>
        </div>
      )}

      {(champion || runnerUp || third) && (
        <div className="card flex flex-wrap items-center justify-around gap-3 border-success/40 text-center">
          {champion && (
            <div><p className="text-2xl">🏆</p><p className="font-bold">{champion.team_name}</p><p className="text-xs text-muted">Champion</p></div>
          )}
          {runnerUp && (
            <div><p className="text-2xl">🥈</p><p className="font-bold">{runnerUp.team_name}</p><p className="text-xs text-muted">Runner-up</p></div>
          )}
          {third && (
            <div><p className="text-2xl">🥉</p><p className="font-bold">{third.team_name}</p><p className="text-xs text-muted">Third place</p></div>
          )}
        </div>
      )}

      {bracket && bracket.status !== "published" && (
        <form action={saveSlots} className="card space-y-3 border-warning/40">
          <h3 className="font-bold">Edit first-round pairings ({firstRound})</h3>
          {oddTeams && (
            <p className="rounded-xl bg-warning/10 px-3 py-2 text-xs font-semibold text-warning">
              ⚠ Odd number of qualifiers — one slot is a BYE. The team paired with it is the
              <b> lucky team</b> and advances without playing. You can move the BYE to a different slot.
            </p>
          )}
          <input type="hidden" name="tournament_id" value={id} />
          <BracketSlotsEditor slots={firstRoundSlots} teams={teams} />
          <button className="btn-primary text-xs">Save pairings</button>
        </form>
      )}

      {bracket && slots.length > 0 && (
        <div className="card">
          <BracketView slots={slots} teams={tm} matches={matchMap} />
        </div>
      )}

      {bracket?.status === "published" && (
        <p className="text-xs text-muted">
          Knockout matches are on the <Link href={`/admin/tournaments/${id}/matches`} className="font-semibold text-accent">Matches</Link> page.
          Winners advance automatically when a match ends; semi-final losers go to the third-place match.
        </p>
      )}
    </div>
  );
}
