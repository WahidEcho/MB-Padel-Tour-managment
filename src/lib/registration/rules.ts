/**
 * Registration and payment rules (plan Phase 9). Pure: shared with the Move Score
 * app through move-score-app/src/core/index.ts, and with the server
 * (./server.ts), which alone decides amounts, statuses and refunds.
 *
 * Owner decisions (DECISIONS.md § 8, final):
 *   - register in Move Score, pay through Move Tick; pay at the venue otherwise;
 *   - online payment only for the Move Beyond organisation (others: free or pay at
 *     the venue), and only while Move Tick is configured;
 *   - approval: "first paid, first in" by default (approval_mode "on_payment"): an
 *     entry is confirmed, with no organiser step, the moment its full online amount
 *     is paid. Only paid entries (and short checkout holds) take a place. The
 *     organiser may still approve each entry instead ("organiser");
 *   - entry: individual, team or both (the player picks) per event;
 *   - who pays for a team: the registering player pays for everyone ("registrant"),
 *     or each player their share ("each_player": the registrant's share online, the
 *     partners' at the venue);
 *   - refunds are always 100 % (Move Beyond absorbs the card fee), until 24 h before
 *     the event's start time (tournaments.starts_at); flagged payments at any time.
 *
 * Money is integer minor units (piastres) everywhere; EGP only.
 */
import { zonedToIso } from "../tennis/ties";

/** What one entry is. */
export type EntryType = "individual" | "team";
/** What an event takes: one kind of entry, or both (the player picks). */
export type EntrySetting = EntryType | "both";
export type ApprovalMode = "on_payment" | "organiser";
export type PaymentSetting = "free" | "online" | "venue" | "online_or_venue";
export type TeamPayer = "registrant" | "each_player";
export type PaymentChoice = "free" | "online" | "venue";
export type RegistrationStatus = "unconfirmed" | "pending_approval" | "awaiting_payment" | "confirmed" | "refused" | "cancelled" | "refunded";

export const REGISTRATION_STATUSES: readonly RegistrationStatus[] = ["unconfirmed", "pending_approval", "awaiting_payment", "confirmed", "refused", "cancelled", "refunded"];
/**
 * Live entries: they block a second entry by the same account (or the same
 * verified email) for the event. Not all of them hold a place: see holdsPlace.
 * "unconfirmed" (a web guest who has not opened the emailed link yet) is not live.
 */
export const LIVE_STATUSES: readonly RegistrationStatus[] = ["pending_approval", "awaiting_payment", "confirmed"];

/** Organiser mode only: how long an approved entry waiting for its online payment keeps its place. */
export const PAYMENT_HOLD_MS = 24 * 3600_000;
/**
 * How long opening a Move Tick checkout keeps a place: 15 minutes, the lifetime of
 * a Move Tick partner checkout (docs/move-tick-partner-api.md). Taken only while a
 * place is free; it ends when the checkout is paid, fails or expires. In organiser
 * mode a checkout made in the approval hold's last 15 minutes stretches that hold
 * to the checkout's length, never past approval + 24 h + 15 min.
 */
export const CHECKOUT_HOLD_MS = 15 * 60_000;
/** Checkouts one entry may open in 24 hours (each takes a hold): a place cannot be kept by pressing Pay all day. */
export const CHECKOUTS_PER_DAY = 6;
/** How long a web guest's emailed confirmation link works. */
export const GUEST_CONFIRM_MS = 24 * 3600_000;

/**
 * Whether an entry counts toward the event's capacity: confirmed, or waiting for
 * its payment inside a hold (a checkout's 15 minutes, or an organiser approval's
 * 24 hours). An unpaid "first paid, first in" entry and a request waiting for the
 * organiser never do, so nobody can fill an event without paying (the database
 * trigger registration_capacity_guard, 0030, applies the same rule atomically).
 */
export function holdsPlace(r: { status: RegistrationStatus; hold_until?: string | null }, now = Date.now()): boolean {
  if (r.status === "confirmed") return true;
  return r.status === "awaiting_payment" && typeof r.hold_until === "string" && Date.parse(r.hold_until) > now;
}

export const CURRENCY = "EGP";
/** Refunds stop this long before the event starts. */
export const REFUND_CUTOFF_MS = 24 * 3600_000;
/** A finished event's links are archived this long after it ended. */
export const ARCHIVE_AFTER_MS = 24 * 3600_000;
/** The largest fee per player (minor units): 100,000 EGP. */
export const MAX_FEE = 10_000_000;

export interface RegistrationSettings {
  open: boolean;
  entryType: EntrySetting;
  /** Players per team entry (team or both); individual entry is always 1. */
  teamSize: number;
  approvalMode: ApprovalMode;
  /** Per player, minor units. */
  feeAmount: number;
  currency: typeof CURRENCY;
  payment: PaymentSetting;
  teamPayer: TeamPayer;
  /**
   * The most entries, or null: teams for team or both entry (a solo player fills
   * one of a team's places), players for individual entry. Counted in players
   * (capacitySeats), so two solo players paired fill exactly one team's place.
   */
  capacity: number | null;
  closesAt: string | null;
  note: string | null;
}

/** Closed, first paid first in, registrant pays for the team. */
export const DEFAULT_REGISTRATION_SETTINGS: RegistrationSettings = {
  open: false,
  entryType: "team",
  teamSize: 2,
  approvalMode: "on_payment",
  feeAmount: 0,
  currency: CURRENCY,
  payment: "free",
  teamPayer: "registrant",
  capacity: null,
  closesAt: null,
  note: null,
};

const int = (v: unknown, min: number, max: number, fallback: number) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};
const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);

/**
 * Settings from a database row (snake_case) or an already-shaped object
 * (camelCase), cleaned: anything unknown or out of range falls back to the
 * default. The old "automatic" approval reads as "on_payment" (it replaced it);
 * an old stored refund_fee_percent is ignored (refunds are always in full).
 */
export function registrationSettings(raw: unknown): RegistrationSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_REGISTRATION_SETTINGS };
  const r = raw as Record<string, unknown>;
  const pick = (camel: string, snake: string) => (camel in r ? r[camel] : r[snake]);
  const d = DEFAULT_REGISTRATION_SETTINGS;
  const entryType = oneOf(pick("entryType", "entry_type"), ["individual", "team", "both"] as const, d.entryType);
  const approvalRaw = pick("approvalMode", "approval_mode");
  const feeAmount = int(pick("feeAmount", "fee_amount"), 0, MAX_FEE, 0);
  const closes = pick("closesAt", "closes_at");
  const closesAt = typeof closes === "string" && Number.isFinite(Date.parse(closes)) ? new Date(Date.parse(closes)).toISOString() : null;
  const cap = pick("capacity", "capacity");
  const capRaw = cap === null || cap === undefined || cap === "" ? null : Number(cap);
  const capacity = capRaw !== null && Number.isFinite(capRaw) && capRaw >= 1 ? Math.min(2000, Math.round(capRaw)) : null;
  const note = pick("note", "note");
  let payment = oneOf(pick("payment", "payment"), ["free", "online", "venue", "online_or_venue"] as const, d.payment);
  if (feeAmount === 0) payment = "free";
  else if (payment === "free") payment = "venue";
  return {
    open: pick("open", "open") === true,
    entryType,
    teamSize: entryType === "individual" ? 1 : int(pick("teamSize", "team_size"), 2, 8, 2),
    approvalMode: approvalRaw === "automatic" ? "on_payment" : oneOf(approvalRaw, ["on_payment", "organiser"] as const, d.approvalMode),
    feeAmount,
    currency: CURRENCY,
    payment,
    teamPayer: oneOf(pick("teamPayer", "team_payer"), ["registrant", "each_player"] as const, d.teamPayer),
    capacity,
    closesAt,
    note: typeof note === "string" && note.trim() ? note.trim().slice(0, 1000) : null,
  };
}

/** The settings as a database row (for registration_settings). */
export function storedRegistrationSettings(s: RegistrationSettings): Record<string, unknown> {
  return {
    open: s.open,
    entry_type: s.entryType,
    team_size: s.teamSize,
    approval_mode: s.approvalMode,
    fee_amount: s.feeAmount,
    currency: s.currency,
    payment: s.payment,
    team_payer: s.teamPayer,
    capacity: s.capacity,
    closes_at: s.closesAt,
    note: s.note,
  };
}

/** How many people one entry names: a team entry (the default for team or both events) or a solo one. */
export function peoplePerEntry(s: Pick<RegistrationSettings, "entryType" | "teamSize">, kind?: EntryType): number {
  const k = kind ?? (s.entryType === "individual" ? "individual" : "team");
  return k === "individual" ? 1 : Math.max(2, s.teamSize);
}

/** The kinds of entry a player may pick for this event. */
export function entryKinds(s: Pick<RegistrationSettings, "entryType">): EntryType[] {
  return s.entryType === "both" ? ["team", "individual"] : [s.entryType];
}

/**
 * The entry kind a registration asked for: the event's own kind, or for "both" the
 * one picked (or, when nothing was picked, the one the number of people names).
 * Null when the event does not take that kind.
 */
export function entryKindFor(s: Pick<RegistrationSettings, "entryType">, picked: unknown, peopleCount: number): EntryType | null {
  if (s.entryType !== "both") return picked === undefined || picked === null || picked === s.entryType ? s.entryType : null;
  if (picked === "individual" || picked === "team") return picked;
  if (picked !== undefined && picked !== null) return null;
  return peopleCount === 1 ? "individual" : "team";
}

/** Players per place: 1 for individual entry, the team size for team or both entry. */
export function seatsPerPlace(s: Pick<RegistrationSettings, "entryType" | "teamSize">): number {
  return s.entryType === "individual" ? 1 : Math.max(2, s.teamSize);
}

/** The capacity in players (null: no limit). A team takes teamSize of them, a solo player one. */
export function capacitySeats(s: Pick<RegistrationSettings, "entryType" | "teamSize" | "capacity">): number | null {
  return s.capacity === null ? null : s.capacity * seatsPerPlace(s);
}

/** The smallest entry this event takes, in players. */
function smallestEntry(s: Pick<RegistrationSettings, "entryType" | "teamSize">): number {
  return s.entryType === "team" ? Math.max(2, s.teamSize) : 1;
}

/** Whether an entry of `people` players fits next to `takenSeats` players already holding places. */
export function entryFits(s: Pick<RegistrationSettings, "entryType" | "teamSize" | "capacity">, takenSeats: number, people: number): boolean {
  const cap = capacitySeats(s);
  return cap === null || takenSeats + Math.max(1, people) <= cap;
}

/** The ways a player may pay for this event now. `onlineAvailable`: Move Beyond's event and Move Tick configured. */
export function paymentOptions(s: Pick<RegistrationSettings, "feeAmount" | "payment">, onlineAvailable: boolean): PaymentChoice[] {
  if (s.feeAmount <= 0 || s.payment === "free") return ["free"];
  const online = onlineAvailable && (s.payment === "online" || s.payment === "online_or_venue");
  const venue = s.payment === "venue" || s.payment === "online_or_venue" || !online;
  // Pay-at-venue fallback: when online payment is not available, the fee is paid at the venue.
  return [...(online ? (["online"] as const) : []), ...(venue ? (["venue"] as const) : [])];
}

/** What one entry costs, split into what is paid online now and what at the venue. Minor units. */
export function charges(
  s: Pick<RegistrationSettings, "feeAmount" | "teamPayer" | "entryType" | "teamSize">,
  choice: PaymentChoice,
  people = peoplePerEntry(s),
): { online: number; venue: number; total: number } {
  const total = Math.max(0, s.feeAmount) * Math.max(1, people);
  if (choice === "free" || total === 0) return { online: 0, venue: 0, total: 0 };
  if (choice === "venue") return { online: 0, venue: total, total };
  // Online: the registrant pays for everyone, or only their own share (the others pay at the venue).
  const own = s.teamPayer === "each_player" ? Math.max(0, s.feeAmount) : total;
  return { online: own, venue: total - own, total };
}

/**
 * The status a new entry starts in. Organiser mode: waiting for the organiser
 * (approval comes before payment, so nobody pays for a request that is turned
 * down). First paid, first in: waiting for its online payment (holding no place
 * until a checkout is opened), or confirmed at once when nothing is due online
 * (free, or paid at the venue) while a place is free.
 */
export function initialStatus(s: Pick<RegistrationSettings, "approvalMode">, amountOnline: number): RegistrationStatus {
  if (s.approvalMode === "organiser") return "pending_approval";
  return amountOnline > 0 ? "awaiting_payment" : "confirmed";
}

/** The status an organiser's approval leads to. */
export function statusAfterApproval(amountOnline: number, alreadyPaid: boolean): RegistrationStatus {
  return amountOnline > 0 && !alreadyPaid ? "awaiting_payment" : "confirmed";
}

/** Who may move a registration where. The server checks these before every conditional update. */
const TRANSITIONS: Record<RegistrationStatus, readonly RegistrationStatus[]> = {
  unconfirmed: ["pending_approval", "awaiting_payment", "confirmed", "cancelled"],
  pending_approval: ["awaiting_payment", "confirmed", "refused", "cancelled"],
  awaiting_payment: ["confirmed", "refused", "cancelled"],
  confirmed: ["refunded", "cancelled"],
  refused: [],
  cancelled: [],
  refunded: [],
};

export function canMove(from: RegistrationStatus, to: RegistrationStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Why registration is not taking entries now, or null. `takenSeats` counts the
 * players holding places (holdsPlace): full when not even the smallest entry fits.
 */
export function registrationClosedReason(
  s: Pick<RegistrationSettings, "open" | "closesAt" | "capacity" | "entryType" | "teamSize">,
  event: { status: string | null | undefined; startsAt?: string | null },
  takenSeats: number,
  now = Date.now(),
): "closed" | "deadline" | "full" | "finished" | null {
  if (!s.open) return "closed";
  if (event.status === "completed" || event.status === "archived") return "finished";
  if (s.closesAt && Date.parse(s.closesAt) <= now) return "deadline";
  if (event.startsAt && Date.parse(event.startsAt) <= now) return "deadline";
  if (!entryFits(s, takenSeats, smallestEntry(s))) return "full";
  return null;
}

export const CLOSED_MESSAGES: Record<NonNullable<ReturnType<typeof registrationClosedReason>>, string> = {
  closed: "Registration for this event is not open.",
  deadline: "Registration for this event has closed.",
  full: "This event is full.",
  finished: "This event has finished.",
};

/** The last moment a refund is allowed: 24 h before the start. Null when the start time is not set. */
export function refundCutoff(startsAt: string | null | undefined): number | null {
  if (!startsAt) return null;
  const at = Date.parse(startsAt);
  return Number.isFinite(at) ? at - REFUND_CUTOFF_MS : null;
}

export type RefundRefusal = "no_start_time" | "too_late" | "not_paid" | "already_refunded";

/** Whether a paid entry may be refunded now (the organiser's action; never automatic). */
export function refundAllowed(startsAt: string | null | undefined, now = Date.now()): { ok: true; cutoff: number } | { ok: false; reason: RefundRefusal; cutoff: number | null } {
  const cutoff = refundCutoff(startsAt);
  if (cutoff === null) return { ok: false, reason: "no_start_time", cutoff };
  if (now > cutoff) return { ok: false, reason: "too_late", cutoff };
  return { ok: true, cutoff };
}

export const REFUND_MESSAGES: Record<RefundRefusal, string> = {
  no_start_time: "Set the event's start time first: refunds are allowed until 24 hours before it.",
  too_late: "Refunds closed 24 hours before the event's start time.",
  not_paid: "Nothing was paid online for this entry.",
  already_refunded: "This entry was already refunded.",
};

/** What a refund gives back: always everything (Move Beyond absorbs the card fee). */
export function refundAmount(paid: number): number {
  return Math.max(0, paid);
}

/** The UTC instant a date's day ends in a time zone ("2026-11-02" in Cairo → 21:59:59.999Z). */
export function endOfDay(date: string, timeZone: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const iso = zonedToIso(`${date}T23:59`, timeZone || "Africa/Cairo");
  return iso ? Date.parse(iso) + 59_999 : null;
}

/**
 * When an event's player links (player_claims) are archived: 24 h after it ended,
 * where "ended" is the end of its last day in its time zone or its completion,
 * whichever is later. A running event is never archived; null = not yet known.
 */
export function archiveAt(e: { endsOn: string | null; timezone: string | null; status: string | null; completedAt: string | null }): number | null {
  if (e.status === "active" || e.status === "live") return null;
  const ends = e.endsOn ? endOfDay(e.endsOn, e.timezone ?? "Africa/Cairo") : null;
  const done = e.status === "completed" && e.completedAt && Number.isFinite(Date.parse(e.completedAt)) ? Date.parse(e.completedAt) : null;
  const candidates = [ends, done].filter((x): x is number => x !== null);
  if (!candidates.length) return null;
  return Math.max(...candidates) + ARCHIVE_AFTER_MS;
}

/** "EGP 250" / "EGP 250.50" from minor units. */
export function moneyLabel(minor: number, currency: string = CURRENCY): string {
  const major = Math.max(0, minor) / 100;
  return `${currency} ${Number.isInteger(major) ? major.toLocaleString("en-US") : major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Minor units from a typed major amount ("250", "250.5"); null when unreadable. */
export function minorFromMajor(text: string): number | null {
  const s = text.trim();
  if (s === "") return 0;
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

export const STATUS_LABELS: Record<RegistrationStatus, string> = {
  unconfirmed: "Waiting for the email to be confirmed",
  pending_approval: "Waiting for the organiser",
  awaiting_payment: "Waiting for payment",
  confirmed: "Confirmed",
  refused: "Not accepted",
  cancelled: "Cancelled",
  refunded: "Refunded",
};
