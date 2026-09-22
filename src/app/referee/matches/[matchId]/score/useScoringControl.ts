"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getDeviceId } from "@/lib/offline/db";
// From the pure module, never from "@/lib/scoringControl" — that file imports
// db() at module scope, which would pull the Supabase client (and the
// non-public key it reads) into this client bundle. See scoringLease.ts.
import { LEASE_RENEW_MS, defaultDeviceLabel } from "@/lib/scoringLease";
import type { Match, MatchSnapshot } from "@/lib/types";

/**
 * Who holds a match's scoring lease, and the request/accept/decline handoff
 * between two devices — see src/lib/scoringControl.ts for the state machine
 * this polls.
 *
 * Polls `GET /api/matches/[matchId]/state` on a self-re-arming timeout, the
 * same shape `useLiveFeed` (src/components/broadcast/hooks.ts) already uses
 * for the venue wall: a slow response cannot let requests pile up, and a
 * failed poll keeps the last good answer instead of flipping the page blank.
 * There is no Supabase Realtime channel behind this — see the note atop
 * src/lib/scoringControl.ts and AGENTS.md on why this app never ships a
 * public Supabase key.
 *
 * The same poll also carries the match and its snapshot, which fixes a real
 * gap: a read-only device used to freeze at whatever loaded on page-open and
 * never update. Feeding that back out is what lets the caller replace its own
 * static score state with a live one while read-only.
 */

export interface LeaseHolderInfo {
  deviceId: string;
  deviceLabel: string | null;
  renewedAt: string;
}

export interface TransferRequestInfo {
  deviceId: string;
  deviceLabel: string | null;
  requestedAt: string;
}

interface StatePayload {
  match: Match;
  snapshot: MatchSnapshot | null;
  lease:
    | null
    | {
        deviceId: string;
        deviceLabel: string | null;
        renewedAt: string;
        expiresAt: string;
        isLive: boolean;
        transferRequest: TransferRequestInfo | null;
      };
}

export interface ScoringControlState {
  /** False until the first claim or poll has answered. */
  ready: boolean;
  isController: boolean;
  heldByOther: boolean;
  holder: LeaseHolderInfo | null;
  /** I hold the lease and someone has asked for it. */
  incomingRequest: TransferRequestInfo | null;
  /** I asked for the lease and am waiting on an answer. */
  myRequestPending: boolean;
  /** The freshest look at the match and its score, from the same poll. */
  match: Match | null;
  snapshot: MatchSnapshot | null;
}

export interface ScoringControlActions {
  /**
   * Explicit "Take control" tap, and the page's first claim on mount.
   * Succeeds immediately if nobody else holds a live lease. `offlineFallback`
   * is what to assume if the request cannot even reach the server.
   */
  claim: (offlineFallback?: boolean) => Promise<boolean>;
  /** A clean handover, without waiting out the lease's own expiry. */
  release: () => Promise<void>;
  /** Ask the current holder. */
  requestControl: () => Promise<void>;
  /** The holder answers a pending request. */
  respond: (accept: boolean) => Promise<void>;
}

async function post(matchId: string, action: string, body: Record<string, unknown>) {
  try {
    const res = await fetch(`/api/matches/${matchId}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  } catch {
    return { ok: false, json: null };
  }
}

export function useScoringControl(
  matchId: string,
  opts: {
    initialMatch?: Match | null;
    initialSnapshot?: MatchSnapshot | null;
    /** Skip every claim and poll — a finished, non-reopenable match has nothing left to control. */
    disabled?: boolean;
    intervalMs?: number;
  } = {},
): ScoringControlState & ScoringControlActions {
  const { initialMatch = null, initialSnapshot = null, disabled = false, intervalMs = 3_000 } = opts;
  const deviceIdRef = useRef<string>("");
  const labelRef = useRef<string>("");

  const [state, setState] = useState<ScoringControlState>({
    ready: disabled,
    isController: false,
    heldByOther: false,
    holder: null,
    incomingRequest: null,
    myRequestPending: false,
    match: initialMatch,
    snapshot: initialSnapshot,
  });

  const applyLease = useCallback((data: StatePayload) => {
    const deviceId = deviceIdRef.current;
    const lease = data.lease;
    const isController = Boolean(lease && lease.isLive && lease.deviceId === deviceId);
    const heldByOther = Boolean(lease && lease.isLive && lease.deviceId !== deviceId);
    setState({
      ready: true,
      isController,
      heldByOther,
      holder: heldByOther && lease ? { deviceId: lease.deviceId, deviceLabel: lease.deviceLabel, renewedAt: lease.renewedAt } : null,
      incomingRequest: isController && lease?.transferRequest ? lease.transferRequest : null,
      myRequestPending: Boolean(heldByOther && lease?.transferRequest?.deviceId === deviceId),
      match: data.match,
      snapshot: data.snapshot,
    });
  }, []);

  /**
   * Claims the lease — the page's first call on mount, and every later
   * explicit "Take control" tap.
   *
   * `offlineFallback`: what to assume when the request itself fails outright
   * (no network at all, not a refusal). The caller decides this, because only
   * it knows whether this device already has unsynced local state for the
   * match — the strongest signal that it was the one scoring it.
   */
  const claim = useCallback(async (offlineFallback = false): Promise<boolean> => {
    const { ok, json } = await post(matchId, "claim", { deviceId: deviceIdRef.current, deviceLabel: labelRef.current });
    if (!ok || !json) {
      setState((s) => ({ ...s, ready: true, isController: offlineFallback, heldByOther: false, holder: null }));
      return offlineFallback;
    }
    if (json.controller) {
      setState((s) => ({ ...s, ready: true, isController: true, heldByOther: false, holder: null, incomingRequest: null, myRequestPending: false }));
      return true;
    }
    const holder = json.holder as LeaseHolderInfo | undefined;
    setState((s) => ({
      ...s,
      ready: true,
      isController: false,
      heldByOther: true,
      holder: holder ? { deviceId: holder.deviceId, deviceLabel: holder.deviceLabel, renewedAt: holder.renewedAt } : null,
    }));
    return false;
  }, [matchId]);

  const poll = useCallback(async () => {
    if (disabled) return;
    try {
      const res = await fetch(`/api/matches/${matchId}/state`, { cache: "no-store" });
      if (!res.ok) return; // Keep the last good look rather than blank the page over a blip.
      applyLease((await res.json()) as StatePayload);
    } catch {
      // Offline or unreachable — keep whatever the last successful poll said.
    }
  }, [matchId, disabled, applyLease]);

  const release = useCallback(async () => {
    await post(matchId, "release-lease", { deviceId: deviceIdRef.current });
    void poll();
  }, [matchId, poll]);

  const requestControl = useCallback(async () => {
    const { ok } = await post(matchId, "request-control", { deviceId: deviceIdRef.current, deviceLabel: labelRef.current });
    if (ok) setState((s) => ({ ...s, myRequestPending: true }));
  }, [matchId]);

  const respond = useCallback(
    async (accept: boolean) => {
      await post(matchId, "respond-control", { deviceId: deviceIdRef.current, accept });
      void poll();
    },
    [matchId, poll],
  );

  // ---------------- a self-re-arming poll loop ----------------
  // The first claim is the caller's to make (see `claim`'s doc comment above)
  // — this only keeps watching once that has happened. Device id and label are
  // set here rather than at module scope so they exist before that first call.
  useEffect(() => {
    deviceIdRef.current = getDeviceId();
    labelRef.current = defaultDeviceLabel(deviceIdRef.current);
    if (disabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      if (document.visibilityState === "visible") await poll();
      if (!cancelled) timer = setTimeout(tick, intervalMs);
    }
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId, disabled, intervalMs]);

  // ---------------- renewal: a heartbeat only while this device is the controller ----------------
  useEffect(() => {
    if (disabled || !state.isController) return;
    const id = setInterval(async () => {
      const { ok, json } = await post(matchId, "renew-lease", { deviceId: deviceIdRef.current });
      // The server is the source of truth: if it says this device no longer
      // holds the lease, the next poll settles the state — nothing forced here.
      if (ok && json && json.renewed === false) void poll();
    }, LEASE_RENEW_MS);
    return () => clearInterval(id);
  }, [matchId, disabled, state.isController, poll]);

  return { ...state, claim, release, requestControl, respond };
}
