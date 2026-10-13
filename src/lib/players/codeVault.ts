/**
 * Player codes at rest (migration 0024). Server-only (node:crypto).
 *
 * A player code is looked up by HMAC-SHA256(PLAYER_CODE_PEPPER, "mb-player-code:v1:" + code)
 * (players.access_code_hash), never by the code itself, so a copy of the players
 * table cannot be used to sign in as anyone. The organiser still shows, prints and
 * sends each player their code: it is kept sealed (AES-256-GCM under a key derived
 * from the same pepper) in players.access_code_sealed, which only this server can
 * open. Neither the database nor a log ever holds a working code in clear once a
 * row has been hashed.
 *
 * Rows written before 0024, and new rows that took the column default
 * gen_player_access_code(), still carry the plain code in players.access_code until
 * `securePlayerCodes` hashes them: on first use, from the messaging cron every
 * minute, and all at once with scripts/ops/hash-player-codes.ts.
 *
 * The same pepper keys the phone one-time-code hashes and the email hashes of
 * organiser link offers, each with its own prefix so no value of one kind can stand
 * in for another. Changing the pepper voids every hashed code (reset them all).
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt } from "node:crypto";
import { db } from "../supabase";
import { isValidAccessCode, newAccessCode } from "./accessCode";

/** Whether SUPABASE_URL points at this machine (the stand-in), or at no database at all (unit tests). */
export function localDatabase(url: string | undefined): boolean {
  if (!url) return true;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/**
 * The pepper. Required in production (32+ characters, never in the database).
 * Without it, a checkout derives one from AUTH_SECRET, but only against a local
 * database (the stand-in) or none: a development run pointed at a real project
 * would otherwise hash that project's codes, irreversibly, under the wrong pepper.
 */
export function playerCodePepper(env: Record<string, string | undefined> = process.env): string {
  const p = env.PLAYER_CODE_PEPPER;
  if (p && p.length >= 32) return p;
  if (env.NODE_ENV === "production") throw new CodesUnavailable("PLAYER_CODE_PEPPER must be set (32+ characters) in production");
  if (!localDatabase(env.SUPABASE_URL)) throw new CodesUnavailable("PLAYER_CODE_PEPPER must be set (32+ characters) for a database that is not local");
  return createHmac("sha256", env.AUTH_SECRET ?? "mb-dev-only").update("mb-player-code-pepper:v1").digest("base64url");
}

/** Thrown when the pepper is missing in production: codes can be neither checked nor issued. */
export class CodesUnavailable extends Error {}

/** Whether codes can be checked here (the pepper is set). */
export function codesReady(env: Record<string, string | undefined> = process.env): boolean {
  try {
    playerCodePepper(env);
    return true;
  } catch {
    return false;
  }
}

const hmacHex = (pepper: string, text: string) => createHmac("sha256", pepper).update(text).digest("hex");

/** What players.access_code_hash holds for a normalised code. */
export function hashPlayerCode(normalized: string, pepper = playerCodePepper()): string {
  return hmacHex(pepper, `mb-player-code:v1:${normalized}`);
}

/** A phone one-time code's hash, bound to its verification row. */
export function hashOneTimeCode(verificationId: string, code: string, pepper = playerCodePepper()): string {
  return hmacHex(pepper, `mb-phone-otp:v1:${verificationId}:${code}`);
}

/** A contact (an email address, a phone number) as a lookup key or rate-limit bucket that never holds it in clear. */
export function contactHash(kind: "email" | "phone", value: string, pepper = playerCodePepper()): string {
  return hmacHex(pepper, `mb-contact:v1:${kind}:${value.trim().toLowerCase()}`);
}

function sealKey(pepper: string): Buffer {
  return createHmac("sha256", pepper).update("mb-player-code-seal:v1").digest();
}

/** "v1.<iv>.<tag>.<body>" (base64url). */
export function sealPlayerCode(code: string, pepper = playerCodePepper()): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", sealKey(pepper), iv);
  const body = Buffer.concat([c.update(code, "utf8"), c.final()]);
  return ["v1", iv, c.getAuthTag(), body].map((b) => (typeof b === "string" ? b : b.toString("base64url"))).join(".");
}

/** The code, or null when the value is not a seal made with this pepper. */
export function openPlayerCode(sealed: string | null | undefined, pepper?: string): string | null {
  if (!sealed) return null;
  try {
    const [v, iv, tag, body] = sealed.split(".");
    if (v !== "v1" || !iv || !tag || !body) return null;
    const authTag = Buffer.from(tag, "base64url");
    // A full 16-byte tag only: a truncated one would be far easier to forge.
    if (authTag.length !== 16) return null;
    const d = createDecipheriv("aes-256-gcm", sealKey(pepper ?? playerCodePepper()), Buffer.from(iv, "base64url"), { authTagLength: 16 });
    d.setAuthTag(authTag);
    const code = Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
    return isValidAccessCode(code) ? code : null;
  } catch {
    return null;
  }
}

/** The code columns of a players row. */
export interface CodeColumns {
  access_code?: string | null;
  access_code_hash?: string | null;
  access_code_sealed?: string | null;
}

export const CODE_COLUMNS = "access_code, access_code_hash, access_code_sealed";

/** Whether the row has a code at all (plain, not hashed yet, or hashed). */
export const hasCode = (r: CodeColumns) => Boolean(r.access_code || r.access_code_hash);

/** The code to show or send the organiser's player, or null (none, or sealed under another pepper). */
export function revealCode(r: CodeColumns): string | null {
  if (r.access_code) return r.access_code;
  try {
    return openPlayerCode(r.access_code_sealed);
  } catch {
    return null;
  }
}

/** A short, non-reversible tag of a code (idempotency keys, logs): never the code. */
export function codeFingerprint(code: string): string {
  try {
    return hashPlayerCode(code).slice(0, 16);
  } catch {
    return "nopepper";
  }
}

/**
 * Hashes and seals rows that still hold a plain code, and clears the plain column.
 * Each row is updated only while its plain code is the one read (compare-and-set),
 * so a reset at the same moment wins. Returns how many rows were hashed. A no-op
 * (0) when the pepper is missing.
 */
export async function securePlayerCodes(opts: { ids?: string[]; tournamentId?: string; limit?: number } = {}): Promise<number> {
  if (!codesReady()) return 0;
  let q = db().from("players").select("id, access_code").not("access_code", "is", null).limit(Math.min(opts.limit ?? 500, 1000));
  if (opts.ids) {
    if (!opts.ids.length) return 0;
    q = q.in("id", opts.ids.slice(0, 1000));
  }
  if (opts.tournamentId) q = q.eq("tournament_id", opts.tournamentId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  let done = 0;
  for (const r of (data ?? []) as { id: string; access_code: string }[]) {
    const { data: upd, error: e } = await db()
      .from("players")
      .update({ access_code_hash: hashPlayerCode(r.access_code), access_code_sealed: sealPlayerCode(r.access_code), access_code: null })
      .eq("id", r.id)
      .eq("access_code", r.access_code)
      .select("id");
    if (e) {
      // Another row already hashed to the same value (a 1-in-10^12 clash): leave this one plain and say so.
      if (/duplicate|unique|23505/i.test(e.message)) console.error("[player-codes] hash clash; row left unhashed", r.id);
      else throw new Error(e.message);
    } else if (upd?.length) done++;
  }
  return done;
}

/**
 * A new code for one player, hashed and sealed (no plain copy). Does not touch the
 * links; resetPlayerCode (claims.ts) is the organiser's reset, which also unlinks.
 */
export async function issuePlayerCode(playerId: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newAccessCode(randomInt);
    const { error } = await db()
      .from("players")
      .update({ access_code: null, access_code_hash: hashPlayerCode(code), access_code_sealed: sealPlayerCode(code), updated_at: new Date().toISOString() })
      .eq("id", playerId);
    if (!error) return code;
    if (!/duplicate|unique|23505/i.test(error.message)) throw new Error(error.message);
  }
  throw new Error("Could not make a unique code. Try again.");
}
