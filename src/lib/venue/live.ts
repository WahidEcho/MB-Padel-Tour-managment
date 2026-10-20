/**
 * Each court's live line on the map, from the public bundle and live reads the
 * app already uses (src/lib/mobile/server.ts: explicit public columns only):
 * "EGY 1–0 USA · 6–4 3–2" for a tie, "EGY v USA · 6–4 3–2" for a match, or
 * the next match on the court. Pure.
 */
import type { MBundle, MLive, MMatch, MScore, MTie } from "../mobile/contract";
import { normalizeCourtName } from "./route";
import type { PublicVenueCourt, VenueCourtLive } from "./types";

export interface EventFeed {
  slug: string;
  bundle: Pick<MBundle, "teams" | "courts">;
  live: Pick<MLive, "ties" | "matches">;
  /** IANA zone for "Next · 10:00". */
  timezone?: string;
}

const DASH = "–";

/** "6–4 3–2": finished sets, then the set in play. */
export function scoreLine(score: MScore | null): string | null {
  if (!score) return null;
  const parts = score.sets.map((s) => `${s.a}${DASH}${s.b}`);
  if (score.games && (score.games.a > 0 || score.games.b > 0 || parts.length === 0)) parts.push(`${score.games.a}${DASH}${score.games.b}`);
  return parts.length ? parts.join(" ") : null;
}

function timeIn(iso: string, tz?: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz ?? "Africa/Cairo" }).format(new Date(iso));
  } catch {
    return null;
  }
}

export function courtLive(court: Pick<PublicVenueCourt, "id" | "name">, feeds: EventFeed[]): VenueCourtLive | null {
  const key = normalizeCourtName(court.name);
  type Cand = { feed: EventFeed; match?: MMatch; tie?: MTie };
  const live: Cand[] = [];
  const next: Cand[] = [];
  for (const feed of feeds) {
    const ids = new Set(feed.bundle.courts.filter((c) => normalizeCourtName(c.name) === key).map((c) => c.id));
    if (!ids.size) continue;
    for (const t of feed.live.ties) {
      if (!t.courtId || !ids.has(t.courtId)) continue;
      if (t.status === "live") live.push({ feed, tie: t });
      else if (t.status === "scheduled") next.push({ feed, tie: t });
    }
    for (const m of feed.live.matches) {
      if (!m.courtId || !ids.has(m.courtId)) continue;
      if (m.status === "live" || m.status === "paused") live.push({ feed, match: m });
      else if ((m.status === "scheduled" || m.status === "ready") && !m.tieId) next.push({ feed, match: m });
    }
  }
  const codeOf = (feed: EventFeed, id: string | null) => {
    const t = id ? feed.bundle.teams.find((x) => x.id === id) : null;
    return t ? t.code || t.name : "TBD";
  };
  // A live rubber of a live tie, else the tie itself, else a live match.
  const liveTie = live.find((c) => c.tie);
  if (liveTie?.tie) {
    const t = liveTie.tie;
    const feed = liveTie.feed;
    const rubber = feed.live.matches.find((m) => m.tieId === t.id && (m.status === "live" || m.status === "paused")) ?? null;
    return {
      courtKey: court.id,
      live: true,
      slug: feed.slug,
      matchId: rubber?.id ?? null,
      tieId: t.id,
      title: `${codeOf(feed, t.a)} ${t.rubbersA}${DASH}${t.rubbersB} ${codeOf(feed, t.b)}`,
      detail: rubber ? scoreLine(rubber.score) : null,
    };
  }
  const liveMatch = live.find((c) => c.match);
  if (liveMatch?.match) {
    const m = liveMatch.match;
    return { courtKey: court.id, live: true, slug: liveMatch.feed.slug, matchId: m.id, tieId: m.tieId, title: `${codeOf(liveMatch.feed, m.a)} v ${codeOf(liveMatch.feed, m.b)}`, detail: scoreLine(m.score) };
  }
  const when = (c: Cand) => Date.parse((c.tie?.scheduledTime ?? c.match?.scheduledTime) || "9999-12-31");
  const up = next.sort((x, y) => when(x) - when(y))[0];
  if (!up) return null;
  const a = up.tie?.a ?? up.match?.a ?? null;
  const b = up.tie?.b ?? up.match?.b ?? null;
  const at = up.tie?.scheduledTime ?? up.match?.scheduledTime ?? null;
  const time = at ? timeIn(at, up.feed.timezone) : null;
  return {
    courtKey: court.id,
    live: false,
    slug: up.feed.slug,
    matchId: up.match?.id ?? null,
    tieId: up.tie?.id ?? null,
    title: `${codeOf(up.feed, a)} v ${codeOf(up.feed, b)}`,
    detail: time ? `Next · ${time}` : "Next",
  };
}

export function venueLive(courts: Pick<PublicVenueCourt, "id" | "name">[], feeds: EventFeed[]): VenueCourtLive[] {
  return courts.map((c) => courtLive(c, feeds)).filter((x): x is VenueCourtLive => x !== null);
}
