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
import { TIMERS, RULINGS, TIME_DECISION_LABELS, clockText, timerView, type TimeDecision, type TimerKind } from "@/lib/scoring/timing";
import type { LogEntry } from "@/lib/scoring/matchLog";
import { violationMarks } from "@/lib/scoring/conduct";
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
              <ViolationMarks marks={violationMarks(state, k)} />
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

/** Ⓣ (time) and Ⓒ (code) at the bottom left of a POINT button, one per violation, oldest first, for the whole match. */
function ViolationMarks({ marks }: { marks: ("T" | "C")[] }) {
  if (marks.length === 0) return null;
  const time = marks.filter((m) => m === "T").length;
  return (
    <span
      className="pointer-events-none absolute bottom-2.5 left-2.5 right-2.5 flex flex-wrap-reverse gap-1.5"
      data-testid="violation-marks"
      aria-label={`${time} time, ${marks.length - time} code violations`}
    >
      {marks.map((m, i) => (
        <span key={i} className="flex h-7 w-7 items-center justify-center rounded-full border-[2.5px] border-white bg-black/20 text-sm font-black leading-none">
          {m}
        </span>
      ))}
    </span>
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
    <div className="grid grid-cols-2 gap-2" data-testid="time-rulings">
      {RULINGS.map((d) => (
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
        {timer.kind === "warmup" && v.over && <p className="text-sm">Warm-up time is up. Start the match when the players are ready.</p>}
        {v.ruling ? (
          <Rulings onDecision={onDecision} />
        ) : (
          <button type="button" onClick={onStop} className="w-full rounded-2xl py-3 text-base font-black text-black" style={{ background: SERVING_YELLOW }} data-testid="timer-stop">
            {timer.kind === "warmup" ? "Start the match" : def.mode === "limit" ? "Resume play" : "Stop"}
          </button>
        )}
        <RuleRef kind={timer.kind} />
      </div>
    </div>
  );
}

/* ---------------- doubles: the set-start question ---------------- */

/**
 * Doubles, at the start of every set (ITF Rule 14): who serves and who receives first, for game 1
 * and for game 2, one question each with nothing picked in advance, then a summary to confirm.
 * Which team serves is never asked again: at the first set "Who serves first?" answered it
 * (`teamFree` lets the referee change it from the summary line), after that it is the rotation's.
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
  const steps = ["server", "receiver", "server2", "receiver2", "next"] as const;
  const [serving, setServing] = useState<TeamKey>(initial.servingTeam);
  const [picks, setPicks] = useState<Partial<Omit<ServeOrder, "servingTeam">>>({});
  const [i, setI] = useState(0);
  const step = steps[i];
  const other: TeamKey = serving === "A" ? "B" : "A";
  const players = (k: TeamKey): [0 | 1, string][] => [
    [0, sides[k].players[0] ?? "Player 1"],
    [1, sides[k].players[1] ?? "Player 2"],
  ];
  const name = (k: TeamKey, n: 0 | 1 | undefined) => (n === undefined ? "" : (sides[k].players[n] ?? "Player"));
  const pick = (patch: Partial<Omit<ServeOrder, "servingTeam">>) => {
    setPicks({ ...picks, ...patch });
    setI(Math.min(i + 1, steps.length - 1));
  };
  // The other team serving first: every answer named a player of the wrong team, so ask again.
  const flip = () => {
    setServing(other);
    setPicks({});
    setI(0);
  };
  const order: ServeOrder | null =
    picks.server !== undefined && picks.receiver !== undefined && picks.otherServer !== undefined && picks.otherReceiver !== undefined
      ? { servingTeam: serving, server: picks.server, receiver: picks.receiver, otherServer: picks.otherServer, otherReceiver: picks.otherReceiver }
      : null;
  return (
    <div className="space-y-4" data-testid="serve-order">
      <h3 className="text-xl font-black uppercase">Start of set {set}</h3>
      <div className="flex items-center justify-between text-xs font-bold uppercase tracking-wider text-muted">
        <span>{step === "next" ? "Check and confirm" : `Question ${i + 1} of ${steps.length - 1}`}</span>
        {i > 0 && (
          <button type="button" className="text-accent" onClick={() => setI(i - 1)}>
            ‹ Back
          </button>
        )}
      </div>
      {i === 0 && (
        <p className="flex items-center gap-3 rounded-xl bg-background px-3 py-2 text-sm font-semibold" data-testid="serve-order-team">
          <span className="flex-1">{teamFree ? `${sides[serving].name} serve first (chosen when the match started).` : `${sides[serving].name} serve first this set (the rotation).`}</span>
          {teamFree && (
            <button type="button" className="text-accent" onClick={flip} data-testid="serve-order-flip">
              Change
            </button>
          )}
        </p>
      )}
      {step === "server" && <Big question={`Which player serves for ${sides[serving].name}?`} value={picks.server} onPick={(v: 0 | 1) => pick({ server: v })} options={players(serving)} />}
      {step === "receiver" && <Big question={`Which player of ${sides[other].name} receives the serve?`} value={picks.receiver} onPick={(v: 0 | 1) => pick({ receiver: v })} options={players(other)} />}
      {step === "server2" && <Big question={`Game 2: which player serves for ${sides[other].name}?`} value={picks.otherServer} onPick={(v: 0 | 1) => pick({ otherServer: v })} options={players(other)} />}
      {step === "receiver2" && <Big question={`Game 2: which player of ${sides[serving].name} receives the serve?`} value={picks.otherReceiver} onPick={(v: 0 | 1) => pick({ otherReceiver: v })} options={players(serving)} />}
      {step === "next" && order && (
        <div className="space-y-4">
          <div className="space-y-2 rounded-xl bg-background p-3 text-sm" data-testid="serve-order-summary">
            <p>
              Game 1: <b>{name(serving, order.server)}</b> ({sides[serving].name}) serves to <b>{name(other, order.receiver)}</b> ({sides[other].name}).
            </p>
            <p>
              Game 2: <b>{name(other, order.otherServer)}</b> ({sides[other].name}) serves to <b>{name(serving, order.otherReceiver)}</b> ({sides[serving].name}).
            </p>
            <p className="text-xs text-muted">
              Each team keeps its sides for the whole set: {name(other, order.receiver)} and {name(serving, order.otherReceiver)} receive on the deuce court (the first point of every game), their partners on the
              ad court. The receiver changes every point; that is the rule, not a mistake.
            </p>
          </div>
          <button type="button" onClick={() => onConfirm(order)} className="w-full rounded-2xl py-4 text-base font-black text-black" style={{ background: SERVING_YELLOW }} data-testid="serve-order-confirm">
            Start the set
          </button>
        </div>
      )}
    </div>
  );
}

/** One question with big answers stacked full width; picking one answers it. */
function Big<V extends string | number>({ question, value, onPick, options }: { question: string; value: V | undefined; onPick: (v: V) => void; options: [V, string][] }) {
  return (
    <div className="space-y-3">
      <p className="text-lg font-bold">{question}</p>
      {options.map(([v, text]) => (
        <button
          key={String(v)}
          type="button"
          onClick={() => onPick(v)}
          className={`block w-full rounded-2xl border-2 px-4 py-4 text-left text-base font-bold ${value === v ? "border-accent bg-accent/15" : "border-border bg-background"}`}
          aria-pressed={value === v}
        >
          {text}
        </button>
      ))}
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
