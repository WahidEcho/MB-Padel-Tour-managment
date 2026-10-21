/**
 * The referee screens' words for values the server sends as codes (roles, statuses,
 * line-up issues, calls for assistance), in the app's language. The shared rules in
 * src/lib write English prose for the web console; the app rebuilds the same
 * sentence from the code, and falls back to the server's words for anything new.
 */
import type { CallStatus, LineupIssue, SquadMember } from "@core";
import { tr, type Key } from "../i18n/t";

const known = (key: string, fallback: string) => {
  const s = tr(key as Key);
  return s === key ? fallback : s;
};

/** "admin", "referee", "master_referee" → in the app's language. */
export const roleLabel = (role: string) => known(`referee.role_${role}`, role);

/** A match status ("live", "completed", …) in lower case. */
export const matchStatusLabel = (status: string) => known(`referee.status_${status}`, status);

/** A tournament status ("active", "draft", …). */
export const tournamentStatusLabel = (status: string) => known(`referee.tStatus_${status}`, status);

const rubberWord = (type: string) => (type === "D" ? tr("referee.rubber_D") : known(`referee.slot_${type}`, type));

/**
 * A line-up problem or warning in the app's language. `squad` (the nation's, No. 1
 * first) names the players the issue's key points at; unknown codes keep the
 * server's message.
 */
export function issueMessage(issue: Pick<LineupIssue, "code" | "message"> & { key?: string; rubbers?: string[] }, squad?: SquadMember[]): string {
  const rank = (id: string) => (squad ? squad.findIndex((p) => p.id === id) : -1);
  const name = (id: string) => squad?.find((p) => p.id === id)?.name ?? tr("referee.thatPlayer");
  switch (issue.code) {
    case "missing_s1":
    case "missing_s2":
    case "same_singles":
    case "doubles_incomplete":
    case "doubles_same":
      return tr(`referee.issue_${issue.code}` as Key);
    case "not_in_squad": {
      const type = issue.key?.split(":")[1] ?? issue.rubbers?.[0];
      return type ? tr("referee.issue_not_in_squad", { rubber: rubberWord(type) }) : issue.message;
    }
    case "order_of_merit": {
      const m = /^order_of_merit:(.+)>(.+)$/.exec(issue.key ?? "");
      if (!m || !squad || rank(m[1]) < 0 || rank(m[2]) < 0) return issue.message;
      const [, lo, hi] = m;
      return tr("referee.issue_order_of_merit", { hi: name(hi), hiN: rank(hi) + 1, lo: name(lo), loN: rank(lo) + 1 });
    }
    case "retired_again": {
      const pid = issue.key?.startsWith("retired_again:") ? issue.key.slice("retired_again:".length) : null;
      if (!pid || !squad || !issue.rubbers?.length) return issue.message;
      return tr("referee.issue_retired_again", { name: name(pid), rubbers: issue.rubbers.map(rubberWord).join(` ${tr("common.and")} `) });
    }
    default:
      return issue.message;
  }
}

/** A call for assistance's state, as the court referee's card says it. */
export function callStatusWords(call: { status: CallStatus; acknowledgedBy?: string | null; resolvedBy?: string | null }): string {
  if (call.status === "open") return tr("referee.callOpen");
  if (call.status === "acknowledged") return tr("referee.callAck", { name: call.acknowledgedBy ?? tr("referee.aMaster") });
  if (call.status === "resolved") return call.resolvedBy ? tr("referee.callResolvedBy", { name: call.resolvedBy }) : tr("referee.callResolved");
  return tr("referee.callCancelled");
}
