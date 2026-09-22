import type { ScoringLease } from "./types";

/**
 * Pure, framework-free logic for the scoring-control lease — the half of
 * `src/lib/scoringControl.ts` that has no `db()` call in it, split out so a
 * client component can safely import it.
 *
 * `src/lib/supabase.ts` reads the service-role key from `SUPABASE_KEY`, a
 * non-`NEXT_PUBLIC_` env var — AGENTS.md is explicit that this key must never
 * reach the browser. `scoringControl.ts` imports `db` from there at module
 * scope, so anything that file exports drags the whole Supabase client into
 * a client bundle the moment a `"use client"` file imports it — even a
 * function, like `defaultDeviceLabel`, that never calls `db()` itself. The
 * referee page's `useScoringControl` hook needs a couple of these pure
 * pieces; it must import them from here, never from `scoringControl.ts`.
 */

export const LEASE_TTL_MS = 15_000;
export const LEASE_RENEW_MS = 5_000;

export function isLeaseLive(lease: ScoringLease | null | undefined, nowMs: number): boolean {
  if (!lease) return false;
  if (lease.released_at) return false;
  return Date.parse(lease.expires_at) > nowMs;
}

/** A short, stable stand-in for a device that never typed a name in. */
export function defaultDeviceLabel(deviceId: string): string {
  const tail = deviceId.replace(/-/g, "").slice(-4).toUpperCase();
  return tail ? `Device ${tail}` : "Another device";
}

/** Trims, bounds and falls back a client-supplied label so it never trips the DB's own length check. */
export function sanitizeLabel(raw: unknown, deviceId: string): string {
  const trimmed = typeof raw === "string" ? raw.trim().slice(0, 60) : "";
  return trimmed || defaultDeviceLabel(deviceId);
}
