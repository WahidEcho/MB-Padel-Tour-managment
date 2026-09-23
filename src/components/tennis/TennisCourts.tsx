"use client";

import { useState } from "react";
import { Big_Shoulders } from "next/font/google";
import { currentServer, formatSet, servingPlayer, type ScoreState, type TeamKey } from "@/lib/scoring/engine";
import type { PublicPlayer } from "@/lib/public";
import { RUBBER_LABELS } from "@/lib/tennis/ties";
import { callout, courtScene, tieScore, type CourtScene, type SceneRubber } from "@/lib/tennis/tvScene";
import { frameFrom, type LiveMatch, type LiveSnapshot } from "@/lib/tv/liveFeed";
import { classifyPointChange, type ScoreFrame } from "@/lib/tv/pointBeat";
import type { CompletedSet, MatchRules, RubberType } from "@/lib/types";
import { useLive } from "@/components/broadcast/LiveFeedProvider";
import Face, { Flag, flagSrc, splitName } from "./Face";
import s from "./tennis.module.css";

const display = Big_Shoulders({ subsets: ["latin", "latin-ext"], variable: "--tennis-display", display: "swap" });

/** A nation on the wall: public fields only. */
export interface TvNation {
  id: string;
  name: string;
  code: string;
  iso2: string | null;
  captain: string | null;
  seed: number | null;
  players: PublicPlayer[];
}

export interface TvTie {
  id: string;
  court_id: string | null;
  tie_order: number;
  round_name: string | null;
  scheduled_time: string | null;
  team_a_id: string | null;
  team_b_id: string | null;
}

/** What the feed does not carry about a rubber: its place in the tie and its nominees. */
export interface TvRubber {
  id: string;
  tie_id: string;
  rubber_no: number;
  rubber_type: RubberType;
  a: string[];
  b: string[];
  rules: MatchRules;
}

export interface TvCourt {
  id: string;
  name: string;
}

interface Ctx {
  nations: Record<string, TvNation>;
  ties: Record<string, TvTie>;
  rubbers: Record<string, TvRubber>;
  records: Record<string, [number, number]>;
  matches: Map<string, LiveMatch>;
  snaps: Map<string, LiveSnapshot>;
  sceneRubbers: SceneRubber[];
  now: number;
  motion: boolean;
  pollGapMs: number;
  timeZone: string;
}

const DONE = ["completed", "walkover", "retired", "disqualified"];

/**
 * The court TVs of a nations team competition. One court fills the wall; a
 * screen covering several shows each court's own scene side by side, at half size.
 */
export default function TennisCourts({
  courts,
  pinnedCourtId,
  nations,
  ties,
  rubbers,
  records,
  timeZone = "Africa/Cairo",
}: {
  courts: TvCourt[];
  pinnedCourtId: string | null;
  nations: Record<string, TvNation>;
  ties: TvTie[];
  rubbers: Record<string, TvRubber>;
  /** Each player's won-lost in this event's finished rubbers. */
  records: Record<string, [number, number]>;
  timeZone?: string;
}) {
  const { feed, now, motion, pollGapMs } = useLive();
  if (!feed) return null;
  const shown = pinnedCourtId ? courts.filter((c) => c.id === pinnedCourtId) : courts;
  const matches = new Map(feed.matches.map((m) => [m.id, m]));
  const snaps = new Map(feed.snapshots.map((x) => [x.match_id, x]));
  const sceneRubbers: SceneRubber[] = Object.values(rubbers).flatMap((r) => {
    const m = matches.get(r.id);
    if (!m) return [];
    return [{
      id: r.id,
      tie_id: r.tie_id,
      rubber_no: r.rubber_no,
      rubber_type: r.rubber_type,
      court_id: m.court_id,
      status: m.status,
      started_at: m.started_at,
      ended_at: m.ended_at,
      winner_team_id: m.winner_team_id,
      team_a_id: m.team_a_id,
      team_b_id: m.team_b_id,
      last_event_number: snaps.get(r.id)?.last_event_number ?? 0,
    }];
  });
  const sceneTies = ties.map((t) => ({ id: t.id, court_id: t.court_id, tie_order: t.tie_order, team_a_id: t.team_a_id, team_b_id: t.team_b_id }));
  const ctx: Ctx = {
    nations,
    ties: Object.fromEntries(ties.map((t) => [t.id, t])),
    rubbers,
    records,
    matches,
    snaps,
    sceneRubbers,
    now,
    motion,
    pollGapMs,
    timeZone,
  };
  const replay = feed.screen.entrance_replay;
  const cls = `${s.scene} ${display.variable}${motion ? "" : ` ${s.still}`}`;

  if (shown.length === 0) {
    return <div className={cls}><div className={s.idle}>No courts on this screen</div></div>;
  }
  if (shown.length === 1) {
    const court = shown[0];
    const scene = courtScene(court.id, sceneTies, sceneRubbers, now, replay);
    return (
      <div className={cls} data-scene={scene.kind}>
        <CourtScene scene={scene} court={court} ctx={ctx} />
      </div>
    );
  }
  // Several courts: each keeps its own 1920×900 layout, scaled into a column.
  const cellW = (1920 - 40 - 16 * (shown.length - 1)) / shown.length;
  const scale = cellW / 1920;
  return (
    <div className={cls}>
      <div className={s.stack} style={{ gridTemplateColumns: `repeat(${shown.length}, 1fr)`, alignItems: "center" }}>
        {shown.map((court) => {
          const scene = courtScene(court.id, sceneTies, sceneRubbers, now, replay);
          return (
            <div key={court.id} className={s.compact} style={{ height: 900 * scale }} data-scene={scene.kind}>
              <div className={s.compactInner} style={{ transform: `scale(${scale})` }}>
                <CourtScene scene={scene} court={court} ctx={ctx} compact />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CourtScene({ scene, court, ctx, compact = false }: { scene: CourtScene; court: TvCourt; ctx: Ctx; compact?: boolean }) {
  const chip = (
    <div className={s.courtChip}>
      <span className={s.courtDot} />
      {court.name}
    </div>
  );
  switch (scene.kind) {
    case "idle":
      return (
        <>
          {chip}
          <div className={s.idle}>{court.name} · next tie to be announced</div>
        </>
      );
    case "lineup":
      return <LineupScene key={scene.tieId} tieId={scene.tieId} court={court} ctx={ctx} />;
    case "walkon":
      return (
        <>
          {compact && chip}
          <WalkOnScene key={`${scene.matchId}:${scene.side}`} matchId={scene.matchId} side={scene.side} ctx={ctx} />
        </>
      );
    case "live":
      return (
        <>
          {compact && chip}
          <LiveScene key={scene.matchId} matchId={scene.matchId} ctx={ctx} />
        </>
      );
    case "rubber_won":
      return (
        <>
          {chip}
          <RubberWonScene key={scene.matchId} matchId={scene.matchId} ctx={ctx} />
        </>
      );
    case "tie_score":
      return (
        <>
          {chip}
          <TieScoreScene key={`${scene.tieId}:${scene.final}`} tieId={scene.tieId} final={scene.final} ctx={ctx} />
        </>
      );
  }
}

// ---------- helpers ----------

function playersOf(ctx: Ctx, nationId: string | null | undefined, ids: string[]): PublicPlayer[] {
  const n = nationId ? ctx.nations[nationId] : undefined;
  if (!n) return [];
  return ids.map((id) => n.players.find((p) => p.id === id)).filter((p): p is PublicPlayer => Boolean(p));
}

function surnames(players: PublicPlayer[]): string {
  return players.map((p) => splitName(p.full_name)[1]).join(" / ");
}

function sideOf(ctx: Ctx, matchId: string, side: TeamKey) {
  const m = ctx.matches.get(matchId);
  const r = ctx.rubbers[matchId];
  const nationId = side === "A" ? m?.team_a_id : m?.team_b_id;
  const nation = nationId ? ctx.nations[nationId] : undefined;
  const players = playersOf(ctx, nationId, r ? (side === "A" ? r.a : r.b) : []);
  return { nation, players };
}

function rubberTitle(r: TvRubber | undefined): string {
  return r ? `Rubber ${r.rubber_no} · ${RUBBER_LABELS[r.rubber_type]}` : "";
}

/** Sets from one side's point of view: 6-4 3-6 [10-8]. */
function setsLine(sets: CompletedSet[], from: TeamKey): string {
  return sets
    .map((x) => formatSet(from === "A" ? x : { ...x, teamAGames: x.teamBGames, teamBGames: x.teamAGames, tiebreak: x.tiebreak ? { a: x.tiebreak.b, b: x.tiebreak.a } : undefined }))
    .join("  ");
}

function clock(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso));
}

function tieRubbers(ctx: Ctx, tieId: string): SceneRubber[] {
  return ctx.sceneRubbers.filter((r) => r.tie_id === tieId).sort((a, b) => a.rubber_no - b.rubber_no);
}

function TieBar({ tieId, ctx, label }: { tieId: string; ctx: Ctx; label: string }) {
  const tie = ctx.ties[tieId];
  const a = tie?.team_a_id ? ctx.nations[tie.team_a_id] : undefined;
  const b = tie?.team_b_id ? ctx.nations[tie.team_b_id] : undefined;
  const [ta, tb] = tieScore(tieRubbers(ctx, tieId), tie?.team_a_id ?? null);
  return (
    <div className={s.tiebar}>
      <span className={s.tiebarNation}>
        <Flag iso2={a?.iso2} height={36} />
        {a?.code}
      </span>
      <span className={s.tiebarScore}>
        {ta}–{tb}
      </span>
      <span className={s.tiebarNation}>
        {b?.code}
        <Flag iso2={b?.iso2} height={36} />
      </span>
      <span className={s.tiebarLabel}>{label}</span>
    </div>
  );
}

// ---------- line-up ----------

function LineupScene({ tieId, court, ctx }: { tieId: string; court: TvCourt; ctx: Ctx }) {
  const tie = ctx.ties[tieId];
  const rubbers = Object.values(ctx.rubbers).filter((r) => r.tie_id === tieId).sort((x, y) => x.rubber_no - y.rubber_no);
  const side = (key: TeamKey) => {
    const nationId = key === "A" ? tie.team_a_id : tie.team_b_id;
    const n = nationId ? ctx.nations[nationId] : undefined;
    return (
      <div className={`${s.side} ${key === "A" ? s.sideLeft : s.sideRight}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a local SVG flag */}
        {flagSrc(n?.iso2) && <img src={flagSrc(n?.iso2)!} alt="" className={s.sideField} />}
        <div className={s.code}>{n?.code ?? "TBD"}</div>
        <div className={s.cname}>
          {n?.name}
          {n?.seed ? ` · seed ${n.seed}` : ""}
        </div>
        {rubbers.map((r) => {
          const players = playersOf(ctx, nationId, key === "A" ? r.a : r.b);
          return (
            <div key={r.id} className={s.lrow}>
              <span className={s.slot}>{r.rubber_type === "D" ? "DBL" : r.rubber_type === "S1" ? "No. 1" : "No. 2"}</span>
              <div style={{ display: "flex", gap: 6, height: 96 }}>
                {(players.length ? players : [null]).map((p, i) => (
                  <Face key={p?.id ?? i} player={p} iso2={n?.iso2} size={96} className={s.lineupFace} />
                ))}
              </div>
              <span className={s.lname}>
                {players.length ? surnames(players) : "To be named"}
                <small>{players.length ? players.map((p) => p.full_name).join(" & ") : RUBBER_LABELS[r.rubber_type]}</small>
              </span>
            </div>
          );
        })}
        {n?.captain && <div className={s.captain}>Captain · {n.captain}</div>}
      </div>
    );
  };
  return (
    <div className={s.lineup}>
      {side("A")}
      {side("B")}
      <div className={s.vs}>VS</div>
      <div className={s.lineupWhen}>
        {[court.name, clock(tie.scheduled_time, ctx.timeZone), tie.round_name].filter(Boolean).join(" · ")}
      </div>
    </div>
  );
}

// ---------- walk-on ----------

function WalkOnScene({ matchId, side, ctx }: { matchId: string; side: TeamKey; ctx: Ctx }) {
  const r = ctx.rubbers[matchId];
  const { nation, players } = sideOf(ctx, matchId, side);
  const pair = players.length > 1;
  const [first] = players.length === 1 ? splitName(players[0].full_name) : [players.map((p) => splitName(p.full_name)[0]).join(" & ")];
  const record = players.length === 1 ? ctx.records[players[0].id] : undefined;
  return (
    <>
      <div className={s.walkRibbon}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a local SVG flag */}
        {flagSrc(nation?.iso2) && <img src={flagSrc(nation?.iso2)!} alt="" />}
      </div>
      <div className={`${s.walkPortrait} ${pair ? s.walkPortraitPair : ""}`}>
        {(players.length ? players : [null]).map((p, i) => (
          <Face key={p?.id ?? i} player={p} iso2={nation?.iso2} size={pair ? 420 : 620} cutout className={s.walkFace} />
        ))}
      </div>
      <div className={s.walkText}>
        <div className={s.walkRubber}>{rubberTitle(r)}</div>
        <div className={s.walkNation}>
          <Flag iso2={nation?.iso2} height={48} />
          {nation?.name}
        </div>
        <div className={s.walkFirst}>{first}</div>
        <div className={`${s.walkLast} ${pair ? s.walkLastPair : ""}`}>
          {pair ? players.map((p) => <span key={p.id}>{splitName(p.full_name)[1]}</span>) : players.length ? surnames(players) : nation?.code}
        </div>
        <div className={s.walkStats}>
          {nation?.seed ? (
            <div>
              <small>Nation seed</small>
              <b>{nation.seed}</b>
            </div>
          ) : null}
          <div>
            <small>This event</small>
            <b>{record ? `${record[0]}–${record[1]}` : "Debut"}</b>
          </div>
          {nation?.captain && (
            <div>
              <small>Captain</small>
              <b>{splitName(nation.captain)[1]}</b>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ---------- live score ----------

const BEAT_MS = { point: 900, game: 1400, set: 1400 } as const;

/**
 * The latest point, classified as it arrives (during render, as the court cards
 * do), so its row can flash and a won game can sweep.
 */
function useBeat(snap: LiveSnapshot | undefined, now: number, pollGapMs: number): { side: TeamKey; kind: "point" | "game" | "set"; key: number } | null {
  const [seen, setSeen] = useState<{ frame: ScoreFrame | null; beat: { side: TeamKey; kind: "point" | "game" | "set"; key: number; at: number } | null }>({
    frame: snap ? frameFrom(snap) : null,
    beat: null,
  });
  if (snap && snap.last_event_number !== seen.frame?.eventNumber) {
    const next = frameFrom(snap);
    const beat = classifyPointChange(seen.frame, next, { observedGapMs: pollGapMs });
    setSeen({ frame: next, beat: beat.kind === "none" ? null : { side: beat.side, kind: beat.kind, key: next.eventNumber, at: now } });
  }
  return seen.beat && now - seen.beat.at < BEAT_MS[seen.beat.kind] ? seen.beat : null;
}

function LiveScene({ matchId, ctx }: { matchId: string; ctx: Ctx }) {
  const r = ctx.rubbers[matchId];
  const m = ctx.matches.get(matchId);
  const snap = ctx.snaps.get(matchId);
  const beat = useBeat(snap, ctx.now, ctx.pollGapMs);
  if (!r || !m) return null;
  const state: ScoreState | undefined = snap?.state;
  const serverTeam: TeamKey | null = state
    ? currentServer(state)
    : snap?.serving_team_id
      ? snap.serving_team_id === m.team_a_id ? "A" : "B"
      : null;
  const doublesServer = state && r.rubber_type === "D" ? servingPlayer(state) : null;
  const call = callout(state, r.rules);
  const sets = snap?.completed_sets ?? [];
  const totalSets = Math.max(1, r.rules.setsToWinMatch * 2 - 1);
  const tiebreak = Boolean(snap?.tiebreak);
  const tie = ctx.ties[r.tie_id];

  const row = (key: TeamKey) => {
    const k = key === "A" ? 0 : 1;
    const { nation, players } = sideOf(ctx, matchId, key);
    const serving = serverTeam === key;
    const firsts = players.map((p, i) => {
      const first = splitName(p.full_name)[0];
      const on = serving && (doublesServer ? doublesServer.index === i : true);
      return (
        <span key={p.id} className={on && players.length > 1 ? s.servingName : undefined}>
          {first}
        </span>
      );
    });
    const pointLabel = snap ? (tiebreak ? String(snap.tiebreak_points[k]) : snap.points[k]) : "0";
    const won = beat !== null && beat.side === key;
    const gameWon = beat !== null && won && beat.kind !== "point";
    return (
      <div key={key} className={`${s.row} ${serving ? s.serving : ""}`}>
        {beat && won && ctx.motion && <span key={`hit${beat.key}`} className={s.hitRing} />}
        <span className={s.serve} />
        <div className={s.faces}>
          {(players.length ? players : [null]).map((p, i) => (
            <Face key={p?.id ?? i} player={p} iso2={nation?.iso2} size={players.length > 1 ? 85 : 170} />
          ))}
        </div>
        <div className={s.who}>
          <div className={s.whoFirst}>
            <Flag iso2={nation?.iso2} height={28} />
            {nation?.code}
            {firsts.length > 0 && <span>·</span>}
            {firsts.reduce<React.ReactNode[]>((acc, f, i) => (i ? [...acc, " & ", f] : [f]), [])}
          </div>
          <div className={`${s.whoLast} ${players.length > 1 ? s.whoLastDoubles : ""}`}>{players.length ? surnames(players) : nation?.name}</div>
        </div>
        {Array.from({ length: 3 }, (_, i) => {
          if (i >= totalSets) return <span key={i} />;
          const done = sets[i];
          if (done) {
            const mine = k === 0 ? done.teamAGames : done.teamBGames;
            const theirs = k === 0 ? done.teamBGames : done.teamAGames;
            const tb = done.tiebreak ? (k === 0 ? done.tiebreak.a : done.tiebreak.b) : null;
            if (done.matchTiebreak && done.tiebreak) {
              return <span key={i} className={`${s.set} ${tb! > (k === 0 ? done.tiebreak.b : done.tiebreak.a) ? s.setWon : ""}`}>{tb}</span>;
            }
            return (
              <span key={i} className={`${s.set} ${mine > theirs ? s.setWon : ""}`}>
                {mine}
                {tb !== null && mine < theirs && <sup>{tb}</sup>}
              </span>
            );
          }
          if (i === sets.length && snap && !snap.match_tiebreak) {
            const g = snap.games[k];
            return (
              <span key={i} className={`${s.set} ${s.setCurrent}`}>
                <span key={g} className={ctx.motion && gameWon ? s.pulse : undefined}>{g}</span>
              </span>
            );
          }
          return <span key={i} className={s.set} />;
        })}
        <div className={s.points}>
          <span key={`${pointLabel}:${snap?.last_event_number ?? 0}`} className={ctx.motion ? s.flip : undefined}>
            {pointLabel}
          </span>
        </div>
        {beat && gameWon && ctx.motion && <span key={`sw${beat.key}`} className={s.sweep} />}
      </div>
    );
  };

  const setHeads = Array.from({ length: 3 }, (_, i) =>
    i < totalSets && !(snap?.match_tiebreak && i === sets.length) ? `Set ${i + 1}` : "",
  );
  return (
    <>
      <TieBar tieId={r.tie_id} ctx={ctx} label={tie?.round_name ?? "Tie"} />
      <div className={s.heads}>
        <span />
        <span />
        <span style={{ textAlign: "left", paddingLeft: 30 }}>{rubberTitle(r)}</span>
        {setHeads.map((h, i) => (
          <span key={i}>{h}</span>
        ))}
        <span>{snap?.match_tiebreak ? "Match TB" : tiebreak ? "Tie-break" : "Points"}</span>
      </div>
      <div className={s.board}>
        {row("A")}
        {row("B")}
      </div>
      {call && (
        <div key={`${call}:${snap?.last_event_number ?? 0}`} className={s.callout}>
          {call}
        </div>
      )}
      <div className={s.meta}>{r.rules.decidingPoint ? "No-ad · " : ""}{r.rules.matchTiebreak ? `Match tie-break to ${r.rules.matchTiebreakPoints ?? 10} in place of a final set` : `Best of ${totalSets} sets`}</div>
      {m.status === "paused" && <div className={s.pausedTag}>PLAY SUSPENDED</div>}
    </>
  );
}

// ---------- rubber won ----------

function RubberWonScene({ matchId, ctx }: { matchId: string; ctx: Ctx }) {
  const r = ctx.rubbers[matchId];
  const m = ctx.matches.get(matchId);
  if (!r || !m) return null;
  const winner: TeamKey = m.winner_team_id && m.winner_team_id === m.team_b_id ? "B" : "A";
  const { nation, players } = sideOf(ctx, matchId, winner);
  const sets = ctx.snaps.get(matchId)?.completed_sets ?? [];
  const tie = ctx.ties[r.tie_id];
  const [ta, tb] = tieScore(tieRubbers(ctx, r.tie_id), tie?.team_a_id ?? null);
  const lead = winner === "A" ? [ta, tb] : [tb, ta];
  const other = winner === "A" ? (tie?.team_b_id ? ctx.nations[tie.team_b_id] : undefined) : (tie?.team_a_id ? ctx.nations[tie.team_a_id] : undefined);
  const tieLine =
    lead[0] >= 2 ? `${nation?.name} win the tie ${lead[0]}–${lead[1]}` : lead[0] === lead[1] ? `Tie level ${lead[0]}–${lead[1]}` : lead[0] > lead[1] ? `${nation?.name} lead ${lead[0]}–${lead[1]}` : `${other?.name} lead ${lead[1]}–${lead[0]}`;
  const how = m.status === "walkover" ? "Walkover" : m.status === "retired" ? "Retired" : m.status === "disqualified" ? "Default" : "";
  return (
    <div className={s.won}>
      <div className={s.wonEyebrow}>
        {RUBBER_LABELS[r.rubber_type]} · won by {nation?.name}
      </div>
      <div className={s.wonFaces}>
        {(players.length ? players : [null]).map((p, i) => (
          <Face key={p?.id ?? i} player={p} iso2={nation?.iso2} size={330} className={s.wonFace} />
        ))}
      </div>
      <div className={s.wonName}>{players.length ? surnames(players) : nation?.name}</div>
      <div className={s.wonScore}>{[setsLine(sets, winner), how].filter(Boolean).join(" · ")}</div>
      <div className={s.wonTie}>{tieLine}</div>
    </div>
  );
}

// ---------- tie score ----------

function TieScoreScene({ tieId, final, ctx }: { tieId: string; final: boolean; ctx: Ctx }) {
  const tie = ctx.ties[tieId];
  const a = tie?.team_a_id ? ctx.nations[tie.team_a_id] : undefined;
  const b = tie?.team_b_id ? ctx.nations[tie.team_b_id] : undefined;
  const scene = tieRubbers(ctx, tieId);
  const [ta, tb] = tieScore(scene, tie?.team_a_id ?? null);
  const rubbers = Object.values(ctx.rubbers).filter((r) => r.tie_id === tieId).sort((x, y) => x.rubber_no - y.rubber_no);
  const next = rubbers.find((r) => {
    const st = ctx.matches.get(r.id)?.status;
    return st && !DONE.includes(st) && st !== "cancelled";
  });
  const winner = final ? (ta > tb ? a : tb > ta ? b : undefined) : undefined;
  return (
    <div className={s.tie}>
      <div className={s.tieEyebrow}>
        {[tie?.round_name, final ? (winner ? `${winner.name} win the tie` : "Final score") : "Tie score"].filter(Boolean).join(" · ")}
      </div>
      <div className={s.tieBig}>
        <div className={s.tieNat}>
          <Flag iso2={a?.iso2} height={120} />
          {a?.code}
        </div>
        <span className={s.tieNum}>{ta}</span>
        <span className={s.tieDash}>–</span>
        <span className={s.tieNum}>{tb}</span>
        <div className={s.tieNat}>
          <Flag iso2={b?.iso2} height={120} />
          {b?.code}
        </div>
      </div>
      <div className={s.rubbers}>
        {rubbers.map((r, i) => {
          const m = ctx.matches.get(r.id);
          const st = m?.status ?? "scheduled";
          const done = DONE.includes(st);
          const pa = surnames(playersOf(ctx, tie?.team_a_id, r.a)) || a?.code;
          const pb = surnames(playersOf(ctx, tie?.team_b_id, r.b)) || b?.code;
          const w: TeamKey | null = done && m?.winner_team_id ? (m.winner_team_id === m.team_a_id ? "A" : "B") : null;
          const sets = ctx.snaps.get(r.id)?.completed_sets ?? [];
          const state = done
            ? `Won by ${(w === "A" ? a : b)?.code ?? ""}`
            : st === "live" || st === "paused"
              ? "On court"
              : st === "cancelled"
                ? "Not played"
                : r === next
                  ? "Next"
                  : "To come";
          return (
            <div
              key={r.id}
              className={`${s.rubber} ${r === next ? s.rubberNext : ""} ${st === "cancelled" ? s.rubberOff : ""}`}
              style={{ animationDelay: `${200 + i * 90}ms` }}
            >
              <b>{r.rubber_type}</b>
              <span>
                <span style={{ fontWeight: w === "A" ? 900 : 500 }}>{pa}</span>
                <span style={{ opacity: 0.5 }}> v </span>
                <span style={{ fontWeight: w === "B" ? 900 : 500 }}>{pb}</span>
              </span>
              <span className={s.rubberScore}>{done && w ? setsLine(sets, w) : ""}</span>
              <span className={s.rubberState}>{state}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

