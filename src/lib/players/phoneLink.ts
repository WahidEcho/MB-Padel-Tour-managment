/**
 * Linking history with a phone one-time code (Phase 1). Server-only.
 *
 *  1. start   POST /me/player/phone/start { phone }: a 6-digit code goes to the phone
 *             on WhatsApp (authentication template, src/lib/messaging/otp.ts). The
 *             answer is the same whether or not any entry has that number.
 *  2. email   POST /me/player/phone/email { verificationId }: only after the app
 *             asked the player (WhatsApp failed, or the code never came): a new code
 *             goes to the email addresses the organisers recorded with that phone.
 *             The answer never says whether there was one.
 *  3. verify  POST /me/player/phone/verify { verificationId, code }: right code →
 *             the entries recorded with that phone (or whose profile has it) are
 *             linked, or, when several people share the phone (a parent's number for
 *             two children), the player picks who they are:
 *  4. choose  POST /me/player/phone/choose { verificationId, choiceId }.
 *
 * Codes: 6 digits, 10 minutes, 5 attempts, only a keyed hash stored
 * (codeVault.hashOneTimeCode), compared in constant time. Limits per phone, per
 * account and per network address. Signed-in accounts only (any kind, including a
 * player-code account).
 */
import { randomInt, randomUUID } from "node:crypto";
import { db } from "../supabase";
import { checkRateLimit } from "../ratelimit";
import { safeEqual } from "../auth/safeEqual";
import { sendOneTimeCode } from "../messaging/queue";
import { normalizeEmail } from "../messaging/email";
import { CodesUnavailable, contactHash, hashOneTimeCode } from "./codeVault";
import { chooseOpen, newOneTimeCode, normalizeOneTimeCode, OTP_MAX_ATTEMPTS, OTP_TTL_MS, verificationOpen } from "./otp";
import { claimedRows, PLAYER_COLUMNS, type PlayerRow } from "./claims";
import { samePerson, normalizePersonName } from "./identity";
import { toE164 } from "./phone";
import { linkAccount } from "./link";
import type { MMyPlayer, MPhoneChoice } from "../mobile/contract";

export type Fail = { ok: false; status: number; error: string; code?: string };

export const WRONG_CODE = "That code didn't work. Check it and try again.";
const TOO_MANY = "Too many codes asked for. Wait a few minutes and try again.";

interface VerificationRow {
  id: string;
  auth_user_id: string;
  phone: string;
  code_hash: string;
  channel: "whatsapp" | "email";
  sent_ok: boolean | null;
  email_sent_at: string | null;
  expires_at: string;
  attempts: number;
  consumed_at: string | null;
}
const V_COLUMNS = "id, auth_user_id, phone, code_hash, channel, sent_ok, email_sent_at, expires_at, attempts, consumed_at";

async function limited(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  return !(await checkRateLimit({ key, limit, windowSeconds })).allowed;
}

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
    phoneKey = contactHash("phone", phone).slice(0, 32);
  } catch (e) {
    if (e instanceof CodesUnavailable) return { ok: false, status: 503, error: "Phone codes aren't available right now. Try again later." };
    throw e;
  }
  // Per phone (short and daily), per account, per network address.
  if (
    (await limited(`otp:p:${phoneKey}`, 3, 900)) ||
    (await limited(`otp:pd:${phoneKey}`, 8, 86_400)) ||
    (await limited(`otp:u:${userId}`, 5, 900)) ||
    (await limited(`otp:ud:${userId}`, 15, 86_400)) ||
    (await limited(`otp:ip:${ip}`, 30, 3600))
  ) {
    return { ok: false, status: 429, error: TOO_MANY };
  }
  const now = Date.now();
  // Only the newest code for this phone works.
  await db().from("phone_verifications").update({ expires_at: new Date(now).toISOString() }).eq("auth_user_id", userId).eq("phone", phone).is("consumed_at", null);
  const id = randomUUID();
  const code = newOneTimeCode(randomInt);
  const expiresAt = new Date(now + OTP_TTL_MS).toISOString();
  const { data: prof } = await db().from("player_profiles").select("id").eq("auth_user_id", userId).maybeSingle();
  const { error } = await db()
    .from("phone_verifications")
    .insert({ id, auth_user_id: userId, player_profile_id: (prof as { id: string } | null)?.id ?? null, phone, code_hash: hashOneTimeCode(id, code), channel: "whatsapp", expires_at: expiresAt });
  if (error) throw new Error(error.message);
  const sent = await sendOneTimeCode({ channel: "whatsapp", to: phone, code });
  await db().from("phone_verifications").update({ sent_ok: sent.ok }).eq("id", id);
  return { ok: true, verificationId: id, phone, channel: "whatsapp", sent: sent.ok, expiresAt };
}

/* ---------------- 2. email, after asking ---------------- */

/** The email addresses organisers recorded with this phone (the entries' own, then their profiles'). */
async function emailsForPhone(phone: string): Promise<string[]> {
  const [{ data: rows }, { data: profs }] = await Promise.all([
    db().from("players").select("email").eq("phone", phone).not("email", "is", null).limit(20),
    db().from("player_profiles").select("email").eq("mobile_normalized", phone).not("email", "is", null).limit(5),
  ]);
  const all = [...((rows ?? []) as { email: string }[]), ...((profs ?? []) as { email: string }[])].map((r) => normalizeEmail(r.email)).filter((x): x is string => Boolean(x));
  return [...new Set(all)].slice(0, 3);
}

export type EmailResult = { ok: true; expiresAt: string } | Fail;

/**
 * The player said yes: the code goes by email instead. A new code (the WhatsApp one
 * stops working), the same 10 minutes from now, attempts carried over. Once per
 * verification. The same answer whether or not an address was on file.
 */
export async function emailPhoneCode(userId: string, verificationId: unknown, ip: string): Promise<EmailResult> {
  const v = await verificationOf(userId, verificationId);
  if (!v) return { ok: false, status: 404, error: "Ask for a new code first." };
  if (verificationOpen(v) !== "open") return { ok: false, status: 410, error: "That code has expired. Ask for a new one.", code: "expired" };
  if (v.email_sent_at) return { ok: false, status: 409, error: "We already tried your email for this code. Ask for a new code if it didn't arrive.", code: "email_sent" };
  if ((await limited(`otp:e:${userId}`, 3, 3600)) || (await limited(`otp:eip:${ip}`, 20, 3600))) return { ok: false, status: 429, error: TOO_MANY };
  const code = newOneTimeCode(randomInt);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
  const { data: upd } = await db()
    .from("phone_verifications")
    .update({ code_hash: hashOneTimeCode(v.id, code), channel: "email", email_sent_at: new Date().toISOString(), expires_at: expiresAt })
    .eq("id", v.id)
    .is("email_sent_at", null)
    .is("consumed_at", null)
    .select("id");
  if (!upd?.length) return { ok: false, status: 409, error: "We already tried your email for this code. Ask for a new code if it didn't arrive.", code: "email_sent" };
  for (const to of await emailsForPhone(v.phone)) await sendOneTimeCode({ channel: "email", to, code });
  return { ok: true, expiresAt };
}

/* ---------------- 3. verify, 4. choose ---------------- */

/** Everyone recorded with this phone, one group per person (identity.ts), leaving out rows another account holds. */
async function peopleWithPhone(userId: string, phone: string): Promise<PlayerRow[][]> {
  const { data: profs } = await db().from("player_profiles").select("id").eq("mobile_normalized", phone).neq("approval_status", "merged").limit(5);
  const profileIds = ((profs ?? []) as { id: string }[]).map((p) => p.id);
  const [{ data: byPhone }, { data: byProfile }] = await Promise.all([
    db().from("players").select(PLAYER_COLUMNS).eq("phone", phone).limit(200),
    profileIds.length ? db().from("players").select(PLAYER_COLUMNS).in("player_profile_id", profileIds).limit(200) : Promise.resolve({ data: [] }),
  ]);
  const rows = new Map<string, PlayerRow>();
  for (const r of [...((byPhone ?? []) as PlayerRow[]), ...((byProfile ?? []) as PlayerRow[])]) rows.set(r.id, r);
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
  | { ok: true; phone: string; linked: { player: MMyPlayer; linked: number } | null; choose: MPhoneChoice[] | null; message: string | null }
  | (Fail & { attemptsLeft?: number });

async function linkGroup(userId: string, phone: string, group: PlayerRow[]) {
  return linkAccount(userId, group, { kind: "phone", phone });
}

export async function verifyPhoneCode(userId: string, verificationId: unknown, rawCode: unknown, ip: string): Promise<VerifyResult> {
  if (await limited(`otp:vip:${ip}`, 60, 3600)) return { ok: false, status: 429, error: "Too many tries. Wait a few minutes and try again." };
  const v = await verificationOf(userId, verificationId);
  const code = normalizeOneTimeCode(rawCode);
  if (!v) return { ok: false, status: 400, error: WRONG_CODE };
  const verdict = verificationOpen(v);
  if (verdict === "used") return { ok: false, status: 409, error: "This code was already used.", code: "used" };
  if (verdict !== "open") return { ok: false, status: 410, error: verdict === "locked" ? "Too many wrong codes. Ask for a new one." : "That code has expired. Ask for a new one.", code: verdict };
  // Count the attempt before comparing (compare-and-set), so parallel guesses each cost one.
  const { data: counted } = await db().from("phone_verifications").update({ attempts: v.attempts + 1 }).eq("id", v.id).eq("attempts", v.attempts).is("consumed_at", null).select("id");
  if (!counted?.length) return { ok: false, status: 409, error: "Try again in a moment.", code: "busy" };
  const right = code !== null && safeEqual(hashOneTimeCode(v.id, code), v.code_hash);
  if (!right) {
    const left = Math.max(0, OTP_MAX_ATTEMPTS - (v.attempts + 1));
    return { ok: false, status: 400, error: left ? WRONG_CODE : "Too many wrong codes. Ask for a new one.", attemptsLeft: left };
  }
  const { data: used } = await db().from("phone_verifications").update({ consumed_at: new Date().toISOString() }).eq("id", v.id).is("consumed_at", null).select("id");
  if (!used?.length) return { ok: false, status: 409, error: "This code was already used.", code: "used" };
  return afterVerified(userId, v.phone);
}

async function afterVerified(userId: string, phone: string): Promise<VerifyResult> {
  const groups = await peopleWithPhone(userId, phone);
  if (!groups.length) {
    return { ok: true, phone, linked: null, choose: null, message: "Your number is confirmed, but no tournament has entered a player with it yet. Ask the tournament desk, or enter your player code." };
  }
  // Already linked: the group with the account's own name.
  const mine = await claimedRows(userId);
  const named = mine.length ? groups.filter((g) => g.some((r) => normalizePersonName(r.full_name) === normalizePersonName(mine[0]!.full_name))) : [];
  const pick = groups.length === 1 ? groups[0]! : named.length === 1 ? named[0]! : null;
  if (!pick) return { ok: true, phone, linked: null, choose: await choicesOf(groups), message: null };
  const r = await linkGroup(userId, phone, pick);
  if (!r.ok) return r;
  return { ok: true, phone, linked: { player: r.player, linked: r.linked }, choose: null, message: null };
}

export async function choosePhonePerson(userId: string, verificationId: unknown, choiceId: unknown): Promise<VerifyResult> {
  const v = await verificationOf(userId, verificationId);
  if (!v || !chooseOpen(v)) return { ok: false, status: 410, error: "That code has expired. Ask for a new one.", code: "expired" };
  const groups = await peopleWithPhone(userId, v.phone);
  const group = typeof choiceId === "string" ? groups.find((g) => g.some((r) => r.id === choiceId)) : undefined;
  if (!group) return { ok: false, status: 404, error: "That entry isn't on this number any more." };
  const r = await linkGroup(userId, v.phone, group);
  if (!r.ok) return r;
  return { ok: true, phone: v.phone, linked: { player: r.player, linked: r.linked }, choose: null, message: null };
}

/** Housekeeping (messaging cron): verifications older than a day go. */
export async function pruneVerifications(): Promise<void> {
  await db().from("phone_verifications").delete().lt("created_at", new Date(Date.now() - 86_400_000).toISOString());
}
