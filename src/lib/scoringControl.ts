import { db } from "./supabase";
import { LEASE_RENEW_MS, LEASE_TTL_MS, defaultDeviceLabel, isLeaseLive, sanitizeLabel } from "./scoringLease";
import type { ScoringLease, ScoringTransferRequest } from "./types";

/**
 * Who may score a match, as a renewable lease rather than a permanent lock.
 *
 * Replaces `matches.active_scoring_device_id`, which — once a device claimed
 * it — stayed claimed until the match finished or an admin force-released it.
 * Two referees had no way to hand a match between themselves; a second device
 * just saw a frozen, read-only screen.
 *
 * A lease is **live** while `released_at` is null and `expires_at` is in the
 * future. The controlling device renews it every `LEASE_RENEW_MS`; three
 * missed renewals (`LEASE_TTL_MS`) and it goes stale on its own — at which
 * point the very next claim just succeeds, because nobody is there to ask.
 * While a lease *is* live, a second device can only request it: the holder
 * alone may accept or decline (`respondTransfer`), matched by `device_id`.
 *
 * Every write here uses the same optimistic-concurrency guard
 * `src/lib/screens.ts` already uses for `screen_settings.revision`: condition
 * the write on the row exactly as read, and on a miss — someone else won the
 * same race — re-read and report the truth instead of silently overwriting it.
 *
 * The pure pieces (`isLeaseLive`, the TTL constants, the label helpers) live
 * in `src/lib/scoringLease.ts`, re-exported below, so a client component can
 * import them without dragging this file's `db()` import — and the Supabase
 * client behind it — into the browser bundle. Import from here on the server;
 * import from `scoringLease.ts` from a `"use client"` file, always.
 */

export { LEASE_TTL_MS, LEASE_RENEW_MS, isLeaseLive, defaultDeviceLabel, sanitizeLabel };

export interface LeaseHolder {
  deviceId: string;
  deviceLabel: string | null;
  renewedAt: string;
  expiresAt: string;
}

function holderOf(lease: ScoringLease | null | undefined): LeaseHolder | null {
  if (!lease) return null;
  return {
    deviceId: lease.device_id,
    deviceLabel: lease.device_label,
    renewedAt: lease.renewed_at,
    expiresAt: lease.expires_at,
  };
}

export async function getLease(matchId: string): Promise<ScoringLease | null> {
  const { data } = await db().from("scoring_leases").select("*").eq("match_id", matchId).maybeSingle();
  return (data as ScoringLease | null) ?? null;
}

export type ClaimResult = { ok: true; lease: ScoringLease } | { ok: false; holder: LeaseHolder };

/**
 * The write behind every reassignment: takes `existing` — the row exactly as
 * read by the caller, or null — and hands the lease to `deviceId` for a fresh
 * full term, keyed to that read so a concurrent write loses the race cleanly.
 * Deliberately does **not** check who currently holds a live lease: that
 * decision belongs to each caller, because it differs between them —
 * `claimLease` refuses when someone else's lease is live, while
 * `respondTransfer`'s accept path calls this on behalf of the *requester*
 * after establishing, separately, that the device answering really is the
 * live holder. Reusing `claimLease` there was the original design, and it was
 * wrong: `claimLease(requesterId)` sees the holder's still-live lease and
 * refuses its own reassignment.
 */
async function writeLease(
  existing: ScoringLease | null,
  matchId: string,
  tournamentId: string,
  deviceId: string,
  deviceLabel: string | null,
  nowMs: number,
): Promise<ScoringLease | null> {
  const nowIso = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + LEASE_TTL_MS).toISOString();

  if (!existing) {
    const { data, error } = await db()
      .from("scoring_leases")
      .insert({
        match_id: matchId,
        tournament_id: tournamentId,
        device_id: deviceId,
        device_label: deviceLabel,
        acquired_at: nowIso,
        renewed_at: nowIso,
        expires_at: expiresAt,
        revision: 0,
      })
      .select()
      .maybeSingle();
    if (error) {
      // 23505: another device's simultaneous first claim won the unique
      // constraint on match_id. Anything else is a genuine failure.
      if (error.code !== "23505") throw new Error(error.message);
      return null;
    }
    return (data as ScoringLease | null) ?? null;
  }

  const mine = existing.device_id === deviceId;
  const { data, error } = await db()
    .from("scoring_leases")
    .update({
      device_id: deviceId,
      device_label: deviceLabel,
      acquired_at: mine ? existing.acquired_at : nowIso,
      renewed_at: nowIso,
      expires_at: expiresAt,
      released_at: null,
      transfer_request: null,
      revision: existing.revision + 1,
    })
    .eq("id", existing.id)
    .eq("revision", existing.revision)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ScoringLease | null) ?? null;
}

/**
 * Claims a match's lease for `deviceId`.
 *
 * Succeeds immediately, no approval, whenever there is no live lease held by
 * someone else — matching "if there is no one opening the scoring session…
 * take control immediately." Refused, with the current holder's label, only
 * when a *different* device's lease is live: that lease can only change hands
 * through `requestTransfer` / `respondTransfer`, never by a second claim.
 */
export async function claimLease(
  matchId: string,
  tournamentId: string,
  deviceId: string,
  deviceLabel: string | null,
): Promise<ClaimResult> {
  const nowMs = Date.now();
  const existing = await getLease(matchId);
  const mine = existing?.device_id === deviceId;

  if (existing && isLeaseLive(existing, nowMs) && !mine) {
    return { ok: false, holder: holderOf(existing)! };
  }

  const written = await writeLease(existing, matchId, tournamentId, deviceId, deviceLabel, nowMs);
  if (written) return { ok: true, lease: written };

  // A race landed between the read above and the write: either another
  // device's simultaneous first claim, or another write beat this one to an
  // existing row. Either way, re-read and report the truth.
  const fresh = await getLease(matchId);
  if (fresh?.device_id === deviceId) return { ok: true, lease: fresh };
  return {
    ok: false,
    holder: holderOf(fresh) ?? holderOf(existing) ?? { deviceId: "unknown", deviceLabel: null, renewedAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs).toISOString() },
  };
}

export type RenewResult = { ok: true; lease: ScoringLease } | { ok: false; reason: "not_holder" | "not_found" };

/** Extends the current holder's lease. Refused if `deviceId` is not the holder — the caller should stop treating itself as one. */
export async function renewLease(matchId: string, deviceId: string): Promise<RenewResult> {
  const existing = await getLease(matchId);
  if (!existing) return { ok: false, reason: "not_found" };
  if (existing.device_id !== deviceId) return { ok: false, reason: "not_holder" };

  const nowMs = Date.now();
  const { data, error } = await db()
    .from("scoring_leases")
    .update({
      renewed_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + LEASE_TTL_MS).toISOString(),
      revision: existing.revision + 1,
    })
    .eq("id", existing.id)
    .eq("revision", existing.revision)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data) return { ok: true, lease: data as ScoringLease };

  // Lost a race with a concurrent write (a request being answered, say). The
  // next poll sees the truth; nothing to renew from this stale a read.
  const fresh = await getLease(matchId);
  if (fresh?.device_id === deviceId) return { ok: true, lease: fresh };
  return { ok: false, reason: "not_holder" };
}

export type RequestTransferResult = { ok: true } | { ok: false; reason: "no_live_lease" | "already_holder" };

/** A read-only device asks the current holder for control. Last request wins — no queue of several pending asks. */
export async function requestTransfer(
  matchId: string,
  deviceId: string,
  deviceLabel: string | null,
): Promise<RequestTransferResult> {
  const existing = await getLease(matchId);
  const nowMs = Date.now();
  if (!isLeaseLive(existing, nowMs)) return { ok: false, reason: "no_live_lease" };
  if (existing!.device_id === deviceId) return { ok: false, reason: "already_holder" };

  const request: ScoringTransferRequest = { deviceId, deviceLabel, requestedAt: new Date(nowMs).toISOString() };
  await db().from("scoring_leases").update({ transfer_request: request }).eq("id", existing!.id);
  return { ok: true };
}

export type RespondTransferResult =
  | { ok: true; accepted: true; lease: ScoringLease }
  | { ok: true; accepted: false }
  | { ok: false; reason: "not_holder" | "no_request" };

/**
 * The current holder answers a pending request. Accept reassigns the lease to
 * the requester directly via `writeLease` — a fresh full term, which clears
 * `transfer_request` as part of that write — deliberately **not** through
 * `claimLease`: called as the requester, `claimLease` would see this same
 * still-live lease (it hasn't been reassigned yet) and refuse its own
 * reassignment. Ownership is already established above (`existing.device_id
 * === deviceId`), so no second check is needed here. Decline just clears the
 * request and changes nothing else.
 */
export async function respondTransfer(
  matchId: string,
  tournamentId: string,
  deviceId: string,
  accept: boolean,
): Promise<RespondTransferResult> {
  const existing = await getLease(matchId);
  if (!existing || existing.device_id !== deviceId) return { ok: false, reason: "not_holder" };
  const request = existing.transfer_request;
  if (!request) return { ok: false, reason: "no_request" };

  if (!accept) {
    await db()
      .from("scoring_leases")
      .update({ transfer_request: null, revision: existing.revision + 1 })
      .eq("id", existing.id)
      .eq("revision", existing.revision);
    return { ok: true, accepted: false };
  }

  const written = await writeLease(existing, matchId, tournamentId, request.deviceId, request.deviceLabel, Date.now());
  if (!written) {
    // Lost a race with some other write in the instant between (the holder's
    // own renewal heartbeat landing at the same moment, say) — vanishingly
    // unlikely, and safe to ask the holder to just try again.
    return { ok: false, reason: "no_request" };
  }
  return { ok: true, accepted: true, lease: written };
}

export type ReleaseResult = { ok: true } | { ok: false; reason: "not_holder" };

/** The holder gives control up on purpose — a clean handover at a changeover, without waiting out the TTL. */
export async function releaseLease(matchId: string, deviceId: string): Promise<ReleaseResult> {
  const existing = await getLease(matchId);
  if (!existing || existing.device_id !== deviceId) return { ok: false, reason: "not_holder" };
  await db()
    .from("scoring_leases")
    .update({ released_at: new Date().toISOString(), transfer_request: null, revision: existing.revision + 1 })
    .eq("id", existing.id)
    .eq("revision", existing.revision);
  return { ok: true };
}

/** Ends a match's lease outright — it finished, or an admin force-released it. */
export async function endLease(matchId: string): Promise<void> {
  await db().from("scoring_leases").delete().eq("match_id", matchId);
}

/** Every lease in a tournament, for a bulk live-data reset. */
export async function endLeasesForTournament(tournamentId: string): Promise<void> {
  await db().from("scoring_leases").delete().eq("tournament_id", tournamentId);
}

/** Every currently-live lease in a tournament, keyed by match id — for the admin matches list. */
export async function getLiveLeasesByMatch(tournamentId: string): Promise<Map<string, ScoringLease>> {
  const { data } = await db().from("scoring_leases").select("*").eq("tournament_id", tournamentId);
  const nowMs = Date.now();
  const map = new Map<string, ScoringLease>();
  for (const row of (data ?? []) as ScoringLease[]) {
    if (isLeaseLive(row, nowMs)) map.set(row.match_id, row);
  }
  return map;
}
