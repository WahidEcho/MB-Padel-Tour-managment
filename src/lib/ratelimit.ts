/**
 * Fixed-window rate limiting for public endpoints.
 *
 * This is the first unauthenticated write path in the app, so it needs a brake.
 * Backed by the `request_counters` table rather than in-memory state, because
 * serverless instances do not share memory and an in-memory limiter would reset
 * on every cold start.
 *
 * `checkRateLimit` is deliberately simple. Read-then-write is not atomic, so two
 * simultaneous requests can each see the same count and both pass. At
 * club-registration volumes that is harmless — it exists to stop scripted abuse
 * and accidental double-submits, not to enforce an exact quota. Brakes on
 * guessing secrets (staff sign-in) use the atomic `takeRateLimit` instead.
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

/* ---------------- atomic: count first, refund later ---------------- */

/** The supabase client, narrowed to what the atomic counter needs (tests pass a fake). */
type CounterClient = Pick<ReturnType<typeof db>, "from">;

interface CounterRow {
  window_started_at: string;
  count: number;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Counts this request against a bucket **before** the work it guards, atomically:
 * every write is a compare-and-set on the row as it was read (PostgREST filters on
 * `count` and `window_started_at`, so two requests can never both turn 7 into 8),
 * and a new bucket is created with `on conflict do nothing`. No RPC, so the same
 * code runs on the live project and on the local stand-in. When the bucket is
 * full nothing is written and the request is refused. Under heavy contention it
 * retries a few times, then refuses (fails closed) rather than letting a burst
 * through uncounted. Pair it with `refundRateLimit` to count only failures.
 */
export async function takeRateLimit(
  { key, limit, windowSeconds }: RateLimitOptions,
  client: CounterClient = db(),
  tries = 12,
): Promise<RateLimitResult & { taken: boolean }> {
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) await pause(4 + Math.floor(Math.random() * 12 * attempt));
    const now = Date.now();
    const { data, error } = await client.from("request_counters").select("window_started_at, count").eq("bucket_key", key).maybeSingle();
    if (error) break;
    const row = data as CounterRow | null;
    const startIso = new Date(now).toISOString();
    if (!row) {
      const { data: made } = await client
        .from("request_counters")
        .upsert({ bucket_key: key, window_started_at: startIso, count: 1 }, { onConflict: "bucket_key", ignoreDuplicates: true })
        .select("bucket_key");
      if ((made as unknown[] | null)?.length) return { taken: true, allowed: limit >= 1, remaining: Math.max(0, limit - 1), retryAfterSeconds: windowSeconds };
      continue; // someone else made it first: read it again
    }
    const age = (now - new Date(row.window_started_at).getTime()) / 1000;
    const expired = !(age < windowSeconds);
    if (!expired && row.count >= limit) {
      return { taken: false, allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(windowSeconds - age)) };
    }
    const next = expired ? { window_started_at: startIso, count: 1 } : { count: row.count + 1 };
    const { data: changed } = await client
      .from("request_counters")
      .update(next)
      .eq("bucket_key", key)
      .eq("window_started_at", row.window_started_at)
      .eq("count", row.count)
      .select("bucket_key");
    if ((changed as unknown[] | null)?.length) {
      const count = expired ? 1 : row.count + 1;
      return {
        taken: true,
        allowed: count <= limit,
        remaining: Math.max(0, limit - count),
        retryAfterSeconds: Math.max(1, Math.ceil(expired ? windowSeconds : windowSeconds - age)),
      };
    }
  }
  // Contended (or the counter is unreachable): refuse rather than let it through uncounted.
  return { taken: false, allowed: false, remaining: 0, retryAfterSeconds: 2 };
}

/** Gives back one request taken with `takeRateLimit` (a sign-in that succeeded). Best effort. */
export async function refundRateLimit({ key, windowSeconds }: Pick<RateLimitOptions, "key" | "windowSeconds">, client: CounterClient = db(), tries = 6): Promise<void> {
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) await pause(4 + Math.floor(Math.random() * 10 * attempt));
    const { data } = await client.from("request_counters").select("window_started_at, count").eq("bucket_key", key).maybeSingle();
    const row = data as CounterRow | null;
    if (!row || row.count <= 0 || (Date.now() - new Date(row.window_started_at).getTime()) / 1000 >= windowSeconds) return;
    const { data: changed } = await client
      .from("request_counters")
      .update({ count: row.count - 1 })
      .eq("bucket_key", key)
      .eq("window_started_at", row.window_started_at)
      .eq("count", row.count)
      .select("bucket_key");
    if ((changed as unknown[] | null)?.length) return;
  }
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
