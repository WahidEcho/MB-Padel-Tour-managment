/**
 * Season fixtures (Phase 7): a dated round robin per division.
 *
 * The division's active members are its entrants: one member alone (singles,
 * chess) or a member with a partner (pairs). Every entrant meets every other
 * once (src/lib/roundrobin.ts, circle method); round n is played on the n-th
 * date given, and when fewer dates are given than rounds, the rounds after the
 * last date follow it a week apart.
 *
 * Regenerating keeps every fixture already played (or under way) and replans
 * only what is left: the pairings not yet played among the entrants as they are
 * now (a member who joined late is added, one who left is dropped), on the new
 * dates.
 *
 * Pure: shared with the Move Score app through move-score-app/src/core/index.ts.
 */
import { roundRobin } from "../roundrobin";
import { addDays, isIsoDate } from "./settings";

export interface SeasonMember {
  id: string;
  profileId: string;
  partnerProfileId?: string | null;
}

export interface SeasonEntrant {
  /** The member row that stands for the entrant (the first of a pair, by id). */
  memberId: string;
  profiles: string[];
}

/**
 * Entrants from members: a member is an entrant on their own, with their partner
 * when they named one. Two members who named each other are one pair. A member
 * already in a pair as somebody's partner is not an entrant again.
 */
export function seasonEntrants(members: SeasonMember[]): SeasonEntrant[] {
  const sorted = [...members].sort((a, b) => a.id.localeCompare(b.id));
  const taken = new Set<string>();
  const out: SeasonEntrant[] = [];
  for (const m of sorted) {
    if (taken.has(m.profileId)) continue;
    const partner = m.partnerProfileId && m.partnerProfileId !== m.profileId && !taken.has(m.partnerProfileId) ? m.partnerProfileId : null;
    taken.add(m.profileId);
    if (partner) taken.add(partner);
    out.push({ memberId: m.id, profiles: partner ? [m.profileId, partner] : [m.profileId] });
  }
  return out;
}

export interface PlannedFixture {
  round: number;
  date: string;
  home: SeasonEntrant;
  away: SeasonEntrant;
}

/** Order-free key of a pairing of two entrants (by member id). */
export function pairingKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** The date of round `round` (1-based): the given dates in order, then a week apart after the last. */
export function roundDate(dates: string[], round: number, fallbackStart: string): string {
  const valid = dates.filter(isIsoDate);
  if (valid.length === 0) return addDays(fallbackStart, 7 * (round - 1));
  if (round <= valid.length) return valid[round - 1];
  return addDays(valid[valid.length - 1], 7 * (round - valid.length));
}

/**
 * The full round robin for these entrants on these dates. `skip` holds pairings
 * already played (pairingKey of the two member ids): they are left out, and the
 * rounds that are left are numbered again from 1 so no date stays empty.
 */
export function seasonPlan(entrants: SeasonEntrant[], dates: string[], opts: { skip?: ReadonlySet<string>; fallbackStart?: string; firstRound?: number } = {}): PlannedFixture[] {
  const skip = opts.skip ?? new Set<string>();
  const start = opts.fallbackStart ?? "2026-01-01";
  const sorted = [...entrants].sort((a, b) => a.memberId.localeCompare(b.memberId));
  const pairings = roundRobin(sorted).filter((p) => !skip.has(pairingKey(p.teamA.memberId, p.teamB.memberId)));
  const rounds = [...new Set(pairings.map((p) => p.round))].sort((a, b) => a - b);
  const renumber = new Map(rounds.map((r, i) => [r, i + 1]));
  const first = Math.max(1, opts.firstRound ?? 1);
  return pairings.map((p) => {
    const round = renumber.get(p.round)! + first - 1;
    return { round, date: roundDate(dates, round - first + 1, start), home: p.teamA, away: p.teamB };
  });
}

/** Statuses of a fixture's match that count as played (kept by a regeneration). */
export const PLAYED_MATCH_STATUSES = ["live", "paused", "pending_sync", "completed", "walkover", "disqualified", "retired"] as const;
export const isPlayedStatus = (s: string | null | undefined) => (PLAYED_MATCH_STATUSES as readonly string[]).includes(s ?? "");
