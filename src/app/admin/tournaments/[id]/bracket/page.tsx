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
import {
  bracketStamp,
  encodeBracketFingerprint,
  podiumDepthFor,
  teardownConfirmMessage,
  tierSizes,
  type BracketSummary,
} from "@/lib/bracket";
import { summarizeBrackets } from "@/lib/ops";
import BracketActionForm from "./BracketActionForm";
import BracketView, { orderedRounds } from "@/components/BracketView";
import BracketSlotsEditor from "@/components/BracketSlotsEditor";
import WinnerDisplay, { podiumFromMatches } from "@/components/WinnerDisplay";
import type { Bracket, BracketTier, Match, Team } from "@/lib/types";
import { approveAction, generateAction, publishAction, resetBracket, saveSlots } from "./actions";

export const dynamic = "force-dynamic";

const TIER_LABEL: Record<BracketTier, string> = { cup: "Cup", plate: "Plate" };

export default async function BracketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [brackets, teams, standings, matches, tournament, summaries] = await Promise.all([
    getBrackets(id),
    getTeams(id),
    getStandings(id),
    getMatches(id),
    getTournament(id),
    summarizeBrackets(id),
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

        {anyDrawn && (
          <div className={anyPublishable ? "card p-3" : ""}>
          <BracketActionForm
            hidden={!anyPublishable}
            stamp={bracketStamp(brackets, "all")}
            action={publishAction}
            fields={{ tournament_id: id }}
            label="Publish + create matches"
            className="btn-primary text-xs"
            confirmMessage="Publish every approved bracket and create its matches? Lucky teams (byes) advance automatically."
            testId="publish-knockout"
          >
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
          </BracketActionForm>
          </div>
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
            stamp={bracketStamp(brackets, tier)}
            summary={bracket ? (summaries.find((b) => b.id === bracket.id) ?? null) : null}
            otherTierDrawn={brackets.some((b) => b.tier !== tier)}
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
  stamp,
  summary,
  otherTierDrawn,
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
  /** This tier's bracket state, which a result message must match to stay visible. */
  stamp: string;
  /** Its knockout matches and how many have been played, for the Redraw and Reset confirmations. */
  summary: BracketSummary | null;
  otherTierDrawn: boolean;
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
        <div className="flex flex-wrap items-start gap-2">
          <BracketActionForm
            stamp={stamp}
            action={generateAction}
            fields={{
              tournament_id: tournamentId,
              tier,
              // The bracket as this page shows it. If a match is played before the
              // click lands, the server refuses rather than delete it.
              ...(summary ? { confirm_bracket: encodeBracketFingerprint(summary) } : {}),
            }}
            label={
              bracket
                ? `Redraw ${showLabel ? TIER_LABEL[tier] : "bracket"}${summary && summary.played > 0 ? ` (deletes ${summary.played} played)` : ""}`
                : `Draw ${showLabel ? TIER_LABEL[tier] : "bracket"}`
            }
            className={`btn-secondary text-xs ${summary && summary.played > 0 ? "text-danger" : ""}`}
            confirmMessage={
              summary
                ? teardownConfirmMessage("redraw", summary, { otherTierDrawn })
                : isChess
                  ? "Generate the knockout from the player list (seeded by seed number)?"
                  : `Draw the ${TIER_LABEL[tier]} from current group standings?`
            }
            testId={`redraw-${tier}`}
          />
          <BracketActionForm
            stamp={stamp}
            hidden={bracket?.status !== "draft"}
            action={approveAction}
            fields={{ tournament_id: tournamentId, tier }}
            label="Approve"
            className="btn-secondary text-xs"
            testId={`approve-${tier}`}
          />
          <BracketActionForm
            stamp={stamp}
            hidden={!bracket || !summary}
            action={resetBracket}
            fields={{
              tournament_id: tournamentId,
              tier,
              ...(summary ? { confirm_bracket: encodeBracketFingerprint(summary) } : {}),
            }}
            label={summary && summary.played > 0 ? `Reset (deletes ${summary.played} played)` : "Reset"}
            className="btn-secondary text-xs text-danger"
            confirmMessage={summary ? teardownConfirmMessage("reset", summary, { otherTierDrawn }) : null}
            testId={`reset-${tier}`}
          />
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
