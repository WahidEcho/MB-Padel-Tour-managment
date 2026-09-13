"use client";

import { useState } from "react";
import { deliveryWidth, focalPosition, portraitSrc, resolvePortrait, sizedImageSrc } from "@/lib/portrait";
import { initials } from "@/components/Avatar";
import { classifyPointChange, type Beat, type ScoreFrame } from "@/lib/tv/pointBeat";
import { BEAT_MS, ENTRANCE, RESULT, seekStyle } from "@/lib/tv/timeline";
import { TYPE, showsAt, type Density } from "@/lib/tv/layout";
import { frameFrom, type LiveMatch, type LiveSnapshot } from "@/lib/tv/liveFeed";
import type { CourtSlotKind } from "@/lib/tv/courtSlots";
import type { PublicPlayer, PublicTeam } from "@/lib/public";
import { useSeekedStage } from "./hooks";

type SideKey = "A" | "B";

export interface CourtCardProps {
  courtName: string;
  kind: CourtSlotKind;
  match: LiveMatch | null;
  snapshot: LiveSnapshot | null;
  teamA: PublicTeam | null;
  teamB: PublicTeam | null;
  /** Where each side stands, for the entrance. Null when there is nothing honest to say. */
  rankA: string | null;
  rankB: string | null;
  density: Density;
  now: number;
  motion: boolean;
  /** Milliseconds between the two most recent successful polls of the feed. */
  pollGapMs?: number;
  /** An operator-requested replay of this court's entrance. */
  entranceReplayAt?: string | null;
  /** The match's last scoring event when the replay was requested; only a later one ends it. */
  entranceReplayEvent?: number | null;
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

function Portrait({ player, size, eager = true }: { player: PublicPlayer; size: number; eager?: boolean }) {
  const portrait = resolvePortrait(player);
  const src = sizedImageSrc(portraitSrc(portrait), deliveryWidth(size));
  if (!src) {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-2xl bg-accent/20 font-bold text-accent"
        style={{ width: size, height: size, fontSize: size * 0.34 }}
        aria-label={player.full_name}
      >
        {initials(player.full_name) || "?"}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={player.full_name}
      width={size}
      height={size}
      loading={eager ? "eager" : "lazy"}
      className="shrink-0 rounded-2xl object-cover"
      style={{ width: size, height: size, objectPosition: focalPosition(portrait) }}
    />
  );
}

/** First initial and surname, for when a full name will not fit. */
function shortName(full: string): string {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return full;
  return `${parts[0][0]}. ${parts.slice(1).join(" ")}`;
}

function playerNames(team: PublicTeam | null, full: boolean): string {
  if (!team) return "";
  return team.players.map((p) => (full ? p.full_name : shortName(p.full_name))).join(" & ");
}

/* ------------------------------------------------------------------ */
/* The card                                                            */
/* ------------------------------------------------------------------ */

/**
 * One court, on the venue screen.
 *
 * Keyed by the match that is on it and nothing else, so it survives every poll:
 * a changing key would remount it and silently kill every animation on the wall.
 * All motion is confined to the card, so two courts scoring at the same moment
 * each animate in their own box and cannot collide.
 */
export default function CourtCard(props: CourtCardProps) {
  const { kind } = props;
  if (kind === "idle") return <IdleCard {...props} />;
  if (kind === "next") return <NextCard {...props} />;
  if (kind === "hold" || kind === "rest") return <ResultCard {...props} animate={kind === "hold"} />;
  return <LiveCard {...props} />;
}

function CourtStrip({ courtName, match, right }: { courtName: string; match: LiveMatch | null; right?: React.ReactNode }) {
  return (
    <div className="flex h-[44px] shrink-0 items-center justify-between px-5">
      <p className="truncate text-[24px] font-bold uppercase tracking-widest text-muted">
        {courtName}
        {match?.round_name ? <span className="font-semibold normal-case tracking-normal"> · {match.round_name}</span> : null}
      </p>
      {right}
    </div>
  );
}

function IdleCard({ courtName }: CourtCardProps) {
  return (
    <div className="bc-card flex h-full flex-col">
      <CourtStrip courtName={courtName} match={null} />
      <div className="flex flex-1 items-center justify-center text-[28px] text-muted">No match on court</div>
    </div>
  );
}

function NextCard({ courtName, match, teamA, teamB, density }: CourtCardProps) {
  const t = TYPE[density];
  return (
    <div className="bc-card flex h-full flex-col">
      <CourtStrip courtName={courtName} match={match} right={<span className="text-[22px] font-bold text-accent">NEXT ON COURT</span>} />
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="font-bold" style={{ fontSize: t.team }}>{teamA?.team_name ?? "TBD"}</p>
        <p className="text-muted" style={{ fontSize: Math.max(22, t.player) }}>v</p>
        <p className="font-bold" style={{ fontSize: t.team }}>{teamB?.team_name ?? "TBD"}</p>
      </div>
    </div>
  );
}

/* ---------------- live, with the point beat and the entrance ---------------- */

interface Seen {
  frame: ScoreFrame | null;
  at: number;
  beat: (Exclude<Beat, { kind: "none" }> & { startedAt: number }) | null;
  /** When the score last changed while this card watched. Null until it does. */
  changedAt: number | null;
}

function LiveCard(props: CourtCardProps) {
  const { courtName, match, snapshot, teamA, teamB, density, now, motion, pollGapMs = 2_000 } = props;
  const t = TYPE[density];
  const shows = showsAt(density);

  // Classify each new observation during render, not in an effect: the beat has
  // to be decided from the frame that arrived with this render, and an effect
  // would run it one render late — long enough for a second poll to slip in.
  const [seen, setSeen] = useState<Seen>({
    frame: snapshot ? frameFrom(snapshot) : null,
    at: now,
    beat: null,
    changedAt: null,
  });
  if (snapshot && snapshot.last_event_number !== seen.frame?.eventNumber) {
    const next = frameFrom(snapshot);
    // Measured between polls, not since the score last moved. A match can go
    // twenty seconds without a point; the screen was still watching throughout,
    // so the next point is fresh and must animate.
    const beat = classifyPointChange(seen.frame, next, { observedGapMs: pollGapMs });
    setSeen({
      frame: next,
      at: now,
      beat: beat.kind === "none" ? null : { ...beat, startedAt: now },
      changedAt: now,
    });
  }
  const beat = seen.beat && now - seen.beat.startedAt < BEAT_MS[seen.beat.kind] ? seen.beat : null;

  // The entrance plays over a board that has not started. The first point ends it
  // early, so the wall never lags what is happening on court.
  const boardStarted = Boolean(
    snapshot &&
      (snapshot.sets.some(Boolean) || snapshot.games.some(Boolean) || snapshot.points.some((p) => p !== "0")),
  );
  // An operator's replay is a deliberate request, usually because the wall was
  // showing something else when the match began — so it plays over a board that
  // has already started. A point scored after the replay was requested still
  // ends it, for the same reason the first point ends the original. "After" is
  // judged by the match's event number recorded with the replay, not by when this
  // wall happened to see a point: one scored just before the press often arrives
  // in the same poll as the replay itself.
  const replayAtMs = props.entranceReplayAt ? Date.parse(props.entranceReplayAt) : null;
  const isReplay = replayAtMs !== null && Number.isFinite(replayAtMs);
  const entranceFrom = isReplay ? props.entranceReplayAt! : (match?.started_at ?? null);
  const entrance = useSeekedStage(ENTRANCE.marks, entranceFrom, now, { skipAfterMs: ENTRANCE.skipAfterMs });
  const replayEvent = props.entranceReplayEvent;
  const interrupted = isReplay
    ? replayEvent !== null && replayEvent !== undefined
      ? (snapshot?.last_event_number ?? 0) > replayEvent
      : seen.changedAt !== null && seen.changedAt >= replayAtMs!
    : boardStarted;
  const showEntrance =
    shows.entrance &&
    motion &&
    !interrupted &&
    entrance.elapsedMs !== null &&
    entrance.elapsedMs < ENTRANCE.durationMs;

  const serving: SideKey | null =
    snapshot?.serving_team_id && match
      ? snapshot.serving_team_id === match.team_a_id
        ? "A"
        : snapshot.serving_team_id === match.team_b_id
          ? "B"
          : null
      : null;

  const rows: { key: SideKey; team: PublicTeam | null; idx: 0 | 1 }[] = [
    { key: "A", team: teamA, idx: 0 },
    { key: "B", team: teamB, idx: 1 },
  ];

  return (
    <div className="bc-card relative flex h-full flex-col overflow-hidden">
      <CourtStrip
        courtName={courtName}
        match={match}
        right={
          snapshot?.tiebreak ? (
            <span className="rounded-lg bg-warning/25 px-3 py-0.5 text-[22px] font-bold text-warning">TIE-BREAK</span>
          ) : match?.status === "paused" ? (
            <span className="text-[22px] font-bold text-warning">PAUSED</span>
          ) : (
            <span className="text-[22px] font-bold text-success">● LIVE</span>
          )
        }
      />

      <div className="flex flex-1 flex-col justify-center gap-3 px-5 pb-4">
        {rows.map(({ key, team, idx }) => {
          const scored = beat?.side === key;
          const points = snapshot
            ? snapshot.tiebreak
              ? String(snapshot.tiebreak_points[idx])
              : snapshot.points[idx]
            : "0";
          return (
            <div key={key} className="relative flex min-h-0 flex-1 items-center gap-4 overflow-hidden rounded-2xl px-3">
              {/* The pulse on the scoring row. Keyed by the beat so a new point
                  restarts it rather than continuing the last one. */}
              {scored && motion && (
                <span
                  key={beat!.startedAt}
                  aria-hidden
                  className="bc-animate pointer-events-none absolute inset-0 rounded-2xl bg-accent/25"
                  style={{ animation: `bc-row-pulse ${BEAT_MS[beat!.kind]}ms ease-out both` }}
                />
              )}

              {shows.photos && team && (
                <div className="flex shrink-0 -space-x-3">
                  {team.players.map((p) => (
                    <Portrait key={p.id} player={p} size={Math.min(t.photo, 120)} />
                  ))}
                </div>
              )}

              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 truncate font-bold leading-tight" style={{ fontSize: t.team }}>
                  {/* Glyph plus colour, never colour alone: an LED wall's calibration
                      and a colour-blind viewer both defeat colour-only encoding. */}
                  <span
                    aria-label={serving === key ? "serving" : undefined}
                    className="inline-block w-[28px] shrink-0 text-center text-accent"
                  >
                    {serving === key && !snapshot?.tiebreak ? "●" : ""}
                  </span>
                  <span className="truncate">{team?.team_name ?? "TBD"}</span>
                </p>
                <p className="truncate pl-[36px] text-muted" style={{ fontSize: t.player }}>
                  {playerNames(team, shows.fullNames)}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-5" data-numeral>
                <span className="bc-num w-[56px] text-center font-bold text-muted" style={{ fontSize: t.games * 0.8 }}>
                  {snapshot?.sets[idx] ?? 0}
                </span>
                <span className="bc-num w-[72px] text-center font-bold" style={{ fontSize: t.games }}>
                  {snapshot?.games[idx] ?? 0}
                </span>
                <span className="relative flex w-[150px] items-center justify-center overflow-hidden" style={{ height: t.points * 1.05 }}>
                  {/* Points are an enum, so they swap rather than roll: an odometer
                      counting 15 to 30 through 16, 17, 18 would be wrong. Keyed on the
                      value, so a change re-runs the entry animation. */}
                  <span
                    key={points}
                    className="bc-num bc-animate font-black leading-none"
                    style={{
                      fontSize: t.points,
                      animation: motion && seen.beat ? "bc-swap-in 240ms ease-out both" : undefined,
                    }}
                  >
                    {points}
                  </span>
                  {scored && motion && (
                    <span
                      key={`burst-${beat!.startedAt}`}
                      aria-hidden
                      className="bc-animate pointer-events-none absolute inset-0 m-auto rounded-full border-4 border-accent"
                      style={{
                        width: t.points,
                        height: t.points,
                        animation: `bc-burst ${Math.min(700, BEAT_MS[beat!.kind])}ms ease-out both`,
                      }}
                    />
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {beat && beat.kind !== "point" && motion && (
        <div
          key={`label-${beat.startedAt}`}
          aria-hidden
          className="bc-animate pointer-events-none absolute right-5 top-[52px] rounded-xl bg-accent px-4 py-1 text-[26px] font-black uppercase text-white"
          style={{ animation: `bc-rank-in 240ms ease-out both` }}
        >
          {beat.kind === "set" ? "SET" : "GAME"} · {(beat.side === "A" ? teamA : teamB)?.team_name}
        </div>
      )}

      {showEntrance && (
        // Keyed on its origin: a replayed entrance is a new timeline and must seek
        // afresh, while polls within one entrance must not touch it.
        <EntranceOverlay key={entranceFrom ?? "entrance"} {...props} elapsedMs={entrance.elapsedMs ?? 0} />
      )}
    </div>
  );
}

/* ---------------- the 9-second entrance ---------------- */

function EntranceOverlay({
  courtName,
  match,
  teamA,
  teamB,
  rankA,
  rankB,
  density,
  elapsedMs,
}: CourtCardProps & { elapsedMs: number }) {
  const t = TYPE[density];
  const photo = Math.min(t.photo, density === "grid" ? 112 : 200);
  // Seek ONCE, from how far in the entrance was when this overlay appeared, then
  // let the browser run the animations. Re-deriving the negative delay on every
  // clock tick would re-time animations already running and count the elapsed
  // time twice, playing the whole entrance at roughly double speed.
  const [seekFrom] = useState(elapsedMs);
  const at = (beginsAtMs: number) => seekStyle(seekFrom, beginsAtMs);

  const side = (team: PublicTeam | null, rank: string | null, from: "left" | "right", begins: number) => (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-2">
      <div className="flex gap-3">
        {(team?.players ?? []).map((p, i) => (
          <div
            key={p.id}
            className="bc-animate flex flex-col items-center gap-1"
            style={{
              animation: `${from === "left" ? "bc-in-left" : "bc-in-right"} 520ms cubic-bezier(.2,.8,.2,1) both`,
              ...at(begins + i * 140),
            }}
          >
            <Portrait player={p} size={photo} />
            {/* Stacked under the portrait, never over it: studio portraits put the
                chin at 70-78% of the frame, so an overlaid name lands on the face. */}
            <p className="max-w-[200px] truncate text-center font-bold" style={{ fontSize: Math.max(22, t.player) }}>
              {shortName(p.full_name)}
            </p>
          </div>
        ))}
      </div>
      <p className="truncate text-center font-black" style={{ fontSize: t.team }}>{team?.team_name ?? "TBD"}</p>
      {/* Reserved height, so a missing rank does not shift the layout. */}
      <p
        className="bc-animate min-h-[30px] text-center text-[24px] font-semibold text-accent"
        style={{ animation: "bc-rank-in 400ms ease-out both", ...at(ENTRANCE.marks[3]) }}
      >
        {rank ?? ""}
      </p>
    </div>
  );

  return (
    <div
      // Fully opaque: an operator can replay an entrance over a match already in
      // play, and at 95% the running score ghosted through the player cards.
      className="bc-animate absolute inset-0 z-20 flex flex-col bg-background"
      // Scheduled from the start, not switched on when the exit stage arrives: a
      // style added mid-way would start its animation then, not at 8.2s. Fill
      // mode holds it fully opaque until its delay has run out.
      style={{ animation: "bc-overlay-out 800ms ease-in both", ...at(ENTRANCE.marks[5]) }}
    >
      <div
        className="bc-animate flex h-[44px] items-center justify-between px-5"
        style={{ animation: "bc-strip-in 500ms ease-out both", ...at(0) }}
      >
        <p className="text-[24px] font-bold uppercase tracking-widest text-muted">{courtName}</p>
        <p className="text-[24px] font-black uppercase tracking-widest text-accent">Now starting</p>
      </div>
      <div className="flex flex-1 items-center gap-4 px-5 pb-3">
        {side(teamA, rankA, "left", ENTRANCE.marks[1])}
        <p className="text-[40px] font-black text-muted">v</p>
        {side(teamB, rankB, "right", ENTRANCE.marks[2])}
      </div>
      <span className="sr-only">{match?.round_name}</span>
    </div>
  );
}

/* ---------------- the 5-second result, then the hold ---------------- */

const RESULT_CHIP: Record<string, string> = {
  completed: "WINNER",
  walkover: "W/O",
  retired: "RET",
  disqualified: "DSQ",
};

function ResultCard({
  courtName,
  match,
  snapshot,
  teamA,
  teamB,
  density,
  now,
  motion,
  animate,
}: CourtCardProps & { animate: boolean }) {
  const t = TYPE[density];
  const shows = showsAt(density);
  const result = useSeekedStage(RESULT.marks, match?.ended_at ?? null, now);
  // Frozen at mount, for the same reason as the entrance: a delay re-derived on
  // every tick re-times a running animation and plays it at double speed.
  const [seekFrom] = useState(() => result.elapsedMs ?? RESULT.durationMs);
  const run = animate && motion && shows.resultAnimation && seekFrom < RESULT.durationMs;
  const seek = (begins: number) => (run ? seekStyle(seekFrom, begins) : undefined);

  const winnerIsA = Boolean(match?.winner_team_id && match.winner_team_id === match.team_a_id);
  const winner = winnerIsA ? teamA : teamB;
  const sets = snapshot?.completed_sets ?? [];
  const chip = RESULT_CHIP[match?.status ?? "completed"] ?? "WINNER";

  const row = (team: PublicTeam | null, isWinner: boolean) => (
    <div
      className={`bc-animate flex min-h-0 flex-1 items-center gap-4 rounded-2xl px-3 ${isWinner ? "bg-accent/15" : ""}`}
      style={
        run
          ? {
              animation: isWinner
                ? "bc-lift 600ms ease-out both"
                : "bc-recede 600ms ease-out both",
              ...seek(isWinner ? RESULT.marks[1] : RESULT.marks[0]),
            }
          : isWinner
            ? undefined
            : { opacity: 0.45 }
      }
    >
      {shows.photos && team && (
        <div className="flex shrink-0 -space-x-3">
          {team.players.map((p) => (
            <Portrait key={p.id} player={p} size={Math.min(t.photo, 112)} />
          ))}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate font-bold" style={{ fontSize: t.team }}>{team?.team_name ?? "TBD"}</p>
        <p className="truncate text-muted" style={{ fontSize: t.player }}>{playerNames(team, shows.fullNames)}</p>
      </div>
      {isWinner && (
        <span
          className="bc-animate origin-left rounded-xl bg-accent px-4 py-1 text-[26px] font-black text-white"
          style={run ? { animation: "bc-chip 360ms ease-out both", ...seek(RESULT.marks[1]) } : undefined}
        >
          {chip}
        </span>
      )}
    </div>
  );

  return (
    <div className="bc-card relative flex h-full flex-col overflow-hidden border-accent/60">
      <CourtStrip courtName={courtName} match={match} right={<span className="text-[22px] font-bold text-accent">FINAL</span>} />
      <div className="flex flex-1 flex-col gap-3 px-5 pb-4">
        {row(teamA, winnerIsA)}
        <div className="flex shrink-0 items-center justify-center gap-6" data-numeral>
          {sets.length === 0 ? (
            <span className="text-[28px] font-bold text-muted">{chip === "WINNER" ? "" : chip}</span>
          ) : (
            sets.map((s, i) => (
              <span
                key={i}
                className="bc-num bc-animate font-black"
                style={{
                  fontSize: t.games,
                  ...(run ? { animation: "bc-set-in 360ms ease-out both", ...seek(RESULT.marks[2] + i * 220) } : {}),
                }}
              >
                {s.teamAGames}-{s.teamBGames}
                {s.tiebreak ? <sup className="text-[22px] text-muted"> ({Math.min(s.tiebreak.a, s.tiebreak.b)})</sup> : null}
              </span>
            ))
          )}
        </div>
        {row(teamB, !winnerIsA && Boolean(match?.winner_team_id))}
      </div>
      <span className="sr-only">{winner ? `${winner.team_name} won` : ""}</span>
    </div>
  );
}
