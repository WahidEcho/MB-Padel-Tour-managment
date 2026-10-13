/**
 * Registration and payment (plan Phase 9), server side. Rules: ./rules.ts.
 * Move Tick: ./moveTick.ts, contract docs/move-tick-partner-api.md.
 *
 *   announce → register (app, signed in; or the web form as a guest)
 *            → organiser approves (default) → pay (Move Tick, or at the venue)
 *            → confirmed: the entry is made in the event (a team and its players,
 *              or friendly-session entries) and, for an app account, the
 *              registrant's own player row is linked to it (src/lib/players/link.ts,
 *              proof "registration"; a partner's row is never linked to anyone)
 *            → refund (organiser only, audited, until 24 h before the start)
 *            → archive (player_claims.archived_at, 24 h after the event ended).
 *
 * Everything money-shaped is decided here from the database: the amount comes
 * from the registration row the server wrote from the settings; nothing a client
 * sends is trusted. Every status change is a conditional update from the status
 * it was read in, so a replayed webhook or a double click changes nothing twice.
 *
 * Server-only.
 */
import { createHmac } from "node:crypto";
import { db } from "../supabase";
import { audit } from "../audit";
import { safeEqual } from "../auth/safeEqual";
import { siteUrl } from "../messaging/links";
import { MOVE_BEYOND_SLUG } from "../orgs/roles";
import { ensureOrgPlayer } from "../orgs/scope";
import { normalizeMobile } from "../friendly/mobile";
import { toE164 } from "../players/phone";
import { sportOf } from "../sports/registry";
import { PLAYER_COLUMNS, claimedRows, type PlayerRow } from "../players/claims";
import { accountProfile, ensureAccountProfile, linkAccount } from "../players/link";
import type { MPaymentChoice, MRegistration, MRegistrationEvent, MRegistrationInfo } from "../mobile/contract";
import {
  CLOSED_MESSAGES,
  LIVE_STATUSES,
  REFUND_MESSAGES,
  STATUS_LABELS,
  archiveAt,
  canMove,
  charges,
  initialStatus,
  moneyLabel,
  paymentOptions,
  peoplePerEntry,
  refundAllowed,
  refundAmount,
  refundCutoff,
  registrationClosedReason,
  registrationSettings,
  statusAfterApproval,
  storedRegistrationSettings,
  type PaymentChoice,
  type RegistrationSettings,
  type RegistrationStatus,
} from "./rules";
import { MoveTickError, createPaymentSession, getPaymentSession, moveTickConfig, refundPaymentSession, type WebhookEvent } from "./moveTick";

/* ---------------- rows ---------------- */

const EVENT_COLUMNS = "id, slug, name, kind, sport, status, organization_id, starts_at, starts_on, ends_on, timezone, format_config, public_access_enabled, updated_at";

export interface EventRow {
  id: string;
  slug: string;
  name: string;
  kind: string;
  sport: string | null;
  status: string | null;
  organization_id: string;
  starts_at: string | null;
  starts_on: string | null;
  ends_on: string | null;
  timezone: string | null;
  format_config: Record<string, unknown> | null;
  public_access_enabled: boolean | null;
  updated_at: string | null;
}

interface SessionRow {
  id: string;
  slug: string;
  status: string;
  starts_at: string | null;
  finalized_at: string | null;
}

export interface Person {
  name: string;
  phone: string | null;
  email: string | null;
}

export interface RegistrationRow {
  id: string;
  tournament_id: string;
  organization_id: string;
  auth_user_id: string | null;
  source: "app" | "web" | "admin";
  entry_type: "individual" | "team";
  team_name: string | null;
  people: Person[];
  status: RegistrationStatus;
  payment_choice: PaymentChoice;
  amount_online: number;
  amount_venue: number;
  currency: "EGP";
  paid_at: string | null;
  venue_paid_at: string | null;
  venue_paid_by: string | null;
  refund_requested_at: string | null;
  refunded_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
  team_id: string | null;
  player_id: string | null;
  entry_ids: string[];
  materialized_at: string | null;
  created_at: string;
  updated_at: string;
}

const REG_COLUMNS =
  "id, tournament_id, organization_id, auth_user_id, source, entry_type, team_name, people, status, payment_choice, amount_online, amount_venue, currency, paid_at, venue_paid_at, venue_paid_by, refund_requested_at, refunded_at, decided_at, decided_by, decision_note, team_id, player_id, entry_ids, materialized_at, created_at, updated_at";

export interface PaymentRow {
  id: string;
  registration_id: string;
  organization_id: string;
  method: "online" | "venue";
  amount: number;
  currency: string;
  status: "created" | "open" | "paid" | "failed" | "expired" | "refund_pending" | "refunded" | "needs_review";
  session_id: string | null;
  checkout_url: string | null;
  expires_at: string | null;
  test_mode: boolean;
  paid_at: string | null;
  refund_amount: number | null;
  refunded_at: string | null;
  review_reason: string | null;
  created_at: string;
}

const PAY_COLUMNS = "id, registration_id, organization_id, method, amount, currency, status, session_id, checkout_url, expires_at, test_mode, paid_at, refund_amount, refunded_at, review_reason, created_at";

const now = () => new Date().toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Outcome<T> = { ok: true; value: T } | { ok: false; status: number; code: string; error: string };
const fail = (status: number, code: string, error: string): { ok: false; status: number; code: string; error: string } => ({ ok: false, status, code, error });
const NOT_FOUND = fail(404, "not_found", "Not found");

/* ---------------- events ---------------- */

export async function eventById(id: string): Promise<EventRow | null> {
  if (!UUID.test(id)) return null;
  const { data } = await db().from("tournaments").select(EVENT_COLUMNS).eq("id", id).maybeSingle();
  return (data as EventRow | null) ?? null;
}

async function sessionOf(event: EventRow): Promise<SessionRow | null> {
  if (event.kind !== "friendly_session") return null;
  const { data } = await db().from("friendly_sessions").select("id, slug, status, starts_at, finalized_at").eq("tournament_id", event.id).maybeSingle();
  return (data as SessionRow | null) ?? null;
}

/** Why an event can never take registrations through Move Score (a nation-based team competition), or null. */
export function eventRefusal(event: Pick<EventRow, "kind" | "format_config">): string | null {
  if (event.kind !== "tournament" && event.kind !== "friendly_session") return "This event does not take registrations.";
  if (event.format_config && (event.format_config as { ties?: unknown }).ties) return "Nations are entered by the organiser: team competitions do not take registrations.";
  return null;
}

/** The event's start time: the tournament's first match, or the session's start. */
export function startsAtOf(event: Pick<EventRow, "starts_at">, session: Pick<SessionRow, "starts_at"> | null): string | null {
  return event.starts_at ?? session?.starts_at ?? null;
}

async function orgOf(orgId: string): Promise<{ id: string; slug: string; name: string; status: string } | null> {
  const { data } = await db().from("organizations").select("id, slug, name, status").eq("id", orgId).maybeSingle();
  return (data as { id: string; slug: string; name: string; status: string } | null) ?? null;
}

/**
 * Online payment through Move Tick: the Move Beyond organisation only (no payouts
 * to other organisations yet), and only while Move Tick is configured.
 */
export function onlinePaymentAvailable(orgSlug: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  return orgSlug === MOVE_BEYOND_SLUG && moveTickConfig(env) !== null;
}

/** A public event by its slug, of an approved organisation. Null for unknown, private or refused events alike. */
export async function publicEventBySlug(slug: string): Promise<{ event: EventRow; org: { id: string; slug: string; name: string }; session: SessionRow | null } | null> {
  if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,118}[a-z0-9]$/.test(slug)) return null;
  const { data } = await db().from("tournaments").select(EVENT_COLUMNS).eq("slug", slug).maybeSingle();
  const event = data as EventRow | null;
  if (!event || event.public_access_enabled === false || eventRefusal(event)) return null;
  const org = await orgOf(event.organization_id);
  if (!org || org.status !== "approved") return null;
  return { event, org: { id: org.id, slug: org.slug, name: org.name }, session: await sessionOf(event) };
}

/* ---------------- settings ---------------- */

export async function getSettings(tournamentId: string): Promise<RegistrationSettings> {
  const { data } = await db().from("registration_settings").select("*").eq("tournament_id", tournamentId).maybeSingle();
  return registrationSettings(data);
}

export async function saveSettings(event: EventRow, settings: RegistrationSettings, actor: { role: string; label: string | null }): Promise<RegistrationSettings> {
  const refusal = eventRefusal(event);
  if (refusal) throw new Error(refusal);
  const before = await getSettings(event.id);
  const row = { tournament_id: event.id, organization_id: event.organization_id, ...storedRegistrationSettings(settings), updated_by: actor.label, updated_at: now() };
  const { error } = await db().from("registration_settings").upsert(row, { onConflict: "tournament_id" });
  if (error) throw new Error(error.message);
  await audit({ tournament_id: event.id, actor_role: actor.role, action: "REGISTRATION_SETTINGS_SAVED", entity_type: "tournament", entity_id: event.id, old_value: before, new_value: settings });
  return settings;
}

async function liveCount(tournamentId: string): Promise<number> {
  const { count } = await db().from("registrations").select("id", { count: "exact", head: true }).eq("tournament_id", tournamentId).in("status", [...LIVE_STATUSES]);
  return count ?? 0;
}

function eventStatusFor(event: EventRow, session: SessionRow | null): string | null {
  if (session) return session.finalized_at || session.status === "finalized" || session.status === "cancelled" ? "completed" : "active";
  return event.status;
}

export function publicEvent(event: EventRow, org: { slug: string; name: string } | null, session: SessionRow | null): MRegistrationEvent {
  return {
    slug: event.slug,
    name: event.name,
    kind: event.kind === "friendly_session" ? "session" : "tournament",
    sport: event.sport ?? "padel",
    startsAt: startsAtOf(event, session),
    organization: org ? { slug: org.slug, name: org.name } : null,
  };
}

/** GET /t/{slug}/registration and the web page: how to register now. */
export async function registrationInfo(slug: string): Promise<MRegistrationInfo | null> {
  const found = await publicEventBySlug(slug);
  if (!found) return null;
  const { event, org, session } = found;
  const s = await getSettings(event.id);
  const startsAt = startsAtOf(event, session);
  const reason = registrationClosedReason(s, { status: eventStatusFor(event, session), startsAt }, s.capacity === null ? 0 : await liveCount(event.id));
  const cutoff = refundCutoff(startsAt);
  return {
    event: publicEvent(event, org, session),
    open: reason === null,
    closedMessage: reason ? CLOSED_MESSAGES[reason] : null,
    entryType: s.entryType,
    people: peoplePerEntry(s),
    feePerPlayer: s.feeAmount,
    currency: "EGP",
    feeLabel: s.feeAmount > 0 ? `${moneyLabel(s.feeAmount)} per player` : null,
    paymentOptions: paymentOptions(s, onlinePaymentAvailable(org.slug)) as MPaymentChoice[],
    teamPayer: s.teamPayer,
    approval: s.approvalMode,
    refundsUntil: cutoff === null ? null : new Date(cutoff).toISOString(),
    refundFeePercent: s.refundFeePercent,
    closesAt: s.closesAt,
    note: s.note,
  };
}

/* ---------------- registering ---------------- */

export interface RegisterInput {
  slug: string;
  source: "app" | "web";
  userId: string | null;
  people: unknown;
  teamName: unknown;
  payment: unknown;
}

const cleanName = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const cleanEmail = (v: unknown): string | null | false => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > 200) return false;
  const e = v.trim().toLowerCase();
  return /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/.test(e) ? e : false;
};

/** The people as typed, checked: the registrant first. */
export function readPeople(raw: unknown, want: number, opts: { registrantContact: "phone" | "phone_and_email"; partnerPhone: boolean }): { ok: true; people: Person[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length !== want) return { ok: false, error: want === 1 ? "Enter your details." : `Enter the details of all ${want} players.` };
  const people: Person[] = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i] as Record<string, unknown> | null;
    if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some((k) => !["name", "phone", "email"].includes(k))) return { ok: false, error: "That request isn't one this server understands." };
    const name = cleanName(p.name);
    if (name.length < 2 || name.length > 80) return { ok: false, error: i === 0 ? "Enter your full name." : `Enter player ${i + 1}'s full name.` };
    const rawPhone = typeof p.phone === "string" ? p.phone.slice(0, 40) : p.phone === undefined || p.phone === null ? "" : null;
    if (rawPhone === null) return { ok: false, error: "That request isn't one this server understands." };
    const phone = rawPhone ? toE164(rawPhone) : null;
    if (rawPhone && !phone) return { ok: false, error: i === 0 ? "Enter a valid mobile number." : `Enter a valid mobile number for player ${i + 1}.` };
    const email = cleanEmail(p.email);
    if (email === false) return { ok: false, error: i === 0 ? "Enter a valid email address." : `Enter a valid email address for player ${i + 1}.` };
    if (i === 0 && !phone) return { ok: false, error: "Enter your mobile number." };
    if (i === 0 && opts.registrantContact === "phone_and_email" && !email) return { ok: false, error: "Enter your email address: the confirmation goes there." };
    if (i > 0 && opts.partnerPhone && !phone) return { ok: false, error: `Enter player ${i + 1}'s mobile number.` };
    people.push({ name, phone, email: email || null });
  }
  const phones = people.map((p) => p.phone).filter(Boolean);
  if (new Set(phones).size !== phones.length) return { ok: false, error: "Each player needs their own mobile number." };
  return { ok: true, people };
}

/** The name an account registers under: the player it already speaks for, else what it typed. */
async function accountName(userId: string, typed: string): Promise<string> {
  const rows = await claimedRows(userId).catch(() => []);
  if (rows[0]?.full_name) return rows[0].full_name;
  const profile = await accountProfile(userId);
  return profile?.public_name || typed;
}

export interface RegisterResult {
  registration: RegistrationRow;
  event: EventRow;
  org: { id: string; slug: string; name: string };
  session: SessionRow | null;
  checkoutUrl: string | null;
  message: string;
}

export async function register(input: RegisterInput): Promise<Outcome<RegisterResult>> {
  const found = await publicEventBySlug(input.slug);
  if (!found) return NOT_FOUND;
  const { event, org, session } = found;
  const s = await getSettings(event.id);
  const startsAt = startsAtOf(event, session);
  const reason = registrationClosedReason(s, { status: eventStatusFor(event, session), startsAt }, s.capacity === null ? 0 : await liveCount(event.id));
  if (reason) return fail(409, reason, CLOSED_MESSAGES[reason]);

  const read = readPeople(input.people, peoplePerEntry(s), {
    registrantContact: input.source === "web" ? "phone_and_email" : "phone",
    // A session's players are found and made by their mobile number.
    partnerPhone: event.kind === "friendly_session",
  });
  if (!read.ok) return fail(400, "invalid", read.error);
  const people = read.people;
  if (input.userId) people[0] = { ...people[0]!, name: await accountName(input.userId, people[0]!.name) };

  const teamName = cleanName(input.teamName).slice(0, 80) || null;
  const options = paymentOptions(s, onlinePaymentAvailable(org.slug));
  const choice = (typeof input.payment === "string" ? input.payment : options[0]) as PaymentChoice;
  if (!options.includes(choice)) return fail(400, "payment", options.includes("venue") ? "Online payment is not available for this event: pay at the venue." : "Pick how to pay.");
  const money = charges(s, choice, people.length);
  const status = initialStatus(s, money.online);

  const { data, error } = await db()
    .from("registrations")
    .insert({
      tournament_id: event.id,
      organization_id: event.organization_id,
      auth_user_id: input.userId,
      source: input.source,
      entry_type: s.entryType,
      team_name: s.entryType === "team" ? teamName : null,
      people,
      status,
      payment_choice: choice,
      amount_online: money.online,
      amount_venue: money.venue,
      currency: "EGP",
    })
    .select(REG_COLUMNS)
    .single();
  if (error) {
    // The unique index: this account already holds a live entry for the event.
    if (input.userId && /duplicate|unique/i.test(error.message)) return fail(409, "already_registered", "You're already registered for this event. See My registrations.");
    return fail(409, "conflict", "Could not register right now. Try again.");
  }
  let reg = data as RegistrationRow;
  await audit({
    tournament_id: event.id,
    organization_id: event.organization_id,
    actor_role: input.source === "app" ? "user" : "public",
    actor_user_id: input.userId,
    action: "REGISTRATION_SUBMITTED",
    entity_type: "registration",
    entity_id: reg.id,
    new_value: { status, entry_type: s.entryType, people: people.length, payment_choice: choice, amount_online: money.online, amount_venue: money.venue },
  });

  let checkoutUrl: string | null = null;
  let message: string;
  if (status === "confirmed") {
    reg = (await confirmEntry(reg, event, "registered")) ?? reg;
    message = money.venue > 0 ? `You're in. Pay ${moneyLabel(money.venue)} at the venue.` : "You're in.";
  } else if (status === "awaiting_payment") {
    const pay = await startPayment(reg, event, input.source);
    checkoutUrl = pay.ok ? pay.value.checkoutUrl : null;
    message = pay.ok ? `Pay ${moneyLabel(money.online)} to finish registering.` : "Registered. Online payment is not reachable right now: try Pay again in a moment.";
    await notify(reg, event, "awaiting_payment");
  } else {
    message = "Registration received. The organiser confirms each entry.";
    await notify(reg, event, "received");
  }
  return { ok: true, value: { registration: reg, event, org, session, checkoutUrl, message } };
}

/* ---------------- payment ---------------- */

/** Where Move Tick sends the payer back: a status page that shows nothing but the event and the status. */
export function returnUrlFor(registrationId: string): string {
  return `${siteUrl()}/register/status?r=${registrationId}&s=${statusToken(registrationId)}`;
}

function statusSecret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET must be set");
  return s;
}

export function statusToken(registrationId: string): string {
  return createHmac("sha256", statusSecret()).update(`mb-registration-status:v1:${registrationId}`).digest("base64url").slice(0, 32);
}

export function statusTokenValid(registrationId: string, token: string | null | undefined): boolean {
  if (!UUID.test(registrationId) || typeof token !== "string") return false;
  return safeEqual(token, statusToken(registrationId));
}

async function openPayment(registrationId: string): Promise<PaymentRow | null> {
  const { data } = await db().from("registration_payments").select(PAY_COLUMNS).eq("registration_id", registrationId).eq("method", "online").order("created_at", { ascending: false }).limit(5);
  const rows = (data ?? []) as PaymentRow[];
  return rows.find((p) => (p.status === "open" || p.status === "created") && (!p.expires_at || Date.parse(p.expires_at) > Date.now() + 60_000)) ?? null;
}

async function paidPayment(registrationId: string): Promise<PaymentRow | null> {
  const { data } = await db().from("registration_payments").select(PAY_COLUMNS).eq("registration_id", registrationId).eq("method", "online").in("status", ["paid", "refund_pending", "refunded"]).order("created_at", { ascending: false }).limit(1);
  return ((data ?? []) as PaymentRow[])[0] ?? null;
}

/**
 * A Move Tick checkout for what this registration owes online, reusing an open
 * one. The amount is the registration row's, written by the server.
 */
export async function startPayment(reg: RegistrationRow, event: EventRow, source: "app" | "web" | "admin"): Promise<Outcome<{ checkoutUrl: string; paymentId: string }>> {
  if (reg.status !== "awaiting_payment" || reg.amount_online <= 0) return fail(409, "not_due", "Nothing is due online for this entry.");
  const org = await orgOf(event.organization_id);
  const cfg = moveTickConfig();
  if (!cfg || org?.slug !== MOVE_BEYOND_SLUG) return fail(409, "unavailable", "Online payment is not available for this event.");
  const existing = await openPayment(reg.id);
  if (existing?.checkout_url) return { ok: true, value: { checkoutUrl: existing.checkout_url, paymentId: existing.id } };
  let payment = existing;
  if (!payment) {
    const { data, error } = await db()
      .from("registration_payments")
      .insert({ registration_id: reg.id, organization_id: reg.organization_id, method: "online", provider: "move_tick", amount: reg.amount_online, currency: "EGP", status: "created", test_mode: cfg.mode === "test" })
      .select(PAY_COLUMNS)
      .single();
    if (error) return fail(409, "conflict", "Could not start the payment. Try again.");
    payment = data as PaymentRow;
  }
  const registrant = reg.people[0];
  try {
    const session = await createPaymentSession(cfg, {
      reference: reg.id,
      amount: payment.amount,
      currency: "EGP",
      description: `${event.name} — entry`,
      returnUrl: returnUrlFor(reg.id),
      customer: { name: registrant?.name ?? "Player", email: registrant?.email ?? null, phone: registrant?.phone ?? null },
      idempotencyKey: payment.id,
    });
    const { error } = await db()
      .from("registration_payments")
      .update({ status: "open", session_id: session.sessionId, checkout_url: session.checkoutUrl, expires_at: session.expiresAt, test_mode: session.testMode, updated_at: now() })
      .eq("id", payment.id)
      .eq("status", "created");
    if (error) return fail(409, "conflict", "Could not start the payment. Try again.");
    await audit({ tournament_id: event.id, organization_id: event.organization_id, actor_role: source === "app" ? "user" : source === "web" ? "public" : null, action: "REGISTRATION_PAYMENT_STARTED", entity_type: "registration", entity_id: reg.id, new_value: { payment_id: payment.id, amount: payment.amount, session_id: session.sessionId, test_mode: session.testMode } });
    return { ok: true, value: { checkoutUrl: session.checkoutUrl, paymentId: payment.id } };
  } catch (e) {
    const code = e instanceof MoveTickError ? e.code : "error";
    console.error("[registration] Move Tick checkout failed", code);
    return fail(502, "move_tick", "Online payment is not reachable right now. Try again in a moment.");
  }
}

/* ---------------- webhooks ---------------- */

export type WebhookOutcome = "applied" | "duplicate" | "ignored" | "unknown_reference" | "mode_mismatch" | "needs_review";

/**
 * Applies one Move Tick event (signature already verified by the route).
 * Idempotent: the event id is recorded first (a replay stops there), and every
 * change is conditional on the status it moves from.
 */
export async function applyWebhook(e: WebhookEvent): Promise<WebhookOutcome> {
  const { error: dup } = await db().from("move_tick_events").insert({ event_id: e.id, type: e.type, reference: e.data.reference });
  if (dup) return "duplicate";
  const outcome = await applyWebhookOnce(e).catch(async (err) => {
    // Let Move Tick retry: forget the event id so the retry is not taken for a replay.
    await db().from("move_tick_events").delete().eq("event_id", e.id);
    throw err;
  });
  await db().from("move_tick_events").update({ outcome }).eq("event_id", e.id);
  return outcome;
}

async function applyWebhookOnce(e: WebhookEvent): Promise<WebhookOutcome> {
  const cfg = moveTickConfig();
  if (!cfg) return "ignored";
  const { data: p } = await db().from("registration_payments").select(PAY_COLUMNS).eq("session_id", e.data.sessionId).maybeSingle();
  const payment = p as PaymentRow | null;
  // The reference must be the registration the session was made for.
  if (!payment || payment.registration_id !== e.data.reference) return "unknown_reference";
  if (e.data.testMode !== (cfg.mode === "test") || payment.test_mode !== e.data.testMode) return "mode_mismatch";
  const { data: r } = await db().from("registrations").select(REG_COLUMNS).eq("id", payment.registration_id).maybeSingle();
  const reg = r as RegistrationRow | null;
  if (!reg) return "unknown_reference";
  const event = await eventById(reg.tournament_id);
  if (!event) return "unknown_reference";
  const base = { tournament_id: event.id, organization_id: event.organization_id, actor_role: "system", entity_type: "registration", entity_id: reg.id };

  if (e.type === "payment.succeeded") {
    // Amounts are never taken from the message: it must be exactly what this server asked for.
    if (e.data.amount !== payment.amount || e.data.currency !== payment.currency) {
      await db().from("registration_payments").update({ status: "needs_review", review_reason: `Move Tick reported ${e.data.amount} ${e.data.currency}; expected ${payment.amount} ${payment.currency}.`, last_event_id: e.id, updated_at: now() }).eq("id", payment.id).in("status", ["created", "open", "failed", "expired"]);
      await audit({ ...base, action: "REGISTRATION_PAYMENT_MISMATCH", new_value: { payment_id: payment.id, reported: e.data.amount, expected: payment.amount } });
      return "needs_review";
    }
    const { data: moved } = await db()
      .from("registration_payments")
      .update({ status: "paid", paid_at: now(), last_event_id: e.id, updated_at: now() })
      .eq("id", payment.id)
      .in("status", ["created", "open", "failed", "expired"])
      .select("id");
    if (!moved?.length) return "duplicate";
    await audit({ ...base, action: "REGISTRATION_PAID", new_value: { payment_id: payment.id, amount: payment.amount, session_id: payment.session_id, test_mode: payment.test_mode } });
    // Paid while it was still waiting for the payment: confirmed. Paid after it was
    // cancelled or refused: kept for the organiser to refund.
    const { data: conf } = await db()
      .from("registrations")
      .update({ status: "confirmed", paid_at: now(), updated_at: now() })
      .eq("id", reg.id)
      .eq("status", "awaiting_payment")
      .select(REG_COLUMNS);
    const confirmed = (conf as RegistrationRow[] | null)?.[0];
    if (confirmed) {
      await confirmEntry(confirmed, event, "paid");
      return "applied";
    }
    await db().from("registration_payments").update({ status: "needs_review", review_reason: "Paid after the entry was no longer waiting for payment: refund it.", updated_at: now() }).eq("id", payment.id).eq("status", "paid");
    await db().from("registrations").update({ paid_at: now(), updated_at: now() }).eq("id", reg.id).is("paid_at", null);
    return "needs_review";
  }

  if (e.type === "payment.failed" || e.type === "payment.expired") {
    await db()
      .from("registration_payments")
      .update({ status: e.type === "payment.failed" ? "failed" : "expired", last_event_id: e.id, updated_at: now() })
      .eq("id", payment.id)
      .in("status", ["created", "open"]);
    return "applied";
  }

  // payment.refunded: only a refund this server asked for, of a paid payment.
  const refunded = e.data.refundedAmount ?? payment.refund_amount ?? payment.amount;
  if (refunded > payment.amount) return "needs_review";
  const { data: moved } = await db()
    .from("registration_payments")
    .update({ status: "refunded", refund_amount: refunded, refunded_at: now(), last_event_id: e.id, updated_at: now() })
    .eq("id", payment.id)
    .in("status", ["refund_pending", "paid", "needs_review"])
    .select("id");
  if (!moved?.length) return "duplicate";
  await finishRefund(reg, event, refunded);
  return "applied";
}

/**
 * A webhook that never arrived: asks Move Tick (authenticated, server to server)
 * how an open checkout ended, and applies the answer through the same idempotent
 * path as a webhook (event id "reconcile:<session>:<status>"). The amount check
 * still applies. Errors are ignored: the webhook or the next look will do.
 */
export async function reconcileOnline(registrationId: string): Promise<void> {
  const cfg = moveTickConfig();
  if (!cfg) return;
  const { data } = await db().from("registration_payments").select(PAY_COLUMNS).eq("registration_id", registrationId).eq("method", "online").in("status", ["open"]).order("created_at", { ascending: false }).limit(1);
  const pay = ((data ?? []) as PaymentRow[])[0];
  if (!pay?.session_id) return;
  try {
    const s = await getPaymentSession(cfg, pay.session_id);
    if (s.reference !== registrationId || s.sessionId !== pay.session_id) return;
    const type = s.status === "paid" ? "payment.succeeded" : s.status === "failed" ? "payment.failed" : s.status === "expired" ? "payment.expired" : null;
    if (!type) return;
    await applyWebhook({ id: `reconcile:${pay.session_id}:${s.status}`, type, createdAt: now(), data: { sessionId: s.sessionId, reference: s.reference, amount: s.amount, currency: s.currency, refundedAmount: null, testMode: s.testMode } });
  } catch {
    /* Move Tick unreachable or the session unknown: nothing to do now */
  }
}

/* ---------------- the entry in the event ---------------- */

/**
 * Makes the entry a confirmed registration stands for (once: claimed with a
 * conditional update on materialized_at), links the registrant's own player row
 * to their account, and tells them. Padel individual entries in a tournament wait
 * for the organiser to pair them (pairRegistrations).
 */
export async function confirmEntry(reg: RegistrationRow, event: EventRow, why: "registered" | "approved" | "paid" | "venue"): Promise<RegistrationRow | null> {
  const waitsForPair = waitsForPairing(event, reg.entry_type);
  if (!waitsForPair) await materialize(reg, event);
  await notify(reg, event, "confirmed", why);
  const { data } = await db().from("registrations").select(REG_COLUMNS).eq("id", reg.id).maybeSingle();
  return (data as RegistrationRow | null) ?? null;
}

/** A tournament's individual entries in a doubles sport wait for the organiser to pair them (one-player sports enter at once). */
export function waitsForPairing(event: Pick<EventRow, "kind" | "sport">, entryType: string): boolean {
  return event.kind === "tournament" && entryType === "individual" && sportOf(event).engine !== "chess";
}

async function claimMaterialize(regIds: string[]): Promise<boolean> {
  const stamp = now();
  const { data } = await db().from("registrations").update({ materialized_at: stamp, updated_at: stamp }).in("id", regIds).is("materialized_at", null).eq("status", "confirmed").select("id");
  if ((data ?? []).length === regIds.length) return true;
  // Only some claimed (a race): let the others go again; nothing is made twice.
  if ((data ?? []).length) await db().from("registrations").update({ materialized_at: null }).in("id", (data as { id: string }[]).map((x) => x.id)).eq("materialized_at", stamp);
  return false;
}

async function materialize(reg: RegistrationRow, event: EventRow): Promise<void> {
  if (!(await claimMaterialize([reg.id]))) return;
  try {
    if (event.kind === "friendly_session") await sessionEntries(reg, event);
    else await tournamentTeam([reg], event);
  } catch (err) {
    await db().from("registrations").update({ materialized_at: null }).eq("id", reg.id);
    console.error("[registration] entry not made", err instanceof Error ? err.message : err);
  }
}

/** A team (and its players) in a tournament from one team entry, or from individual entries paired by the organiser. */
async function tournamentTeam(regs: RegistrationRow[], event: EventRow): Promise<void> {
  const people = regs.flatMap((r) => r.people.map((p, i) => ({ ...p, reg: r, own: i === 0 })));
  const chess = sportOf(event).engine === "chess";
  const teamName = (chess ? people[0]!.name : regs.length === 1 ? regs[0]!.team_name : null) || people.map((p) => p.name.split(" ")[0]).join(" / ");
  const { data: t, error } = await db()
    .from("teams")
    .insert({ tournament_id: event.id, team_name: teamName.slice(0, 80), phone: people[0]!.phone, notes: "Registered in Move Score" })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const teamId = (t as { id: string }).id;
  const ownProfiles = new Map<string, string | null>();
  for (const r of regs) if (r.auth_user_id) ownProfiles.set(r.id, (await accountProfile(r.auth_user_id))?.id ?? null);
  const { data: rows, error: pe } = await db()
    .from("players")
    .insert(
      people.map((p, i) => ({
        tournament_id: event.id,
        team_id: teamId,
        player_order: i + 1,
        full_name: p.name,
        phone: p.phone,
        email: p.email,
        // The registrant's row joins their account's own profile; nobody else's row is put on a profile here.
        player_profile_id: p.own && p.reg.auth_user_id ? (ownProfiles.get(p.reg.id) ?? null) : null,
      })),
    )
    .select(PLAYER_COLUMNS);
  if (pe) {
    await db().from("teams").delete().eq("id", teamId);
    throw new Error(pe.message);
  }
  const made = (rows ?? []) as PlayerRow[];
  for (const r of regs) {
    const ownIndex = people.findIndex((p) => p.reg.id === r.id && p.own);
    const ownRow = made.find((m) => m.full_name === people[ownIndex]!.name && m.team_id === teamId) ?? null;
    await db().from("registrations").update({ team_id: teamId, player_id: ownRow?.id ?? null, updated_at: now() }).eq("id", r.id);
    if (r.auth_user_id && ownRow) await linkOwnRow(r, event, ownRow);
  }
  await audit({ tournament_id: event.id, organization_id: event.organization_id, actor_role: "system", action: "REGISTRATION_ENTRY_MADE", entity_type: "team", entity_id: teamId, new_value: { registrations: regs.map((r) => r.id), players: made.length } });
}

/** The registrant's own row, to the account that registered (never anybody else's row). */
async function linkOwnRow(reg: RegistrationRow, event: EventRow, row: PlayerRow): Promise<void> {
  const linked = await linkAccount(reg.auth_user_id!, [row], { kind: "registration", row });
  await audit({
    tournament_id: event.id,
    organization_id: event.organization_id,
    actor_role: "system",
    action: linked.ok ? "REGISTRATION_PLAYER_LINKED" : "REGISTRATION_PLAYER_NOT_LINKED",
    entity_type: "registration",
    entity_id: reg.id,
    new_value: linked.ok ? { player_id: row.id } : { player_id: row.id, reason: linked.error },
  });
}

/** A session's entries: the registrant's profile (the account's own, for an app account) and their partners'. */
async function sessionEntries(reg: RegistrationRow, event: EventRow): Promise<void> {
  const session = await sessionOf(event);
  if (!session) throw new Error("session not found");
  const { findOrCreateProfile } = await import("../friendly/ops");
  const profiles: string[] = [];
  for (let i = 0; i < reg.people.length; i++) {
    const p = reg.people[i]!;
    if (i === 0 && reg.auth_user_id) {
      const id = await ensureAccountProfile(reg.auth_user_id, p.name);
      // The player registered with this organisation themselves: theirs to see.
      await ensureOrgPlayer(event.organization_id, id, "registration", "approved");
      profiles.push(id);
      continue;
    }
    const mobile = normalizeMobile(p.phone ?? "");
    if (!mobile) throw new Error("a session entry needs a mobile number");
    const found = await findOrCreateProfile(p.name, mobile);
    // A profile found by a typed number proves nothing about who typed it ('matched').
    await ensureOrgPlayer(event.organization_id, found.id, found.created ? "registration" : "matched", "approved", found.created ? null : p.name);
    profiles.push(found.id);
  }
  const ids: string[] = [];
  for (const pid of profiles) {
    const { data } = await db()
      .from("friendly_entries")
      .upsert({ session_id: session.id, player_profile_id: pid, source: "self", approval: "approved", hidden: false, updated_at: now() }, { onConflict: "session_id,player_profile_id" })
      .select("id")
      .single();
    if (data) ids.push((data as { id: string }).id);
  }
  if (profiles.length === 2) {
    await db().from("friendly_entries").update({ preferred_partner_profile_id: profiles[1] }).eq("session_id", session.id).eq("player_profile_id", profiles[0]!);
    await db().from("friendly_entries").update({ preferred_partner_profile_id: profiles[0] }).eq("session_id", session.id).eq("player_profile_id", profiles[1]!);
  }
  await db().from("registrations").update({ entry_ids: ids, updated_at: now() }).eq("id", reg.id);
  await audit({ tournament_id: event.id, organization_id: event.organization_id, actor_role: "system", action: "REGISTRATION_ENTRY_MADE", entity_type: "friendly_session", entity_id: session.id, new_value: { registration: reg.id, entries: ids.length } });
}

/** Takes the entry back out of the event (refund, cancellation). A team that already has matches stays, for the organiser. */
async function withdrawEntry(reg: RegistrationRow, event: EventRow): Promise<"removed" | "kept" | "none"> {
  if (reg.entry_ids?.length) {
    await db().from("friendly_entries").update({ approval: "withdrawn", updated_at: now() }).in("id", reg.entry_ids);
    return "removed";
  }
  if (!reg.team_id) return "none";
  const { count } = await db().from("matches").select("id", { count: "exact", head: true }).eq("tournament_id", event.id).or(`team_a_id.eq.${reg.team_id},team_b_id.eq.${reg.team_id}`);
  if ((count ?? 0) > 0) return "kept";
  await db().from("teams").delete().eq("id", reg.team_id).eq("tournament_id", event.id);
  return "removed";
}

/* ---------------- organiser actions ---------------- */

export interface Actor {
  role: string;
  label: string;
}

async function loadReg(id: string): Promise<{ reg: RegistrationRow; event: EventRow } | null> {
  if (!UUID.test(id)) return null;
  const { data } = await db().from("registrations").select(REG_COLUMNS).eq("id", id).maybeSingle();
  const reg = data as RegistrationRow | null;
  if (!reg) return null;
  const event = await eventById(reg.tournament_id);
  return event ? { reg, event } : null;
}

async function move(reg: RegistrationRow, to: RegistrationStatus, patch: Record<string, unknown> = {}): Promise<RegistrationRow | null> {
  if (!canMove(reg.status, to)) return null;
  const { data } = await db()
    .from("registrations")
    .update({ status: to, ...patch, updated_at: now() })
    .eq("id", reg.id)
    .eq("status", reg.status)
    .select(REG_COLUMNS);
  return ((data ?? []) as RegistrationRow[])[0] ?? null;
}

/** Approve or refuse (the caller checked the organisation from the registration itself). */
export async function decide(registrationId: string, decision: "approve" | "refuse", note: string | null, actor: Actor): Promise<string> {
  const found = await loadReg(registrationId);
  if (!found) throw new Error("Not found");
  const { reg, event } = found;
  if (decision === "refuse") {
    if (reg.paid_at) throw new Error("This entry is paid: refund it instead.");
    const moved = await move(reg, "refused", { decided_at: now(), decided_by: actor.label, decision_note: note });
    if (!moved) throw new Error("This entry can't be refused now. Reload the page.");
    await audit({ tournament_id: event.id, actor_role: actor.role, action: "REGISTRATION_REFUSED", entity_type: "registration", entity_id: reg.id, old_value: { status: reg.status }, new_value: { status: "refused", note } });
    await notify(moved, event, "refused");
    return "Refused.";
  }
  if (reg.status !== "pending_approval") throw new Error("Only an entry waiting for approval can be approved. Reload the page.");
  const to = statusAfterApproval(reg.amount_online, Boolean(reg.paid_at));
  const moved = await move(reg, to, { decided_at: now(), decided_by: actor.label, decision_note: note });
  if (!moved) throw new Error("This entry changed meanwhile. Reload the page.");
  await audit({ tournament_id: event.id, actor_role: actor.role, action: "REGISTRATION_APPROVED", entity_type: "registration", entity_id: reg.id, old_value: { status: reg.status }, new_value: { status: to } });
  if (to === "confirmed") {
    await confirmEntry(moved, event, "approved");
    return "Approved: the entry is in.";
  }
  await notify(moved, event, "awaiting_payment");
  return "Approved: the player was asked to pay online.";
}

/** The amount due at the venue was paid (recorded by the organiser). */
export async function markVenuePaid(registrationId: string, actor: Actor): Promise<string> {
  const found = await loadReg(registrationId);
  if (!found) throw new Error("Not found");
  const { reg, event } = found;
  if (reg.amount_venue <= 0) throw new Error("Nothing is due at the venue for this entry.");
  if (reg.venue_paid_at) return "Already recorded.";
  if (reg.status !== "confirmed") throw new Error("Confirm the entry first.");
  const { data } = await db().from("registrations").update({ venue_paid_at: now(), venue_paid_by: actor.label, updated_at: now() }).eq("id", reg.id).is("venue_paid_at", null).eq("status", "confirmed").select("id");
  if (!data?.length) return "Already recorded.";
  await db().from("registration_payments").insert({ registration_id: reg.id, organization_id: reg.organization_id, method: "venue", provider: "venue", amount: reg.amount_venue, currency: "EGP", status: "paid", paid_at: now(), recorded_by: actor.label });
  await audit({ tournament_id: event.id, actor_role: actor.role, action: "REGISTRATION_PAID_AT_VENUE", entity_type: "registration", entity_id: reg.id, new_value: { amount: reg.amount_venue } });
  return `Recorded ${moneyLabel(reg.amount_venue)} paid at the venue.`;
}

/** Pairs two confirmed individual entries of a padel tournament into one team. */
export async function pairRegistrations(ids: [string, string], tournamentId: string, actor: Actor): Promise<string> {
  const a = await loadReg(ids[0]);
  const b = await loadReg(ids[1]);
  if (!a || !b || a.reg.id === b.reg.id || a.reg.tournament_id !== tournamentId || b.reg.tournament_id !== tournamentId) throw new Error("Not found");
  const event = a.event;
  if (event.kind !== "tournament") throw new Error("Sessions pair their players on the session's own page.");
  for (const r of [a.reg, b.reg]) {
    if (r.entry_type !== "individual" || r.status !== "confirmed" || r.materialized_at) throw new Error("Pick two confirmed individual entries that are not in a team yet.");
  }
  if (!(await claimMaterialize([a.reg.id, b.reg.id]))) throw new Error("One of them was paired meanwhile. Reload the page.");
  try {
    await tournamentTeam([a.reg, b.reg], event);
  } catch (err) {
    await db().from("registrations").update({ materialized_at: null }).in("id", [a.reg.id, b.reg.id]);
    throw err;
  }
  await audit({ tournament_id: event.id, actor_role: actor.role, action: "REGISTRATIONS_PAIRED", entity_type: "registration", entity_id: a.reg.id, new_value: { with: b.reg.id } });
  return "Paired into a team.";
}

/**
 * Refunds an online payment through Move Tick: the organiser's action only, until
 * 24 h before the event's start time, audited. The amount is the payment's own,
 * less the card fee the settings keep (none by default).
 */
export async function refund(registrationId: string, actor: Actor, reasonText: string | null): Promise<string> {
  const found = await loadReg(registrationId);
  if (!found) throw new Error("Not found");
  const { reg, event } = found;
  const session = await sessionOf(event);
  if (reg.status === "refunded") throw new Error(REFUND_MESSAGES.already_refunded);
  const payment = await paidPayment(reg.id);
  if (!payment || payment.status !== "paid" || !payment.session_id) {
    const review = await db().from("registration_payments").select(PAY_COLUMNS).eq("registration_id", reg.id).eq("status", "needs_review").not("paid_at", "is", null).limit(1);
    const flagged = ((review.data ?? []) as PaymentRow[])[0];
    if (!flagged) throw new Error(payment?.status === "refund_pending" ? "A refund is already on its way." : REFUND_MESSAGES.not_paid);
    return refundPayment(reg, event, flagged, actor, reasonText, { skipCutoff: true });
  }
  const allowed = refundAllowed(startsAtOf(event, session));
  if (!allowed.ok) throw new Error(REFUND_MESSAGES[allowed.reason]);
  return refundPayment(reg, event, payment, actor, reasonText, { skipCutoff: false });
}

async function refundPayment(reg: RegistrationRow, event: EventRow, payment: PaymentRow, actor: Actor, reasonText: string | null, opts: { skipCutoff: boolean }): Promise<string> {
  const cfg = moveTickConfig();
  if (!cfg) throw new Error("Move Tick is not configured on this server.");
  const settings = await getSettings(event.id);
  const amount = refundAmount(payment.amount, settings.refundFeePercent);
  const { data: claimed } = await db()
    .from("registration_payments")
    .update({ status: "refund_pending", refund_amount: amount, refund_requested_by: actor.label, updated_at: now() })
    .eq("id", payment.id)
    .eq("status", payment.status)
    .select("id");
  if (!claimed?.length) throw new Error("This payment changed meanwhile. Reload the page.");
  await audit({
    tournament_id: event.id,
    actor_role: actor.role,
    action: "REGISTRATION_REFUND_REQUESTED",
    entity_type: "registration",
    entity_id: reg.id,
    new_value: { payment_id: payment.id, paid: payment.amount, refund: amount, fee_percent: settings.refundFeePercent, reason: reasonText, after_cutoff_review: opts.skipCutoff },
  });
  try {
    const r = await refundPaymentSession(cfg, { sessionId: payment.session_id!, reference: reg.id, amount, reason: reasonText ?? "Registration refunded by the organiser", idempotencyKey: `refund-${payment.id}` });
    if (r.status === "refunded") {
      const { data: done } = await db()
        .from("registration_payments")
        .update({ status: "refunded", refund_id: r.refundId, refunded_at: now(), updated_at: now() })
        .eq("id", payment.id)
        .eq("status", "refund_pending")
        .select("id");
      if (done?.length) await finishRefund(reg, event, amount);
      return `Refunded ${moneyLabel(amount)}.`;
    }
    await db().from("registration_payments").update({ refund_id: r.refundId, updated_at: now() }).eq("id", payment.id);
    return `Refund of ${moneyLabel(amount)} requested from Move Tick.`;
  } catch (e) {
    await db().from("registration_payments").update({ status: payment.status, updated_at: now() }).eq("id", payment.id).eq("status", "refund_pending");
    const code = e instanceof MoveTickError ? e.code : "error";
    await audit({ tournament_id: event.id, actor_role: actor.role, action: "REGISTRATION_REFUND_FAILED", entity_type: "registration", entity_id: reg.id, new_value: { payment_id: payment.id, code } });
    throw new Error(code === "PARTIAL_REFUND_UNSUPPORTED" ? "Move Tick can only refund the full amount for now: set the card fee kept on refunds to 0 %." : "Move Tick did not take the refund. Try again in a moment.");
  }
}

/** After Move Tick refunded: the registration is refunded and the entry leaves the event. */
async function finishRefund(reg: RegistrationRow, event: EventRow, amount: number): Promise<void> {
  const { data } = await db().from("registrations").select(REG_COLUMNS).eq("id", reg.id).maybeSingle();
  const fresh = data as RegistrationRow | null;
  if (!fresh) return;
  const { data: moved } = await db()
    .from("registrations")
    .update({ status: "refunded", refunded_at: now(), updated_at: now() })
    .eq("id", fresh.id)
    .in("status", ["confirmed", "cancelled", "refused", "awaiting_payment"])
    .select(REG_COLUMNS);
  const done = ((moved ?? []) as RegistrationRow[])[0];
  if (!done) return;
  const entry = await withdrawEntry(done, event);
  await audit({ tournament_id: event.id, organization_id: event.organization_id, actor_role: "system", action: "REGISTRATION_REFUNDED", entity_type: "registration", entity_id: done.id, new_value: { amount, entry } });
  await notify(done, event, "refunded", undefined, amount);
}

/* ---------------- the player's own actions ---------------- */

/** One of the account's registrations; null for another account's and a missing one alike. */
export async function ownRegistration(userId: string, id: string): Promise<{ reg: RegistrationRow; event: EventRow } | null> {
  const found = await loadReg(id);
  return found && found.reg.auth_user_id === userId ? found : null;
}

export async function payOwn(userId: string, id: string): Promise<Outcome<{ checkoutUrl: string }>> {
  const first = await ownRegistration(userId, id);
  if (!first) return NOT_FOUND;
  await reconcileOnline(id);
  const found = (await ownRegistration(userId, id)) ?? first;
  const r = await startPayment(found.reg, found.event, "app");
  return r.ok ? { ok: true, value: { checkoutUrl: r.value.checkoutUrl } } : r;
}

/** The player withdraws before paying (or a free / pay-at-venue entry before the event). Paid entries ask for a refund instead. */
export async function cancelOwn(userId: string, id: string): Promise<Outcome<RegistrationRow>> {
  const found = await ownRegistration(userId, id);
  if (!found) return NOT_FOUND;
  const { reg, event } = found;
  if (reg.paid_at) return fail(409, "paid", "This entry is paid: ask the organiser for a refund.");
  const session = await sessionOf(event);
  const start = startsAtOf(event, session);
  if (reg.status === "confirmed" && start && Date.parse(start) <= Date.now()) return fail(409, "started", "The event has started: ask the organiser.");
  const moved = await move(reg, "cancelled");
  if (!moved) return fail(409, "status", "This entry can't be cancelled now.");
  // An open checkout is left to expire; a payment that still arrives is flagged for a refund.
  if (reg.status === "confirmed") await withdrawEntry(moved, event);
  await audit({ tournament_id: event.id, organization_id: event.organization_id, actor_role: "user", actor_user_id: userId, action: "REGISTRATION_CANCELLED", entity_type: "registration", entity_id: reg.id, old_value: { status: reg.status } });
  return { ok: true, value: moved };
}

/** The player asks the organiser for a refund (the organiser decides; nothing is refunded here). */
export async function requestRefundOwn(userId: string, id: string): Promise<Outcome<RegistrationRow>> {
  const found = await ownRegistration(userId, id);
  if (!found) return NOT_FOUND;
  const { reg, event } = found;
  if (reg.status !== "confirmed" || !reg.paid_at) return fail(409, "not_paid", REFUND_MESSAGES.not_paid);
  const allowed = refundAllowed(startsAtOf(event, await sessionOf(event)));
  if (!allowed.ok) return fail(409, allowed.reason, REFUND_MESSAGES[allowed.reason]);
  if (!reg.refund_requested_at) {
    await db().from("registrations").update({ refund_requested_at: now(), updated_at: now() }).eq("id", reg.id).is("refund_requested_at", null);
    await audit({ tournament_id: event.id, organization_id: event.organization_id, actor_role: "user", actor_user_id: userId, action: "REGISTRATION_REFUND_ASKED", entity_type: "registration", entity_id: reg.id });
  }
  const { data } = await db().from("registrations").select(REG_COLUMNS).eq("id", reg.id).single();
  return { ok: true, value: data as RegistrationRow };
}

/** One of the account's registrations as the app shows it; null for another account's and a missing one alike. */
export async function ownPublicRegistration(userId: string, id: string): Promise<MRegistration | null> {
  const found = await ownRegistration(userId, id);
  if (!found) return null;
  const org = await orgOf(found.event.organization_id);
  return toPublicRegistration(found.reg, found.event, org, await sessionOf(found.event), userId);
}

/** The account's registrations, newest first. */
export async function myRegistrations(userId: string): Promise<MRegistration[]> {
  const { data } = await db().from("registrations").select(REG_COLUMNS).eq("auth_user_id", userId).order("created_at", { ascending: false }).limit(100);
  let regs = (data ?? []) as RegistrationRow[];
  if (!regs.length) return [];
  const waiting = regs.filter((r) => r.status === "awaiting_payment").slice(0, 3);
  if (waiting.length) {
    for (const r of waiting) await reconcileOnline(r.id);
    const { data: again } = await db().from("registrations").select(REG_COLUMNS).eq("auth_user_id", userId).order("created_at", { ascending: false }).limit(100);
    regs = (again ?? []) as RegistrationRow[];
  }
  const { data: ev } = await db().from("tournaments").select(EVENT_COLUMNS).in("id", [...new Set(regs.map((r) => r.tournament_id))]);
  const events = new Map(((ev ?? []) as EventRow[]).map((e) => [e.id, e]));
  const orgIds = [...new Set([...events.values()].map((e) => e.organization_id))];
  const { data: os } = await db().from("organizations").select("id, slug, name").in("id", orgIds.length ? orgIds : ["00000000-0000-0000-0000-000000000000"]);
  const orgs = new Map(((os ?? []) as { id: string; slug: string; name: string }[]).map((o) => [o.id, o]));
  const out: MRegistration[] = [];
  for (const r of regs) {
    const e = events.get(r.tournament_id);
    if (!e) continue;
    const session = await sessionOf(e);
    out.push(await toPublicRegistration(r, e, orgs.get(e.organization_id) ?? null, session, userId));
  }
  return out;
}

/** What the registrant sees of their own entry: names only, never a phone or email. */
export async function toPublicRegistration(r: RegistrationRow, e: EventRow, org: { slug: string; name: string } | null, session: SessionRow | null, userId: string | null): Promise<MRegistration> {
  const start = startsAtOf(e, session);
  const cutoff = refundCutoff(start);
  const cfgOk = onlinePaymentAvailable(org?.slug);
  let linked = false;
  if (userId && r.player_id) {
    const { data } = await db().from("player_claims").select("user_id").eq("player_id", r.player_id).maybeSingle();
    linked = (data as { user_id: string } | null)?.user_id === userId;
  } else if (userId && r.entry_ids?.length) linked = true;
  return {
    id: r.id,
    event: publicEvent(e, org, session),
    status: r.status,
    statusLabel: STATUS_LABELS[r.status],
    entryType: r.entry_type,
    teamName: r.team_name,
    people: (r.people ?? []).map((p) => ({ name: p.name })),
    paymentChoice: r.payment_choice,
    amountOnline: r.amount_online,
    amountVenue: r.amount_venue,
    currency: "EGP",
    paid: Boolean(r.paid_at),
    venuePaid: Boolean(r.venue_paid_at),
    canPay: r.status === "awaiting_payment" && r.amount_online > 0 && cfgOk,
    canCancel: !r.paid_at && (r.status === "pending_approval" || r.status === "awaiting_payment" || (r.status === "confirmed" && !(start && Date.parse(start) <= Date.now()))),
    canRequestRefund: r.status === "confirmed" && Boolean(r.paid_at) && !r.refund_requested_at && cutoff !== null && Date.now() <= cutoff,
    refundRequested: Boolean(r.refund_requested_at),
    refundsUntil: cutoff === null ? null : new Date(cutoff).toISOString(),
    linked,
    createdAt: r.created_at,
  };
}

/** The web status page (Move Tick's return URL): the event and the status, nothing personal. */
export async function statusView(registrationId: string, token: string | null): Promise<{ event: MRegistrationEvent; status: RegistrationStatus; label: string; paid: boolean } | null> {
  if (!statusTokenValid(registrationId, token)) return null;
  await reconcileOnline(registrationId);
  const found = await loadReg(registrationId);
  if (!found) return null;
  const org = await orgOf(found.event.organization_id);
  return { event: publicEvent(found.event, org, await sessionOf(found.event)), status: found.reg.status, label: STATUS_LABELS[found.reg.status], paid: Boolean(found.reg.paid_at) };
}

/* ---------------- organiser list ---------------- */

export interface AdminRegistration extends RegistrationRow {
  payments: PaymentRow[];
}

/** An event's registrations with their payments (the caller checked the organisation). */
export async function eventRegistrations(tournamentId: string): Promise<AdminRegistration[]> {
  const { data } = await db().from("registrations").select(REG_COLUMNS).eq("tournament_id", tournamentId).order("created_at", { ascending: true }).limit(2000);
  const regs = (data ?? []) as RegistrationRow[];
  if (!regs.length) return [];
  const pays: PaymentRow[] = [];
  const ids = regs.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 200) {
    const { data: p } = await db().from("registration_payments").select(PAY_COLUMNS).in("registration_id", ids.slice(i, i + 200)).order("created_at", { ascending: true });
    pays.push(...((p ?? []) as PaymentRow[]));
  }
  return regs.map((r) => ({ ...r, payments: pays.filter((p) => p.registration_id === r.id) }));
}

/* ---------------- messages ---------------- */

type Notice = "received" | "awaiting_payment" | "confirmed" | "refused" | "refunded";

/** Tells the registrant (email when they gave one, else WhatsApp). Never blocks the flow. */
async function notify(reg: RegistrationRow, event: EventRow, kind: Notice, why?: string, amount?: number): Promise<void> {
  const who = reg.people?.[0];
  if (!who) return;
  const to = who.email ?? who.phone;
  if (!to) return;
  const venue = reg.amount_venue > 0 && !reg.venue_paid_at ? ` Pay ${moneyLabel(reg.amount_venue)} at the venue.` : "";
  const text: Record<Notice, [string, string]> = {
    received: [`${event.name}: registration received`, `we received your registration for ${event.name}. The organiser confirms each entry; you'll hear from us when they do.`],
    awaiting_payment: [`${event.name}: pay to finish registering`, `your entry for ${event.name} is approved. Pay ${moneyLabel(reg.amount_online)} in the Move Score app (My profile → Registrations) to confirm your place.`],
    confirmed: [`${event.name}: you're in`, `your place in ${event.name} is confirmed.${venue}${reg.auth_user_id ? " Your entry is in your Move Score app." : ""}`],
    refused: [`${event.name}: registration not accepted`, `the organiser could not accept your registration for ${event.name}.`],
    refunded: [`${event.name}: refunded`, `your entry for ${event.name} was refunded (${moneyLabel(amount ?? 0)}). It can take a few days to reach your card.`],
  };
  const [title, message] = text[kind];
  try {
    const { sendTransactional } = await import("../messaging/queue");
    await sendTransactional({
      to,
      channel: who.email ? "email" : "whatsapp",
      template: "confirmation",
      vars: { name: who.name, first_name: who.name.split(" ")[0], title, message, tournament: event.name },
      idempotencyKey: `registration:${reg.id}:${kind}${why ? `:${why}` : ""}`,
      recipient: { kind: "adhoc", name: who.name },
    });
  } catch (err) {
    console.error("[registration] message not sent", err instanceof Error ? err.message : err);
  }
}

/* ---------------- housekeeping (messaging cron) ---------------- */

/**
 * Archives the player links of events that ended: player_claims.archived_at, 24 h
 * after the event's last day ended in its time zone (or its completion, whichever
 * is later). Looks back `days` days so each run stays small. Returns how many
 * claims were archived.
 */
export async function archiveFinishedEvents(opts: { days?: number; nowMs?: number } = {}): Promise<number> {
  const nowMs = opts.nowMs ?? Date.now();
  const days = opts.days ?? 60;
  const from = new Date(nowMs - days * 86400_000).toISOString().slice(0, 10);
  const to = new Date(nowMs - 86400_000).toISOString().slice(0, 10);
  const due: string[] = [];
  const { data: ts } = await db().from("tournaments").select("id, status, ends_on, timezone, updated_at").gte("ends_on", from).lte("ends_on", to).limit(500);
  for (const t of (ts ?? []) as { id: string; status: string | null; ends_on: string | null; timezone: string | null; updated_at: string | null }[]) {
    const at = archiveAt({ endsOn: t.ends_on, timezone: t.timezone, status: t.status, completedAt: t.status === "completed" ? t.updated_at : null });
    if (at !== null && at <= nowMs) due.push(t.id);
  }
  // Friendly sessions: their day is their start, their completion the finalisation.
  const since = new Date(nowMs - days * 86400_000).toISOString();
  const { data: ss } = await db().from("friendly_sessions").select("tournament_id, starts_at, finalized_at").gte("finalized_at", since).limit(500);
  for (const s of (ss ?? []) as { tournament_id: string; starts_at: string | null; finalized_at: string | null }[]) {
    const day = s.starts_at ? new Date(Date.parse(s.starts_at) + 2 * 3600_000).toISOString().slice(0, 10) : null;
    const at = archiveAt({ endsOn: day, timezone: "Africa/Cairo", status: "completed", completedAt: s.finalized_at });
    if (at !== null && at <= nowMs) due.push(s.tournament_id);
  }
  let n = 0;
  const stamp = new Date(nowMs).toISOString();
  for (const tid of due) {
    const { data: ps } = await db().from("players").select("id").eq("tournament_id", tid).limit(3000);
    const ids = ((ps ?? []) as { id: string }[]).map((p) => p.id);
    for (let i = 0; i < ids.length; i += 200) {
      const { data: changed } = await db().from("player_claims").update({ archived_at: stamp }).in("player_id", ids.slice(i, i + 200)).is("archived_at", null).select("player_id");
      n += (changed ?? []).length;
    }
  }
  return n;
}

/** Online payments whose checkout expired without a word from Move Tick. */
export async function expireStalePayments(nowMs = Date.now()): Promise<number> {
  const { data } = await db()
    .from("registration_payments")
    .update({ status: "expired", updated_at: new Date(nowMs).toISOString() })
    .in("status", ["created", "open"])
    .lt("expires_at", new Date(nowMs - 3600_000).toISOString())
    .select("id");
  return (data ?? []).length;
}
