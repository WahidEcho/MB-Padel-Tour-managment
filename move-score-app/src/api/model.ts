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

export function liveMatches(live: MLive | undefined): MMatch[] {
  return (live?.matches ?? []).filter((m) => isLiveStatus(m.status));
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

export function dateRange(a: string | null, b: string | null): string {
  if (!a) return "";
  const f = (d: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));
  if (!b || a === b) return f(a, { day: "numeric", month: "short" });
  const sameMonth = a.slice(0, 7) === b.slice(0, 7);
  return sameMonth ? `${f(a, { day: "numeric" })}–${f(b, { day: "numeric", month: "short" })}` : `${f(a, { day: "numeric", month: "short" })} – ${f(b, { day: "numeric", month: "short" })}`;
}
