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

/**
 * The lease as `GET /api/matches/[id]/state` shows it to one caller. `heldByYou`
 * and `requestedByYou` are the server's own answer to "is that me?", worked out
 * from the device id the caller sends (`X-Device-Id`) or its install token.
 */
export interface SeenLease {
  deviceId: string;
  deviceLabel: string | null;
  isLive: boolean;
  heldByYou?: boolean;
  transferRequest: { deviceId: string; deviceLabel: string | null } | null;
  requestedByYou?: boolean;
}

/** One console's side of a lease: what it may do, and what it should say. */
export interface LeaseSideView {
  isController: boolean;
  heldByOther: boolean;
  holderLabel: string | null;
  incomingRequest: { deviceId: string; deviceLabel: string | null } | null;
  myRequestPending: boolean;
  /** Goes up each time this console gains control: it reloads the server's score then. */
  gained: number;
  /** This console was scoring and another device holds the match now (a handover, or its lease ran out). */
  lostTo: string | null;
}

export const NO_LEASE_VIEW: LeaseSideView = {
  isController: false,
  heldByOther: false,
  holderLabel: null,
  incomingRequest: null,
  myRequestPending: false,
  gained: 0,
  lostTo: null,
};

const OTHER = "another device";

/**
 * Who holds the match, from this console's side. The lease is this console's
 * when the server says so (`heldByYou`) or shows this console's own device id.
 * Comparing shown ids alone was the bug behind "it takes control from me": a
 * phone whose install token was missing or stale was shown its own lease under
 * a handle, so every poll took control away from the device that held it.
 */
export function nextLeaseView(prev: LeaseSideView, lease: SeenLease | null, me: string): LeaseSideView {
  const live = Boolean(lease?.isLive);
  const mine = live && (lease!.heldByYou === true || lease!.deviceId === me);
  const other = live && !mine;
  const label = other ? (lease!.deviceLabel ?? OTHER) : null;
  const asked = lease?.transferRequest ?? null;
  return {
    isController: mine,
    heldByOther: other,
    holderLabel: label,
    incomingRequest: mine && asked ? asked : null,
    myRequestPending: other && (lease!.requestedByYou === true || asked?.deviceId === me),
    gained: mine && !prev.isController ? prev.gained + 1 : prev.gained,
    lostTo: other ? (prev.isController ? label : prev.lostTo) : null,
  };
}

/** A claim came back. Refused while this console thought it was scoring: someone else holds the match now. */
export function claimedLeaseView(prev: LeaseSideView, controller: boolean, holderLabel: string | null): LeaseSideView {
  if (controller) {
    return {
      ...prev,
      isController: true,
      heldByOther: false,
      holderLabel: null,
      incomingRequest: null,
      myRequestPending: false,
      lostTo: null,
      gained: prev.isController ? prev.gained : prev.gained + 1,
    };
  }
  const label = holderLabel ?? OTHER;
  return { ...prev, isController: false, heldByOther: true, holderLabel: label, incomingRequest: null, lostTo: prev.isController ? label : prev.lostTo };
}

/**
 * Orders a console's looks at the lease. A poll that left before a claim,
 * release, request or answer came back describes the lease as it was before
 * that change, so applying it would undo what the change just did (the console
 * flips to read-only for one poll, then back). Polls are also applied in order.
 */
export function createLeaseOrder() {
  let epoch = 0;
  let seq = 0;
  let applied = 0;
  return {
    /** Call as a claim, release, request or answer goes out, and again when it comes back. */
    changed() {
      epoch++;
    },
    /** A poll goes out. */
    ask(): { epoch: number; seq: number } {
      return { epoch, seq: ++seq };
    },
    /** The poll came back: true when nothing changed since it left and no later poll was applied first. */
    fresh(t: { epoch: number; seq: number }): boolean {
      if (t.epoch !== epoch || t.seq <= applied) return false;
      applied = t.seq;
      return true;
    },
  };
}
