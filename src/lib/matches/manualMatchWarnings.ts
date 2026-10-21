/**
 * What to warn about before a match is added by hand (the organiser's matches page
 * and the master referee's desk). Warnings never refuse: the desk confirms and the
 * match is created. Pure.
 */
import { eventDay } from "../matchday/eventDay";

export interface ExistingMatch {
  team_a_id: string | null;
  team_b_id: string | null;
  court_id: string | null;
  status: string;
  scheduled_time: string | null;
  tie_id?: string | null;
}

export interface ManualMatchDraft {
  teamA: string;
  teamB: string;
  courtId: string | null;
  groupId: string | null;
}

export type ManualMatchWarningCode = "same_pair" | "team_busy" | "court_busy" | "outside_draw";

export interface ManualMatchWarning {
  code: ManualMatchWarningCode;
  message: string;
}

const DONE = ["completed", "walkover", "retired", "disqualified", "cancelled"];
const IN_PLAY = ["live", "paused"];

export function manualMatchWarnings(
  draft: ManualMatchDraft,
  existing: ExistingMatch[],
  ctx: {
    /** A nations event: every fixture is a tie of rubbers. */
    tieFormat: boolean;
    teamName: (id: string) => string;
    courtName: (id: string) => string;
    timeZone: string;
    nowMs?: number;
  },
): ManualMatchWarning[] {
  const out: ManualMatchWarning[] = [];
  const today = eventDay(ctx.timeZone, ctx.nowMs);
  const plays = (m: ExistingMatch, team: string) => m.team_a_id === team || m.team_b_id === team;
  const open = (m: ExistingMatch) => !DONE.includes(m.status);
  // Unfinished and either today or with no time yet: what the desk would be clashing with.
  const todayOrUnset = (m: ExistingMatch) => !m.scheduled_time || eventDay(ctx.timeZone, Date.parse(m.scheduled_time)) === today;
  const fixtures = (list: ExistingMatch[]) => new Set(list.map((m, i) => m.tie_id ?? `m${i}`)).size;
  const a = ctx.teamName(draft.teamA);
  const b = ctx.teamName(draft.teamB);
  const unit = ctx.tieFormat ? "tie" : "match";
  const plural = (n: number, w: "tie" | "match") => `${n} ${n === 1 ? w : w === "match" ? "matches" : "ties"}`;

  const pair = existing.filter((m) => m.status !== "cancelled" && plays(m, draft.teamA) && plays(m, draft.teamB));
  if (pair.length) {
    const n = fixtures(pair);
    out.push({ code: "same_pair", message: `${a} and ${b} already have ${plural(n, unit)} against each other${pair.some(open) ? ", not finished yet" : ""}.` });
  }

  for (const [team, name] of [[draft.teamA, a], [draft.teamB, b]] as const) {
    const busy = existing.filter((m) => open(m) && todayOrUnset(m) && plays(m, team));
    if (!busy.length) continue;
    const live = busy.find((m) => IN_PLAY.includes(m.status));
    const where = live?.court_id ? ` on ${ctx.courtName(live.court_id)}` : "";
    out.push({
      code: "team_busy",
      message: live ? `${name} is playing now${where}.` : `${name} already has ${plural(fixtures(busy), unit)} today not finished.`,
    });
  }

  if (draft.courtId) {
    const onCourt = existing.filter((m) => open(m) && todayOrUnset(m) && m.court_id === draft.courtId);
    if (onCourt.length) {
      const live = onCourt.find((m) => IN_PLAY.includes(m.status));
      const now = live ? ` (in play now: ${ctx.teamName(live.team_a_id ?? "")} v ${ctx.teamName(live.team_b_id ?? "")})` : "";
      out.push({ code: "court_busy", message: `${ctx.courtName(draft.courtId)} already has ${plural(onCourt.length, "match")} not finished today${now}.` });
    }
  }

  if (ctx.tieFormat) {
    out.push({
      code: "outside_draw",
      message: "This is a single match, not a tie of the draw: it will not count in the group ranking and will not move anyone in the placement draws.",
    });
  } else if (!draft.groupId) {
    out.push({
      code: "outside_draw",
      message: "This match is in no group and not in the bracket: it will not count in any standings and will not move anyone on.",
    });
  }
  return out;
}
