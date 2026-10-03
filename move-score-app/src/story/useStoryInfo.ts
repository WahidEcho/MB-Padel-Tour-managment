/**
 * What each share is about, as one StoryInfo: a match (or rubber), a tie, or the
 * phone's event pass. The share screen and every sticker draw from it.
 */
import type { MBundle, MEventGroup, MMatch, MTeam, MTie } from "@core";
import { isDoneStatus, isLiveStatus } from "@core";
import { isOffline, useBundle, useLive, useMatch } from "../api/queries";
import { useOnline } from "../api/network";
import { isAwaitingResult, makeView, whenIn, type View } from "../api/model";
import { useFeaturedGroup } from "../api/featured";
import { usePass } from "../pass/usePass";
import { eventToday } from "../pass/day";
import { eventDays, serialOf, storyDate, type StoryInfo, type StoryPass, type StorySide } from "./model";

export interface StoryState {
  info: StoryInfo | null;
  /** Why there is nothing to draw, once loading has failed. */
  problem: "offline" | "gone" | null;
  retry: () => void;
}

const loading = (retry: () => void): StoryState => ({ info: null, problem: null, retry });

/** With no connection a read pauses rather than fails: still loading, but offline. */
const waiting = (online: boolean, retry: () => void, ...qs: { data: unknown; fetchStatus: string }[]): StoryState =>
  !online || qs.some((q) => q.data === undefined && q.fetchStatus === "paused") ? { info: null, problem: "offline", retry } : loading(retry);

/** The phone's pass, when the featured event holds this tournament. */
function usePassFor(group: MEventGroup | null, bundle: MBundle | undefined, slug: string | undefined): StoryPass | null {
  const q = usePass(group?.id);
  const p = q.pass;
  if (!group || !p) return null;
  if (slug && !group.tournaments.some((t) => t.slug === slug)) return null;
  const nationIso2 = bundle?.teams.find((t) => t.code === p.nationCode)?.iso2 ?? null;
  return { pass: p, event: { name: group.name, venue: group.venue, city: group.city, days: eventDays(group.startsOn, group.endsOn) }, nationIso2 };
}

function sideOf(team: MTeam | undefined, label: string, sets: number[], games: number | null, won: boolean): StorySide {
  return { code: team?.code ?? "TBD", iso2: team?.iso2 ?? null, label, sets, games, won };
}

function matchSides(m: MMatch, v: View): [StorySide, StorySide] {
  const done = isDoneStatus(m.status);
  const s = m.score;
  const mk = (side: "A" | "B") => {
    const id = side === "A" ? m.a : m.b;
    const sets = (s?.sets ?? []).map((x) => (side === "A" ? x.a : x.b));
    const games = s?.games && !done ? (side === "A" ? s.games.a : s.games.b) : null;
    return sideOf(v.team(id), v.sideLabel(m, side, true), sets, games, done && !!m.winner && m.winner === id);
  };
  return [mk("A"), mk("B")];
}

export function useMatchStory(id: string): StoryState {
  const q = useMatch(id);
  const slug = q.data?.tournamentSlug;
  const b = useBundle(slug);
  const l = useLive(slug, 20_000);
  const group = useFeaturedGroup();
  const pass = usePassFor(group, b.data, slug);
  const online = useOnline();
  const retry = () => void Promise.all([q.refetch(), b.refetch()]);
  if (!q.data || !b.data) {
    const failed = q.isError ? q : b.isError ? b : null;
    if (!failed) return waiting(online, retry, q, b);
    return { info: null, problem: isOffline(failed.error) ? "offline" : "gone", retry };
  }
  const v = makeView(b.data, l.data);
  // The live feed is fresher than the match detail when both have it.
  const m = l.data?.matches.find((x) => x.id === id) ?? q.data.match;
  const t = b.data.tournament;
  const tie = v.tieOf(m);
  const done = isDoneStatus(m.status);
  const tieWon = tie?.status === "completed" && tie.winner === m.winner;
  const live = isLiveStatus(m.status);
  const headline: [string, string] = done
    ? [tieWon ? "Tie" : m.tieId ? "Rubber" : "Match", "won"]
    : isAwaitingResult(m)
      ? ["Match", "over"]
      : live
        ? ["Live", "now"]
        : m.status === "cancelled"
          ? ["Not", "played"]
          : ["Coming", "up"];
  const sides = matchSides(m, v);
  const note = tie ? `${v.team(tie.a)?.code ?? "TBD"} ${tie.rubbersA}–${tie.rubbersB} ${v.team(tie.b)?.code ?? "TBD"} in the tie` : null;
  // "Group A · Round 1 · S2": the stage, then the rubber (the round label also names the tie and rubber in full).
  const round = [...(m.round ?? "").split(" · ").filter(Boolean).slice(0, m.rubberType ? 2 : 3), m.rubberType].filter(Boolean).join(" · ") || null;
  const winner = sides.find((s) => s.won);
  return {
    info: {
      kind: "match",
      event: t.name,
      round,
      place: [v.court(m.courtId), t.city].filter(Boolean).join(" · ") || null,
      city: t.city,
      date: storyDate(new Date(), t.timezone),
      when: (m.status === "scheduled" || m.status === "ready") && m.scheduledTime ? whenIn(m.scheduledTime, t.timezone, true) : null,
      status: done ? "final" : live || isAwaitingResult(m) ? "live" : "upcoming",
      headline,
      sides,
      note,
      serial: serialOf(m.id),
      holder: pass?.pass.holderName ?? null,
      pass,
      a11y: `${sides[0].label} against ${sides[1].label}, ${headline.join(" ").toLowerCase()}${winner ? `, ${winner.label} won` : ""}, at ${t.name}`,
    },
    problem: null,
    retry,
  };
}

export function useTieStory(tieId: string, slug: string | undefined): StoryState {
  const b = useBundle(slug);
  const l = useLive(slug, 20_000);
  const group = useFeaturedGroup();
  const pass = usePassFor(group, b.data, slug);
  const online = useOnline();
  const retry = () => void Promise.all([b.refetch(), l.refetch()]);
  const tie: MTie | undefined = l.data?.ties.find((x) => x.id === tieId);
  if (!b.data || !l.data || !tie) {
    const failed = b.isError ? b : l.isError ? l : null;
    if (failed) return { info: null, problem: isOffline(failed.error) ? "offline" : "gone", retry };
    if (!slug || (b.data && l.data && !tie)) return { info: null, problem: "gone", retry };
    return waiting(online, retry, b, l);
  }
  const v = makeView(b.data, l.data);
  const t = b.data.tournament;
  const done = tie.status === "completed";
  const sides: [StorySide, StorySide] = [
    sideOf(v.team(tie.a), v.team(tie.a)?.code ?? "TBD", [tie.rubbersA], null, done && tie.winner === tie.a),
    sideOf(v.team(tie.b), v.team(tie.b)?.code ?? "TBD", [tie.rubbersB], null, done && tie.winner === tie.b),
  ];
  const headline: [string, string] = done ? ["Tie", "won"] : tie.status === "live" ? ["Live", "now"] : ["Coming", "up"];
  const winner = sides.find((s) => s.won);
  return {
    info: {
      kind: "tie",
      event: t.name,
      round: tie.roundName ?? (tie.stage === "group" ? "Group stage" : "Placement"),
      place: [v.court(tie.courtId), t.city].filter(Boolean).join(" · ") || null,
      city: t.city,
      date: storyDate(new Date(), t.timezone),
      when: tie.status === "scheduled" && tie.scheduledTime ? whenIn(tie.scheduledTime, t.timezone, true) : null,
      status: done ? "final" : tie.status === "live" ? "live" : "upcoming",
      headline,
      sides,
      note: `${v.team(tie.a)?.name ?? "TBD"} v ${v.team(tie.b)?.name ?? "TBD"}, rubbers won`,
      serial: serialOf(tie.id),
      holder: pass?.pass.holderName ?? null,
      pass,
      a11y: `${v.team(tie.a)?.name ?? "TBD"} against ${v.team(tie.b)?.name ?? "TBD"}, ${tie.rubbersA}–${tie.rubbersB} in rubbers${winner ? `, ${winner.code} won the tie` : ""}, at ${t.name}`,
    },
    problem: null,
    retry,
  };
}

export function usePassStory(): StoryState {
  const group = useFeaturedGroup();
  const first = group?.tournaments[0]?.slug;
  const b = useBundle(first);
  const q = usePass(group?.id);
  const pass = usePassFor(group, b.data, undefined);
  const online = useOnline();
  const retry = () => void q.refetch();
  if (!group) return { info: null, problem: null, retry };
  if (!pass) {
    if (q.isError) return { info: null, problem: isOffline(q.error) ? "offline" : "gone", retry };
    return q.confirmedNone ? { info: null, problem: "gone", retry } : waiting(online, retry, q);
  }
  const p = pass.pass;
  const onsite = Boolean(p.onsiteUnlockedAt);
  const days = p.stamps.length;
  const today = eventToday(group.timezone);
  return {
    info: {
      kind: "pass",
      event: group.name,
      round: p.edition === "staff" ? (p.staffRole ?? "Accredited") : onsite ? "On-site pass" : "Event pass",
      place: [group.venue, group.city].filter(Boolean).join(" · ") || null,
      city: group.city,
      date: storyDate(new Date(), group.timezone),
      when: null,
      status: "here",
      headline: onsite || p.stamps.includes(today) ? ["I'm", "here"] : ["I'm", "following"],
      sides: null,
      note: onsite ? `${days} ${days === 1 ? "day" : "days"} on-site` : null,
      serial: `No. ${String(p.serial).padStart(6, "0")}`,
      holder: p.holderName,
      pass,
      a11y: `${p.holderName ?? "A Move Score fan"}'s pass for ${group.name}, number ${p.serial}${onsite ? `, ${days} ${days === 1 ? "day" : "days"} on-site` : ""}`,
    },
    problem: null,
    retry,
  };
}
