/**
 * Coach line-up entry, server side (rules: lineupEntry.ts; docs/coaches.md). Off unless an
 * admin turns it on for the event; while off nothing here answers but `feature_off`.
 *
 * A coach's submission is never written to the rubbers: it is kept as an audit row
 * (`COACH_LINEUP_SUBMITTED`, entity = the tie, with the side, team, line-up and the warnings
 * accepted), so no public page, screen or opponent ever sees it. The officials' picker
 * (lineupServer.ts) shows the latest one prefilled, "Submitted by the coach at HH:MM";
 * confirming it there writes it through setLineup and locks the line-ups.
 *
 * Everything is limited to the coach's own team: a tie of another team (or a missing one)
 * is null (404); only the coach's own squad and side are read into the answer, with
 * explicit columns.
 */
import { db } from "../supabase";
import { takeRateLimit } from "../ratelimit";
import { isUuid } from "../orgs/roles";
import { courtKey } from "../orgs/courtScope";
import { sendExpo, type ExpoMessage } from "../notify/drain";
import { alertLang, aw, vsIn } from "../notify/i18n";
import { mastersOnDuty } from "../referees/server";
import { RUBBER_LABELS } from "../tennis/ties";
import { issueText, rubberEditable, unaccepted, type LineupIssue } from "../tennis/lineupRules";
import { lineupOfRubbers, tieContext, type Lineup } from "../tennis/tieOps";
import { COACH_LINEUP_ACTION, latestCoachSubmissions, lineupFromBody, acceptedKeys, recordLineupException, tieBundle, type SideIssue } from "../tennis/lineupServer";
import type { Match, MatchStatus, RubberType, Tie } from "../types";
import type { MCoachLineupEntry, MatchStatusLite } from "../mobile/contract";
import { coachReaches, coachSideOf } from "./rules";
import { COACH_LINEUP_CLOSED_MESSAGE, checkCoachLineup, coachActorLabel, coachLineupSettings, coachLineupWindow, newlyAccepted, sameLineup, type CoachLineupClosed, type CoachLineupSettings } from "./lineupEntry";
import type { CoachPrincipal } from "./server";

/** Brakes on submissions: per sign-in and per team, atomic (takeRateLimit). */
export const COACH_LINEUP_PER_SESSION = { limit: 20, windowSeconds: 10 * 60 };
export const COACH_LINEUP_PER_TEAM = { limit: 40, windowSeconds: 10 * 60 };

const TIE_COLUMNS = "id, tournament_id, court_id, scheduled_time, team_a_id, team_b_id, status, lineup_locked_at, round_name";
const RUBBER_COLUMNS = "id, tie_id, rubber_no, rubber_type, status, winner_team_id, team_a_player_ids, team_b_player_ids";

type TieRow = Pick<Tie, "id" | "tournament_id" | "court_id" | "scheduled_time" | "team_a_id" | "team_b_id" | "status" | "lineup_locked_at" | "round_name">;
type RubberRow = Pick<Match, "id" | "tie_id" | "rubber_no" | "rubber_type" | "status" | "winner_team_id" | "team_a_player_ids" | "team_b_player_ids">;

interface TournamentRow {
  id: string;
  name: string;
  timezone: string | null;
  format_config: unknown;
  organization_id: string | null;
  event_group_id: string | null;
}

/** The event's coach line-up switch (off when unknown). */
export async function coachLineupSettingsOf(tournamentId: string): Promise<CoachLineupSettings> {
  const { data } = await db().from("tournaments").select("format_config").eq("id", tournamentId).maybeSingle();
  return coachLineupSettings((data as { format_config: unknown } | null)?.format_config);
}

interface Loaded {
  tour: TournamentRow;
  settings: CoachLineupSettings;
  tie: TieRow;
  side: "A" | "B";
  rubbers: RubberRow[];
  squad: { id: string; name: string }[];
}

/** The coach's own tie, its rubbers and their own squad; null for any other tie (404). */
async function load(coach: CoachPrincipal, tieId: string): Promise<Loaded | null> {
  if (!isUuid(tieId)) return null;
  const [{ data: t }, { data: tr }] = await Promise.all([
    db().from("ties").select(TIE_COLUMNS).eq("id", tieId).eq("tournament_id", coach.tournamentId).maybeSingle(),
    db().from("tournaments").select("id, name, timezone, format_config, organization_id, event_group_id").eq("id", coach.tournamentId).maybeSingle(),
  ]);
  const tie = t as TieRow | null;
  const tour = tr as TournamentRow | null;
  if (!tie || !tour || !coachReaches(coach.teamId, tie)) return null;
  const side = coachSideOf(coach.teamId, tie)!;
  const [{ data: m }, { data: p }] = await Promise.all([
    db().from("matches").select(RUBBER_COLUMNS).eq("tie_id", tie.id).eq("tournament_id", coach.tournamentId).order("rubber_no"),
    db().from("players").select("id, full_name, player_order").eq("team_id", coach.teamId).eq("tournament_id", coach.tournamentId).order("player_order"),
  ]);
  const rubbers = ((m ?? []) as RubberRow[]).filter((r) => r.tie_id === tie.id);
  const squad = ((p ?? []) as { id: string; full_name: string }[]).map((x) => ({ id: x.id, name: x.full_name }));
  return { tour, settings: coachLineupSettings(tour.format_config), tie, side, rubbers, squad };
}

function windowOf(l: Loaded, now = Date.now()) {
  const singles = l.rubbers.filter((r) => r.rubber_type !== "D");
  return coachLineupWindow(
    {
      settings: l.settings,
      locked: Boolean(l.tie.lineup_locked_at),
      tieStatus: l.tie.status,
      scheduledTime: l.tie.scheduled_time,
      opponentKnown: Boolean(l.tie.team_a_id && l.tie.team_b_id),
      singlesEditable: singles.length > 0 && singles.every((r) => rubberEditable(r.status as MatchStatus)),
    },
    now,
  );
}

/** Our side's latest submission (never the opponent's). */
async function ownSubmission(l: Loaded) {
  const subs = await latestCoachSubmissions(l.tie.id, l.tie.tournament_id, { A: l.tie.team_a_id, B: l.tie.team_b_id });
  return subs[l.side] ?? null;
}

function entryOf(l: Loaded, sub: Awaited<ReturnType<typeof ownSubmission>>, now = Date.now()): MCoachLineupEntry {
  const w = windowOf(l, now);
  const ctx = tieContext(l.rubbers, l.tie, l.side);
  return {
    open: w.open,
    closed: w.closed,
    closedMessage: w.closed ? COACH_LINEUP_CLOSED_MESSAGE[w.closed] : null,
    deadline: w.deadline,
    side: l.side,
    squad: l.squad,
    retired: ctx.retired,
    openRubbers: ctx.open,
    rubbers: l.rubbers.map((r) => ({ type: r.rubber_type as string, label: RUBBER_LABELS[r.rubber_type as RubberType] ?? String(r.rubber_type), status: r.status as MatchStatusLite, editable: rubberEditable(r.status as MatchStatus) })),
    official: lineupOfRubbers(l.rubbers, l.side),
    submitted: sub ? { lineup: sub.lineup, at: sub.at, accepted: sub.accepted.map((a) => a.key), by: sub.by } : null,
  };
}

/** The coach's line-up form for one of their ties; null (404) for another team's or a missing tie, or while the switch is off. */
export async function coachLineupEntry(coach: CoachPrincipal, tieId: string): Promise<MCoachLineupEntry | null> {
  const l = await load(coach, tieId);
  if (!l || !l.settings.on) return null;
  return entryOf(l, await ownSubmission(l));
}

/** For the tie views: the switch's state for one tie (absent while off). */
export async function coachEntryBadges(coach: CoachPrincipal, tieIds: string[]): Promise<Map<string, { open: boolean; submittedAt: string | null }> | null> {
  const settings = await coachLineupSettingsOf(coach.tournamentId);
  if (!settings.on || !tieIds.length) return null;
  const out = new Map<string, { open: boolean; submittedAt: string | null }>();
  for (const id of tieIds.slice(0, 40)) {
    const l = await load(coach, id);
    if (!l) continue;
    const sub = await ownSubmission(l);
    out.set(id, { open: windowOf(l).open, submittedAt: sub?.at ?? null });
  }
  return out;
}

export type CoachSubmitResult =
  | { ok: true; changed: boolean; entry: MCoachLineupEntry; accepted: LineupIssue[]; officialsAlerted: number; exceptionAlerted: number }
  | { ok: false; status: number; code: string; error: string; problems?: LineupIssue[]; warnings?: LineupIssue[]; retryAfterSeconds?: number };

const refuse = (status: number, code: string, error: string, extra: Partial<Extract<CoachSubmitResult, { ok: false }>> = {}): CoachSubmitResult => ({ ok: false, status, code, error, ...extra });

/**
 * A coach submits (or changes) their team's line-up for one of their ties. Order: the
 * switch (409 feature_off), the tie (404 for anyone else's), the brakes (429), the body
 * (400), the window (409 locked | deadline | under_way | …), the checks (400 problems; 409
 * warnings until accepted), then the submission is recorded, an accepted exception is
 * audited and alerted (master referees on duty, the organisation's admins), and the
 * officials (the court's referee if signed in, the master referees) are told.
 */
export async function submitCoachLineup(coach: CoachPrincipal, tieId: string, body: unknown, now = Date.now()): Promise<CoachSubmitResult> {
  const l = await load(coach, tieId);
  if (!l) return refuse(404, "not_found", "Not found");
  if (!l.settings.on) return refuse(409, "feature_off", COACH_LINEUP_CLOSED_MESSAGE.feature_off);
  for (const b of [
    { key: `coach-lineup:${coach.sessionId}`, ...COACH_LINEUP_PER_SESSION },
    { key: `coach-lineup-team:${coach.teamId}`, ...COACH_LINEUP_PER_TEAM },
  ]) {
    const r = await takeRateLimit(b);
    if (!r.allowed) return refuse(429, "rate_limited", "Too many line-up changes. Wait a few minutes.", { retryAfterSeconds: r.retryAfterSeconds });
  }
  const o = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const lineup = lineupFromBody(o?.lineup);
  if (!lineup) return refuse(400, "bad_request", "No line-up sent.");
  const ids = [lineup.S1, lineup.S2, ...lineup.D].filter(Boolean) as string[];
  if (ids.some((id) => !l.squad.some((p) => p.id === id))) return refuse(400, "problems", "Only your own team's players can be named.", { problems: [{ code: "not_in_squad", reg: null, message: "Only your own team's players can be named.", rubbers: [], key: "not_in_squad" }] });
  const accept = acceptedKeys(o?.accept).map((k) => k.replace(/^[AB]:/, ""));

  const w = windowOf(l, now);
  if (!w.open) return refuse(409, w.closed as CoachLineupClosed, COACH_LINEUP_CLOSED_MESSAGE[w.closed as CoachLineupClosed]);

  const ctx = tieContext(l.rubbers, l.tie, l.side);
  const check = checkCoachLineup(lineup, l.squad, ctx);
  if (check.problems.length) return refuse(400, "problems", check.problems.map(issueText).join(" "), { problems: check.problems });
  const pending = unaccepted(check.warnings, accept);
  if (pending.length) return refuse(409, "warnings", `${pending.map(issueText).join(" ")} Accept the exception to submit it.`, { warnings: pending });

  const before = await ownSubmission(l);
  if (before && sameLineup(before.lineup, lineup) && check.warnings.every((x) => before.accepted.some((a) => a.key === x.key))) {
    return { ok: true, changed: false, entry: entryOf(l, before, now), accepted: [], officialsAlerted: 0, exceptionAlerted: 0 };
  }
  const by = coachActorLabel(coach.team.name);
  const { error } = await db()
    .from("audit_logs")
    .insert({
      tournament_id: l.tie.tournament_id,
      organization_id: coach.orgId,
      actor_role: "coach",
      actor_name: by,
      action: COACH_LINEUP_ACTION,
      entity_type: "tie",
      entity_id: l.tie.id,
      old_value: before ? { lineup: before.lineup, at: before.at } : null,
      new_value: {
        side: l.side,
        team_id: coach.teamId,
        lineup: { S1: lineup.S1, S2: lineup.S2, D: lineup.D },
        accepted: check.warnings.map((x) => ({ code: x.code, reg: x.reg, message: x.message, key: x.key })),
        code_id: coach.codeId,
        session_id: coach.sessionId,
        change: Boolean(before),
      },
    });
  if (error) return refuse(503, "unavailable", "Not saved. Try again.");
  const after = await ownSubmission(l);

  // An exception accepted now (not already accepted with the last submission): audited and alerted like an official's.
  const fresh = newlyAccepted(check.warnings, before?.accepted.map((a) => a.key));
  let exceptionAlerted = 0;
  if (fresh.length) {
    const b = await tieBundle(l.tie.id, l.tie.tournament_id);
    if (b) {
      const issues: SideIssue[] = fresh.map((x) => ({ ...x, side: l.side }));
      exceptionAlerted = await recordLineupException({ kind: "coach", label: by }, "coach", b, issues, { actorName: by, emailAdmins: true });
    }
  }
  const officialsAlerted = await tellOfficials(l, by, Boolean(before), now);
  return { ok: true, changed: true, entry: entryOf(l, after, now), accepted: check.warnings, officialsAlerted, exceptionAlerted };
}

/** The installations of the court referees signed in on this tie's court (its events), right now. */
async function courtRefereePhones(orgId: string, courtName: string, scope: { eventGroupId: string | null; tournamentId: string }, now: number): Promise<string[]> {
  const since = new Date(now - 12 * 3600_000).toISOString();
  const { data } = await db()
    .from("referee_sessions")
    .select("installation_id, court_name, event_group_id, tournament_id, expires_at, code_id")
    .eq("organization_id", orgId)
    .is("ended_at", null)
    .not("court_name", "is", null)
    .gte("last_seen_at", since)
    .limit(200);
  const key = courtKey(courtName);
  const rows = ((data ?? []) as { installation_id: string | null; court_name: string | null; event_group_id: string | null; tournament_id: string | null; expires_at: string; code_id: string | null }[]).filter(
    (s) =>
      Date.parse(s.expires_at) > now &&
      courtKey(s.court_name) === key &&
      ((s.event_group_id !== null && s.event_group_id === scope.eventGroupId) || (s.tournament_id !== null && s.tournament_id === scope.tournamentId)),
  );
  const codeIds = [...new Set(rows.map((r) => r.code_id).filter((x): x is string => Boolean(x)))];
  if (!codeIds.length) return [];
  const { data: codes } = await db().from("organization_codes").select("id, revoked_at, expires_at").eq("organization_id", orgId).in("id", codeIds);
  const working = new Set(((codes ?? []) as { id: string; revoked_at: string | null; expires_at: string | null }[]).filter((c) => !c.revoked_at && !(c.expires_at && Date.parse(c.expires_at) <= now)).map((c) => c.id));
  return [...new Set(rows.filter((r) => r.code_id && working.has(r.code_id)).map((r) => r.installation_id).filter((x): x is string => Boolean(x)))];
}

/** "Coach of Egypt submitted the line-up for EGY v ESP (Court 1)": to the court's referee and the master referees on duty. */
async function tellOfficials(l: Loaded, by: string, change: boolean, now: number): Promise<number> {
  try {
    const orgId = l.tour.organization_id;
    if (!orgId) return 0;
    const [{ data: court }, { data: teams }] = await Promise.all([
      l.tie.court_id ? db().from("courts").select("court_name").eq("id", l.tie.court_id).maybeSingle() : Promise.resolve({ data: null }),
      db().from("teams").select("id, team_name, nation_code").in("id", [l.tie.team_a_id, l.tie.team_b_id].filter((x): x is string => Boolean(x))),
    ]);
    const courtName = (court as { court_name: string } | null)?.court_name ?? null;
    const code = (id: string | null) => {
      const t = ((teams ?? []) as { id: string; team_name: string; nation_code: string | null }[]).find((x) => x.id === id);
      return t?.nation_code || t?.team_name || "TBD";
    };
    // In each official's phone language.
    const words = (locale: string | null | undefined) => {
      const lang = alertLang(locale);
      const pair = vsIn(lang, code(l.tie.team_a_id), code(l.tie.team_b_id));
      const court = courtName ? ` (${courtName})` : "";
      return {
        title: aw(lang, change ? "coachLineupChanged" : "coachLineupSubmitted"),
        body: aw(lang, change ? "coachLineupChangedBody" : "coachLineupSubmittedBody", { by, vs: pair, court }),
      };
    };
    const firstRubber = l.rubbers[0]?.id ?? null;
    const [duty, court0] = await Promise.all([
      mastersOnDuty(orgId, { eventGroupId: l.tour.event_group_id, tournamentId: l.tour.id }, now),
      courtName ? courtRefereePhones(orgId, courtName, { eventGroupId: l.tour.event_group_id, tournamentId: l.tour.id }, now) : Promise.resolve([] as string[]),
    ]);
    const masters = new Set(duty.installationIds);
    const installs = [...new Set([...court0, ...duty.installationIds])].slice(0, 200);
    if (!installs.length) return 0;
    const { data } = await db().from("push_devices").select("installation_id, expo_push_token, locale").in("installation_id", installs).is("disabled_at", null).not("expo_push_token", "is", null);
    const messages: ExpoMessage[] = ((data ?? []) as { installation_id: string; expo_push_token: string; locale?: string | null }[]).map((d) => ({
      to: d.expo_push_token,
      ...words(d.locale),
      data: { url: !masters.has(d.installation_id) && firstRubber ? `movescore://referee/lineup/${firstRubber}` : "movescore://referee/master", kind: "coach_lineup_submitted", tieId: l.tie.id },
      sound: "default",
      channelId: "assistance",
      priority: "high",
      ttl: 1800,
    }));
    if (!messages.length) return 0;
    return (await sendExpo(messages)).filter((x) => x.status === "ok").length;
  } catch (err) {
    console.error("[coach lineups] officials not told:", (err as Error).message);
    return 0;
  }
}

export type { Lineup };
