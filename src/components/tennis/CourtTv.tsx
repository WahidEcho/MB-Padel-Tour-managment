"use client";

/* eslint-disable @next/next/no-img-element -- the wall paints local flags and CDN-sized logos itself */
import { useState } from "react";
import { Barlow_Condensed } from "next/font/google";
import { currentServer, servingPlayer, type ScoreState, type TeamKey } from "@/lib/scoring/engine";
import { aceMoment } from "@/lib/scoring/serve";
import { statLines, durationText, type MatchStatsResult } from "@/lib/scoring/stats";
import type { PublicPlayer } from "@/lib/public";
import { callout, courtScene, tieScore, type SceneRubber } from "@/lib/tennis/tvScene";
import {
  OFFICIAL_BREAKS,
  breakLength,
  breakScene,
  cardAlpha,
  changeoverWhat,
  countdown,
  formatLine,
  matchClock,
  rubberName,
  RUBBER_NAMES,
  scoreFrom,
  setBreakWhat,
  setLabel,
  shortName,
  statCell,
  tieStatus,
  type BreakView,
  type CourtTvSettings,
  type EventRecord,
} from "@/lib/tennis/courtTv";
import type { LiveMatch, LiveSnapshot } from "@/lib/tv/liveFeed";
import type { CompletedSet } from "@/lib/types";
import { useLive } from "@/components/broadcast/LiveFeedProvider";
import { useStageSize } from "@/components/broadcast/BroadcastStage";
import TennisCourts, { type TvCourt, type TvNation, type TvRubber, type TvTie } from "./TennisCourts";
import Face, { flagSrc, splitName } from "./Face";
import s from "./courtTv.module.css";

const font = Barlow_Condensed({ subsets: ["latin", "latin-ext"], weight: ["500", "600", "700", "800"], variable: "--ctv-font", display: "swap" });

const DONE = ["completed", "walkover", "retired", "disqualified"];
const LIVE = ["live", "paused"];

export interface CourtTvPartner {
  name: string;
  src: string;
  aspect?: number;
  /** Stage pixels tall. */
  height?: number;
}

interface Props {
  court: TvCourt;
  /** The event's name: the logo's alt text, and the header's words when there is no logo. */
  title: string;
  eventLogo: string | null;
  partners: CourtTvPartner[];
  theme: "light" | "dark";
  /** An event background is drawn behind the stage. */
  backdrop: boolean;
  settings: CourtTvSettings;
  /** The organiser shows timers on TV (Scoring features: "Show timers on TV & app"). */
  timers: boolean;
  /** …and runs the 25-second timer between points. */
  shotClock: boolean;
  aces: boolean;
  nations: Record<string, TvNation>;
  ties: TvTie[];
  rubbers: Record<string, TvRubber>;
  records: Record<string, [number, number]>;
  eventRecords: Record<string, EventRecord>;
  stats: Record<string, MatchStatsResult>;
  footer: React.ReactNode;
}

interface Ctx extends Props {
  matches: Map<string, LiveMatch>;
  snaps: Map<string, LiveSnapshot>;
  sceneRubbers: SceneRubber[];
  tiesById: Record<string, TvTie>;
  now: number;
  anim: boolean;
}

/**
 * One court of a team competition on its own wall, in the Cairo design. The
 * scene comes from courtScene (line-up → walk-on → live → rubber won → tie score);
 * a live rubber shows its break when the console records one (breakScene).
 */
export default function CourtTv(props: Props) {
  const { feed, now, motion } = useLive();
  const tall = useStageSize().height > 1080;
  const scoreMovedAt = useScoreMovedAt(feed?.snapshots ?? []);
  if (!feed) return null;
  const matches = new Map(feed.matches.map((m) => [m.id, m]));
  const snaps = new Map(feed.snapshots.map((x) => [x.match_id, x]));
  const sceneRubbers: SceneRubber[] = Object.values(props.rubbers).flatMap((r) => {
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
  const sceneTies = props.ties.map((t) => ({ id: t.id, court_id: t.court_id, tie_order: t.tie_order, team_a_id: t.team_a_id, team_b_id: t.team_b_id }));
  const scene = courtScene(props.court.id, sceneTies, sceneRubbers, now, feed.screen.entrance_replay);
  const anim = motion && props.settings.breakAnimation;
  const ctx: Ctx = { ...props, matches, snaps, sceneRubbers, tiesById: Object.fromEntries(props.ties.map((t) => [t.id, t])), now, anim };

  let brk: BreakView | null = null;
  if (scene.kind === "live" && props.timers) {
    const snap = snaps.get(scene.matchId);
    brk = breakScene(snap?.state, scoreMovedAt[scene.matchId] ?? snap?.updated_at ?? null, now, { shotClock: props.shotClock });
  }
  const sub = brk && brk.kind !== "shot" ? brk.kind : scene.kind === "live" ? (brk ? "shot" : "live") : scene.kind;

  const status =
    scene.kind === "live" ? (brk?.kind === "warmup" ? "Warm-up" : "Live") : scene.kind === "rubber_won" || scene.kind === "tie_score" ? "Final" : scene.kind === "lineup" || scene.kind === "walkon" ? (scene.kind === "walkon" ? "Live" : "Next") : null;
  const pulsing = scene.kind === "live" || scene.kind === "walkon";

  const cls = [s.stage, font.variable, props.settings.palette === "noir" ? s.noir : s.forest, props.theme === "light" ? s.light : s.dark, props.settings.glass ? s.isGlass : "", anim ? s.anim : "", motion ? "" : s.still, props.backdrop ? "" : s.ground, tall ? s.tall : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls} style={{ "--ga": cardAlpha(props.settings) } as React.CSSProperties} data-scene={scene.kind} data-court-tv={sub}>
      <header className={s.header}>
        <div className={s.partners} data-testid="header-partners">
          {props.partners.map((p) => {
            const h = p.height ?? 48;
            return <img key={p.src} src={p.src} alt={p.name} style={{ height: h, width: p.aspect ? Math.round(h * p.aspect) : "auto" }} />;
          })}
        </div>
        {props.eventLogo ? <img src={props.eventLogo} alt={props.title} className={s.evLogo} /> : <h3 className={s.evTitle}>{props.title}</h3>}
        <div className={s.chip}>
          {status && (
            <>
              <i className={pulsing && motion ? s.pulse : undefined} />
              {status}
              <span className={s.sep} />
            </>
          )}
          {props.court.name}
        </div>
      </header>

      <Main scene={scene} brk={brk} ctx={ctx} />

      <footer className={s.band}>{props.footer}</footer>
    </div>
  );
}

/**
 * When each match's score last moved, as this wall saw it: the snapshot's
 * updated_at, kept only when the score itself changed (a timer started or
 * stopped rewrites the snapshot without moving the score).
 */
function useScoreMovedAt(snapshots: LiveSnapshot[]): Record<string, string | null> {
  const [seen, setSeen] = useState<Record<string, { key: string; at: string | null }>>({});
  let changed = false;
  const next: Record<string, { key: string; at: string | null }> = { ...seen };
  for (const x of snapshots) {
    const key = `${x.points.join("-")}|${x.games.join("-")}|${x.sets.join("-")}|${x.tiebreak_points.join("-")}`;
    const was = seen[x.match_id];
    if (!was) {
      next[x.match_id] = { key, at: x.updated_at ?? null };
      changed = true;
    } else if (was.key !== key) {
      next[x.match_id] = { key, at: x.updated_at ?? null };
      changed = true;
    }
  }
  if (changed) setSeen(next);
  return Object.fromEntries(Object.entries(changed ? next : seen).map(([k, v]) => [k, v.at]));
}

function Main({ scene, brk, ctx }: { scene: ReturnType<typeof courtScene>; brk: BreakView | null; ctx: Ctx }) {
  switch (scene.kind) {
    case "idle":
      return (
        <main className={s.main}>
          <div className={`${s.idle} ${s.glass}`}>{ctx.court.name} · next tie to be announced</div>
        </main>
      );
    case "lineup":
    case "walkon":
      return <Legacy ctx={ctx} />;
    case "live": {
      const legend = ctx.settings.breakLegend;
      if (brk && brk.kind !== "shot") {
        return (
          <main className={s.main} style={{ gridTemplateRows: `auto 1fr auto${legend ? " auto" : ""}` }}>
            <TieBar ctx={ctx} tieId={scene.tieId} matchId={scene.matchId} />
            <BreakPanel ctx={ctx} matchId={scene.matchId} brk={brk} />
            <Compact ctx={ctx} matchId={scene.matchId} warmup={brk.kind === "warmup"} />
            {legend && <Legend on={brk.kind} />}
          </main>
        );
      }
      return (
        <main className={s.main} style={{ gridTemplateRows: `auto 1fr${legend ? " auto" : ""}` }}>
          <TieBar ctx={ctx} tieId={scene.tieId} matchId={scene.matchId} shot={brk?.kind === "shot" && ctx.settings.breakTimer ? brk : null} />
          <ScoreCard ctx={ctx} matchId={scene.matchId} />
          {legend && <Legend on={brk?.kind === "shot" ? "shot" : null} />}
        </main>
      );
    }
    case "rubber_won":
      return <EndScene ctx={ctx} tieId={scene.tieId} matchId={scene.matchId} />;
    case "tie_score": {
      // Between rubbers and after the tie: the last rubber finished on this court.
      const last = ctx.sceneRubbers
        .filter((r) => r.tie_id === scene.tieId && DONE.includes(r.status) && r.ended_at)
        .sort((a, b) => Date.parse(b.ended_at!) - Date.parse(a.ended_at!))[0];
      return last ? <EndScene ctx={ctx} tieId={scene.tieId} matchId={last.id} /> : <Legacy ctx={ctx} />;
    }
  }
}

/** Line-up and walk-on: the classic scenes, scaled into the content area. */
function Legacy({ ctx }: { ctx: Ctx }) {
  // 1920×900 into the content box (1792 wide; 792 tall, 912 on a 16:10 canvas), centred.
  const boxH = useStageSize().height - 260 - 28;
  const scale = Math.min(1792 / 1920, boxH / 900);
  const dx = Math.round((1792 - 1920 * scale) / 2);
  const dy = Math.round((boxH - 900 * scale) / 2);
  return (
    <main className={s.main} style={{ gridTemplateRows: "1fr" }}>
      <div className={s.legacy}>
        <div className={s.legacyInner} style={{ transform: `translate(${dx}px, ${dy}px) scale(${scale})` }}>
          <TennisCourts courts={[ctx.court]} pinnedCourtId={ctx.court.id} nations={ctx.nations} ties={ctx.ties} rubbers={ctx.rubbers} records={ctx.records} />
        </div>
      </div>
    </main>
  );
}

// ---------- helpers ----------

function nationOf(ctx: Ctx, id: string | null | undefined): TvNation | undefined {
  return id ? ctx.nations[id] : undefined;
}

function sideOf(ctx: Ctx, matchId: string, side: TeamKey): { nation?: TvNation; players: PublicPlayer[] } {
  const m = ctx.matches.get(matchId);
  const r = ctx.rubbers[matchId];
  const nation = nationOf(ctx, side === "A" ? m?.team_a_id : m?.team_b_id);
  const ids = r ? (side === "A" ? r.a : r.b) : [];
  const players = nation ? ids.map((id) => nation.players.find((p) => p.id === id)).filter((p): p is PublicPlayer => Boolean(p)) : [];
  return { nation, players };
}

function FlagImg({ iso2 }: { iso2: string | null | undefined }) {
  const src = flagSrc(iso2);
  return src ? <img src={src} alt="" className={s.flagImg} /> : null;
}

function surnames(players: PublicPlayer[]): string {
  return players.map((p) => splitName(p.full_name)[1]).join(" / ");
}

function tieRubbers(ctx: Ctx, tieId: string): SceneRubber[] {
  return ctx.sceneRubbers.filter((r) => r.tie_id === tieId).sort((a, b) => a.rubber_no - b.rubber_no);
}

const CLOCK_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
    <circle cx="12" cy="13" r="8" />
    <path d="M12 9v4l2.5 2M9 2h6" />
  </svg>
);

function Ring({ size, r, w, left, className }: { size: number; r: number; w: number; left: number; className?: string }) {
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} className={className} aria-hidden>
      <circle className={s.trk} cx={size / 2} cy={size / 2} r={r} strokeWidth={w} />
      <circle className={s.prg} cx={size / 2} cy={size / 2} r={r} strokeWidth={w} strokeDasharray={c} strokeDashoffset={c * (1 - left)} />
    </svg>
  );
}

// ---------- tie bar ----------

function TieBar({ ctx, tieId, matchId, shot = null }: { ctx: Ctx; tieId: string; matchId: string; shot?: BreakView | null }) {
  const tie = ctx.tiesById[tieId];
  const a = nationOf(ctx, tie?.team_a_id);
  const b = nationOf(ctx, tie?.team_b_id);
  const [ta, tb] = tieScore(tieRubbers(ctx, tieId), tie?.team_a_id ?? null);
  const r = ctx.rubbers[matchId];
  const cd = shot ? countdown(shot.total ?? 25, shot.elapsedMs, { seconds: true }) : null;
  return (
    <div className={s.tie}>
      <div className={`${s.side} ${s.sideL}`}>
        <small>{a?.name}</small>
        {a?.code}
        <FlagImg iso2={a?.iso2} />
      </div>
      <div className={s.tieMid}>
        <div className={s.tieScore} data-testid="tv-tie-score">
          {ta}
          <em>–</em>
          {tb}
        </div>
        <div className={s.what}>Tie score{r ? ` · ${rubberName(r.rubber_no, r.rubber_type)}` : ""}</div>
      </div>
      <div className={s.side}>
        <FlagImg iso2={b?.iso2} />
        {b?.code}
        <small>{b?.name}</small>
        {cd && (
          <div className={`${s.shot} ${s.glass} ${cd.over ? s.over : ""}`} data-testid="tv-shot-clock">
            <div className={s.ring} style={{ width: 76, height: 76 }}>
              <Ring size={76} r={32} w={7} left={cd.left} />
              <b>{cd.text}</b>
            </div>
            <span>
              Shot clock<small>Between points</small>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function Legend({ on }: { on: string | null }) {
  return (
    <div className={s.legend} data-testid="tv-break-legend">
      <div className={s.t}>Official breaks</div>
      {OFFICIAL_BREAKS.map((x) => (
        <div key={x.kind} className={x.kind === on ? s.on : undefined}>
          {x.label} <b>{breakLength(x.seconds)}</b>
        </div>
      ))}
    </div>
  );
}

// ---------- live score card ----------

interface SetCell {
  label: string;
  a: number | null;
  b: number | null;
  /** A tie-break's loser points, shown small. */
  tbA?: number;
  tbB?: number;
  done: boolean;
}

function setCells(sets: CompletedSet[], snap: LiveSnapshot | undefined, live: boolean): SetCell[] {
  const cells: SetCell[] = sets.map((x, i) => {
    if (x.matchTiebreak && x.tiebreak) return { label: setLabel(i, true), a: x.tiebreak.a, b: x.tiebreak.b, done: true };
    const lowA = x.tiebreak && x.teamAGames < x.teamBGames ? x.tiebreak.a : undefined;
    const lowB = x.tiebreak && x.teamBGames < x.teamAGames ? x.tiebreak.b : undefined;
    return { label: setLabel(i, false), a: x.teamAGames, b: x.teamBGames, tbA: lowA, tbB: lowB, done: true };
  });
  if (live && snap && !snap.match_tiebreak) cells.push({ label: setLabel(sets.length, false), a: snap.games[0], b: snap.games[1], done: false });
  return cells;
}

function ScoreCard({ ctx, matchId, final = false }: { ctx: Ctx; matchId: string; final?: boolean }) {
  const r = ctx.rubbers[matchId];
  const m = ctx.matches.get(matchId);
  const snap = ctx.snaps.get(matchId);
  if (!r || !m) return null;
  const state: ScoreState | undefined = snap?.state;
  const dbl = r.rubber_type === "D";
  const sets = snap?.completed_sets ?? [];
  const cells = setCells(sets, snap, !final);
  const hasPts = !final;
  const n = Math.max(1, cells.length);
  const cols = dbl
    ? `326px minmax(0,1fr) repeat(${n},150px)${hasPts ? " 190px" : ""}`
    : `190px minmax(0,1fr) 56px repeat(${n},150px)${hasPts ? " 190px" : ""}`;
  const serverTeam: TeamKey | null = final ? null : state ? currentServer(state) : snap?.serving_team_id ? (snap.serving_team_id === m.team_a_id ? "A" : "B") : null;
  const dServer = state && dbl && !final ? servingPlayer(state) : null;
  const tb = Boolean(snap?.tiebreak);
  const call = final ? null : ctx.aces && state && aceMoment(state) ? "Ace" : callout(state, r.rules);
  const clock = final ? (durationText(m.started_at && m.ended_at ? (Date.parse(m.ended_at) - Date.parse(m.started_at)) / 1000 : null)) : matchClock(m.started_at, ctx.now);

  const row = (key: TeamKey) => {
    const k = key === "A" ? 0 : 1;
    const { nation, players } = sideOf(ctx, matchId, key);
    const serving = serverTeam === key;
    const shown = players.length ? players : [null];
    const pts = snap ? (tb ? String(snap.tiebreak_points[k]) : snap.points[k]) : "0";
    return (
      <div className={s.row} style={{ gridTemplateColumns: cols }}>
        <div className={s.photos}>
          {shown.map((p, i) => (
            <div key={p?.id ?? i} className={s.photo}>
              <Face player={p} iso2={nation?.iso2} size={dbl ? 148 : 190} />
            </div>
          ))}
        </div>
        <div className={s.who}>
          {dbl ? (
            shown.map((p, i) => {
              const [first, last] = splitName(p?.full_name ?? nation?.name ?? "");
              return (
                <div key={p?.id ?? i} className={s.dn}>
                  <span>{first}</span>
                  <b>{last}</b>
                  {serving && dServer?.index === i && <i className={`${s.ball} ${s.ballSm}`} title="Serving" />}
                </div>
              );
            })
          ) : (
            <>
              <div className={s.first}>{players[0] ? splitName(players[0].full_name)[0] : ""}</div>
              <div className={s.last}>{players[0] ? splitName(players[0].full_name)[1] : nation?.name}</div>
            </>
          )}
          <div className={s.nat}>
            <FlagImg iso2={nation?.iso2} />
            <b>{nation?.code}</b>
            <span>{[nation?.name, nation?.captain ? `Captain ${nation.captain}` : ""].filter(Boolean).join(" · ")}</span>
          </div>
        </div>
        {!dbl && <i className={`${s.ball} ${serving ? "" : s.ballOff}`} title="Serving" />}
        {cells.map((c, i) => {
          const me = k === 0 ? c.a : c.b;
          const them = k === 0 ? c.b : c.a;
          const low = k === 0 ? c.tbA : c.tbB;
          return (
            <div key={i} className={`${s.set} ${c.done && me !== null && them !== null && me < them ? s.lost : ""}`}>
              {me}
              {low !== undefined && <sup>{low}</sup>}
            </div>
          );
        })}
        {cells.length === 0 && <div />}
        {hasPts && (
          <div className={s.pts}>
            <span key={`${pts}:${snap?.last_event_number ?? 0}`} className={s.flip}>
              {pts}
            </span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={`${s.card} ${s.glass} ${dbl ? s.dbl : ""}`} data-testid="tv-score-card">
      <div className={s.cols} style={{ gridTemplateColumns: cols }}>
        <div className={s.meta} style={{ gridColumn: `1 / ${dbl ? 3 : 4}` }}>
          {clock && (
            <span className={s.clock}>
              {CLOCK_ICON}
              {clock}
            </span>
          )}
          <span>{final ? "Final" : formatLine(r.rules)}</span>
          {call && (
            <span key={`${call}:${snap?.last_event_number ?? 0}`} className={`${s.call} ${call === "Match point" || call === "Break point" ? s.callAlert : ""}`} data-testid={call === "Ace" ? "tv-ace" : "tv-callout"}>
              {call}
            </span>
          )}
          {m.status === "paused" && <span className={`${s.call} ${s.callAlert}`}>Play suspended</span>}
        </div>
        {cells.map((c, i) => (
          <div key={i} className={s.c}>
            {c.label}
          </div>
        ))}
        {cells.length === 0 && <div />}
        {hasPts && <div className={s.c}>{snap?.match_tiebreak ? "Match tie-break" : tb ? "Tie-break" : "Points"}</div>}
      </div>
      {row("A")}
      {row("B")}
    </div>
  );
}

// ---------- breaks ----------

function BreakPanel({ ctx, matchId, brk }: { ctx: Ctx; matchId: string; brk: BreakView }) {
  const r = ctx.rubbers[matchId];
  const snap = ctx.snaps.get(matchId);
  const state = snap?.state;
  const A = sideOf(ctx, matchId, "A");
  const B = sideOf(ctx, matchId, "B");
  const eye = r ? rubberName(r.rubber_no, r.rubber_type) : "";
  const names = (x: { players: PublicPlayer[]; nation?: TvNation }) => (x.players.length ? x.players.map((p) => p.full_name).join(" & ") : (x.nation?.name ?? ""));
  let title = brk.label;
  let line = "";
  let note = "";
  switch (brk.kind) {
    case "changeover":
      title = "Changeover";
      line = `90 seconds${state ? ` · ${changeoverWhat(state)}` : ""}`;
      note = "No rest after the first game of a set or at tie-break changeovers.";
      break;
    case "set_break": {
      title = "Set break";
      const sets = snap?.completed_sets ?? [];
      line = `120 seconds · ${setBreakWhat(sets, A.nation?.name ?? "A", B.nation?.name ?? "B")}`;
      note = `Players return for set ${sets.length + 1} when the time is up.`;
      break;
    }
    case "warmup":
      title = "Warm-up";
      line = "5 minutes before the first point";
      note = `${names(A)} (${A.nation?.code ?? ""}) v ${names(B)} (${B.nation?.code ?? ""})`;
      break;
    case "medical": {
      title = "Medical time-out";
      line = "3 minutes of treatment";
      const who = brk.team === "B" ? B : brk.team === "A" ? A : null;
      note = who ? `${names(who)} · ${who.nation?.name ?? ""}` : "";
      break;
    }
    default:
      line = brk.total ? `${breakLength(brk.total)}` : "";
      {
        const who = brk.team === "B" ? B : brk.team === "A" ? A : null;
        note = who ? `${names(who)} · ${who.nation?.name ?? ""}` : "";
      }
  }
  const timer = ctx.settings.breakTimer && brk.total !== null;
  const cd = brk.total !== null ? countdown(brk.total, brk.elapsedMs) : null;
  const noir = ctx.settings.palette === "noir";
  return (
    <div className={`${s.brk} ${s.glass} ${timer ? "" : s.noTimer} ${cd?.over ? s.over : ""}`} data-testid="tv-break" data-break={brk.kind}>
      {noir ? (
        <svg className={s.arc} viewBox="0 0 1792 520" preserveAspectRatio="xMidYMid slice" aria-hidden>
          <path d="M-40 540 C 420 400, 900 160, 1600 110" />
          <circle cx="1660" cy="104" r="34" />
        </svg>
      ) : (
        <svg className={s.arc} viewBox="0 0 1792 520" preserveAspectRatio="xMidYMid slice" aria-hidden>
          <path d="M-40 560 C 380 380, 760 40, 1180 60 S 1700 260, 1760 600" />
        </svg>
      )}
      {timer && cd && (
        <div className={s.cd} data-testid="tv-break-timer">
          <Ring size={370} r={164} w={22} left={cd.left} />
          <div className={s.cdIn}>
            <b>{cd.text}</b>
            <small>{cd.over ? "Over time" : "Remaining"}</small>
          </div>
        </div>
      )}
      <div className={s.bt}>
        <div className={s.eye}>{eye}</div>
        <h4>{title}</h4>
        {line && <div className={s.line}>{line}</div>}
        {note && <div className={s.note}>{note}</div>}
        {!timer && <div className={s.back}>Play resumes shortly</div>}
      </div>
    </div>
  );
}

function Compact({ ctx, matchId, warmup }: { ctx: Ctx; matchId: string; warmup: boolean }) {
  const snap = ctx.snaps.get(matchId);
  const sets = snap?.completed_sets ?? [];
  const cells = warmup ? [] : setCells(sets, snap, true);
  const n = cells.length;
  const hasPts = !warmup && snap && (snap.points[0] !== "0" || snap.points[1] !== "0" || snap.tiebreak);
  const cols = `46px 90px minmax(0,1fr)${n ? ` repeat(${n},70px)` : " auto"}${hasPts ? " 96px" : ""}`;
  const r = (key: TeamKey) => {
    const k = key === "A" ? 0 : 1;
    const { nation, players } = sideOf(ctx, matchId, key);
    return (
      <div className={s.r} style={{ gridTemplateColumns: cols }}>
        <FlagImg iso2={nation?.iso2} />
        <span className={s.code}>{nation?.code}</span>
        <span className={s.nm}>{players.length ? surnames(players) : nation?.name}</span>
        {n ? (
          cells.map((c, i) => {
            const me = k === 0 ? c.a : c.b;
            const them = k === 0 ? c.b : c.a;
            return (
              <span key={i} className={`${s.s} ${c.done && me !== null && them !== null && me < them ? s.lost : ""}`}>
                {me}
              </span>
            );
          })
        ) : (
          <span className={s.vs}>{key === "A" ? "Match starts after the warm-up" : " "}</span>
        )}
        {hasPts && <span className={s.p}>{snap!.tiebreak ? snap!.tiebreak_points[k] : snap!.points[k]}</span>}
      </div>
    );
  };
  return (
    <div className={`${s.miniSc} ${s.glass}`}>
      {r("A")}
      {r("B")}
    </div>
  );
}

// ---------- match end ----------

function EndScene({ ctx, tieId, matchId }: { ctx: Ctx; tieId: string; matchId: string }) {
  const r = ctx.rubbers[matchId];
  const m = ctx.matches.get(matchId);
  if (!r || !m) return <Legacy ctx={ctx} />;
  const tie = ctx.tiesById[tieId];
  const a = nationOf(ctx, tie?.team_a_id);
  const b = nationOf(ctx, tie?.team_b_id);
  const w: TeamKey = m.winner_team_id && m.winner_team_id === m.team_b_id ? "B" : "A";
  const winner = sideOf(ctx, matchId, w);
  const sets = ctx.snaps.get(matchId)?.completed_sets ?? [];
  const how = m.status === "walkover" ? "Walkover" : m.status === "retired" ? "Retired" : m.status === "disqualified" ? "Default" : "";
  const who = winner.players.length === 2 ? surnames(winner.players) : winner.players[0]?.full_name ?? winner.nation?.name ?? "";
  const verb = winner.players.length === 1 ? "wins" : "win";
  const res = (
    <div className={`${s.res} ${s.glass}`} data-testid="tv-result">
      <div className={s.pics}>
        {(winner.players.length ? winner.players : [null]).map((p, i) => (
          <div key={p?.id ?? i} className={s.pic}>
            <Face player={p} iso2={winner.nation?.iso2} size={84} />
          </div>
        ))}
      </div>
      <div className={s.tx}>
        <small>Match finished · {rubberName(r.rubber_no, r.rubber_type)}</small>
        <b>
          {who} {verb}
          <em>{[scoreFrom(sets, w), how].filter(Boolean).join(" · ")}</em>
        </b>
      </div>
      <div className={s.won}>{winner.nation?.name} +1</div>
    </div>
  );
  const st = ctx.stats[matchId];
  // The match's own A/B may be the tie's B/A; the stats card reads left = tie's A.
  const showStats = ctx.settings.postMatchStats && st && st.available;
  if (!showStats) {
    return (
      <main className={s.main} style={{ gridTemplateRows: "auto auto 1fr" }}>
        <TieBar ctx={ctx} tieId={tieId} matchId={matchId} />
        {res}
        <ScoreCard ctx={ctx} matchId={matchId} final />
      </main>
    );
  }
  const lines = statLines(st.sides);
  const A = sideOf(ctx, matchId, "A");
  const B = sideOf(ctx, matchId, "B");
  return (
    <main className={s.main} style={{ gridTemplateRows: "auto auto 1fr" }}>
      <TieBar ctx={ctx} tieId={tieId} matchId={matchId} />
      {res}
      <div className={s.two}>
        <div className={`${s.vc} ${s.glass}`} data-testid="tv-match-stats">
          <h5>
            This match
            <span>
              <FlagImg iso2={A.nation?.iso2} />
              {surnames(A.players) || A.nation?.code} &nbsp;·&nbsp; {surnames(B.players) || B.nation?.code}
              <FlagImg iso2={B.nation?.iso2} />
            </span>
          </h5>
          <div className={s.sl}>
            {lines.map((x) => {
              const ca = statCell(x.a);
              const cb = statCell(x.b);
              return (
                <div key={x.key} className={s.ln}>
                  <span className={`${s.v} ${x.lead === "A" ? s.lead : ""}`}>
                    {ca.big}
                    {ca.small && <small> {ca.small}</small>}
                  </span>
                  <div className={s.lnMid}>
                    <div className={s.lab}>{x.label}</div>
                    <div className={s.bars}>
                      <i className={s.ba} style={{ "--w": `${Math.round(x.aBar * 100)}%` } as React.CSSProperties} />
                      <i className={s.bb} style={{ "--w": `${Math.round(x.bBar * 100)}%` } as React.CSSProperties} />
                    </div>
                  </div>
                  <span className={`${s.v} ${s.vb} ${x.lead === "B" ? s.lead : ""}`}>
                    {cb.small && <small>{cb.small} </small>}
                    {cb.big}
                  </span>
                </div>
              );
            })}
          </div>
          <div className={s.foot}>
            <span>
              Match <b>{durationText(st.durationSeconds)}</b>
            </span>
            {st.sets.map((x) => (
              <span key={x.set}>
                {x.label === "Match tie-break" ? "Tie-break" : x.label} <b>{durationText(x.seconds)}</b>
              </span>
            ))}
          </div>
        </div>
        <TieCard ctx={ctx} tieId={tieId} a={a} b={b} />
      </div>
    </main>
  );
}

function TieCard({ ctx, tieId, a, b }: { ctx: Ctx; tieId: string; a?: TvNation; b?: TvNation }) {
  const tie = ctx.tiesById[tieId];
  const rubbers = Object.values(ctx.rubbers)
    .filter((r) => r.tie_id === tieId)
    .sort((x, y) => x.rubber_no - y.rubber_no);
  const scoreNow = tieScore(tieRubbers(ctx, tieId), tie?.team_a_id ?? null);
  const played = rubbers.filter((r) => ctx.matches.get(r.id)?.status !== "cancelled");
  const left = played.filter((r) => !DONE.includes(ctx.matches.get(r.id)?.status ?? "")).length;
  const next = played.find((r) => !DONE.includes(ctx.matches.get(r.id)?.status ?? ""));
  const status = tieStatus(scoreNow, a?.name ?? "", b?.name ?? "", { rubbers: played.length, decided: left === 0 });
  const people: { p: PublicPlayer; iso2: string | null | undefined }[] = [];
  const seen = new Set<string>();
  for (const nation of [a, b]) {
    for (const r of rubbers) {
      const ids = nation && nation.id === tie?.team_a_id ? r.a : r.b;
      for (const id of ids) {
        const p = nation?.players.find((x) => x.id === id);
        if (p && !seen.has(p.id)) {
          seen.add(p.id);
          people.push({ p, iso2: nation?.iso2 });
        }
      }
    }
  }
  const pair = (x: [number, number] | undefined) => (x ? `${x[0]}–${x[1]}` : "0–0");
  return (
    <div className={`${s.vc} ${s.glass}`} data-testid="tv-tie-card">
      <h5>
        The tie<span>{tie?.round_name ?? ""}</span>
      </h5>
      <div className={s.tiebox}>
        <div className={s.tiebig}>
          <FlagImg iso2={a?.iso2} />
          {a?.code}
          <span className={s.sc}>
            {scoreNow[0]} – {scoreNow[1]}
          </span>
          {b?.code}
          <FlagImg iso2={b?.iso2} />
        </div>
        <div className={s.tiestat}>{status}</div>
        <div>
          {rubbers.map((r) => {
            const m = ctx.matches.get(r.id);
            const st = m?.status ?? "scheduled";
            const done = DONE.includes(st);
            const pa = sideOf(ctx, r.id, "A").players;
            const pb = sideOf(ctx, r.id, "B").players;
            const name = (ps: PublicPlayer[], n?: TvNation) => (ps.length === 1 ? shortName(ps[0].full_name) : ps.length ? surnames(ps) : (n?.code ?? ""));
            const aName = name(pa, nationOf(ctx, m?.team_a_id));
            const bName = name(pb, nationOf(ctx, m?.team_b_id));
            const w: TeamKey | null = done && m?.winner_team_id ? (m.winner_team_id === m.team_a_id ? "A" : "B") : null;
            const text = w ? (w === "A" ? `${aName} d. ${bName}` : `${bName} d. ${aName}`) : `${aName} v ${bName}`;
            const sets = ctx.snaps.get(r.id)?.completed_sets ?? [];
            const right = w ? scoreFrom(sets, w) || "W/O" : LIVE.includes(st) ? "On court" : st === "cancelled" ? "Not played" : r === next ? "Next" : "To come";
            return (
              <div key={r.id} className={s.rub}>
                <span className={s.k}>{RUBBER_NAMES[r.rubber_type]}</span>
                <span className={s.w}>{text}</span>
                <span className={`${s.rs} ${w ? "" : s.next}`}>{right}</span>
              </div>
            );
          })}
        </div>
        {people.length > 0 && (
          <div>
            <div className={`${s.rec} ${s.recH}`}>
              <span>At the event</span>
              <span className={s.rc}>Matches</span>
              <span className={s.rc}>Sets</span>
              <span className={s.rc}>Games</span>
            </div>
            {people.slice(0, 4).map(({ p, iso2 }) => {
              const rec = ctx.eventRecords[p.id];
              return (
                <div key={p.id} className={s.rec}>
                  <span className={s.recN}>
                    <FlagImg iso2={iso2} />
                    <span>{p.full_name}</span>
                  </span>
                  <span className={s.rc}>{pair(rec?.matches)}</span>
                  <span className={s.rc}>{pair(rec?.sets)}</span>
                  <span className={s.rc}>{pair(rec?.games)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className={s.foot}>
        <span>W–L across singles and doubles at this event</span>
      </div>
    </div>
  );
}
