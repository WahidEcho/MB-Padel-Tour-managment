/**
 * Fixed-window rate limiting for public endpoints.
 *
 * This is the first unauthenticated write path in the app, so it needs a brake.
 * Backed by the `request_counters` table rather than in-memory state, because
 * serverless instances do not share memory and an in-memory limiter would reset
 * on every cold start.
 *
 * Deliberately simple. Read-then-write is not atomic, so two simultaneous
 * requests can each see the same count and both pass. At club-registration
 * volumes that is harmless — the limiter exists to stop scripted abuse and
 * accidental double-submits, not to enforce an exact quota.
 */
import { db } from "./supabase";

export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in the current window (never negative). */
  remaining: number;
  /** Seconds until the window resets. */
  retryAfterSeconds: number;
}

export interface RateLimitOptions {
  /** Stable identifier, e.g. `register:<slug>:<ip>`. */
  key: string;
  limit: number;
  windowSeconds: number;
}

export async function checkRateLimit({
  key,
  limit,
  windowSeconds,
}: RateLimitOptions): Promise<RateLimitResult> {
  const now = Date.now();

  const { data } = await db()
    .from("request_counters")
    .select("bucket_key, window_started_at, count")
    .eq("bucket_key", key)
    .maybeSingle();

  const row = data as { window_started_at: string; count: number } | null;
  const windowStart = row ? new Date(row.window_started_at).getTime() : 0;
  const windowAge = (now - windowStart) / 1000;
  const windowExpired = !row || windowAge >= windowSeconds;

  const nextCount = windowExpired ? 1 : row.count + 1;
  const nextWindowStart = windowExpired ? new Date(now).toISOString() : row!.window_started_at;

  await db()
    .from("request_counters")
    .upsert(
      { bucket_key: key, window_started_at: nextWindowStart, count: nextCount },
      { onConflict: "bucket_key" }
    );

  const elapsed = windowExpired ? 0 : windowAge;
  return {
    allowed: nextCount <= limit,
    remaining: Math.max(0, limit - nextCount),
    retryAfterSeconds: Math.max(1, Math.ceil(windowSeconds - elapsed)),
  };
}

/**
 * Best-effort client IP from proxy headers.
 * Spoofable, so it is a throttle input only — never an identity or an
 * authorisation signal.
 */
export function clientIpFrom(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return headers.get("x-real-ip")?.trim() || "unknown";
}

/** Housekeeping: drop counter rows whose window is long gone. */
export async function pruneRateLimitCounters(olderThanSeconds = 86400): Promise<void> {
  const cutoff = new Date(Date.now() - olderThanSeconds * 1000).toISOString();
  await db().from("request_counters").delete().lt("window_started_at", cutoff);
}
