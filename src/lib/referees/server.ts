/**
 * Referees (migration 0035), server side: the roster, PIN sign-in behind the brakes,
 * the sign-in rows (referee_sessions) that tokens name, a master referee's reach, and
 * "On court now". Pure rules: rules.ts; hashing: pin.ts. Docs: docs/referees.md.
 */
import { db } from "../supabase";
import { refundRateLimit, takeRateLimit, type RateLimitOptions } from "../ratelimit";
import { isUuid } from "../orgs/roles";
import { courtKey } from "../orgs/courtScope";
import { generateRefereePin, hashRefereeDevice, hashRefereePin } from "./pin";
import { safeEqual } from "../auth/safeEqual";
import { ON_COURT_MINUTES, PIN_LEGACY_ORG_TIERS, PIN_ORG_TIERS, PIN_PER_IP, PIN_PER_PHONE, normalizePin, type RefereeChoice, type RefereeRole } from "./rules";

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
  /** When the sign-in row lapses (referee_sessions.expires_at, ms): a carry-over never outlives it. */
  sessionExpiresAt?: number;
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

/** A referee as the PIN step lists them, with what the server alone needs to check the PIN. */
interface EligibleReferee extends Pick<RefereeRow, "id" | "name" | "photo_url" | "role" | "event_group_id"> {
  pin_hash: string;
}

/**
 * The referees who may sign in with a code (audit H1): the organisation's active
 * referees open to the code's event group (a referee limited to a group only that
 * group's codes); on a master code only that code's own master referee. A master
 * referee may pick themselves on a court code (they are then that court's referee).
 */
async function eligibleFor(code: PinCode): Promise<EligibleReferee[]> {
  if (code.role === "master_referee") {
    if (!isUuid(code.referee_id)) return [];
    const { data } = await db()
      .from("referees")
      .select("id, name, photo_url, role, event_group_id, pin_hash")
      .eq("id", code.referee_id)
      .eq("organization_id", code.organization_id)
      .eq("status", "active")
      .eq("role", "master_referee")
      .maybeSingle();
    return data ? [data as EligibleReferee] : [];
  }
  const group = await groupOfCode(code);
  const { data } = await db()
    .from("referees")
    .select("id, name, photo_url, role, event_group_id, pin_hash")
    .eq("organization_id", code.organization_id)
    .eq("status", "active")
    .order("name")
    .limit(500);
  return ((data ?? []) as EligibleReferee[]).filter((r) => !r.event_group_id || r.event_group_id === group);
}

/** The names (and photos) the PIN step shows for a code: never a phone, a PIN hash or anything else. */
export async function refereeChoices(code: PinCode): Promise<RefereeChoice[]> {
  return (await eligibleFor(code)).map((r) => ({ id: r.id, name: r.name, photoUrl: r.photo_url && /^https:\/\//.test(r.photo_url) ? r.photo_url : null }));
}

const orgBuckets = (orgId: string): RateLimitOptions[] => PIN_ORG_TIERS.map((t, i) => ({ key: `staff-pin-org${i + 1}:${orgId}`, ...t }));
const legacyBuckets = (orgId: string): RateLimitOptions[] => PIN_LEGACY_ORG_TIERS.map((t, i) => ({ key: `staff-pin-legacy${i + 1}:${orgId}`, ...t }));
/** One phone's wrong PINs: its install token / browser id, or its address when it has neither. */
const phoneBucket = (deviceHash: string | null, ip: string): RateLimitOptions => ({
  key: deviceHash ? `staff-pin-phone:${deviceHash.slice(0, 32)}` : `staff-pin-phone-ip:${ip}`,
  ...PIN_PER_PHONE,
});
const ipBucket = (ip: string): RateLimitOptions => ({ key: `staff-pin-ip:${ip}`, ...PIN_PER_IP });

/**
 * The wrong PIN that fills a phone's bucket starts its block: the window restarts now, so
 * it stays blocked PIN_LOCK_MINUTES from that PIN (not just for what was left of the
 * window). Only ever moves the window later.
 */
async function lockFromNow(key: string, limit: number): Promise<void> {
  const { data } = await db().from("request_counters").select("count, window_started_at").eq("bucket_key", key).maybeSingle();
  const row = data as { count: number; window_started_at: string } | null;
  if (!row || row.count < limit) return;
  await db().from("request_counters").update({ window_started_at: new Date().toISOString() }).eq("bucket_key", key).eq("window_started_at", row.window_started_at);
}

/**
 * Tells the organisation that its referees' PINs are being guessed (an org tier just
 * filled): an audit row (Admin → Referees shows the latest as a banner) and an email to
 * its active owners and admins (MESSAGING_DRY_RUN=1 sends nothing). Once per tier
 * window. Never blocks the sign-in answer for long, never throws.
 */
async function alertOrgPinBrake(orgId: string, bucket: RateLimitOptions, nowMs: number): Promise<void> {
  try {
    const t = bucket;
    const tier = bucket.key.slice(0, bucket.key.indexOf(":"));
    const until = new Date(nowMs + t.windowSeconds * 1000).toISOString();
    await db().from("audit_logs").insert({
      organization_id: orgId,
      actor_role: "system",
      action: PIN_BRAKE_AUDIT,
      entity_type: "organization",
      entity_id: orgId,
      new_value: { tier, wrong_pins: t.limit, window_minutes: Math.round(t.windowSeconds / 60), paused_until: until },
    });
    const { data } = await db().from("organization_members").select("id, invited_email").eq("organization_id", orgId).eq("status", "active").in("role", ["owner", "admin"]).limit(20);
    const { sendTransactional } = await import("../messaging/queue");
    const { siteUrl } = await import("../messaging/links");
    const minutes = Math.round(t.windowSeconds / 60);
    const seen = new Set<string>();
    for (const m of (data ?? []) as { id: string; invited_email: string | null }[]) {
      const to = m.invited_email?.trim().toLowerCase();
      if (!to || seen.has(to)) continue;
      seen.add(to);
      await sendTransactional({
        to,
        channel: "email",
        template: "staff_alert",
        vars: {
          title: "Referee PINs: too many wrong attempts",
          message: `${t.limit} wrong referee PINs were typed for your organisation within ${minutes >= 60 ? `${Math.round(minutes / 60)} h` : `${minutes} minutes`}. Nobody is locked out: each phone that types 5 wrong PINs is blocked for 5 minutes on its own. If this was not your referees, give the referees new PINs (Admin → Referees).`,
          cta_label: "Open Referees",
          link: `${siteUrl()}/admin/org/referees`,
        },
        idempotencyKey: `pin-brake:${orgId}:${tier}:${Math.floor(nowMs / (t.windowSeconds * 1000))}:${m.id}`,
        recipient: { kind: "adhoc", name: null },
      });
    }
  } catch (err) {
    console.error("[referees] PIN brake alert not sent:", err instanceof Error ? err.message : err);
  }
}

/** The audit action of a PIN brake alert (the admin banner reads the latest). */
export const PIN_BRAKE_AUDIT = "REFEREE_PIN_BRAKE";

export type PinCheck =
  | { ok: true; referee: RefereeRow; deviceHash: string | null }
  | {
      ok: false;
      reason: "wrong_pin" | "pin_locked" | "pin_paused" | "pin_busy" | "unknown_referee" | "unavailable";
      retryAfterSeconds?: number;
      /** The picked referee's name (wrong_pin, pin_locked). */
      refereeName?: string;
      /** Wrong PINs left before the picked referee is locked. */
      triesLeft?: number;
    };

export interface PinAttempt {
  /** The referee picked on the PIN step; absent for Move Score 1.0.1's one field (and older new-app builds). */
  refereeId?: string | null;
  ip: string;
  /** "app:<installation id>" or "web:<browser id>": the device's own, unguessable id. */
  deviceKey?: string | null;
}

/**
 * Checks a PIN typed with a referee code. The PIN says who it is: it is matched (constant
 * time) across the code's referees (PINs are unique per organisation); a referee picked by
 * an older app is still honoured (then only their PIN is compared). Every attempt is
 * counted before it is checked (atomically, takeRateLimit) for this phone and for the
 * address ceiling, and a right PIN is refunded, so only wrong ones count: 5 wrong PINs
 * block this phone for 5 minutes, never a referee. The organisation tiers only count and
 * alert. PINs are never logged.
 */
export async function checkRefereePin(code: PinCode, rawPin: unknown, attempt: PinAttempt, nowMs = Date.now()): Promise<PinCheck> {
  const eligible = await eligibleFor(code);
  const named = attempt.refereeId !== undefined && attempt.refereeId !== null;
  const picked = named ? (eligible.find((r) => r.id === attempt.refereeId) ?? null) : null;
  if (named && !picked) return { ok: false, reason: "unknown_referee" };

  let deviceHash: string | null = null;
  let hash: string | null = null;
  const pin = normalizePin(rawPin);
  try {
    if (attempt.deviceKey) deviceHash = hashRefereeDevice(attempt.deviceKey);
    if (pin) hash = hashRefereePin(code.organization_id, pin);
  } catch (err) {
    console.error("referee PINs unavailable:", (err as Error).message);
    return { ok: false, reason: "unavailable" };
  }

  // Strict buckets refuse the attempt when full: this phone, then the address ceiling.
  const phone = phoneBucket(deviceHash, attempt.ip);
  const strict: { b: RateLimitOptions; reason: "pin_locked" | "pin_busy" }[] = [
    { b: phone, reason: "pin_locked" },
    { b: ipBucket(attempt.ip), reason: "pin_busy" },
  ];
  // Soft buckets only count (and alert when full): the organisation never locks anyone out.
  const soft = [...orgBuckets(code.organization_id), ...(picked ? [] : legacyBuckets(code.organization_id))];
  const taken: RateLimitOptions[] = [];
  const filled: string[] = [];
  const refund = async () => {
    await Promise.all(taken.splice(0).map((b) => refundRateLimit(b)));
  };
  for (const { b, reason } of strict) {
    const r = await takeRateLimit(b);
    if (r.taken) taken.push(b);
    if (!r.allowed) {
      await refund();
      return { ok: false, reason, retryAfterSeconds: r.retryAfterSeconds };
    }
  }
  for (const b of soft) {
    const r = await takeRateLimit(b);
    if (r.taken) taken.push(b);
    if (r.taken && r.remaining === 0) filled.push(b.key);
  }

  let match: EligibleReferee | null = null;
  if (hash) {
    if (picked) match = safeEqual(picked.pin_hash, hash) ? picked : null;
    else for (const r of eligible) if (safeEqual(r.pin_hash, hash)) match = r;
  }
  if (!match) {
    await lockFromNow(phone.key, PIN_PER_PHONE.limit);
    const orgWide = [...orgBuckets(code.organization_id), ...legacyBuckets(code.organization_id)];
    for (const key of filled) {
      const b = orgWide.find((x) => x.key === key);
      if (b) await alertOrgPinBrake(code.organization_id, b, nowMs);
    }
    const { data } = await db().from("request_counters").select("count").eq("bucket_key", phone.key).maybeSingle();
    const triesLeft = Math.max(0, PIN_PER_PHONE.limit - ((data as { count: number } | null)?.count ?? 0));
    return { ok: false, reason: "wrong_pin", triesLeft };
  }
  await refund();
  const { data: full } = await db().from("referees").select(REFEREE_COLS).eq("id", match.id).eq("status", "active").maybeSingle();
  if (!full) return { ok: false, reason: "wrong_pin" };
  return { ok: true, referee: full as RefereeRow, deviceHash };
}

/** A new sign-in row; its id goes in the token (`s`). */
export async function startRefereeSession(
  code: PinCode,
  referee: Pick<RefereeRow, "id" | "role">,
  opts: { via: "web" | "app" | "app_legacy"; expiresAt: string; installationId?: string | null; deviceHash?: string | null },
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
      ...(opts.deviceHash ? { device_hash: opts.deviceHash } : {}),
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
    db().from("referee_sessions").select("id, referee_id, organization_id, code_id, ended_at, expires_at, last_seen_at, installation_id").eq("id", p.s).maybeSingle(),
  ]);
  const ref = r as { id: string; organization_id: string; name: string; role: RefereeRole; status: string; pin_set_at: string } | null;
  const ses = s as { id: string; referee_id: string; organization_id: string; code_id: string | null; ended_at: string | null; expires_at: string; last_seen_at: string; installation_id: string | null } | null;
  if (!ref || ref.status !== "active" || ref.organization_id !== p.o) return null;
  // A PIN reset signs the person out everywhere (1 s of slack for clock rounding).
  if (Date.parse(ref.pin_set_at) > p.iat + 1000) return null;
  if (code.role === "master_referee" && (code.referee_id !== ref.id || ref.role !== "master_referee")) return null;
  if (!ses || ses.referee_id !== ref.id || ses.organization_id !== p.o || ses.ended_at || ses.code_id !== p.c) return null;
  // A sign-in row past its own expiry is over, whatever token still names it (audit L2).
  const sesExp = Date.parse(ses.expires_at);
  if (!Number.isFinite(sesExp) || sesExp <= nowMs) return null;
  if (nowMs - Date.parse(ses.last_seen_at) > SEEN_EVERY_MS) {
    await db()
      .from("referee_sessions")
      .update({ last_seen_at: new Date(nowMs).toISOString() })
      .eq("id", ses.id)
      .lt("last_seen_at", new Date(nowMs - SEEN_EVERY_MS).toISOString());
  }
  // The role the person acts in on this code: a master referee on a court code is that court's referee.
  return { id: ref.id, name: ref.name, role: code.role === "master_referee" ? "master_referee" : "referee", sessionId: ses.id, installationId: ses.installation_id, sessionExpiresAt: sesExp };
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
export async function mastersOnDuty(
  orgId: string,
  scope: { eventGroupId: string | null; tournamentId: string | null },
  nowMs = Date.now(),
): Promise<{ refereeIds: string[]; installationIds: string[]; byReferee: Record<string, string[]> }> {
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
  // A call from a court code made for one tournament carries no event group: its tournament's
  // group still decides (22 Oct 2026: such a call alerted no master signed in for the group).
  if (!scope.eventGroupId && scope.tournamentId) {
    const { data: t } = await db().from("tournaments").select("event_group_id").eq("id", scope.tournamentId).maybeSingle();
    const group = (t as { event_group_id: string | null } | null)?.event_group_id ?? null;
    if (group) scope = { ...scope, eventGroupId: group };
  }
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
  // Each master's own phones (reminders skip a master who declined; "X is going" skips X).
  const byReferee: Record<string, string[]> = {};
  for (const s of ok) {
    const list = (byReferee[s.referee_id] ??= []);
    if (s.installation_id && !list.includes(s.installation_id)) list.push(s.installation_id);
  }
  return { refereeIds: [...new Set(ok.map((s) => s.referee_id))], installationIds: [...new Set(ok.map((s) => s.installation_id).filter((x): x is string => Boolean(x)))], byReferee };
}
