/**
 * National team coaches (migration 0037), server side: the codes (one per team), signing
 * in with one, who this request's coach is (re-checked in the database every time), and
 * the coach's read-only view of their own team. Pure rules: rules.ts. Docs: docs/coaches.md.
 *
 * A coach is never a staff principal: coach tokens ("mbc1.", token.ts) are refused by every
 * staff guard, and the coach routes accept nothing else. Everything a coach is served is
 * read here with explicit columns (never a player's code, phone or email; never a referee's
 * name) and limited to the token's one team: a tie, rubber, line-up or log of another team
 * is answered exactly like a missing one (null → 404).
 */
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { db } from "../supabase";
import { bearerToken, isLocalHost } from "../auth";
import { formatEventCode, generateEventCode, hashEventCode, normalizeEventCode, sealEventCode } from "../orgs/codes";
import { codePrefixKey } from "../staffLogin";
import { refundRateLimit, takeRateLimit, type RateLimitOptions } from "../ratelimit";
import { isUuid } from "../orgs/roles";
import { nationByCode } from "../tennis/nations";
import { RUBBER_LABELS } from "../tennis/ties";
import { toScore, toStandingRow } from "../mobile/projection";
import { SNAPSHOT_COLUMNS } from "../mobile/server";
import type { MatchSnapshot, RubberType, Standing } from "../types";
import type { MatchStatusLite, MCoachMatch, MCoachPlayer, MCoachRubber, MCoachSlot, MCoachTeamRef, MCoachTeamView, MCoachTie } from "../mobile/contract";
import { COACH_APP_HOURS, COACH_TOKEN_PREFIX, coachSecret, isCoachTokenShaped, signCoachToken, verifyCoachToken } from "./token";
import { coachCodeLabel, coachReaches, coachSideOf, landingFrom, opponentsShown, orientScore, resultFor, tieStageLabel, type CoachSide } from "./rules";
import type { CourtCodeEvent } from "../orgs/courtCodes";

/* ---------------- codes ---------------- */

export interface CoachTeamRow {
  id: string;
  tournament_id: string;
  team_name: string;
  nation_code: string | null;
  iso2: string | null;
  team_status: string | null;
}

export interface CoachCodeRow {
  id: string;
  tournament_id: string;
  team_id: string;
  label: string | null;
  code_sealed: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

const TEAM_COLUMNS = "id, tournament_id, team_name, nation_code, iso2, team_status";
const CODE_COLUMNS = "id, tournament_id, team_id, label, code_sealed, expires_at, revoked_at, last_used_at, created_at";

/** The teams of an event (every tournament of its group), by tournament then name. */
export async function coachEventTeams(ev: CourtCodeEvent): Promise<CoachTeamRow[]> {
  const ids = ev.tournaments.map((t) => t.id);
  if (!ids.length) return [];
  const { data } = await db().from("teams").select(TEAM_COLUMNS).in("tournament_id", ids).order("team_name").limit(500);
  const order = new Map(ids.map((id, i) => [id, i]));
  return ((data ?? []) as CoachTeamRow[]).sort((a, b) => (order.get(a.tournament_id)! - order.get(b.tournament_id)!) || a.team_name.localeCompare(b.team_name));
}

/** The coach codes of an event's tournaments (the organisation's own), newest first. */
export async function coachCodesOf(orgId: string, ev: CourtCodeEvent): Promise<CoachCodeRow[]> {
  const ids = ev.tournaments.map((t) => t.id);
  if (!ids.length) return [];
  const { data } = await db().from("coach_codes").select(CODE_COLUMNS).eq("organization_id", orgId).in("tournament_id", ids).order("created_at", { ascending: false }).limit(500);
  return (data ?? []) as CoachCodeRow[];
}

export const coachCodeWorks = (c: Pick<CoachCodeRow, "revoked_at" | "expires_at">, now = Date.now()) => !c.revoked_at && !(c.expires_at && Date.parse(c.expires_at) <= now);

/** A new code for one team: the row to insert and the code (shown once, then only through its seal). */
export function newCoachCodeRow(o: {
  orgId: string;
  team: Pick<CoachTeamRow, "id" | "tournament_id" | "team_name">;
  eventName: string;
  expiresAt: string | null;
  createdBy: string | null;
  createdByRole: string | null;
}) {
  const code = generateEventCode();
  return {
    code,
    row: {
      organization_id: o.orgId,
      tournament_id: o.team.tournament_id,
      team_id: o.team.id,
      code_hash: hashEventCode(code),
      code_sealed: sealEventCode(code),
      label: coachCodeLabel(o.team.team_name, o.eventName),
      expires_at: o.expiresAt,
      created_by: o.createdBy,
      created_by_role: o.createdByRole,
    },
  };
}

/** Ends every sign-in of a code (revoked or replaced): their next request is refused, and their phones get no more alerts. */
export async function endCoachSessionsOf(codeId: string, reason: "revoked" | "replaced"): Promise<void> {
  await db().from("coach_sessions").update({ ended_at: new Date().toISOString(), end_reason: reason }).eq("code_id", codeId).is("ended_at", null);
}

/** Per working code: how many devices are signed in with it now, and when one was last seen (Admin → Team coaches). */
export async function coachDevicesByCode(orgId: string, codeIds: string[], now = Date.now()): Promise<Map<string, { n: number; last: string | null }>> {
  const out = new Map<string, { n: number; last: string | null }>();
  if (!codeIds.length) return out;
  const { data } = await db().from("coach_sessions").select("code_id, last_seen_at, expires_at").eq("organization_id", orgId).in("code_id", codeIds).is("ended_at", null);
  for (const s of (data ?? []) as { code_id: string; last_seen_at: string; expires_at: string }[]) {
    if (Date.parse(s.expires_at) <= now) continue;
    const d = out.get(s.code_id) ?? { n: 0, last: null };
    d.n++;
    if (!d.last || s.last_seen_at > d.last) d.last = s.last_seen_at;
    out.set(s.code_id, d);
  }
  return out;
}

/* ---------------- signing in ---------------- */

/** Brakes on guessing coach codes: failed attempts only (a right code is refunded); atomic (takeRateLimit). */
export const COACH_LOGIN_PER_IP = { limit: 20, windowSeconds: 15 * 60 };
export const COACH_LOGIN_PER_PREFIX = { limit: 40, windowSeconds: 15 * 60 };

export function coachLoginBuckets(ip: string, typed: string): RateLimitOptions[] {
  const prefix = codePrefixKey(typed);
  return [{ key: `coach-login:${ip}`, ...COACH_LOGIN_PER_IP }, ...(prefix ? [{ key: `coach-code:${prefix}`, ...COACH_LOGIN_PER_PREFIX }] : [])];
}

/** Counts one attempt before it is checked; refused when a bucket is full (what was taken for it is given back). */
export async function coachLoginAttempt(ip: string, typed: string): Promise<{ allowed: boolean; retryAfterSeconds: number; refund: () => Promise<void> }> {
  const taken: RateLimitOptions[] = [];
  const refund = async () => {
    await Promise.all(taken.splice(0).map((b) => refundRateLimit(b)));
  };
  for (const b of coachLoginBuckets(ip, typed)) {
    const r = await takeRateLimit(b);
    if (r.taken) taken.push(b);
    if (!r.allowed) {
      await refund();
      return { allowed: false, retryAfterSeconds: r.retryAfterSeconds, refund: async () => {} };
    }
  }
  return { allowed: true, retryAfterSeconds: 0, refund };
}

export type CoachRefusal = "signed_out" | "code_revoked" | "code_expired" | "session_ended" | "org_suspended" | "unavailable";

export const COACH_REFUSAL_MESSAGE: Record<CoachRefusal | "wrong_code", string> = {
  wrong_code: "Wrong team code. Check the code on your team's card.",
  signed_out: "Sign in with your team's coach code.",
  code_revoked: "This team code was replaced or revoked. Ask the tournament desk for your team's new card.",
  code_expired: "This team code has expired: the event is over.",
  session_ended: "You were signed out. Sign in again with your team's code.",
  org_suspended: "This event is not available right now.",
  unavailable: "Coach sign-in is not available right now.",
};

interface CodeRowFull extends CoachCodeRow {
  organization_id: string;
}

async function orgOk(orgId: string): Promise<boolean> {
  const { data } = await db().from("organizations").select("status").eq("id", orgId).maybeSingle();
  return (data as { status: string } | null)?.status === "approved";
}

async function teamRef(teamId: string, tournamentId: string): Promise<(MCoachTeamRef & { tournamentId: string }) | null> {
  const { data } = await db().from("teams").select(TEAM_COLUMNS).eq("id", teamId).eq("tournament_id", tournamentId).maybeSingle();
  const t = data as CoachTeamRow | null;
  return t ? { ...toRef(t), tournamentId: t.tournament_id } : null;
}

function toRef(t: Pick<CoachTeamRow, "id" | "team_name" | "nation_code" | "iso2">): MCoachTeamRef {
  return { id: t.id, name: t.team_name, code: t.nation_code || t.team_name.slice(0, 3).toUpperCase(), iso2: t.iso2 ?? nationByCode(t.nation_code)?.iso2 ?? null };
}

interface TournamentLite {
  id: string;
  slug: string;
  name: string;
  timezone: string | null;
  event_group_id: string | null;
  organization_id: string | null;
}

async function tournamentLite(id: string): Promise<TournamentLite | null> {
  const { data } = await db().from("tournaments").select("id, slug, name, timezone, event_group_id, organization_id").eq("id", id).maybeSingle();
  return (data as TournamentLite | null) ?? null;
}

export type CoachSignIn =
  | { ok: true; token: string; expiresAt: string; codeId: string; orgId: string; sessionId: string; team: MCoachTeamRef; event: { name: string; slug: string; tournamentId: string; timeZone: string } }
  | { ok: false; reason: CoachRefusal | "wrong_code"; error: string };

/** A team's code typed (or from its QR) on the web or in the app. The caller rate-limits (coachLoginAttempt). */
export async function signInWithCoachCode(raw: unknown, opts: { hours: number; via: "web" | "app"; installationId?: string | null }, now = Date.now()): Promise<CoachSignIn> {
  const refuse = (reason: CoachRefusal | "wrong_code"): CoachSignIn => ({ ok: false, reason, error: COACH_REFUSAL_MESSAGE[reason] });
  const code = normalizeEventCode(typeof raw === "string" ? raw.trim() : "");
  if (!code) return refuse("wrong_code");
  let hash: string;
  let secret: string;
  try {
    hash = hashEventCode(code);
    secret = coachSecret();
  } catch (err) {
    console.error("coach codes unavailable:", (err as Error).message);
    return refuse("unavailable");
  }
  const { data } = await db().from("coach_codes").select(`${CODE_COLUMNS}, organization_id`).eq("code_hash", hash).maybeSingle();
  const row = data as CodeRowFull | null;
  if (!row) return refuse("wrong_code");
  if (row.revoked_at) return refuse("code_revoked");
  const codeEnds = row.expires_at ? Date.parse(row.expires_at) : Infinity;
  if (codeEnds <= now) return refuse("code_expired");
  if (!(await orgOk(row.organization_id))) return refuse("org_suspended");
  const [team, t] = await Promise.all([teamRef(row.team_id, row.tournament_id), tournamentLite(row.tournament_id)]);
  if (!team || !t) return refuse("wrong_code");
  const exp = Math.min(now + opts.hours * 3600_000, codeEnds);
  const installationId = opts.installationId && opts.installationId.length >= 16 && opts.installationId.length <= 80 ? opts.installationId : null;
  // The same phone signing in again replaces its earlier sign-in (one alert per phone).
  if (installationId) {
    await db().from("coach_sessions").update({ ended_at: new Date(now).toISOString(), end_reason: "replaced" }).eq("installation_id", installationId).is("ended_at", null);
  }
  const { data: s, error } = await db()
    .from("coach_sessions")
    .insert({ organization_id: row.organization_id, code_id: row.id, team_id: row.team_id, via: opts.via, installation_id: installationId, expires_at: new Date(exp).toISOString() })
    .select("id")
    .single();
  if (error || !s) return refuse("unavailable");
  const sessionId = (s as { id: string }).id;
  const token = signCoachToken({ v: 1, k: "coach", c: row.id, o: row.organization_id, tm: row.team_id, s: sessionId, iat: now, exp }, secret);
  await db().from("coach_codes").update({ last_used_at: new Date(now).toISOString() }).eq("id", row.id);
  return { ok: true, token, expiresAt: new Date(exp).toISOString(), codeId: row.id, orgId: row.organization_id, sessionId, team, event: { name: t.name, slug: t.slug, tournamentId: t.id, timeZone: t.timezone || "Africa/Cairo" } };
}

/* ---------------- who is asking ---------------- */

export interface CoachPrincipal {
  orgId: string;
  codeId: string;
  sessionId: string;
  teamId: string;
  tournamentId: string;
  team: MCoachTeamRef;
}

export type CoachResolution = { ok: true; coach: CoachPrincipal } | { ok: false; reason: CoachRefusal };

/** One presented coach token, re-checked: the code (revoked, expired), the sign-in (ended), the organisation. */
export async function resolveCoachToken(token: string, now = Date.now()): Promise<CoachResolution> {
  let secret: string;
  try {
    secret = coachSecret();
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  const p = verifyCoachToken(token, secret, now);
  if (!p) return { ok: false, reason: "signed_out" };
  const [{ data: c }, { data: s }] = await Promise.all([
    db().from("coach_codes").select("id, organization_id, tournament_id, team_id, expires_at, revoked_at").eq("id", p.c).maybeSingle(),
    db().from("coach_sessions").select("id, code_id, team_id, ended_at, expires_at, last_seen_at").eq("id", p.s).maybeSingle(),
  ]);
  const code = c as { id: string; organization_id: string; tournament_id: string; team_id: string; expires_at: string | null; revoked_at: string | null } | null;
  const session = s as { id: string; code_id: string; team_id: string; ended_at: string | null; expires_at: string; last_seen_at: string } | null;
  if (!code || code.organization_id !== p.o || code.team_id !== p.tm) return { ok: false, reason: "signed_out" };
  if (code.revoked_at) return { ok: false, reason: "code_revoked" };
  if (code.expires_at && Date.parse(code.expires_at) <= now) return { ok: false, reason: "code_expired" };
  if (!session || session.code_id !== code.id || session.team_id !== code.team_id) return { ok: false, reason: "signed_out" };
  if (session.ended_at || Date.parse(session.expires_at) <= now) return { ok: false, reason: "session_ended" };
  if (!(await orgOk(code.organization_id))) return { ok: false, reason: "org_suspended" };
  const team = await teamRef(code.team_id, code.tournament_id);
  if (!team) return { ok: false, reason: "signed_out" };
  if (now - Date.parse(session.last_seen_at) > 60_000) {
    await db().from("coach_sessions").update({ last_seen_at: new Date(now).toISOString() }).eq("id", session.id);
  }
  return { ok: true, coach: { orgId: code.organization_id, codeId: code.id, sessionId: session.id, teamId: code.team_id, tournamentId: code.tournament_id, team: { id: team.id, name: team.name, code: team.code, iso2: team.iso2 } } };
}

/** The web coach cookie: `__Host-` (Secure, host-only, path /) off localhost; plain `mb_coach` on a localhost server. */
export function coachCookieFor(host: string | null | undefined): { name: string; secure: boolean } {
  return isLocalHost(host) ? { name: "mb_coach", secure: false } : { name: "__Host-mb_coach", secure: true };
}

export async function setCoachCookie(token: string, expiresAt: string) {
  const { name, secure } = coachCookieFor((await headers()).get("host"));
  const maxAge = Math.max(60, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  (await cookies()).set(name, token, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge });
}

export async function clearCoachCookie() {
  const store = await cookies();
  store.set("__Host-mb_coach", "", { httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 0 });
  store.set("mb_coach", "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
}

/** The coach token this request carries: the app's bearer (coach-shaped only), else the coach cookie. */
export async function presentedCoachToken(): Promise<string | null> {
  const h = await headers();
  const bearer = bearerToken(h);
  if (bearer && isCoachTokenShaped(bearer)) return bearer;
  const store = await cookies();
  const names = isLocalHost(h.get("host")) ? ["__Host-mb_coach", "mb_coach"] : ["__Host-mb_coach"];
  for (const n of names) {
    const v = store.get(n)?.value;
    if (v?.startsWith(COACH_TOKEN_PREFIX)) return v;
  }
  return null;
}

/** This request's coach (memoised per render). */
export const currentCoachResolution = cache(async (): Promise<CoachResolution> => {
  const token = await presentedCoachToken();
  if (!token) return { ok: false, reason: "signed_out" };
  return resolveCoachToken(token);
});

const NO_STORE = { "Cache-Control": "private, no-store" };

/** Route guard for /api/mobile/v1/coach/*: the coach, or 401 with the reason. Never a staff credential. */
export async function coachRoute(): Promise<{ ok: true; coach: CoachPrincipal } | { ok: false; response: NextResponse }> {
  const r = await currentCoachResolution();
  if (!r.ok) return { ok: false, response: NextResponse.json({ error: COACH_REFUSAL_MESSAGE[r.reason], code: r.reason }, { status: 401, headers: NO_STORE }) };
  return r;
}

export const coachNotFound = () => NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
export const coachJson = (data: unknown) => NextResponse.json(data, { headers: NO_STORE });

export async function endCoachSession(sessionId: string, reason: "signed_out" | "replaced"): Promise<void> {
  if (!isUuid(sessionId)) return;
  await db().from("coach_sessions").update({ ended_at: new Date().toISOString(), end_reason: reason }).eq("id", sessionId).is("ended_at", null);
}

/* ---------------- the coach's view ---------------- */

const RUBBER_COLUMNS = "id, tournament_id, tie_id, rubber_no, rubber_type, round_name, match_order, court_id, scheduled_time, team_a_id, team_b_id, status, winner_team_id, started_at, ended_at, team_a_player_ids, team_b_player_ids";
const TIE_COLUMNS = "id, tournament_id, stage, group_id, draw_from, draw_to, places_from, places_to, round_no, round_name, tie_order, court_id, scheduled_time, team_a_id, team_b_id, status, rubbers_a, rubbers_b, winner_team_id, lineup_locked_at";

interface RubberRow {
  id: string;
  tournament_id: string;
  tie_id: string | null;
  rubber_no: number | null;
  rubber_type: string | null;
  round_name: string | null;
  match_order: number;
  court_id: string | null;
  scheduled_time: string | null;
  team_a_id: string | null;
  team_b_id: string | null;
  status: string;
  winner_team_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  team_a_player_ids: string[] | null;
  team_b_player_ids: string[] | null;
}

interface TieRow {
  id: string;
  tournament_id: string;
  stage: "group" | "placement";
  group_id: string | null;
  draw_from: number | null;
  draw_to: number | null;
  places_from: number | null;
  places_to: number | null;
  round_no: number;
  round_name: string | null;
  tie_order: number;
  court_id: string | null;
  scheduled_time: string | null;
  team_a_id: string | null;
  team_b_id: string | null;
  status: "scheduled" | "live" | "completed";
  rubbers_a: number;
  rubbers_b: number;
  winner_team_id: string | null;
  lineup_locked_at: string | null;
}

interface Names {
  teams: Map<string, CoachTeamRow>;
  players: Map<string, { id: string; full_name: string; team_id: string }>;
  courts: Map<string, string>;
  groups: Map<string, string>;
}

/** Names for a tournament: teams (no phone or notes), players (names only), courts, groups. */
async function names(tournamentId: string, playerIds: string[]): Promise<Names> {
  const [{ data: teams }, { data: players }, { data: courts }, { data: groups }] = await Promise.all([
    db().from("teams").select(TEAM_COLUMNS).eq("tournament_id", tournamentId),
    playerIds.length ? db().from("players").select("id, full_name, team_id").eq("tournament_id", tournamentId).in("id", playerIds.slice(0, 300)) : Promise.resolve({ data: [] }),
    db().from("courts").select("id, court_name").eq("tournament_id", tournamentId),
    db().from("groups").select("id, group_name").eq("tournament_id", tournamentId),
  ]);
  return {
    teams: new Map(((teams ?? []) as CoachTeamRow[]).map((t) => [t.id, t])),
    players: new Map(((players ?? []) as { id: string; full_name: string; team_id: string }[]).map((p) => [p.id, p])),
    courts: new Map(((courts ?? []) as { id: string; court_name: string }[]).map((c) => [c.id, c.court_name])),
    groups: new Map(((groups ?? []) as { id: string; group_name: string }[]).map((g) => [g.id, g.group_name])),
  };
}

const playerList = (ids: string[] | null | undefined, n: Names, teamId: string | null): MCoachPlayer[] =>
  (ids ?? []).map((id) => n.players.get(id)).filter((p): p is { id: string; full_name: string; team_id: string } => Boolean(p) && p!.team_id === teamId).map((p) => ({ id: p.id, name: p.full_name }));

function rubberView(r: RubberRow, side: CoachSide, teamId: string, n: Names, snap: MatchSnapshot | null, lineupConfirmed: boolean): MCoachRubber {
  const oursIds = side === "A" ? r.team_a_player_ids : r.team_b_player_ids;
  const theirIds = side === "A" ? r.team_b_player_ids : r.team_a_player_ids;
  const theirTeam = side === "A" ? r.team_b_id : r.team_a_id;
  return {
    matchId: r.id,
    rubberNo: r.rubber_no,
    rubberType: r.rubber_type,
    label: r.rubber_type ? (RUBBER_LABELS[r.rubber_type as RubberType] ?? r.rubber_type) : (r.round_name ?? "Match"),
    status: r.status as MatchStatusLite,
    court: r.court_id ? (n.courts.get(r.court_id) ?? null) : null,
    scheduledTime: r.scheduled_time,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    ours: playerList(oursIds, n, teamId),
    theirs: opponentsShown(r.status, lineupConfirmed) ? playerList(theirIds, n, theirTeam) : null,
    score: orientScore(toScore(r, snap), side),
    result: resultFor(teamId, r.winner_team_id),
  };
}

function tieView(t: TieRow, teamId: string, rubbers: RubberRow[], n: Names, snaps: Map<string, MatchSnapshot>): MCoachTie {
  const side = coachSideOf(teamId, t)!;
  const opp = side === "A" ? t.team_b_id : t.team_a_id;
  const oppRow = opp ? n.teams.get(opp) : undefined;
  const own = rubbers.filter((r) => r.tie_id === t.id).sort((a, b) => (a.rubber_no ?? 0) - (b.rubber_no ?? 0));
  const singlesNamed = own.filter((r) => r.rubber_type !== "D").every((r) => ((side === "A" ? r.team_a_player_ids : r.team_b_player_ids) ?? []).length > 0);
  return {
    id: t.id,
    stage: t.stage,
    stageLabel: tieStageLabel(t, t.group_id ? (n.groups.get(t.group_id) ?? null) : null),
    roundName: t.round_name,
    court: t.court_id ? (n.courts.get(t.court_id) ?? null) : null,
    scheduledTime: t.scheduled_time,
    status: t.status,
    side,
    opponent: oppRow ? toRef(oppRow) : null,
    rubbersUs: side === "A" ? t.rubbers_a : t.rubbers_b,
    rubbersThem: side === "A" ? t.rubbers_b : t.rubbers_a,
    result: resultFor(teamId, t.winner_team_id),
    placesFrom: t.places_from,
    placesTo: t.places_to,
    lineupLocked: Boolean(t.lineup_locked_at),
    lineupEntered: own.length > 0 && singlesNamed,
    rubbers: own.map((r) => rubberView(r, side, teamId, n, snaps.get(r.id) ?? null, Boolean(t.lineup_locked_at))),
  };
}

async function snapshotsFor(ids: string[]): Promise<Map<string, MatchSnapshot>> {
  if (!ids.length) return new Map();
  const { data } = await db().from("match_score_snapshots").select(SNAPSHOT_COLUMNS).in("match_id", ids);
  return new Map(((data ?? []) as unknown as MatchSnapshot[]).map((s) => [s.match_id, s]));
}

/** The team's ties (either side) and their rubbers. */
async function teamTies(coach: CoachPrincipal): Promise<{ ties: TieRow[]; rubbers: RubberRow[] }> {
  const { data } = await db()
    .from("ties")
    .select(TIE_COLUMNS)
    .eq("tournament_id", coach.tournamentId)
    .or(`team_a_id.eq.${coach.teamId},team_b_id.eq.${coach.teamId}`)
    .order("tie_order");
  const ties = ((data ?? []) as TieRow[]).filter((t) => coachReaches(coach.teamId, t));
  if (!ties.length) return { ties, rubbers: [] };
  const { data: m } = await db().from("matches").select(RUBBER_COLUMNS).in("tie_id", ties.map((t) => t.id)).order("rubber_no");
  // A rubber whose sides are not this team's (it should never happen) is left out too.
  const rubbers = ((m ?? []) as RubberRow[]).filter((r) => coachReaches(coach.teamId, r));
  return { ties, rubbers };
}

const byTime = (a: { scheduledTime: string | null; order?: number }, b: { scheduledTime: string | null; order?: number }) =>
  (a.scheduledTime ? Date.parse(a.scheduledTime) : Infinity) - (b.scheduledTime ? Date.parse(b.scheduledTime) : Infinity);

/** Everything the "My team" screen shows. */
export async function coachTeamView(coach: CoachPrincipal): Promise<MCoachTeamView | null> {
  const t = await tournamentLite(coach.tournamentId);
  if (!t) return null;
  const [{ ties, rubbers }, { data: squad }, { data: gt }, groupName] = await Promise.all([
    teamTies(coach),
    db().from("players").select("id, full_name, player_order").eq("team_id", coach.teamId).eq("tournament_id", coach.tournamentId).order("player_order"),
    db().from("group_teams").select("group_id").eq("tournament_id", coach.tournamentId).eq("team_id", coach.teamId).maybeSingle(),
    t.event_group_id ? db().from("event_groups").select("name").eq("id", t.event_group_id).maybeSingle().then((r) => (r.data as { name: string } | null)?.name ?? null) : Promise.resolve(null),
  ]);
  const ids = [...new Set(rubbers.flatMap((r) => [...(r.team_a_player_ids ?? []), ...(r.team_b_player_ids ?? [])]))];
  const [n, snaps] = await Promise.all([names(coach.tournamentId, ids), snapshotsFor(rubbers.map((r) => r.id))]);
  const tieViews = ties.map((x) => tieView(x, coach.teamId, rubbers, n, snaps)).sort((a, b) => byTime(a, b));

  // The group table: every team of the coach's group, results only.
  const groupId = (gt as { group_id: string } | null)?.group_id ?? null;
  let group: MCoachTeamView["group"] = null;
  let ownStatus: string | null = null;
  if (groupId) {
    const { data: rows } = await db().from("standings_snapshots").select("*").eq("tournament_id", coach.tournamentId).eq("group_id", groupId).order("rank");
    const standings = (rows ?? []) as Standing[];
    ownStatus = standings.find((s) => s.team_id === coach.teamId)?.status ?? null;
    group = {
      id: groupId,
      name: n.groups.get(groupId) ?? "",
      rows: standings.filter((s) => n.teams.has(s.team_id)).map((s) => ({ ...toStandingRow(s), team: toRef(n.teams.get(s.team_id)!) })),
    };
  }
  // The placement draws drawn so far (their blocks of places), for where the team lands.
  const { data: draws } = await db().from("ties").select("draw_from, draw_to").eq("tournament_id", coach.tournamentId).eq("stage", "placement").limit(200);
  const blocks = [...new Map(((draws ?? []) as { draw_from: number | null; draw_to: number | null }[]).filter((d) => d.draw_from && d.draw_to).map((d) => [`${d.draw_from}-${d.draw_to}`, { from: d.draw_from!, to: d.draw_to! }])).values()];
  const ownDraw = tieViews.find((x) => x.stage === "placement");
  const placementTie = ownDraw ? ties.find((x) => x.id === ownDraw.id) : undefined;
  const landing = placementTie?.draw_from ? tieStageLabel({ ...placementTie, round_name: null }, null) : landingFrom(ownStatus, blocks);
  let place: number | null = null;
  const decided = ties.find((x) => x.stage === "placement" && x.places_from && x.places_to && x.winner_team_id && x.status === "completed" && x.places_to - x.places_from === 1);
  if (decided) place = decided.winner_team_id === coach.teamId ? decided.places_from : decided.places_to;

  const players = ((squad ?? []) as { id: string; full_name: string }[]).map((p) => ({ id: p.id, name: p.full_name }));
  const schedule: MCoachSlot[] = [];
  for (const tie of tieViews) {
    for (const r of tie.rubbers) {
      for (const p of r.ours) {
        schedule.push({ playerId: p.id, tieId: tie.id, matchId: r.matchId, label: r.label, opponent: tie.opponent?.code ?? null, court: r.court ?? tie.court, scheduledTime: r.scheduledTime ?? tie.scheduledTime, status: r.status });
      }
    }
  }
  const next = tieViews.find((x) => x.status !== "completed" && x.opponent);
  return {
    generatedAt: new Date().toISOString(),
    team: { ...coach.team, players },
    event: { tournamentId: t.id, slug: t.slug, name: t.name, group: groupName, timeZone: t.timezone || "Africa/Cairo" },
    group,
    landing,
    place,
    ties: tieViews,
    nextTieId: next?.id ?? null,
    schedule: schedule.sort((a, b) => byTime(a, b)),
  };
}

/** One of the team's ties; null (404) for any other tie, a missing one or a malformed id. */
export async function coachTie(coach: CoachPrincipal, tieId: string): Promise<MCoachTie | null> {
  if (!isUuid(tieId)) return null;
  const { data } = await db().from("ties").select(TIE_COLUMNS).eq("id", tieId).eq("tournament_id", coach.tournamentId).maybeSingle();
  const tie = data as TieRow | null;
  if (!tie || !coachReaches(coach.teamId, tie)) return null;
  const { data: m } = await db().from("matches").select(RUBBER_COLUMNS).eq("tie_id", tie.id).order("rubber_no");
  const rubbers = ((m ?? []) as RubberRow[]).filter((r) => coachReaches(coach.teamId, r));
  const ids = [...new Set(rubbers.flatMap((r) => [...(r.team_a_player_ids ?? []), ...(r.team_b_player_ids ?? [])]))];
  const [n, snaps] = await Promise.all([names(coach.tournamentId, ids), snapshotsFor(rubbers.map((r) => r.id))]);
  return tieView(tie, coach.teamId, rubbers, n, snaps);
}

/** The team's own line-up for one of its ties (never the opponents'); null (404) otherwise. */
export async function coachLineup(coach: CoachPrincipal, tieId: string): Promise<{ tieId: string; locked: boolean; rubbers: { type: string | null; label: string; players: MCoachPlayer[] }[] } | null> {
  const tie = await coachTie(coach, tieId);
  if (!tie) return null;
  return { tieId: tie.id, locked: tie.lineupLocked, rubbers: tie.rubbers.map((r) => ({ type: r.rubberType, label: r.label, players: r.ours })) };
}

/** One of the team's own rubbers with its log (no referee or staff names); null (404) for any other match. */
export async function coachMatch(coach: CoachPrincipal, matchId: string): Promise<MCoachMatch | null> {
  if (!isUuid(matchId)) return null;
  const { data } = await db().from("matches").select(RUBBER_COLUMNS).eq("id", matchId).eq("tournament_id", coach.tournamentId).maybeSingle();
  const r = data as RubberRow | null;
  if (!r || !coachReaches(coach.teamId, r)) return null;
  const side = coachSideOf(coach.teamId, r)!;
  const ids = [...(r.team_a_player_ids ?? []), ...(r.team_b_player_ids ?? [])];
  const [n, snaps, { loadMatchLog }, tie] = await Promise.all([
    names(coach.tournamentId, ids),
    snapshotsFor([r.id]),
    import("../scoring/matchLogServer"),
    r.tie_id ? db().from("ties").select("lineup_locked_at").eq("id", r.tie_id).eq("tournament_id", coach.tournamentId).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const log = await loadMatchLog(r.id);
  const oppId = side === "A" ? r.team_b_id : r.team_a_id;
  const opp = oppId ? n.teams.get(oppId) : undefined;
  return {
    tieId: r.tie_id,
    team: coach.team,
    opponent: opp ? toRef(opp) : null,
    rubber: rubberView(r, side, coach.teamId, n, snaps.get(r.id) ?? null, Boolean((tie.data as { lineup_locked_at: string | null } | null)?.lineup_locked_at)),
    // Who entered each event (a referee's name) is staff-only: never in a coach's log.
    log: (log?.entries ?? []).filter((e) => !e.superseded).map((e) => ({ n: e.n, at: e.at, title: e.title, detail: e.detail, tag: e.tag, chip: e.chip, set: e.set, undone: e.undone })),
  };
}

/* ---------------- alerts ---------------- */

/** The teams among these that have a working coach code (only they get coach alerts). */
export async function teamsWithCoaches(teamIds: (string | null | undefined)[]): Promise<string[]> {
  const ids = [...new Set(teamIds.filter((x): x is string => isUuid(x)))];
  if (!ids.length) return [];
  const { data, error } = await db().from("coach_codes").select("team_id, expires_at").in("team_id", ids).is("revoked_at", null);
  if (error) return []; // before migration 0037: no coaches
  const now = Date.now();
  return [...new Set(((data ?? []) as { team_id: string; expires_at: string | null }[]).filter((c) => !c.expires_at || Date.parse(c.expires_at) > now).map((c) => c.team_id))];
}

/** The phones signed in with these teams' working codes right now (installation ids). */
export async function coachInstallations(teamIds: string[], now = Date.now()): Promise<string[]> {
  if (!teamIds.length) return [];
  const { data, error } = await db()
    .from("coach_sessions")
    .select("installation_id, code_id, expires_at")
    .in("team_id", teamIds.slice(0, 200))
    .is("ended_at", null)
    .not("installation_id", "is", null);
  if (error) return [];
  const rows = ((data ?? []) as { installation_id: string; code_id: string; expires_at: string }[]).filter((s) => Date.parse(s.expires_at) > now);
  if (!rows.length) return [];
  const { data: codes } = await db().from("coach_codes").select("id, expires_at, revoked_at").in("id", [...new Set(rows.map((r) => r.code_id))]);
  const live = new Set(((codes ?? []) as { id: string; expires_at: string | null; revoked_at: string | null }[]).filter((c) => coachCodeWorks(c, now)).map((c) => c.id));
  return [...new Set(rows.filter((r) => live.has(r.code_id)).map((r) => r.installation_id))];
}

/** The event's time zone (times are shown in it). */
export async function coachTimeZone(tournamentId: string): Promise<string> {
  return (await tournamentLite(tournamentId))?.timezone || "Africa/Cairo";
}

export { COACH_APP_HOURS, formatEventCode };
