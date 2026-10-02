/** Joins a tournament's bundle (who) with its live feed (what is happening). Pure. */
import type { MBundle, MLive, MMatch, MTeam, MTie, MPlayer } from "@core";
import { isDoneStatus, isLiveStatus, scoreLine } from "@core";

export interface View {
  bundle: MBundle;
  live: MLive | undefined;
  team: (id: string | null | undefined) => MTeam | undefined;
  player: (id: string) => (MPlayer & { team: MTeam }) | undefined;
  court: (id: string | null | undefined) => string | null;
  rubbers: (tieId: string) => MMatch[];
  sidePlayers: (m: MMatch, side: "A" | "B") => MPlayer[];
  sideLabel: (m: MMatch, side: "A" | "B", short?: boolean) => string;
  tieOf: (m: MMatch) => MTie | undefined;
}

export function makeView(bundle: MBundle, live: MLive | undefined): View {
  const teams = new Map(bundle.teams.map((t) => [t.id, t]));
  const players = new Map(bundle.teams.flatMap((t) => t.players.map((p) => [p.id, { ...p, team: t }] as const)));
  const courts = new Map(bundle.courts.map((c) => [c.id, c.name]));
  const ties = new Map((live?.ties ?? []).map((t) => [t.id, t]));
  const byTie = new Map<string, MMatch[]>();
  for (const m of live?.matches ?? []) if (m.tieId) byTie.set(m.tieId, [...(byTie.get(m.tieId) ?? []), m]);
  for (const list of byTie.values()) list.sort((a, b) => (a.rubberNo ?? 0) - (b.rubberNo ?? 0));
  const surname = (n: string) => n.trim().split(/\s+/).slice(-1)[0] ?? n;
  const sidePlayers = (m: MMatch, side: "A" | "B") => {
    const ids = side === "A" ? m.aPlayers : m.bPlayers;
    const team = teams.get((side === "A" ? m.a : m.b) ?? "");
    if (ids.length) return ids.map((id) => players.get(id)).filter(Boolean) as MPlayer[];
    return m.tieId ? [] : (team?.players ?? []);
  };
  return {
    bundle,
    live,
    team: (id) => (id ? teams.get(id) : undefined),
    player: (id) => players.get(id),
    court: (id) => (id ? (courts.get(id) ?? null) : null),
    rubbers: (tieId) => byTie.get(tieId) ?? [],
    sidePlayers,
    sideLabel: (m, side, short) => {
      const team = teams.get((side === "A" ? m.a : m.b) ?? "");
      if (!team) return "TBD";
      if (!m.tieId) return short ? team.code : team.name;
      const ps = sidePlayers(m, side);
      if (!ps.length) return short ? team.code : team.name;
      return ps.map((p) => (short ? surname(p.name) : p.name)).join(" / ");
    },
    tieOf: (m) => (m.tieId ? ties.get(m.tieId) : undefined),
  };
}

/** On court now, or just finished and waiting for the referee's phone to send the result. */
export function isOnCourt(m: MMatch): boolean {
  return isLiveStatus(m.status) || m.status === "pending_sync";
}

/**
 * The last point is played but the result is not confirmed yet: the referee
 * still has to confirm it (live with no game in play) or their phone has not
 * synced it (pending_sync).
 */
export function isAwaitingResult(m: MMatch): boolean {
  return m.status === "pending_sync" || (isLiveStatus(m.status) && Boolean(m.score) && !m.score!.games && !m.score!.points);
}

export function liveMatches(live: MLive | undefined): MMatch[] {
  return (live?.matches ?? []).filter(isOnCourt);
}

export function upcomingMatches(live: MLive | undefined): MMatch[] {
  return (live?.matches ?? [])
    .filter((m) => m.status === "scheduled" || m.status === "ready")
    .sort((a, b) => (a.scheduledTime ?? "9").localeCompare(b.scheduledTime ?? "9") || a.order - b.order);
}

export function finishedMatches(live: MLive | undefined): MMatch[] {
  return (live?.matches ?? []).filter((m) => isDoneStatus(m.status)).sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""));
}

export { scoreLine };

/** "15:30" and "Wed 4 Nov" in the event's own zone. */
export function timeIn(iso: string | null, tz: string): string {
  if (!iso) return "Time TBC";
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

export function dayIn(iso: string | null, tz: string): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/** True when times alone would mislead: the list spans several days, or its one day is not today. */
export function needsDay(isos: (string | null | undefined)[], tz: string, now = Date.now()): boolean {
  const days = new Set(isos.filter(Boolean).map((x) => dayIn(x!, tz)));
  if (days.size > 1) return true;
  return days.size === 1 && !days.has(dayIn(new Date(now).toISOString(), tz));
}

/** "11:00", or "Tue 3 Nov · 11:00" when the day matters. */
export function whenIn(iso: string | null, tz: string, withDay: boolean): string {
  if (!iso || !withDay) return timeIn(iso, tz);
  return `${dayIn(iso, tz)} · ${timeIn(iso, tz)}`;
}

/** One sentence for VoiceOver and TalkBack: who, where the match stands, and the score. */
export function matchA11y(m: MMatch, v: View): string {
  const a = v.sideLabel(m, "A");
  const b = v.sideLabel(m, "B");
  const tz = v.bundle.tournament.timezone;
  const s = m.score;
  const winner = m.winner === m.a ? a : m.winner === m.b ? b : null;
  const status = isAwaitingResult(m)
    ? "Match over, awaiting confirmation"
    : m.status === "paused"
      ? "Play suspended"
      : isLiveStatus(m.status)
        ? "Live"
        : isDoneStatus(m.status)
          ? `Final${m.winner && winner ? `, ${winner} won` : ""}`
          : m.status === "cancelled"
            ? "Not played"
            : m.scheduledTime
              ? `Starts ${dayIn(m.scheduledTime, tz)} at ${timeIn(m.scheduledTime, tz)}`
              : "Time to be confirmed";
  const parts = [`${a} against ${b}`, status];
  if (s?.sets.length) parts.push(`Sets ${s.sets.map((x) => `${x.a}–${x.b}`).join(", ")}`);
  if (isLiveStatus(m.status) && s?.games) parts.push(`Games ${s.games.a}–${s.games.b}`);
  if (isLiveStatus(m.status) && s?.points) parts.push(`${s.tiebreak ? "Tie-break points" : "Points"} ${s.points.a}–${s.points.b}`);
  return parts.join(". ");
}

export function dateRange(a: string | null, b: string | null): string {
  if (!a) return "";
  const f = (d: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));
  if (!b || a === b) return f(a, { day: "numeric", month: "short" });
  const sameMonth = a.slice(0, 7) === b.slice(0, 7);
  return sameMonth ? `${f(a, { day: "numeric" })}–${f(b, { day: "numeric", month: "short" })}` : `${f(a, { day: "numeric", month: "short" })} – ${f(b, { day: "numeric", month: "short" })}`;
}
