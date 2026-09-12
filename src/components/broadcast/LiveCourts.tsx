"use client";

import { courtSlots } from "@/lib/tv/courtSlots";
import { GUTTER, planGrid } from "@/lib/tv/layout";
import type { PublicTeam } from "@/lib/public";
import CourtCard from "./CourtCard";
import { useLive } from "./LiveFeedProvider";

export interface CourtInfo {
  id: string;
  name: string;
}

/**
 * Every court this screen covers, laid out for the room.
 *
 * Resolved per court from the live feed on every poll, so a finished match stays
 * on its court for its result and hold instead of vanishing, and the next fixture
 * takes the card when it is done.
 */
export default function LiveCourts({
  courts,
  teams,
  ranks,
  pinnedCourtId,
}: {
  /** The courts this screen covers, in order. */
  courts: CourtInfo[];
  /** Public projections only — a raw team row carries a phone number. */
  teams: Record<string, PublicTeam>;
  /** Where each side stands, keyed by match id. */
  ranks: Record<string, { a: string | null; b: string | null }>;
  pinnedCourtId: string | null;
}) {
  const { feed, now, motion, pollGapMs } = useLive();
  if (!feed) return null;

  const shown = pinnedCourtId ? courts.filter((c) => c.id === pinnedCourtId) : courts;
  const plan = planGrid(shown.length);
  const slots = courtSlots(shown.map((c) => c.id), feed.matches, now);
  const snapByMatch = new Map(feed.snapshots.map((s) => [s.match_id, s]));
  const replay = feed.screen.entrance_replay;

  if (shown.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[40px] text-muted">
        No courts on this screen
      </div>
    );
  }

  return (
    <div
      className="grid h-full"
      style={{
        gridTemplateColumns: `repeat(${plan.columns}, ${plan.cardWidth}px)`,
        gridTemplateRows: `repeat(${plan.rows}, ${plan.cardHeight}px)`,
        gap: GUTTER,
        padding: `0 ${GUTTER}px ${GUTTER}px`,
      }}
    >
      {slots.map((slot) => {
        const court = shown.find((c) => c.id === slot.courtId)!;
        const match = slot.match;
        const rank = match ? ranks[match.id] : undefined;
        return (
          // Keyed by the court, so the cell is stable; the card inside is keyed by
          // what is on it, so a new match gets a fresh card and an unchanged one
          // keeps its animation state across every poll.
          <div key={slot.courtId} className="min-h-0 min-w-0">
            <CourtCard
              key={`${slot.kind}-${match?.id ?? "none"}`}
              courtName={court.name}
              kind={slot.kind}
              match={match}
              snapshot={match ? (snapByMatch.get(match.id) ?? null) : null}
              teamA={match?.team_a_id ? (teams[match.team_a_id] ?? null) : null}
              teamB={match?.team_b_id ? (teams[match.team_b_id] ?? null) : null}
              rankA={rank?.a ?? null}
              rankB={rank?.b ?? null}
              density={plan.density}
              now={now}
              motion={motion}
              pollGapMs={pollGapMs}
              entranceReplayAt={replay && match && replay.match_id === match.id ? replay.at : null}
            />
          </div>
        );
      })}
      {Array.from({ length: plan.spareCells }, (_, i) => (
        <div key={`spare-${i}`} className="bc-card flex items-center justify-center text-[26px] text-muted">
          {/* Three courts on a 2x2 grid leave one cell. It stays a quiet card
              rather than stretching the others and breaking the layout budget. */}
        </div>
      ))}
    </div>
  );
}
