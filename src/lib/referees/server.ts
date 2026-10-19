/**
 * Referees (migration 0035), server side: the roster, PIN sign-in behind the brakes,
 * the sign-in rows (referee_sessions) that tokens name, a master referee's reach, and
 * "On court now". Pure rules: rules.ts; hashing: pin.ts. Docs: docs/referees.md.
 */
import { db } from "../supabase";
import { refundRateLimit, takeRateLimit, type RateLimitOptions } from "../ratelimit";
import { isUuid } from "../orgs/roles";
import { courtKey } from "../orgs/courtScope";
import { generateRefereePin, hashRefereePin } from "./pin";
import { ON_COURT_MINUTES, PIN_LOCK, PIN_PER_IP, normalizePin, type RefereeRole } from "./rules";

export interface RefereeRow {
  id: string;
  organization_id: string;
  event_group_id: string | null;
  name: string;
  phone: string | null;
  photo_url: string | null;
  role: RefereeRole;
  pin_set_at: string;
  status: "active" | "removed";
  created_at: string;
}
export const REFEREE_COLS = "id, organization_id, event_group_id, name, phone, photo_url, role, pin_set_at, status, created_at";

/** Who the token says is signed in, once re-checked: what the principal carries. */
export interface RefereeIdentity {
  id: string;
  name: string;
  role: RefereeRole;
  sessionId: string;
  /** The phone recorded on the sign-in (a master referee's alerts go to it). */
  installationId: string | null;
}

/** The code row fields a PIN sign-in needs (organization_codes). */
export interface PinCode {
  id: string;
  organization_id: string;
  role: "referee" | "operator" | "master_referee";
  tournament_id: string | null;
  event_group_id: string | null;
  court_name: string | null;
  referee_id: string | null;
}

/**
 * Every referee code signs in only with a referee PIN (owner's decision): court codes,
 * whole-event referee codes and master referee codes. Operator (TV) codes need none.
 */
export const codeNeedsPin = (c: Pick<PinCode, "court_name" | "role">) => c.role === "referee" || c.role === "master_referee" || Boolean(c.court_name);

/** The event group a code belongs to (its own, or its tournament's). */
async function groupOfCode(c: Pick<PinCode, "event_group_id" | "tournament_id">): Promise<string | null> {
  if (c.event_group_id) return c.event_group_id;
  if (!c.tournament_id) return null;
  const { data } = await db().from("tournaments").select("event_group_id").eq("id", c.tournament_id).maybeSingle();
  return (data as { event_group_id: string | null } | null)?.event_group_id ?? null;
}

const pinBuckets = (codeId: string, ip: string): RateLimitOptions[] => [
  { key: `staff-pin-ip:${ip}`, ...PIN_PER_IP },
  { key: `staff-pin:${codeId}`, ...PIN_LOCK },
];

/**
 * The wrong PIN that fills a code's bucket starts its lock: the window restarts now,
 * so the code stays locked PIN_LOCK_MINUTES from that PIN (not just for what was left
 * of the window). Only ever moves the window later.
 */
async function lockFromNow(codeId: string): Promise<void> {
  const key = `staff-pin:${codeId}`;
  const { data } = await db().from("request_counters").select("count, window_started_at").eq("bucket_key", key).maybeSingle();
  const row = data as { count: number; window_started_at: string } | null;
  if (!row || row.count < PIN_LOCK.limit) return;
  await db().from("request_counters").update({ window_started_at: new Date().toISOString() }).eq("bucket_key", key).eq("window_started_at", row.window_started_at);
}

export type PinCheck =
  | { ok: true; referee: RefereeRow }
  | { ok: false; reason: "wrong_pin" | "pin_locked" | "unavailable"; retryAfterSeconds?: number };

/**
 * Checks a PIN typed with a court or master code. Counted before it is checked
 * (atomically, per address and per code); a right PIN is refunded, so only wrong
 * ones count, and after PIN_LOCK.limit wrong PINs the code is locked for the rest of
 * the window (a right PIN too). A court code takes any active referee of the
 * organisation (a referee limited to an event group, only that group's codes); a
 * master code only its own master referee's PIN.
 */
export async function checkRefereePin(code: PinCode, rawPin: unknown, ip: string): Promise<PinCheck> {
  const taken: RateLimitOptions[] = [];
  const refund = async () => {
    await Promise.all(taken.splice(0).map((b) => refundRateLimit(b)));
  };
  for (const b of pinBuckets(code.id, ip)) {
    const r = await takeRateLimit(b);
    if (r.taken) taken.push(b);
    if (!r.allowed) {
      await refund();
      return { ok: false, reason: "pin_locked", retryAfterSeconds: r.retryAfterSeconds };
    }
  }
  const pin = normalizePin(rawPin);
  if (!pin) return { ok: false, reason: "wrong_pin" };
  let hash: string;
  try {
    hash = hashRefereePin(code.organization_id, pin);
  } catch (err) {
    console.error("referee PINs unavailable:", (err as Error).message);
    await refund();
    return { ok: false, reason: "unavailable" };
  }
  const { data } = await db()
    .from("referees")
    .select(REFEREE_COLS)
    .eq("organization_id", code.organization_id)
    .eq("pin_hash", hash)
    .eq("status", "active")
    .maybeSingle();
  const ref = data as RefereeRow | null;
  let ok = Boolean(ref);
  if (ref && code.role === "master_referee") ok = ref.role === "master_referee" && code.referee_id === ref.id;
  if (ref && ok && ref.event_group_id) ok = (await groupOfCode(code)) === ref.event_group_id;
  if (!ok || !ref) {
    await lockFromNow(code.id);
    return { ok: false, reason: "wrong_pin" };
  }
  await refund();
  return { ok: true, referee: ref };
}

/** A new sign-in row; its id goes in the token (`s`). */
export async function startRefereeSession(
  code: PinCode,
  referee: Pick<RefereeRow, "id" | "role">,
  opts: { via: "web" | "app" | "app_legacy"; expiresAt: string; installationId?: string | null },
): Promise<string | null> {
  const { data, error } = await db()
    .from("referee_sessions")
    .insert({
      organization_id: code.organization_id,
      referee_id: referee.id,
      code_id: code.id,
      role: code.role === "master_referee" ? "master_referee" : "referee",
      court_name: code.court_name,
      event_group_id: code.event_group_id,
      tournament_id: code.tournament_id,
      via: opts.via,
      installation_id: opts.installationId && opts.installationId.length >= 16 && opts.installationId.length <= 80 ? opts.installationId : null,
      expires_at: opts.expiresAt,
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("referee session not recorded:", error?.message);
    return null;
  }
  return (data as { id: string }).id;
}

/** Ends a sign-in (signed out, replaced by a sign-in on another court). */
export async function endRefereeSession(sessionId: string | null | undefined, reason: "signed_out" | "replaced" | "pin_reset" | "removed"): Promise<void> {
  if (!isUuid(sessionId)) return;
  await db().from("referee_sessions").update({ ended_at: new Date().toISOString(), end_reason: reason }).eq("id", sessionId).is("ended_at", null);
}

const SEEN_EVERY_MS = 60_000;

/**
 * The referee a court or master token names, re-checked: the person is active in the
 * token's organisation, their PIN was not reset after the token was signed, the
 * sign-in row is theirs and not ended. Null otherwise. Touches last_seen_at at most
 * once a minute (one filtered update), for "On court now".
 */
export async function refereeForToken(p: { o: string; p?: string; s?: string; iat: number; c: string }, code: Pick<PinCode, "role" | "referee_id">, nowMs = Date.now()): Promise<RefereeIdentity | null> {
  if (!isUuid(p.p) || !isUuid(p.s)) return null;
  const [{ data: r }, { data: s }] = await Promise.all([
    db().from("referees").select("id, organization_id, name, role, status, pin_set_at").eq("id", p.p).maybeSingle(),
    db().from("referee_sessions").select("id, referee_id, organization_id, code_id, ended_at, last_seen_at, installation_id").eq("id", p.s).maybeSingle(),
  ]);
  const ref = r as { id: string; organization_id: string; name: string; role: RefereeRole; status: string; pin_set_at: string } | null;
  const ses = s as { id: string; referee_id: string; organization_id: string; code_id: string | null; ended_at: string | null; last_seen_at: string; installation_id: string | null } | null;
  if (!ref || ref.status !== "active" || ref.organization_id !== p.o) return null;
  // A PIN reset signs the person out everywhere (1 s of slack for clock rounding).
  if (Date.parse(ref.pin_set_at) > p.iat + 1000) return null;
  if (code.role === "master_referee" && (code.referee_id !== ref.id || ref.role !== "master_referee")) return null;
  if (!ses || ses.referee_id !== ref.id || ses.organization_id !== p.o || ses.ended_at || ses.code_id !== p.c) return null;
  if (nowMs - Date.parse(ses.last_seen_at) > SEEN_EVERY_MS) {
    await db()
      .from("referee_sessions")
      .update({ last_seen_at: new Date(nowMs).toISOString() })
      .eq("id", ses.id)
      .lt("last_seen_at", new Date(nowMs - SEEN_EVERY_MS).toISOString());
  }
  // The role the person acts in on this code: a master referee on a court code is that court's referee.
  return { id: ref.id, name: ref.name, role: code.role === "master_referee" ? "master_referee" : "referee", sessionId: ses.id, installationId: ses.installation_id };
}

/** Records the phone of a sign-in (a master referee's alerts go to it). */
export async function noteSessionDevice(who: Pick<RefereeIdentity, "sessionId" | "installationId">, installationId: string | null): Promise<void> {
  if (!installationId || installationId === who.installationId || installationId.length < 16 || installationId.length > 80) return;
  await db().from("referee_sessions").update({ installation_id: installationId }).eq("id", who.sessionId).is("ended_at", null);
}

/**
 * The tournaments a master referee code reaches: its event group's (kind
 * "tournament"), its one tournament, or, with neither, the organisation's open
 * events (draft or active). Read on every request, so a new event of the group counts at once.
 */
export async function masterTournamentIds(code: Pick<PinCode, "organization_id" | "event_group_id" | "tournament_id">): Promise<string[]> {
  let q = db().from("tournaments").select("id").eq("organization_id", code.organization_id).eq("kind", "tournament");
  if (code.event_group_id) q = q.eq("event_group_id", code.event_group_id);
  else if (code.tournament_id) q = q.eq("id", code.tournament_id);
  else q = q.in("status", ["draft", "active"]);
  const { data } = await q.limit(80);
  return ((data ?? []) as { id: string }[]).map((t) => t.id);
}

/* ---------------- the roster ---------------- */

export type RosterResult = { ok: true; referee: RefereeRow; pin: string } | { ok: false; message: string };

async function takenPins(orgId: string): Promise<Set<string>> {
  const { data } = await db().from("referees").select("pin_hash").eq("organization_id", orgId).eq("status", "active").limit(5000);
  return new Set(((data ?? []) as { pin_hash: string }[]).map((r) => r.pin_hash));
}

/** Writes a fresh PIN for a new or existing referee, retrying when another write took it first. */
async function withFreshPin<T>(orgId: string, write: (pinHash: string) => Promise<{ data: T | null; error: { code?: string; message: string } | null }>): Promise<{ ok: true; row: T; pin: string } | { ok: false; message: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    let pin: string | null;
    let hash: string;
    try {
      pin = generateRefereePin(orgId, await takenPins(orgId));
      if (!pin) return { ok: false, message: "No free PIN left for this organisation. Remove referees who no longer work." };
      hash = hashRefereePin(orgId, pin);
    } catch (err) {
      console.error("referee PINs unavailable:", (err as Error).message);
      return { ok: false, message: "Referee PINs are not set up on this server yet (EVENT_CODE_PEPPER). Contact Move Beyond." };
    }
    const { data, error } = await write(hash);
    if (data && !error) return { ok: true, row: data, pin };
    if (error && error.code !== "23505" && !/duplicate|unique/i.test(error.message)) return { ok: false, message: "Could not save the referee. Try again." };
  }
  return { ok: false, message: "Could not find a free PIN. Try again." };
}

export async function createReferee(
  orgId: string,
  input: { name: string; phone: string | null; photoUrl: string | null; role: RefereeRole; eventGroupId: string | null },
  by: { userId: string | null; orgRole: string },
): Promise<RosterResult> {
  const r = await withFreshPin<RefereeRow>(orgId, async (pin_hash) => {
    const { data, error } = await db()
      .from("referees")
      .insert({
        organization_id: orgId,
        event_group_id: input.eventGroupId,
        name: input.name,
        phone: input.phone,
        photo_url: input.photoUrl,
        role: input.role,
        pin_hash,
        created_by: by.userId,
        created_by_role: by.orgRole,
      })
      .select(REFEREE_COLS)
      .single();
    return { data: data as RefereeRow | null, error };
  });
  return r.ok ? { ok: true, referee: r.row, pin: r.pin } : r;
}

/** A new PIN (shown once); every sign-in of the person ends at once. */
export async function resetRefereePin(orgId: string, refereeId: string): Promise<RosterResult> {
  const r = await withFreshPin<RefereeRow>(orgId, async (pin_hash) => {
    const { data, error } = await db()
      .from("referees")
      .update({ pin_hash, pin_set_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", refereeId)
      .eq("organization_id", orgId)
      .eq("status", "active")
      .select(REFEREE_COLS)
      .maybeSingle();
    if (!data && !error) return { data: null, error: { message: "not found" } };
    return { data: data as RefereeRow | null, error };
  });
  if (!r.ok) return r.message === "Could not save the referee. Try again." ? { ok: false, message: "Not found" } : r;
  await db().from("referee_sessions").update({ ended_at: new Date().toISOString(), end_reason: "pin_reset" }).eq("referee_id", refereeId).is("ended_at", null);
  return { ok: true, referee: r.row, pin: r.pin };
}

/** Removes a referee: their PIN stops working and every sign-in ends; their master codes are revoked. */
export async function removeReferee(orgId: string, refereeId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const { data } = await db()
    .from("referees")
    .update({ status: "removed", updated_at: now })
    .eq("id", refereeId)
    .eq("organization_id", orgId)
    .eq("status", "active")
    .select("id")
    .maybeSingle();
  if (!data) return false;
  await db().from("referee_sessions").update({ ended_at: now, end_reason: "removed" }).eq("referee_id", refereeId).is("ended_at", null);
  await db().from("organization_codes").update({ revoked_at: now }).eq("referee_id", refereeId).eq("organization_id", orgId).is("revoked_at", null);
  return true;
}

export async function rosterOf(orgId: string): Promise<RefereeRow[]> {
  const { data } = await db().from("referees").select(REFEREE_COLS).eq("organization_id", orgId).order("status").order("name").limit(500);
  return (data ?? []) as RefereeRow[];
}

/* ---------------- On court now, and the history ---------------- */

export interface SessionRow {
  id: string;
  referee_id: string;
  code_id: string | null;
  role: RefereeRole;
  court_name: string | null;
  event_group_id: string | null;
  tournament_id: string | null;
  via: string;
  signed_in_at: string;
  last_seen_at: string;
  expires_at: string;
  ended_at: string | null;
  end_reason: string | null;
}
const SESSION_COLS = "id, referee_id, code_id, role, court_name, event_group_id, tournament_id, via, signed_in_at, last_seen_at, expires_at, ended_at, end_reason";

export interface OnCourt {
  court: string;
  key: string;
  referees: { id: string; name: string; photo_url: string | null; since: string; lastSeen: string; via: string }[];
}

/** Whether a sign-in still counts as on court (or on duty) now. */
export function sessionIsCurrent(s: Pick<SessionRow, "ended_at" | "expires_at" | "last_seen_at">, nowMs = Date.now()): boolean {
  return !s.ended_at && Date.parse(s.expires_at) > nowMs && nowMs - Date.parse(s.last_seen_at) <= ON_COURT_MINUTES * 60_000;
}

/** Who is signed in on which court right now, by court; and the master referees on duty. */
export async function onCourtNow(orgId: string, nowMs = Date.now()): Promise<{ courts: OnCourt[]; masters: OnCourt["referees"] }> {
  const since = new Date(nowMs - ON_COURT_MINUTES * 60_000).toISOString();
  const [{ data: rows }, roster] = await Promise.all([
    db().from("referee_sessions").select(SESSION_COLS).eq("organization_id", orgId).is("ended_at", null).gte("last_seen_at", since).order("signed_in_at", { ascending: false }).limit(300),
    rosterOf(orgId),
  ]);
  const byId = new Map(roster.map((r) => [r.id, r]));
  const courts = new Map<string, OnCourt>();
  const masters: OnCourt["referees"] = [];
  const seenMaster = new Set<string>();
  for (const s of ((rows ?? []) as SessionRow[]).filter((x) => sessionIsCurrent(x, nowMs))) {
    const r = byId.get(s.referee_id);
    if (!r || r.status !== "active") continue;
    const who = { id: r.id, name: r.name, photo_url: r.photo_url, since: s.signed_in_at, lastSeen: s.last_seen_at, via: s.via };
    if (!s.court_name) {
      if (s.role === "master_referee" && !seenMaster.has(r.id)) {
        seenMaster.add(r.id);
        masters.push(who);
      }
      continue;
    }
    const key = courtKey(s.court_name);
    const c = courts.get(key) ?? { court: s.court_name, key, referees: [] };
    if (!c.referees.some((x) => x.id === r.id)) c.referees.push(who);
    courts.set(key, c);
  }
  return { courts: [...courts.values()].sort((a, b) => a.court.localeCompare(b.court, "en", { numeric: true })), masters };
}

/** Recent sign-ins, newest first, with the referee's name. */
export async function signInHistory(orgId: string, limit = 100): Promise<(SessionRow & { name: string })[]> {
  const [{ data }, roster] = await Promise.all([
    db().from("referee_sessions").select(SESSION_COLS).eq("organization_id", orgId).order("signed_in_at", { ascending: false }).limit(limit),
    rosterOf(orgId),
  ]);
  const name = new Map(roster.map((r) => [r.id, r.name]));
  return ((data ?? []) as SessionRow[]).map((s) => ({ ...s, name: name.get(s.referee_id) ?? "Removed referee" }));
}

/** The master referees on duty now (signed in with their code, seen recently): their phones' installation ids. */
export async function mastersOnDuty(orgId: string, scope: { eventGroupId: string | null; tournamentId: string | null }, nowMs = Date.now()): Promise<{ refereeIds: string[]; installationIds: string[] }> {
  const since = new Date(nowMs - 12 * 3600_000).toISOString();
  const { data } = await db()
    .from("referee_sessions")
    .select("referee_id, installation_id, event_group_id, tournament_id, ended_at, expires_at, last_seen_at, code_id")
    .eq("organization_id", orgId)
    .eq("role", "master_referee")
    .is("ended_at", null)
    .gte("last_seen_at", since)
    .limit(200);
  const rows = ((data ?? []) as { referee_id: string; installation_id: string | null; event_group_id: string | null; tournament_id: string | null; expires_at: string; code_id: string | null }[]).filter(
    (s) => Date.parse(s.expires_at) > nowMs,
  );
  // A master code limited to another event group (or event) does not cover this court.
  const covers = (s: { event_group_id: string | null; tournament_id: string | null }) =>
    (!s.event_group_id && !s.tournament_id) ||
    (s.event_group_id !== null && s.event_group_id === scope.eventGroupId) ||
    (s.tournament_id !== null && s.tournament_id === scope.tournamentId);
  const live = rows.filter(covers);
  // Revoked master codes never alert.
  const codeIds = [...new Set(live.map((s) => s.code_id).filter((x): x is string => Boolean(x)))];
  const { data: codes } = codeIds.length
    ? await db().from("organization_codes").select("id, revoked_at, expires_at").eq("organization_id", orgId).in("id", codeIds)
    : { data: [] };
  const working = new Set(((codes ?? []) as { id: string; revoked_at: string | null; expires_at: string | null }[]).filter((c) => !c.revoked_at && !(c.expires_at && Date.parse(c.expires_at) <= nowMs)).map((c) => c.id));
  const ok = live.filter((s) => s.code_id && working.has(s.code_id));
  return { refereeIds: [...new Set(ok.map((s) => s.referee_id))], installationIds: [...new Set(ok.map((s) => s.installation_id).filter((x): x is string => Boolean(x)))] };
}
