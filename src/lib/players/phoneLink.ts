/**
 * Linking history with a phone one-time code (Phase 1). Server-only.
 *
 *  1. start   POST /me/player/phone/start { phone }: a 6-digit code goes to the phone
 *             on WhatsApp (authentication template, src/lib/messaging/otp.ts). The
 *             answer is the same whether or not any entry has that number.
 *  2. email   POST /me/player/phone/email { verificationId, consent: true }: only
 *             after the app asked the player (WhatsApp failed, or the code never
 *             came): a new code goes to the ACCOUNT'S OWN confirmed email, and only
 *             when an organiser recorded that address with that phone (on an entry,
 *             or on the profile that has the number). Never to any other address on
 *             file: whoever controls an address an organiser typed is not thereby the
 *             owner of the phone. The answer never says whether it was on file, and
 *             the send happens after the answer (timing says nothing either).
 *  3. verify  POST /me/player/phone/verify { verificationId, code }: right code →
 *             WhatsApp (the phone itself): the entries recorded with that phone (or
 *             whose profile has it) are linked, or, when several people share the
 *             phone (a parent's number for two children), the player picks who they
 *             are. Email: the code proved the address, not the phone, so only
 *             entries recorded with BOTH that phone and that address are linked, a
 *             profile only when the address is the profile's own, and the number is
 *             never marked confirmed.
 *  4. choose  POST /me/player/phone/choose { verificationId, choiceId }.
 *
 * Codes: 6 digits, 10 minutes, 5 attempts, only a keyed hash stored
 * (codeVault.hashOneTimeCode), compared in constant time. Limits per phone, per
 * account and per network address, counted atomically before the work
 * (takeRateLimit); at most OPEN_PER_PHONE codes open for one phone across all
 * accounts, and WRONG_PER_PHONE wrong guesses per phone per day across all
 * verifications and accounts. Signed-in accounts only (any kind, including a
 * player-code account; the email fallback needs a confirmed email).
 *
 * The number a player types in the app (PATCH /me/player) is stored apart
 * (players.self_reported_phone) and never looked up here.
 */
import { randomInt, randomUUID } from "node:crypto";
import { db } from "../supabase";
import { refundRateLimit, takeRateLimit } from "../ratelimit";
import { safeEqual } from "../auth/safeEqual";
import { sendOneTimeCode } from "../messaging/queue";
import { CodesUnavailable, contactHash, hashOneTimeCode } from "./codeVault";
import { chooseOpen, newOneTimeCode, normalizeOneTimeCode, OTP_MAX_ATTEMPTS, OTP_TTL_MS, verificationOpen } from "./otp";
import { claimedRows, PLAYER_COLUMNS, type PlayerRow } from "./claims";
import { samePerson, normalizePersonName } from "./identity";
import { toE164 } from "./phone";
import { linkAccount } from "./link";
import { confirmedEmail } from "./suggestions";
import type { MMyPlayer, MPhoneChoice } from "../mobile/contract";

export type Fail = { ok: false; status: number; error: string; code?: string };

export const WRONG_CODE = "That code didn't work. Check it and try again.";
const TOO_MANY = "Too many codes asked for. Wait a few minutes and try again.";

/** Codes open at once for one phone, across every account. */
export const OPEN_PER_PHONE = 2;
/** Wrong guesses per phone per day, across every verification and account. */
export const WRONG_PER_PHONE = 10;
const WRONG_WINDOW = 86_400;

interface VerificationRow {
  id: string;
  auth_user_id: string;
  phone: string;
  code_hash: string;
  channel: "whatsapp" | "email";
  sent_ok: boolean | null;
  email_sent_at: string | null;
  email_hash: string | null;
  expires_at: string;
  attempts: number;
  consumed_at: string | null;
}
const V_COLUMNS = "id, auth_user_id, phone, code_hash, channel, sent_ok, email_sent_at, email_hash, expires_at, attempts, consumed_at";

/** Counts this request (atomically, before the work); true when the bucket is full. */
async function limited(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  return !(await takeRateLimit({ key, limit, windowSeconds })).allowed;
}

const phoneKeyOf = (phone: string) => contactHash("phone", phone).slice(0, 32);
const sameEmail = (a: string | null | undefined, email: string) => (a ?? "").trim().toLowerCase() === email;

/** The caller's own verification, or null (another account's is "not found" too). */
async function verificationOf(userId: string, id: unknown): Promise<VerificationRow | null> {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await db().from("phone_verifications").select(V_COLUMNS).eq("id", id).eq("auth_user_id", userId).maybeSingle();
  return (data as VerificationRow | null) ?? null;
}

/* ---------------- 1. start ---------------- */

export type StartResult = { ok: true; verificationId: string; phone: string; channel: "whatsapp"; sent: boolean; expiresAt: string } | Fail;

export async function startPhoneVerification(userId: string, rawPhone: unknown, ip: string): Promise<StartResult> {
  const phone = typeof rawPhone === "string" && rawPhone.length <= 40 ? toE164(rawPhone) : null;
  if (!phone) return { ok: false, status: 400, error: "That doesn't look like a mobile number. Include the country code if it isn't Egyptian, e.g. +44 7700 900123." };
  let phoneKey: string;
  try {
    phoneKey = phoneKeyOf(phone);
  } catch (e) {
    if (e instanceof CodesUnavailable) return { ok: false, status: 503, error: "Phone codes aren't available right now. Try again later." };
    throw e;
  }
  // Per network address and account first (so one account cannot spend a phone's
  // budget once it is over its own), then per phone, short and daily. Atomic: a burst
  // of parallel starts cannot all see the same count.
  if (
    (await limited(`otp:ip:${ip}`, 30, 3600)) ||
    (await limited(`otp:u:${userId}`, 5, 900)) ||
    (await limited(`otp:ud:${userId}`, 15, 86_400)) ||
    (await limited(`otp:p:${phoneKey}`, 3, 900)) ||
    (await limited(`otp:pd:${phoneKey}`, 8, 86_400))
  ) {
    return { ok: false, status: 429, error: TOO_MANY };
  }
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  // This account's earlier codes for the phone stop working.
  await db().from("phone_verifications").update({ expires_at: nowIso }).eq("auth_user_id", userId).eq("phone", phone).is("consumed_at", null).gt("expires_at", nowIso);
  // Every account together: only a few codes open at once for one phone.
  const { count: open } = await db()
    .from("phone_verifications")
    .select("id", { count: "exact", head: true })
    .eq("phone", phone)
    .is("consumed_at", null)
    .gt("expires_at", nowIso)
    .lt("attempts", OTP_MAX_ATTEMPTS);
  if ((open ?? 0) >= OPEN_PER_PHONE) return { ok: false, status: 429, error: TOO_MANY };
  const id = randomUUID();
  const code = newOneTimeCode(randomInt);
  const expiresAt = new Date(now + OTP_TTL_MS).toISOString();
  const { data: prof } = await db().from("player_profiles").select("id").eq("auth_user_id", userId).maybeSingle();
  const { error } = await db()
    .from("phone_verifications")
    .insert({ id, auth_user_id: userId, player_profile_id: (prof as { id: string } | null)?.id ?? null, phone, code_hash: hashOneTimeCode(id, code), channel: "whatsapp", expires_at: expiresAt });
  if (error) throw new Error(error.message);
  // Two starts at once by this account: only the newest stays open (both calls agree which).
  const { data: mine } = await db()
    .from("phone_verifications")
    .select("id, created_at")
    .eq("auth_user_id", userId)
    .eq("phone", phone)
    .is("consumed_at", null)
    .gt("expires_at", nowIso)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });
  const older = ((mine ?? []) as { id: string }[]).slice(1).map((r) => r.id);
  if (older.length) await db().from("phone_verifications").update({ expires_at: new Date().toISOString() }).in("id", older);
  // Starts from several accounts at once all counted before any was written: the oldest
  // OPEN_PER_PHONE stay, a later one is closed again before its code goes anywhere.
  const { data: openNow } = await db()
    .from("phone_verifications")
    .select("id")
    .eq("phone", phone)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .lt("attempts", OTP_MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(20);
  const keep = ((openNow ?? []) as { id: string }[]).slice(0, OPEN_PER_PHONE).map((r) => r.id);
  if (!keep.includes(id)) {
    await db().from("phone_verifications").update({ expires_at: new Date().toISOString() }).eq("id", id);
    return { ok: false, status: 429, error: TOO_MANY };
  }
  const sent = await sendOneTimeCode({ channel: "whatsapp", to: phone, code });
  await db().from("phone_verifications").update({ sent_ok: sent.ok }).eq("id", id);
  return { ok: true, verificationId: id, phone, channel: "whatsapp", sent: sent.ok, expiresAt };
}

/* ---------------- 2. email, after asking ---------------- */

/**
 * Whether an organiser recorded this address with this phone: on an entry (both on
 * the same row), or on the profile that has the number. A number the player typed
 * in the app (players.self_reported_phone) is not looked at.
 */
export async function emailOnFileForPhone(phone: string, email: string): Promise<boolean> {
  const [{ data: rows }, { data: profs }] = await Promise.all([
    db().from("players").select("email").eq("phone", phone).not("email", "is", null).limit(200),
    db().from("player_profiles").select("email, approval_status").eq("mobile_normalized", phone).not("email", "is", null).limit(5),
  ]);
  if (((rows ?? []) as { email: string }[]).some((r) => sameEmail(r.email, email))) return true;
  return ((profs ?? []) as { email: string; approval_status: string }[]).some((p) => p.approval_status !== "merged" && sameEmail(p.email, email));
}

/** "m•••@example.com": the account's own address, for the app's "sent to" line. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "your email";
  return `${local.slice(0, 1)}•••@${domain}`;
}

export type EmailResult = { ok: true; expiresAt: string; to: string; send: (() => Promise<unknown>) | null } | Fail;

/**
 * The player said yes: the code goes by email instead. A new code (the WhatsApp one
 * stops working), the same 10 minutes from now, attempts carried over. Once per
 * verification. Only to the account's own confirmed address, and only when it is on
 * file for the phone; the answer is the same either way, and the caller sends
 * (`send`) after answering, so the answer's timing says nothing either.
 */
export async function emailPhoneCode(userId: string, accessToken: string, verificationId: unknown, ip: string): Promise<EmailResult> {
  const v = await verificationOf(userId, verificationId);
  if (!v) return { ok: false, status: 404, error: "Ask for a new code first." };
  if (verificationOpen(v) !== "open") return { ok: false, status: 410, error: "That code has expired. Ask for a new one.", code: "expired" };
  if (v.email_sent_at) return { ok: false, status: 409, error: "We already tried your email for this code. Ask for a new code if it didn't arrive.", code: "email_sent" };
  const email = await confirmedEmail(accessToken);
  if (!email) return { ok: false, status: 409, error: "Your account has no confirmed email address. Add one in Account, or ask the tournament desk for your player code.", code: "no_email" };
  if ((await limited(`otp:e:${userId}`, 3, 3600)) || (await limited(`otp:eip:${ip}`, 20, 3600))) return { ok: false, status: 429, error: TOO_MANY };
  const code = newOneTimeCode(randomInt);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
  const { data: upd } = await db()
    .from("phone_verifications")
    .update({ code_hash: hashOneTimeCode(v.id, code), channel: "email", email_hash: contactHash("email", email), email_sent_at: new Date().toISOString(), expires_at: expiresAt })
    .eq("id", v.id)
    .is("email_sent_at", null)
    .is("consumed_at", null)
    .select("id");
  if (!upd?.length) return { ok: false, status: 409, error: "We already tried your email for this code. Ask for a new code if it didn't arrive.", code: "email_sent" };
  // Not on file: the new code goes nowhere (and the WhatsApp one no longer works), same answer.
  const onFile = await emailOnFileForPhone(v.phone, email);
  return { ok: true, expiresAt, to: maskEmail(email), send: onFile ? () => sendOneTimeCode({ channel: "email", to: email, code }) : null };
}

/* ---------------- 3. verify, 4. choose ---------------- */

/**
 * Everyone this verification reaches, one group per person (identity.ts), leaving out
 * rows another account holds. WhatsApp (the phone itself): rows recorded with the
 * phone, and the rows of profiles whose mobile it is. Email (`email` set: the code
 * proved the account's address, not the phone): only rows recorded with both the
 * phone and that address, so what one organisation typed on its own rows never
 * reaches another organisation's.
 */
async function peopleWithPhone(userId: string, phone: string, email: string | null): Promise<PlayerRow[][]> {
  const rows = new Map<string, PlayerRow>();
  const { data: byPhone } = await db().from("players").select(PLAYER_COLUMNS).eq("phone", phone).limit(200);
  for (const r of (byPhone ?? []) as PlayerRow[]) if (email === null || sameEmail(r.email, email)) rows.set(r.id, r);
  if (email === null) {
    const { data: profs } = await db().from("player_profiles").select("id").eq("mobile_normalized", phone).neq("approval_status", "merged").limit(5);
    const profileIds = ((profs ?? []) as { id: string }[]).map((p) => p.id);
    const { data: byProfile } = profileIds.length ? await db().from("players").select(PLAYER_COLUMNS).in("player_profile_id", profileIds).limit(200) : { data: [] };
    for (const r of (byProfile ?? []) as PlayerRow[]) rows.set(r.id, r);
  }
  if (!rows.size) return [];
  const { data: held } = await db().from("player_claims").select("player_id, user_id").in("player_id", [...rows.keys()]);
  for (const h of (held ?? []) as { player_id: string; user_id: string }[]) if (h.user_id !== userId) rows.delete(h.player_id);
  // Group: same profile, or same name and a shared contact (they all share the phone, so: same name).
  const keyed = (r: PlayerRow) => ({ ...r, phone: r.phone ?? phone });
  const groups: PlayerRow[][] = [];
  for (const r of rows.values()) {
    const g = groups.find((x) => x.some((y) => samePerson(keyed(y), keyed(r))));
    if (g) g.push(r);
    else groups.push([r]);
  }
  return groups;
}

async function choicesOf(groups: PlayerRow[][]): Promise<MPhoneChoice[]> {
  const tids = [...new Set(groups.flat().map((r) => r.tournament_id))];
  const { data } = tids.length ? await db().from("tournaments").select("id, name, starts_on").in("id", tids) : { data: [] };
  const tour = new Map(((data ?? []) as { id: string; name: string; starts_on: string | null }[]).map((t) => [t.id, t]));
  return groups.map((g) => ({
    choiceId: g[0]!.id,
    name: g[0]!.full_name,
    entries: [...new Set(g.map((r) => tour.get(r.tournament_id)?.name).filter((x): x is string => Boolean(x)))].slice(0, 6),
  }));
}

export type VerifyResult =
  | { ok: true; phone: string; confirmed: "phone" | "email"; linked: { player: MMyPlayer; linked: number } | null; choose: MPhoneChoice[] | null; message: string | null }
  | (Fail & { attemptsLeft?: number });

/** What a checked verification proved: the phone (WhatsApp), or the account's address (email), or nothing any more. */
async function proofOf(v: VerificationRow, accessToken: string): Promise<{ email: string | null } | null> {
  if (v.channel !== "email") return { email: null };
  const email = await confirmedEmail(accessToken);
  // The code went to the address the account had then; a changed address proves nothing.
  if (!email || !v.email_hash || !safeEqual(contactHash("email", email), v.email_hash)) return null;
  return { email };
}

async function linkGroup(userId: string, phone: string, email: string | null, group: PlayerRow[]) {
  return linkAccount(userId, group, email === null ? { kind: "phone", phone } : { kind: "email", email });
}

export async function verifyPhoneCode(userId: string, accessToken: string, verificationId: unknown, rawCode: unknown, ip: string): Promise<VerifyResult> {
  if (await limited(`otp:vip:${ip}`, 60, 3600)) return { ok: false, status: 429, error: "Too many tries. Wait a few minutes and try again." };
  const v = await verificationOf(userId, verificationId);
  const code = normalizeOneTimeCode(rawCode);
  if (!v) return { ok: false, status: 400, error: WRONG_CODE };
  const verdict = verificationOpen(v);
  if (verdict === "used") return { ok: false, status: 409, error: "This code was already used.", code: "used" };
  if (verdict !== "open") return { ok: false, status: 410, error: verdict === "locked" ? "Too many wrong codes. Ask for a new one." : "That code has expired. Ask for a new one.", code: verdict };
  // Every guess at this phone counts, whichever account or verification it comes through
  // (a right one is given back), so new verifications cannot buy endless guesses.
  const guessBucket = { key: `otp:pf:${phoneKeyOf(v.phone)}`, windowSeconds: WRONG_WINDOW };
  if (!(await takeRateLimit({ ...guessBucket, limit: WRONG_PER_PHONE })).allowed) {
    return { ok: false, status: 429, error: "Too many wrong codes for this number. Try again tomorrow, or ask the tournament desk for your player code.", code: "phone_locked" };
  }
  // Count the attempt before comparing (compare-and-set), so parallel guesses each cost one.
  const { data: counted } = await db().from("phone_verifications").update({ attempts: v.attempts + 1 }).eq("id", v.id).eq("attempts", v.attempts).is("consumed_at", null).select("id");
  if (!counted?.length) {
    await refundRateLimit(guessBucket);
    return { ok: false, status: 409, error: "Try again in a moment.", code: "busy" };
  }
  const right = code !== null && safeEqual(hashOneTimeCode(v.id, code), v.code_hash);
  if (!right) {
    const left = Math.max(0, OTP_MAX_ATTEMPTS - (v.attempts + 1));
    return { ok: false, status: 400, error: left ? WRONG_CODE : "Too many wrong codes. Ask for a new one.", attemptsLeft: left };
  }
  await refundRateLimit(guessBucket);
  const { data: used } = await db().from("phone_verifications").update({ consumed_at: new Date().toISOString() }).eq("id", v.id).is("consumed_at", null).select("id");
  if (!used?.length) return { ok: false, status: 409, error: "This code was already used.", code: "used" };
  const proof = await proofOf(v, accessToken);
  if (!proof) return { ok: false, status: 410, error: "Your account's email changed since the code was sent. Ask for a new one.", code: "expired" };
  return afterVerified(userId, v.phone, proof.email);
}

async function afterVerified(userId: string, phone: string, email: string | null): Promise<VerifyResult> {
  const confirmed = email === null ? "phone" : "email";
  const groups = await peopleWithPhone(userId, phone, email);
  if (!groups.length) {
    return {
      ok: true,
      phone,
      confirmed,
      linked: null,
      choose: null,
      message:
        email === null
          ? "Your number is confirmed, but no tournament has entered a player with it yet. Ask the tournament desk, or enter your player code."
          : "Your email is confirmed, but no tournament has entered a player with this number and your email together. Ask the tournament desk, or enter your player code.",
    };
  }
  // Already linked: the group with the account's own name.
  const mine = await claimedRows(userId);
  const named = mine.length ? groups.filter((g) => g.some((r) => normalizePersonName(r.full_name) === normalizePersonName(mine[0]!.full_name))) : [];
  const pick = groups.length === 1 ? groups[0]! : named.length === 1 ? named[0]! : null;
  if (!pick) return { ok: true, phone, confirmed, linked: null, choose: await choicesOf(groups), message: null };
  const r = await linkGroup(userId, phone, email, pick);
  if (!r.ok) return r;
  return { ok: true, phone, confirmed, linked: { player: r.player, linked: r.linked }, choose: null, message: null };
}

export async function choosePhonePerson(userId: string, accessToken: string, verificationId: unknown, choiceId: unknown): Promise<VerifyResult> {
  const v = await verificationOf(userId, verificationId);
  if (!v || !chooseOpen(v)) return { ok: false, status: 410, error: "That code has expired. Ask for a new one.", code: "expired" };
  const proof = await proofOf(v, accessToken);
  if (!proof) return { ok: false, status: 410, error: "That code has expired. Ask for a new one.", code: "expired" };
  const groups = await peopleWithPhone(userId, v.phone, proof.email);
  const group = typeof choiceId === "string" ? groups.find((g) => g.some((r) => r.id === choiceId)) : undefined;
  if (!group) return { ok: false, status: 404, error: "That entry isn't on this number any more." };
  const r = await linkGroup(userId, v.phone, proof.email, group);
  if (!r.ok) return r;
  return { ok: true, phone: v.phone, confirmed: proof.email === null ? "phone" : "email", linked: { player: r.player, linked: r.linked }, choose: null, message: null };
}

/** Housekeeping (messaging cron): verifications older than a day go. */
export async function pruneVerifications(): Promise<void> {
  await db().from("phone_verifications").delete().lt("created_at", new Date(Date.now() - 86_400_000).toISOString());
}
