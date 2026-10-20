"use client";

/**
 * Scoring screen v2 (web console), drawn after the owner's Figma frames "v2 …":
 * the scoreboard card, the Fault · Ace · Let row, two tall point columns side by
 * side (left and right as the referee sees the court), Undo · Pause · Serve · More,
 * the timers (25 s banner, changeover / break card with the referee's ruling), the
 * doubles set-start question, the More sheet and the match log. Every rule lives in
 * the shared engine (serve.ts, timing.ts, console.ts); this file only draws.
 */
import { useEffect, useState } from "react";
import { currentServer, formatSet, type ScoreState, type TeamKey } from "@/lib/scoring/engine";
import { receivingPlayer, serveNumber, servingPlayer, type ServeOrder } from "@/lib/scoring/serve";
import { TIMERS, TIME_DECISION_LABELS, TIME_DECISIONS, clockText, timerView, type TimeDecision, type TimerKind } from "@/lib/scoring/timing";
import type { LogEntry } from "@/lib/scoring/matchLog";
import type { ScoringFeatures } from "@/lib/matchday/rules";
import { SIDES } from "@/lib/sides";

export interface V2Side {
  name: string;
  /** "EGY": the nation code, or a short form of the name. */
  code: string;
  players: string[];
}

export const SERVING_YELLOW = "#FFF500";

export function shortCode(name: string, nation?: string | null): string {
  if (nation) return nation.toUpperCase();
  const words = name.replace(/\(.*?\)/g, "").trim().split(/\s+|\//).filter(Boolean);
  return (words.length > 1 ? words.map((w) => w[0]).join("") : name).slice(0, 4).toUpperCase();
}

function pointsText(s: ScoreState, k: TeamKey): string {
  if (s.isTiebreak) return String(k === "A" ? s.teamA.tiebreakPoints : s.teamB.tiebreakPoints);
  return k === "A" ? s.teamA.points : s.teamB.points;
}

/* ---------------- scoreboard ---------------- */

export function BoardV2({
  state,
  sides,
  eyebrow,
  rules,
  sunlight,
  onSunlight,
  doubles,
  aces,
  aceNow = false,
  banner,
}: {
  state: ScoreState;
  sides: Record<TeamKey, V2Side>;
  eyebrow: string;
  rules: string;
  sunlight: boolean;
  onSunlight: () => void;
  doubles: boolean;
  /** Aces per side, when the organiser shows them. */
  aces?: { A: number; B: number } | null;
  /** Right after an ace: the short "ACE" moment. */
  aceNow?: boolean;
  /** The 25 s banner, drawn over the top of the card. */
  banner?: React.ReactNode;
}) {
  const server = currentServer(state);
  const serving = doubles ? servingPlayer(state) : null;
  const receiving = doubles ? receivingPlayer(state) : null;
  return (
    <div className="relative rounded-[20px] border border-border bg-card px-4 pb-3 pt-3" data-testid="v2-board">
      {banner}
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-[11px] font-bold uppercase tracking-widest text-muted">{eyebrow}</p>
        {aceNow && (
          <span className="rounded-full px-2.5 py-0.5 text-[11px] font-black uppercase tracking-widest text-black" style={{ background: SERVING_YELLOW }} data-testid="ace-moment">
            Ace
          </span>
        )}
        <button type="button" onClick={onSunlight} className={`badge ${sunlight ? "bg-warning/25 text-foreground" : "bg-background text-muted"}`} aria-pressed={sunlight} data-testid="sunlight">
          {sunlight ? "☀ SUNLIGHT ON" : "☀ SUNLIGHT"}
        </button>
      </div>
      {(["A", "B"] as TeamKey[]).map((k) => {
        const s = sides[k];
        const ts = k === "A" ? state.teamA : state.teamB;
        const servingHere = server === k && !state.matchOver;
        const who =
          doubles && serving?.team === k
            ? `Serving: ${s.players[serving.index] ?? ""}`
            : doubles && receiving?.team === k
              ? `Receiving: ${s.players[receiving.index] ?? ""}`
              : s.players.join(" / ");
        return (
          <div key={k} className={`flex items-center gap-3 py-2.5 ${k === "B" ? "border-t border-border" : ""}`} data-testid={`v2-row-${k}`}>
            <span className="w-3">
              {servingHere && <span className="block h-3 w-3 rounded-full border border-black/30" style={{ background: SERVING_YELLOW }} aria-label="serving" />}
            </span>
            <span className="rounded bg-background px-1.5 py-0.5 text-[10px] font-bold text-muted">{s.code}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-lg font-bold leading-tight">{s.name}</span>
              <span className="block truncate text-[11px] font-semibold uppercase tracking-wide text-muted" data-testid={`v2-who-${k}`}>
                {who}
                {aces ? ` · ${aces[k]} ace${aces[k] === 1 ? "" : "s"}` : ""}
              </span>
            </span>
            {state.completedSets.map((x, i) => (
              <span key={i} className="w-6 text-center text-2xl font-semibold tabular-nums text-muted">
                {k === "A" ? x.teamAGames : x.teamBGames}
              </span>
            ))}
            {!state.matchOver && <span className="w-7 text-center text-2xl font-bold tabular-nums">{ts.games}</span>}
            {!state.matchOver && (
              <span className="flex h-12 min-w-[58px] items-center justify-center rounded-xl bg-background px-2 text-3xl font-bold tabular-nums" data-testid={`v2-points-${k}`}>
                {pointsText(state, k)}
              </span>
            )}
          </div>
        );
      })}
      <p className="text-[11px] text-muted" data-testid="resolved-rules">{rules}</p>
      {state.matchOver && <p className="text-xs text-muted">{state.completedSets.map((x) => formatSet(x)).join(" ")}</p>}
    </div>
  );
}

/* ---------------- Fault · Ace · Let, the point columns, the controls ---------------- */

export function PadV2({
  state,
  sides,
  features,
  swapped,
  disabled,
  canUndo,
  paused,
  onPoint,
  onFault,
  onAce,
  onLet,
  onUndo,
  onPause,
  onServe,
  onMore,
}: {
  state: ScoreState;
  sides: Record<TeamKey, V2Side>;
  features: ScoringFeatures;
  swapped: boolean;
  disabled: boolean;
  canUndo: boolean;
  paused: boolean;
  onPoint: (k: TeamKey) => void;
  onFault: () => void;
  onAce: () => void;
  onLet: () => void;
  onUndo: () => void;
  onPause: () => void;
  onServe: () => void;
  onMore: () => void;
}) {
  const server = currentServer(state);
  const second = serveNumber(state) === 2;
  const order: TeamKey[] = swapped ? ["B", "A"] : ["A", "B"];
  const extras = [features.fault, features.ace, features.let].filter(Boolean).length;
  const off = disabled || paused;
  return (
    <div className="mt-3 flex flex-col gap-3">
      {extras > 0 && (
        <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(${extras}, minmax(0, 1fr))` }}>
          {features.fault && (
            <button
              type="button"
              onClick={onFault}
              disabled={off || !server}
              className={`flex h-[70px] flex-col items-center justify-center gap-1 rounded-2xl border-2 text-lg font-bold transition active:scale-95 disabled:opacity-40 ${second ? "border-orange-500 bg-orange-500/10" : "border-border bg-card"}`}
              data-testid="v2-fault"
            >
              Fault
              <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-black uppercase tracking-widest ${second ? "bg-orange-500 text-black" : "bg-background text-muted"}`} data-testid="v2-serve-tag">
                {second ? "2nd serve" : "1st serve"}
              </span>
            </button>
          )}
          {features.ace && (
            <button type="button" onClick={onAce} disabled={off || !server} className="h-[70px] rounded-2xl border-2 border-border bg-card text-lg font-bold transition active:scale-95 disabled:opacity-40" data-testid="v2-ace">
              Ace
            </button>
          )}
          {features.let && (
            <button type="button" onClick={onLet} disabled={off} className="h-[70px] rounded-2xl border-2 border-border bg-card text-lg font-bold transition active:scale-95 disabled:opacity-40" data-testid="v2-let">
              Let
            </button>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2.5" style={{ height: "clamp(200px, 31dvh, 460px)" }} data-testid="v2-points" data-swapped={swapped ? "1" : "0"}>
        {order.map((k) => {
          const s = sides[k];
          const serving = server === k && !state.matchOver;
          return (
            <button
              key={k}
              type="button"
              onClick={() => onPoint(k)}
              disabled={off}
              className="relative flex flex-col items-center justify-center gap-2 rounded-[22px] px-2 text-white transition active:scale-[0.98] disabled:opacity-40"
              style={{ background: SIDES[k].hex }}
              data-testid={`v2-point-${k}`}
              aria-label={`Point to ${s.name}`}
            >
              {serving && (
                <span className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-black uppercase tracking-wider text-black" style={{ background: SERVING_YELLOW }}>
                  <span className="h-2 w-2 rounded-full bg-black" /> Serving
                </span>
              )}
              <span className="text-center text-4xl font-black uppercase leading-[0.95] tracking-tight">
                Point
                <br />
                {s.code}
              </span>
              <span className="text-center text-xs font-bold uppercase tracking-widest text-white/85">
                {s.name}
                {serving ? " · serving" : ""}
              </span>
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-4 gap-2 pb-2">
        {[
          ["↶", "Undo", onUndo, !canUndo || disabled, "v2-undo"],
          [paused ? "▶" : "❚❚", paused ? "Resume" : "Pause", onPause, disabled, "v2-pause"],
          ["⇄", "Serve", onServe, off, "v2-serve"],
          ["•••", "More", onMore, false, "v2-more"],
        ].map(([icon, label, fn, dis, id]) => (
          <button
            key={id as string}
            type="button"
            onClick={fn as () => void}
            disabled={dis as boolean}
            className="flex flex-col items-center gap-1 rounded-2xl border border-border bg-card py-3 text-xs font-bold disabled:opacity-40"
            data-testid={id as string}
          >
            <span className="text-lg leading-none">{icon as string}</span>
            {label as string}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------------- timers ---------------- */

export interface RunningTimer {
  kind: TimerKind;
  startedAt: number;
  team: TeamKey | null;
  /** Recorded as TIMER_STARTED (changeover, set break, breaks); the 25 s is not. */
  recorded: boolean;
}

/** Re-renders every quarter second while a timer runs. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function RuleRef({ kind }: { kind: TimerKind }) {
  const rule = TIMERS[kind].rule;
  if (!rule) return null;
  return (
    <a href={rule.href} target="_blank" rel="noreferrer" className="text-[11px] font-semibold underline underline-offset-2 opacity-80" data-testid="rule-ref">
      {rule.label}
    </a>
  );
}

function Rulings({ onDecision }: { onDecision: (d: TimeDecision) => void }) {
  return (
    <div className="grid grid-cols-3 gap-2" data-testid="time-rulings">
      {(["warning", "code_violation", "no_action"] as TimeDecision[]).filter((d) => TIME_DECISIONS.includes(d)).map((d) => (
        <button key={d} type="button" onClick={() => onDecision(d)} className="rounded-xl bg-white/15 px-2 py-2 text-xs font-bold text-white hover:bg-white/25" data-testid={`ruling-${d}`}>
          {TIME_DECISION_LABELS[d]}
        </button>
      ))}
    </div>
  );
}

/** The 25 s between points: a banner over the scoreboard. */
export function BetweenPointsBanner({ timer, now, onDismiss, onDecision }: { timer: RunningTimer; now: number; onDismiss: () => void; onDecision: (d: TimeDecision) => void }) {
  const v = timerView(timer.kind, now - timer.startedAt);
  return (
    <div
      className={`absolute inset-x-0 -top-1 z-10 space-y-2 rounded-[20px] border-2 p-4 shadow-xl ${v.over ? "border-[#E5133A] bg-[#E5133A] text-white" : "border-accent bg-card"}`}
      data-testid="timer-25"
      data-over={v.over ? "1" : "0"}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-3xl font-black tabular-nums">
            {v.text} / {clockText(v.limit ?? 25)}
          </p>
          <p className="text-[11px] font-bold uppercase tracking-widest opacity-80">{v.over ? "Time" : "Next serve"}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          {!v.over && (
            <button type="button" onClick={onDismiss} className="rounded-xl border border-border bg-background px-3 py-1.5 text-xs font-bold" data-testid="timer-dismiss">
              Dismiss
            </button>
          )}
          <RuleRef kind={timer.kind} />
        </div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/30">
        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round((v.progress ?? 0) * 100)}%`, background: v.over ? "white" : undefined }} />
      </div>
      {v.ruling && <Rulings onDecision={onDecision} />}
    </div>
  );
}

/** A changeover, set break or break: a card over the point columns. */
export function TimerCard({
  timer,
  now,
  sides,
  onStop,
  onDecision,
}: {
  timer: RunningTimer;
  now: number;
  sides: Record<TeamKey, V2Side>;
  onStop: () => void;
  onDecision: (d: TimeDecision) => void;
}) {
  const v = timerView(timer.kind, now - timer.startedAt);
  const def = TIMERS[timer.kind];
  const title =
    timer.kind === "changeover" ? "Change of ends" : `${def.label}${timer.team ? ` · ${sides[timer.team].name}` : ""}`;
  const red = v.over && def.mode === "limit";
  const amber = v.over && def.mode === "warn";
  const started = new Date(timer.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const note =
    def.mode === "open"
      ? `Stopwatch · started ${started}`
      : def.mode === "warn"
        ? v.over
          ? `${v.text} · over ${clockText(def.limit ?? 0)} — tell the master referee`
          : `Stopwatch · started ${started} · warns at ${clockText(def.limit ?? 0)}`
        : v.over
          ? `${v.overBy} s over the ${clockText(def.limit ?? 0)} ${def.label.toLowerCase()}`
          : `${def.label} · counting up to ${clockText(def.limit ?? 0)}`;
  return (
    <div className="fixed inset-x-0 top-1/3 z-40 mx-auto w-[calc(100%-24px)] max-w-md" data-testid="timer-card" data-kind={timer.kind} data-over={v.over ? "1" : "0"}>
      <div
        className={`space-y-3 rounded-[24px] border-2 p-5 text-center shadow-2xl ${red ? "border-[#E5133A] bg-[#E5133A] text-white" : amber ? "border-orange-500 bg-card text-orange-500" : "border-border bg-card"}`}
      >
        <p className="text-xs font-black uppercase tracking-widest">{red ? `${title} · Time` : title}</p>
        <p className="text-7xl font-black tabular-nums leading-none" data-testid="timer-text">
          {v.text}
          {def.limit !== null && def.mode === "limit" && <span className="ml-1 text-2xl font-bold opacity-70">/ {clockText(def.limit)}</span>}
        </p>
        <p className="text-xs font-semibold opacity-90">{note}</p>
        {v.progress !== null && (
          <div className="h-1.5 overflow-hidden rounded-full bg-black/20">
            <div className="h-full rounded-full" style={{ width: `${Math.round(v.progress * 100)}%`, background: red ? "white" : amber ? "#f97316" : "var(--accent)" }} />
          </div>
        )}
        {v.ruling ? (
          <Rulings onDecision={onDecision} />
        ) : (
          <button type="button" onClick={onStop} className="w-full rounded-2xl py-3 text-base font-black text-black" style={{ background: SERVING_YELLOW }} data-testid="timer-stop">
            {def.mode === "limit" ? "Resume play" : "Stop"}
          </button>
        )}
        <RuleRef kind={timer.kind} />
      </div>
    </div>
  );
}

/* ---------------- doubles: the set-start question ---------------- */

function Choice<V extends string | number>({ label, value, onPick, options }: { label: string; value: V; onPick: (v: V) => void; options: [V, string][] }) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-semibold text-muted">{label}</p>
      <div className="grid grid-cols-2 gap-2">
        {options.map(([v, text]) => (
          <button
            key={String(v)}
            type="button"
            onClick={() => onPick(v)}
            className={`rounded-2xl border-2 px-3 py-3 text-sm font-bold ${value === v ? "border-accent bg-accent/15" : "border-border bg-background"}`}
            aria-pressed={value === v}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Doubles, at the start of every set: which partner serves and receives first (ITF
 * Rule 14). Which team serves is the toss's at the first set only (`teamFree`); after
 * that the rotation decides it, and the dialog shows it without offering a choice.
 */
export function ServeOrderDialog({
  set,
  sides,
  initial,
  onConfirm,
  teamFree = true,
}: {
  set: number;
  sides: Record<TeamKey, { name: string; players: string[] }>;
  initial: ServeOrder;
  onConfirm: (o: ServeOrder) => void;
  teamFree?: boolean;
}) {
  const [o, setO] = useState<ServeOrder>(initial);
  const serving = o.servingTeam;
  const other: TeamKey = serving === "A" ? "B" : "A";
  const players = (k: TeamKey): [0 | 1, string][] => [
    [0, sides[k].players[0] ?? "Player 1"],
    [1, sides[k].players[1] ?? "Player 2"],
  ];
  return (
    <div className="space-y-3" data-testid="serve-order">
      <h3 className="text-xl font-black uppercase">Start of set {set}</h3>
      {teamFree ? (
        <Choice label="Which team serves?" value={serving} onPick={(v: TeamKey) => setO({ ...o, servingTeam: v })} options={[["A", sides.A.name], ["B", sides.B.name]] as [TeamKey, string][]} />
      ) : (
        <p className="text-sm font-semibold text-muted" data-testid="serve-order-team">
          {sides[serving].name} serve first (the rotation)
        </p>
      )}
      <Choice label={`Who serves for ${sides[serving].name}?`} value={o.server} onPick={(v: 0 | 1) => setO({ ...o, server: v })} options={players(serving)} />
      <Choice label={`Who receives first for ${sides[other].name}?`} value={o.receiver} onPick={(v: 0 | 1) => setO({ ...o, receiver: v })} options={players(other)} />
      <Choice label={`Who serves first for ${sides[other].name} (game 2)?`} value={o.otherServer} onPick={(v: 0 | 1) => setO({ ...o, otherServer: v })} options={players(other)} />
      <Choice label={`Who receives first for ${sides[serving].name} (game 2)?`} value={o.otherReceiver} onPick={(v: 0 | 1) => setO({ ...o, otherReceiver: v })} options={players(serving)} />
      <button type="button" onClick={() => onConfirm(o)} className="w-full rounded-2xl py-4 text-base font-black text-black" style={{ background: SERVING_YELLOW }} data-testid="serve-order-confirm">
        Confirm
      </button>
    </div>
  );
}

/* ---------------- the match log ---------------- */

const CHIP_TONE: Record<string, string> = {
  ace: "bg-[#FFF500] text-black",
  double_fault: "bg-[#E5133A] text-white",
  fault: "bg-orange-500 text-black",
  let: "bg-accent text-white",
  violation: "bg-orange-500 text-black",
  time_ruling: "bg-orange-500 text-black",
  undo: "bg-background text-muted",
};

export function MatchLogList({ entries, newestFirst = true }: { entries: LogEntry[]; newestFirst?: boolean }) {
  const list = newestFirst ? [...entries].reverse() : entries;
  // A "Set 2" heading before the first row of each set.
  const heads = list.map((e, i) => e.set !== null && (i === 0 || list[i - 1].set !== e.set));
  return (
    <div className="divide-y divide-border" data-testid="match-log">
      {list.length === 0 && <p className="py-4 text-sm text-muted">Nothing recorded yet.</p>}
      {list.map((e, i) => {
        const head = heads[i] ? <p className="pb-1 pt-3 text-[11px] font-black uppercase tracking-widest text-muted">Set {e.set}</p> : null;
        return (
          <div key={e.n}>
            {head}
            <div className={`flex items-start gap-3 py-2.5 ${e.undone || e.superseded ? "opacity-50" : ""}`} data-testid="log-row" data-tag={e.tag}>
              <span className="w-12 shrink-0 font-mono text-xs text-muted">{e.at ? new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</span>
              <span className="min-w-0 flex-1">
                <span className={`block text-sm font-bold ${e.undone ? "line-through" : ""}`}>{e.title}</span>
                <span className="block text-xs text-muted">
                  {e.detail}
                  {e.by ? ` · ${e.by}` : ""}
                  {e.undone ? " · undone" : ""}
                </span>
              </span>
              {e.chip && <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${CHIP_TONE[e.tag] ?? "bg-background text-muted"}`}>{e.chip}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Fetches and shows a match's log (the referee console's More → Match log). */
export function MatchLogPanel({ matchId, onClose }: { matchId: string; onClose: () => void }) {
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/matches/${matchId}/log`, { cache: "no-store" })
      .then(async (r) => {
        const body = (await r.json().catch(() => ({}))) as { entries?: LogEntry[]; error?: string };
        if (!alive) return;
        if (r.ok) setEntries(body.entries ?? []);
        else setError(body.error ?? "The log could not be loaded.");
      })
      .catch(() => alive && setError("No connection: the log needs signal."));
    return () => {
      alive = false;
    };
  }, [matchId]);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xl font-black uppercase">Match log</h3>
        <button type="button" className="btn-secondary px-3 py-1 text-xs" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="text-xs text-muted">Newest first · every point, call, violation and break</p>
      {error && <p className="text-sm text-danger">{error}</p>}
      {!entries && !error && <p className="text-sm text-muted">Loading…</p>}
      {entries && (
        <div className="max-h-[65vh] overflow-y-auto">
          <MatchLogList entries={entries} />
        </div>
      )}
    </div>
  );
}
