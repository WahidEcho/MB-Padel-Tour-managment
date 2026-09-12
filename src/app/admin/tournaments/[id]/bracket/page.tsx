import Link from "next/link";
import {
  getBrackets,
  getBracketSlots,
  getMatches,
  getStandings,
  getTeams,
  getTournament,
  teamMap,
} from "@/lib/data";
import { podiumDepthFor, tierSizes } from "@/lib/bracket";
import BracketView, { orderedRounds } from "@/components/BracketView";
import BracketSlotsEditor from "@/components/BracketSlotsEditor";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import WinnerDisplay, { podiumFromMatches } from "@/components/WinnerDisplay";
import type { Bracket, BracketTier, Match, Team } from "@/lib/types";
import { approveAction, generateAction, publishAction, resetBracket, saveSlots } from "./actions";

export const dynamic = "force-dynamic";

const TIER_LABEL: Record<BracketTier, string> = { cup: "Cup", plate: "Plate" };

export default async function BracketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [brackets, teams, standings, matches, tournament] = await Promise.all([
    getBrackets(id),
    getTeams(id),
    getStandings(id),
    getMatches(id),
    getTournament(id),
  ]);
  const tm = teamMap(teams);
  const matchMap = new Map(matches.map((m) => [m.id, m]));
  const isChess = tournament?.sport === "chess";
  const { platePerGroup } = tierSizes(tournament?.format_config);
  const plateEnabled = !isChess && platePerGroup > 0;

  const slotsByBracket = new Map(
    await Promise.all(brackets.map(async (b) => [b.id, await getBracketSlots(b.id)] as const)),
  );

  const entrantCount = teams.filter((t) => t.team_status !== "disqualified" && t.team_status !== "withdrawn").length;
  const countFor = (tier: BracketTier) =>
    isChess ? entrantCount : standings.filter((s) => s.status === (tier === "plate" ? "plate" : "qualified")).length;

  // Sections shown: whatever is drawn, plus any tier that is configured but not
  // drawn yet, so the Generate button for it has somewhere to live.
  const tiers: BracketTier[] = isChess ? ["cup"] : plateEnabled ? ["cup", "plate"] : ["cup"];
  const anyDrawn = brackets.length > 0;
  const anyPublishable = brackets.some((b) => b.status === "approved");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold">Knockout{tiers.length > 1 ? "s" : " bracket"}</h2>
          {tiers.length > 1 && (
            <p className="text-xs text-muted">
              Cup takes the top {tierSizes(tournament?.format_config).qualifyPerGroup} of each group; Plate
              takes the next {platePerGroup}. Draw both, then publish once.
            </p>
          )}
        </div>

        {anyPublishable && (
          <form action={publishAction} className="card space-y-2 p-3">
            <input type="hidden" name="tournament_id" value={id} />
            <p className="label">Publish knockout</p>
            {tiers.length > 1 ? (
              <>
                <label className="flex items-start gap-2 text-xs">
                  <input type="radio" name="court_strategy" value="parallel" defaultChecked className="mt-0.5" />
                  <span>
                    <b>Both at once</b> — Cup and Plate matches of the same round share the courts, so the
                    whole field plays together.
                  </span>
                </label>
                <label className="flex items-start gap-2 text-xs">
                  <input type="radio" name="court_strategy" value="sequential" className="mt-0.5" />
                  <span>
                    <b>One after another</b> — the Cup plays each round out first, then the Plate plays the
                    same round on the same courts.
                  </span>
                </label>
              </>
            ) : (
              <input type="hidden" name="court_strategy" value="parallel" />
            )}
            <ConfirmSubmit
              className="btn-primary text-xs"
              message="Publish every approved bracket and create its matches? Lucky teams (byes) advance automatically."
            >
              Publish + create matches
            </ConfirmSubmit>
          </form>
        )}
      </div>

      {tiers.map((tier) => {
        const bracket = brackets.find((b) => b.tier === tier) ?? null;
        return (
          <TierSection
            key={tier}
            tournamentId={id}
            tier={tier}
            bracket={bracket}
            slots={bracket ? (slotsByBracket.get(bracket.id) ?? []) : []}
            teams={teams}
            tm={tm}
            matches={matches}
            matchMap={matchMap}
            isChess={isChess}
            readyCount={countFor(tier)}
            podiumDepth={podiumDepthFor(tournament?.format_config, tier)}
            showLabel={tiers.length > 1}
          />
        );
      })}

      {anyDrawn && (
        <p className="text-xs text-muted">
          Knockout matches are on the{" "}
          <Link href={`/admin/tournaments/${id}/matches`} className="font-semibold text-accent">
            Matches
          </Link>{" "}
          page. Winners advance automatically when a match ends; semi-final losers go to the third-place
          match. Undoing a finished result takes the winner back out of the next round, unless that match
          has already started.
        </p>
      )}
    </div>
  );
}

function TierSection({
  tournamentId,
  tier,
  bracket,
  slots,
  teams,
  tm,
  matches,
  matchMap,
  isChess,
  readyCount,
  podiumDepth,
  showLabel,
}: {
  tournamentId: string;
  tier: BracketTier;
  bracket: Bracket | null;
  slots: Awaited<ReturnType<typeof getBracketSlots>>;
  teams: Team[];
  tm: Map<string, Team>;
  matches: Match[];
  matchMap: Map<string, Match>;
  isChess: boolean;
  readyCount: number;
  podiumDepth: 1 | 2 | 3 | 4;
  showLabel: boolean;
}) {
  const firstRound = slots.length > 0 ? orderedRounds(slots.filter((s) => s.round_name !== "TP"))[0] : null;
  const firstRoundSlots = slots
    .filter((s) => s.round_name === firstRound)
    .sort((a, b) => a.slot_order - b.slot_order);
  const hasBye = firstRoundSlots.some((s) => s.is_bye);
  const podium = bracket
    ? podiumFromMatches(matches, tm, { tier, bracketId: bracket.id, depth: podiumDepth })
    : null;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-bold">
          {showLabel ? TIER_LABEL[tier] : "Bracket"}{" "}
          {bracket && (
            <span
              className={`badge ${
                bracket.status === "published" ? "bg-success/15 text-success" : "bg-warning/15 text-warning"
              }`}
            >
              {bracket.status}
            </span>
          )}
        </h3>
        <div className="flex flex-wrap gap-2">
          <form action={generateAction}>
            <input type="hidden" name="tournament_id" value={tournamentId} />
            <input type="hidden" name="tier" value={tier} />
            <ConfirmSubmit
              className="btn-secondary text-xs"
              message={
                bracket
                  ? `Redraw the ${TIER_LABEL[tier]}? Its matches are deleted. The other bracket is untouched.`
                  : isChess
                    ? "Generate the knockout from the player list (seeded by seed number)?"
                    : `Draw the ${TIER_LABEL[tier]} from current group standings?`
              }
            >
              {bracket ? `Redraw ${showLabel ? TIER_LABEL[tier] : "bracket"}` : `Draw ${showLabel ? TIER_LABEL[tier] : "bracket"}`}
            </ConfirmSubmit>
          </form>
          {bracket?.status === "draft" && (
            <form action={approveAction}>
              <input type="hidden" name="tournament_id" value={tournamentId} />
              <input type="hidden" name="tier" value={tier} />
              <button className="btn-secondary text-xs">Approve</button>
            </form>
          )}
          {bracket && (
            <form action={resetBracket}>
              <input type="hidden" name="tournament_id" value={tournamentId} />
              <input type="hidden" name="tier" value={tier} />
              <ConfirmSubmit
                className="btn-secondary text-xs text-danger"
                message={`Delete the ${TIER_LABEL[tier]} and its knockout matches? The other bracket is untouched.`}
              >
                Reset
              </ConfirmSubmit>
            </form>
          )}
        </div>
      </div>

      {!bracket && (
        <div className="card p-6 text-center text-muted">
          <p>
            {isChess
              ? `${readyCount} player(s) ready for the knockout.`
              : `${readyCount} team(s) currently in the ${TIER_LABEL[tier]} places.`}
          </p>
          <p className="mt-1 text-sm">
            {isChess
              ? "Seeded by seed number. You can edit every pairing before publishing."
              : "Draw it once the group stage is (nearly) done. You can edit every pairing before publishing."}
          </p>
        </div>
      )}

      {podium && podium.places.length > 0 && <WinnerDisplay podium={podium} />}

      {bracket && bracket.status !== "published" && firstRound && (
        <form action={saveSlots} className="card space-y-3 border-warning/40">
          <h4 className="font-bold">Edit first-round pairings ({firstRound})</h4>
          {hasBye && (
            <p className="rounded-xl bg-warning/10 px-3 py-2 text-xs font-semibold text-warning">
              ⚠ Odd number of entrants — one slot is a BYE. The team paired with it is the
              <b> lucky team</b> and advances without playing. You can move the BYE to a different slot.
            </p>
          )}
          <input type="hidden" name="tournament_id" value={tournamentId} />
          <input type="hidden" name="tier" value={tier} />
          <BracketSlotsEditor slots={firstRoundSlots} teams={teams} />
          <button className="btn-primary text-xs">Save pairings</button>
        </form>
      )}

      {bracket && slots.length > 0 && (
        <div className="card">
          <BracketView slots={slots} teams={tm} matches={matchMap} />
        </div>
      )}
    </section>
  );
}
