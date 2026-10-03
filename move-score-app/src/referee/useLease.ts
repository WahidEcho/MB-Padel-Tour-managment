/**
 * Who scores this match: the same 15-second lease, request / accept / decline
 * handoff and heartbeat as the web console (useScoringControl.ts), over the same
 * routes. Re-claims when the app returns to the foreground, because the phone
 * stops timers in the background and the lease may have lapsed meanwhile.
 *
 * The phone is recognised by one id everywhere: the device id its claims,
 * renewals and events carry, sent as `X-Device-Id` on the state poll too, so
 * the server's `heldByYou` never depends on the install token. (Comparing the
 * shown id alone made a phone with a missing or stale install token see its own
 * lease as another device's: it stopped renewing and lost control every poll.)
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import * as Device from "expo-device";
import { LEASE_RENEW_MS, NO_LEASE_VIEW, claimedLeaseView, createLeaseOrder, nextLeaseView, type LeaseSideView, type SeenLease, type MatchSnapshot, type Match } from "@core";
import { api } from "../api/client";

export interface LeaseView extends LeaseSideView {
  ready: boolean;
  match: Match | null;
  snapshot: MatchSnapshot | null;
}

interface StatePayload {
  match: Match;
  snapshot: MatchSnapshot | null;
  lease: SeenLease | null;
}

const label = () => `${Device.modelName ?? (Platform.OS === "ios" ? "iPhone" : "Android")} · app`;

async function post(matchId: string, action: string, body: Record<string, unknown>) {
  try {
    return { ok: true, json: await api<Record<string, unknown>>(`/api/matches/${matchId}/${action}`, { who: "staff", body }) };
  } catch {
    return { ok: false, json: null };
  }
}

export function useLease(matchId: string, deviceId: string, disabled: boolean) {
  const [v, setV] = useState<LeaseView>({ ...NO_LEASE_VIEW, ready: disabled, match: null, snapshot: null });
  const dev = useRef(deviceId);
  dev.current = deviceId;
  // One order for every look at the lease, so a poll that left before a claim or an answer never undoes it.
  const order = useRef(createLeaseOrder()).current;

  const poll = useCallback(async () => {
    if (disabled) return;
    const ticket = order.ask();
    try {
      const d = await api<StatePayload>(`/api/matches/${matchId}/state`, { headers: { "X-Device-Id": dev.current } });
      if (!order.fresh(ticket)) return;
      setV((s) => ({ ...s, ...nextLeaseView(s, d.lease, dev.current), ready: true, match: d.match, snapshot: d.snapshot }));
    } catch {
      /* keep the last good look */
    }
  }, [matchId, disabled, order]);

  /** Runs a claim, release, request or answer: polls already on their way describe the lease from before it. */
  const change = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      order.changed();
      try {
        return await fn();
      } finally {
        order.changed();
      }
    },
    [order],
  );

  const claim = useCallback(
    (offlineFallback = false): Promise<boolean> =>
      change(async () => {
        const { ok, json } = await post(matchId, "claim", { deviceId: dev.current, deviceLabel: label() });
        if (!ok || !json) {
          setV((s) => ({ ...s, ready: true, isController: offlineFallback, heldByOther: false, holderLabel: null }));
          return offlineFallback;
        }
        const holder = json.holder as { deviceLabel?: string | null } | undefined;
        setV((s) => ({ ...s, ...claimedLeaseView(s, Boolean(json.controller), holder?.deviceLabel ?? null), ready: true }));
        return Boolean(json.controller);
      }),
    [matchId, change],
  );

  const release = useCallback(async () => {
    await change(() => post(matchId, "release-lease", { deviceId: dev.current }));
    void poll();
  }, [matchId, poll, change]);

  const requestControl = useCallback(async () => {
    const { ok } = await change(() => post(matchId, "request-control", { deviceId: dev.current, deviceLabel: label() }));
    if (ok) setV((s) => ({ ...s, myRequestPending: true }));
    // Refused (this phone holds it already, or nobody does): the poll says which.
    else void poll();
  }, [matchId, poll, change]);

  const respond = useCallback(
    async (accept: boolean) => {
      await change(() => post(matchId, "respond-control", { deviceId: dev.current, accept }));
      void poll();
    },
    [matchId, poll, change],
  );

  /** Clears "Control moved to …" once read. */
  const dismissLost = useCallback(() => setV((s) => ({ ...s, lostTo: null })), []);

  useEffect(() => {
    if (disabled) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (AppState.currentState === "active") await poll();
      if (!stop) timer = setTimeout(tick, 3_000);
    };
    void tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [poll, disabled]);

  useEffect(() => {
    if (disabled || !v.isController) return;
    const id = setInterval(async () => {
      const { ok, json } = await post(matchId, "renew-lease", { deviceId: dev.current });
      // Not the holder any more (handed over, or the lease ran out and someone claimed it): the poll says who, and the heartbeat stops.
      if (ok && json && json.renewed === false) void poll();
    }, LEASE_RENEW_MS);
    return () => clearInterval(id);
  }, [matchId, disabled, v.isController, poll]);

  const wasController = useRef(false);
  wasController.current = v.isController;
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active" && wasController.current) void claim(true);
    });
    return () => sub.remove();
  }, [claim]);

  return { ...v, claim, release, requestControl, respond, poll, dismissLost };
}
