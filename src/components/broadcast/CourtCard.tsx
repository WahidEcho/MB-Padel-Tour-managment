"use client";

import { useState } from "react";
import { deliveryWidth, focalPosition, portraitSrc, resolvePortrait, sizedImageSrc } from "@/lib/portrait";
import { initials } from "@/components/Avatar";
import { classifyPointChange, type Beat, type ScoreFrame } from "@/lib/tv/pointBeat";
import { BEAT_MS, ENTRANCE, RESULT, seekStyle } from "@/lib/tv/timeline";
import { TYPE, fitFontSize, isTall, numeralWidth, showsAt, type Density } from "@/lib/tv/layout";
import { frameFrom, type LiveMatch, type LiveSnapshot } from "@/lib/tv/liveFeed";
import type { CourtSlotKind } from "@/lib/tv/courtSlots";
import type { PublicPlayer, PublicTeam } from "@/lib/public";
import { SIDES, sideTint, type SideKey } from "@/lib/sides";
import { useSeekedStage } from "./hooks";

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
  /** The cell this card fills, in canvas pixels. Boxes inside are sized from it. */
  cardWidth: number;
  cardHeight: number;
  now: number;
  motion: boolean;
  /** Milliseconds between the two most recent successful polls of the feed. */
  pollGapMs?: number;
  /** An operator-requested replay of this court's entrance. */
  entranceReplayAt?: string | null;
  /** The match's last scoring event when the replay was requested; only a later one ends it. */
  entranceReplayEvent?: number | null;
  /** Red and blue teams: the first-listed team is marked Red, the second Blue. */
  sides?: boolean;
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

/** The shape of a player card: portrait, so a standing figure is not cropped to a head. */
const CARD_RATIO = 4 / 3;

/**
 * A player, as a card: their photo with their name on a faded plate across the
 * foot of it.
 *
 * The plate can sit on the picture because the card is 3:4 and the photo is
 * positioned by its focal point, which puts the face in the upper half — the
 * plate lands on the chest. On a square crop it would land on the chin, which is
 * why names used to be stacked underneath.
 */
function PlayerCard({ player, width, nameSize }: { player: PublicPlayer; width: number; nameSize: number }) {
  const portrait = resolvePortrait(player);
  const src = sizedImageSrc(portraitSrc(portrait), deliveryWidth(width));
  const height = Math.round(width * CARD_RATIO);
  const name = shortName(player.full_name);
  // Two names on one card must not be cut, so the plate's type gives way first.
  const fitted = fitFontSize(name, width - 12, nameSize, Math.max(14, Math.round(nameSize * 0.6)));

  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-2xl bg-accent/15"
      style={{ width, height }}
      data-testid="player-card"
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={player.full_name}
          width={width}
          height={height}
          loading="eager"
          className="h-full w-full object-cover"
          style={{ objectPosition: focalPosition(portrait) }}
        />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center font-bold text-accent"
          style={{ fontSize: width * 0.4 }}
          aria-hidden
        >
          {initials(player.full_name) || "?"}
        </span>
      )}
      <span
        className="absolute inset-x-0 bottom-0 flex items-end justify-center"
        style={{
          background: "linear-gradient(to top, rgba(0,0,0,0.78), rgba(0,0,0,0.45) 55%, rgba(0,0,0,0))",
          paddingTop: Math.round(nameSize * 1.4),
        }}
      >
        <span
          className="block w-full truncate px-2 pb-1.5 text-center font-bold leading-tight text-white"
          style={{ fontSize: fitted }}
        >
          {name}
        </span>
      </span>
    </div>
  );
}

/** The small round portrait used where a card will not fit. */
function Portrait({ player, size }: { player: PublicPlayer; size: number }) {
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
      loading="eager"
      className="shrink-0 rounded-2xl object-cover"
      style={{ width: size, height: size, objectPosition: focalPosition(portrait) }}
    />
  );
}

/** "RED" or "BLUE" on its colour, sized to sit beside a team name. */
function SideTag({ side, size }: { side: SideKey; size: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-lg px-3 font-black uppercase leading-none tracking-widest text-white"
      style={{ background: SIDES[side].hex, fontSize: size, height: size * 1.5 }}
      data-side={SIDES[side].short.toLowerCase()}
    >
      {SIDES[side].short}
    </span>
  );
}

/** A side's row on its colour: a solid bar down the left and a tint behind. */
function sideRowStyle(side: SideKey): React.CSSProperties {
  return { background: sideTint(side, 0.16), boxShadow: `inset 12px 0 0 ${SIDES[side].hex}`, paddingLeft: 24 };
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

/**
 * The scoreboard numerals for one side: sets, games and the point.
 *
 * Every box is as wide as the digits inside it, so nothing is ever clipped. The
 * captions appear only where there is room; on a crowded grid three bare numbers
 * in a fixed order are what a scoreboard has always been.
 */
function Numerals({
  sets,
  games,
  points,
  t,
  captions,
  beating,
  motion,
  burst,
  sideHex,
}: {
  sets: number;
  games: number;
  points: string;
  t: (typeof TYPE)[Density];
  captions: boolean;
  /** A point landed in this poll, so the numeral swaps in rather than appearing. */
  beating: boolean;
  motion: boolean;
  /** This side scored: when and for how long its burst rings, or null. */
  burst: { startedAt: number; ms: number } | null;
  sideHex: string | null;
}) {
  const setsPx = Math.round(t.games * 0.8);
  const capPx = Math.max(16, Math.round(t.games * 0.34));
  const column = (value: React.ReactNode, width: number, caption: string, key: string) => (
    <div key={key} className="flex flex-col items-center justify-end" style={{ width }}>
      {value}
      {captions && (
        <span className="uppercase tracking-widest text-muted" style={{ fontSize: capPx }}>
          {caption}
        </span>
      )}
    </div>
  );

  return (
    <div className="flex shrink-0 items-end" style={{ gap: Math.round(t.games * 0.35) }} data-numeral>
      {column(
        <span className="bc-num text-center font-bold leading-none text-muted" style={{ fontSize: setsPx }}>
          {sets}
        </span>,
        numeralWidth(2, setsPx),
        "sets",
        "sets",
      )}
      {column(
        <span className="bc-num text-center font-bold leading-none" style={{ fontSize: t.games }}>
          {games}
        </span>,
        numeralWidth(2, t.games),
        "games",
        "games",
      )}
      {column(
        <span
          className="relative flex items-center justify-center"
          style={{ height: t.points * 1.02, width: numeralWidth(Math.max(2, points.length), t.points) }}
        >
          {/* Points are an enum, so they swap rather than roll: an odometer
              counting 15 to 30 through 16, 17, 18 would be wrong. Keyed on the
              value, so a change re-runs the entry animation. */}
          <span
            key={points}
            className="bc-num bc-animate font-black leading-none"
            style={{ fontSize: t.points, animation: motion && beating ? "bc-swap-in 240ms ease-out both" : undefined }}
          >
            {points}
          </span>
          {burst && motion && (
            <span
              // Keyed by the beat, so a new point restarts the ring rather than
              // continuing the last one.
              key={burst.startedAt}
              aria-hidden
              className={`bc-animate pointer-events-none absolute inset-0 m-auto rounded-full border-4 ${sideHex ? "" : "border-accent"}`}
              style={{
                ...(sideHex ? { borderColor: sideHex } : {}),
                width: t.points,
                height: t.points,
                animation: `bc-burst ${burst.ms}ms ease-out both`,
              }}
            />
          )}
        </span>,
        numeralWidth(Math.max(2, points.length), t.points),
        "points",
        "points",
      )}
    </div>
  );
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
 *
 * Two shapes, chosen by how much height the card has. A tall card — one or two
 * courts on the wall — gives each side a block of its own: player cards on the
 * left, the team's name across the top of the rest, the score beneath it. A short
 * card keeps both sides on one line each. Neither ever clips a name or a numeral:
 * every box is sized from what goes in it.
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
    <div className="flex h-[44px] shrink-0 items-center justify-between gap-4 px-5">
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

/**
 * A team's name, at the largest size that fits the room it has.
 *
 * Wraps to a second line rather than being cut: a spectator looking for their own
 * team needs the whole name, and "Team Alp…" is the one thing a scoreboard must
 * never say.
 */
function TeamName({
  team,
  side,
  sides,
  basePx,
  widthPx,
  serving,
  lines = 2,
}: {
  team: PublicTeam | null;
  side: SideKey;
  sides: boolean;
  basePx: number;
  widthPx: number;
  serving?: boolean;
  lines?: 1 | 2;
}) {
  const name = team?.team_name ?? "TBD";
  const tag = Math.max(18, Math.round(basePx * 0.45));
  // The tag and the serve dot take their share of the line before the name does.
  const room = widthPx - (sides ? tag * 3.6 : 0) - (serving !== undefined ? basePx * 0.6 : 0);
  const size = fitFontSize(name, room * lines, basePx);
  return (
    <p className="flex min-w-0 items-center gap-2 font-bold leading-tight" style={{ fontSize: size }}>
      {serving !== undefined && (
        // Glyph plus colour, never colour alone: an LED wall's calibration and a
        // colour-blind viewer both defeat colour-only encoding.
        <span
          aria-label={serving ? "serving" : undefined}
          className="inline-block shrink-0 text-center text-accent"
          style={{ width: size * 0.6 }}
        >
          {serving ? "●" : ""}
        </span>
      )}
      {sides && <SideTag side={side} size={tag} />}
      <span className={lines === 2 ? "min-w-0 break-words" : "min-w-0 truncate"}>{name}</span>
    </p>
  );
}

/**
 * The fixture waiting on a court: two sides facing each other across a "v".
 *
 * Always side by side, at every density. Stacking them down the card was the
 * obvious reading of "one above the other", and on a four-court wall it pushed
 * the second team clean off the bottom — a fixture card that shows one of the
 * two teams is worse than no card. A court card is always wider than it is tall,
 * so across is the shape that fits.
 *
 * The player cards are sized from the cell this card was given, by whichever of
 * width and height runs out first, so nothing is ever cut.
 */
function NextCard({ courtName, match, teamA, teamB, density, cardWidth, cardHeight, sides }: CourtCardProps) {
  const t = TYPE[density];
  const shows = showsAt(density);
  const nameSize = Math.max(18, Math.round(t.player * 0.8));
  const mostPlayers = Math.max(teamA?.players.length ?? 0, teamB?.players.length ?? 0, 1);

  // Half the card, less its padding and the "v" between the two sides.
  const sideWidth = (cardWidth - 48 - 56) / 2;
  // The card, less the court strip, its own padding and the team name under it.
  const room = cardHeight - 44 - 28 - t.team * 1.5;
  const photo = Math.floor(
    Math.max(
      64,
      Math.min(
        // A ceiling only, so the cards stay cards. One court has the height for
        // much larger ones; four share it and are held to the width instead.
        density === "hero" ? 360 : 190,
        (sideWidth - 12 * (mostPlayers - 1)) / mostPlayers,
        room / CARD_RATIO,
      ),
    ),
  );

  const side = (key: SideKey, team: PublicTeam | null) => {
    const name = team?.team_name ?? "TBD";
    const tag = Math.max(18, Math.round(t.team * 0.45));
    return (
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3">
        {shows.photos && team && team.players.length > 0 && (
          <div className="flex items-end gap-3">
            {team.players.map((p) => (
              <PlayerCard key={p.id} player={p} width={photo} nameSize={nameSize} />
            ))}
          </div>
        )}
        <p
          className="flex max-w-full items-center justify-center gap-3 text-center font-bold leading-tight"
          style={{ fontSize: fitFontSize(name, sideWidth * 2 - (sides ? tag * 3.6 : 0), t.team) }}
        >
          {sides && <SideTag side={key} size={tag} />}
          <span className="min-w-0 break-words">{name}</span>
        </p>
      </div>
    );
  };

  return (
    <div className="bc-card flex h-full flex-col overflow-hidden">
      <CourtStrip courtName={courtName} match={match} right={<span className="shrink-0 text-[22px] font-bold text-accent">NEXT ON COURT</span>} />
      <div className="flex min-h-0 flex-1 items-center justify-center gap-6 px-6 pb-4 text-center">
        {side("A", teamA)}
        <p className="shrink-0 text-muted" style={{ fontSize: Math.max(22, t.player) }}>v</p>
        {side("B", teamB)}
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
  const { courtName, match, snapshot, teamA, teamB, density, now, motion, pollGapMs = 2_000, sides } = props;
  const t = TYPE[density];
  const shows = showsAt(density);
  const tall = isTall(density);
  // One court owns 1880 pixels of width, so its name and its score sit side by
  // side with room to spare. Two courts own 930 each, which is not enough for a
  // 150px score and a team name on one line — that is what cut "Team Alpha" to
  // "Team Alp…" — so there the name takes a line of its own above the score.
  const stack = density === "wide";

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

  // The room each part of a side's block has, so nothing has to guess. A tall
  // card gives its photos at most two fifths of the width; a short one keeps the
  // old strip and only sizes its boxes honestly.
  const cardPad = 56;
  // As tall as the row allows: a card is 3:4, and one court gives each side
  // about 400 pixels of height.
  const photoWidth = tall ? (density === "hero" ? 290 : 185) : Math.min(t.photo, 120);
  const photoRoom = (n: number) => (n > 0 ? n * photoWidth + (n - 1) * 12 + 16 : 0);
  /** What the scoreboard takes when it sits beside the name rather than under it. */
  const scoreRoom =
    numeralWidth(2, Math.round(t.games * 0.8)) + numeralWidth(2, t.games) + numeralWidth(2, t.points) + t.games;

  return (
    <div className="bc-card relative flex h-full flex-col overflow-hidden">
      <CourtStrip
        courtName={courtName}
        match={match}
        right={
          snapshot?.tiebreak ? (
            <span className="shrink-0 rounded-lg bg-warning/25 px-3 py-0.5 text-[22px] font-bold text-warning">
              {snapshot.match_tiebreak ? "MATCH TIE-BREAK" : "TIE-BREAK"}
            </span>
          ) : match?.status === "paused" ? (
            <span className="shrink-0 text-[22px] font-bold text-warning">PAUSED</span>
          ) : (
            <span className="shrink-0 text-[22px] font-bold text-success">● LIVE</span>
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
          const players = shows.photos ? (team?.players ?? []) : [];
          // What is left for the name and the score once the photos have theirs.
          const rest = props.cardWidth - cardPad - photoRoom(players.length);
          const numerals = (
            <Numerals
              sets={snapshot?.sets[idx] ?? 0}
              games={snapshot?.games[idx] ?? 0}
              points={points}
              t={t}
              captions={tall}
              beating={Boolean(seen.beat)}
              motion={motion}
              burst={scored ? { startedAt: beat!.startedAt, ms: Math.min(700, BEAT_MS[beat!.kind]) } : null}
              sideHex={sides ? SIDES[key].hex : null}
            />
          );

          return (
            <div
              key={key}
              className={`relative flex min-h-0 flex-1 gap-4 overflow-hidden rounded-2xl px-3 ${tall ? "items-center py-2" : "items-center"}`}
              style={sides ? sideRowStyle(key) : undefined}
            >
              {/* The pulse on the scoring row. Keyed by the beat so a new point
                  restarts it rather than continuing the last one. */}
              {scored && motion && (
                <span
                  key={beat!.startedAt}
                  aria-hidden
                  className={`bc-animate pointer-events-none absolute inset-0 rounded-2xl ${sides ? "" : "bg-accent/25"}`}
                  style={{
                    animation: `bc-row-pulse ${BEAT_MS[beat!.kind]}ms ease-out both`,
                    ...(sides ? { background: sideTint(key, 0.4) } : {}),
                  }}
                />
              )}

              {players.length > 0 &&
                (tall ? (
                  <div className="flex shrink-0 items-center gap-3">
                    {players.map((p) => (
                      <PlayerCard key={p.id} player={p} width={photoWidth} nameSize={Math.max(18, t.player * 0.78)} />
                    ))}
                  </div>
                ) : (
                  <div className="flex shrink-0 -space-x-3">
                    {players.map((p) => (
                      <Portrait key={p.id} player={p} size={photoWidth} />
                    ))}
                  </div>
                ))}

              {stack ? (
                // The name across the top of the space the photos left, the score
                // under it — so both get the full width instead of competing for
                // one line.
                <div className="flex min-w-0 flex-1 flex-col justify-center gap-2">
                  <TeamName
                    team={team}
                    side={key}
                    sides={Boolean(sides)}
                    basePx={t.team}
                    widthPx={rest}
                    serving={serving === key && !snapshot?.tiebreak}
                  />
                  <p className="truncate text-muted" style={{ fontSize: t.player }}>
                    {playerNames(team, shows.fullNames)}
                  </p>
                  <div className="flex items-end justify-end">{numerals}</div>
                </div>
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <TeamName
                      team={team}
                      side={key}
                      sides={Boolean(sides)}
                      basePx={t.team}
                      widthPx={rest - scoreRoom}
                      serving={serving === key && !snapshot?.tiebreak}
                      lines={tall ? 2 : 1}
                    />
                    <p className="truncate text-muted" style={{ fontSize: t.player }}>
                      {playerNames(team, shows.fullNames)}
                    </p>
                  </div>
                  {numerals}
                </>
              )}
            </div>
          );
        })}
      </div>

      {beat && beat.kind !== "point" && motion && (
        <div
          key={`label-${beat.startedAt}`}
          aria-hidden
          className={`bc-animate pointer-events-none absolute right-5 top-[52px] rounded-xl px-4 py-1 text-[26px] font-black uppercase text-white ${sides ? "" : "bg-accent"}`}
          style={{ animation: `bc-rank-in 240ms ease-out both`, ...(sides ? { background: SIDES[beat.side].hex } : {}) }}
        >
          {beat.kind === "set" ? "SET" : "GAME"} · {sides ? SIDES[beat.side].label : (beat.side === "A" ? teamA : teamB)?.team_name}
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
  sides,
}: CourtCardProps & { elapsedMs: number }) {
  const t = TYPE[density];
  const photo = density === "hero" ? 300 : density === "wide" ? 210 : 130;
  // Seek ONCE, from how far in the entrance was when this overlay appeared, then
  // let the browser run the animations. Re-deriving the negative delay on every
  // clock tick would re-time animations already running and count the elapsed
  // time twice, playing the whole entrance at roughly double speed.
  const [seekFrom] = useState(elapsedMs);
  const at = (beginsAtMs: number) => seekStyle(seekFrom, beginsAtMs);

  const side = (team: PublicTeam | null, rank: string | null, from: "left" | "right", begins: number, key: SideKey) => (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-3">
      <div className="flex items-end gap-4">
        {(team?.players ?? []).map((p, i) => (
          <div
            key={p.id}
            className="bc-animate"
            style={{
              animation: `${from === "left" ? "bc-in-left" : "bc-in-right"} 520ms cubic-bezier(.2,.8,.2,1) both`,
              ...at(begins + i * 140),
            }}
          >
            {/* The name rides on the card now, on its own faded plate, rather than
                below it — one object per player instead of two stacked pieces. */}
            <PlayerCard player={p} width={photo} nameSize={Math.max(20, t.player * 0.9)} />
          </div>
        ))}
      </div>
      {sides && <SideTag side={key} size={Math.max(18, Math.round(t.team * 0.45))} />}
      <p className="max-w-full break-words text-center font-black leading-tight" style={{ fontSize: t.team }}>
        {team?.team_name ?? "TBD"}
      </p>
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
        {side(teamA, rankA, "left", ENTRANCE.marks[1], "A")}
        <p className="text-[40px] font-black text-muted">v</p>
        {side(teamB, rankB, "right", ENTRANCE.marks[2], "B")}
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
  cardWidth,
  now,
  motion,
  animate,
  sides,
}: CourtCardProps & { animate: boolean }) {
  const t = TYPE[density];
  const shows = showsAt(density);
  const tall = isTall(density);
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
  const photoWidth = tall ? (density === "hero" ? 210 : 155) : Math.min(t.photo, 112);

  // The winner chip and the photos take their share before the name does.
  const nameRoom = (photos: number) =>
    cardWidth - 100 - (photos > 0 ? photos * photoWidth + (photos - 1) * 12 + 16 : 0);
  const row = (team: PublicTeam | null, isWinner: boolean, key: SideKey) => {
    const players = shows.photos ? (team?.players ?? []) : [];
    return (
      <div
        className={`bc-animate flex min-h-0 flex-1 items-center gap-4 overflow-hidden rounded-2xl px-3 ${isWinner && !sides ? "bg-accent/15" : ""}`}
        style={{
          ...(sides ? { ...sideRowStyle(key), background: sideTint(key, isWinner ? 0.28 : 0.1) } : {}),
          ...(run
            ? {
                animation: isWinner ? "bc-lift 600ms ease-out both" : "bc-recede 600ms ease-out both",
                ...seek(isWinner ? RESULT.marks[1] : RESULT.marks[0]),
              }
            : isWinner
              ? {}
              : { opacity: 0.45 }),
        }}
      >
        {players.length > 0 &&
          (tall ? (
            <div className="flex shrink-0 items-center gap-3">
              {players.map((p) => (
                <PlayerCard key={p.id} player={p} width={photoWidth} nameSize={Math.max(18, t.player * 0.78)} />
              ))}
            </div>
          ) : (
            <div className="flex shrink-0 -space-x-3">
              {players.map((p) => (
                <Portrait key={p.id} player={p} size={photoWidth} />
              ))}
            </div>
          ))}
        <div className="min-w-0 flex-1">
          <TeamName
            team={team}
            side={key}
            sides={Boolean(sides)}
            basePx={t.team}
            widthPx={nameRoom(players.length)}
            lines={tall ? 2 : 1}
          />
          <p className="truncate text-muted" style={{ fontSize: t.player }}>{playerNames(team, shows.fullNames)}</p>
        </div>
        {isWinner && (
          <span
            className={`bc-animate shrink-0 origin-left rounded-xl px-4 py-1 text-[26px] font-black text-white ${sides ? "" : "bg-accent"}`}
            style={{
              ...(sides ? { background: SIDES[key].hex } : {}),
              ...(run ? { animation: "bc-chip 360ms ease-out both", ...seek(RESULT.marks[1]) } : {}),
            }}
          >
            {chip}
          </span>
        )}
      </div>
    );
  };

  return (
    <div
      className={`bc-card relative flex h-full flex-col overflow-hidden ${sides ? "" : "border-accent/60"}`}
      style={sides && match?.winner_team_id ? { borderColor: SIDES[winnerIsA ? "A" : "B"].hex } : undefined}
    >
      <CourtStrip courtName={courtName} match={match} right={<span className="shrink-0 text-[22px] font-bold text-accent">FINAL</span>} />
      <div className="flex flex-1 flex-col gap-3 px-5 pb-4">
        {row(teamA, winnerIsA, "A")}
        <div className="flex shrink-0 flex-wrap items-center justify-center gap-6" data-numeral>
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
                {s.matchTiebreak && s.tiebreak ? (
                  <>[{s.tiebreak.a}-{s.tiebreak.b}]</>
                ) : (
                  <>
                    {s.teamAGames}-{s.teamBGames}
                    {s.tiebreak ? <sup className="text-[22px] text-muted"> ({Math.min(s.tiebreak.a, s.tiebreak.b)})</sup> : null}
                  </>
                )}
              </span>
            ))
          )}
        </div>
        {row(teamB, !winnerIsA && Boolean(match?.winner_team_id), "B")}
      </div>
      <span className="sr-only">{winner ? `${winner.team_name} won` : ""}</span>
    </div>
  );
}
