/**
 * Who scores this match: the same 15-second lease, request / accept / decline
 * handoff and heartbeat as the web console (useScoringControl.ts), over the same
 * routes. Re-claims when the app returns to the foreground, because the phone
 * stops timers in the background and the lease may have lapsed meanwhile.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import * as Device from "expo-device";
import { LEASE_RENEW_MS, type MatchSnapshot, type Match } from "@core";
import { api } from "../api/client";

export interface LeaseView {
  ready: boolean;
  isController: boolean;
  heldByOther: boolean;
  holderLabel: string | null;
  incomingRequest: { deviceId: string; deviceLabel: string | null } | null;
  myRequestPending: boolean;
  match: Match | null;
  snapshot: MatchSnapshot | null;
  /** Goes up each time this phone gains control (a claim, an accepted handover, a re-claim on return): the console reloads the server's score then. */
  gained: number;
}

interface StatePayload {
  match: Match;
  snapshot: MatchSnapshot | null;
  lease: { deviceId: string; deviceLabel: string | null; isLive: boolean; transferRequest: { deviceId: string; deviceLabel: string | null } | null } | null;
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
  const [v, setV] = useState<LeaseView>({ ready: disabled, isController: false, heldByOther: false, holderLabel: null, incomingRequest: null, myRequestPending: false, match: null, snapshot: null, gained: 0 });
  const dev = useRef(deviceId);
  dev.current = deviceId;

  const apply = useCallback((d: StatePayload) => {
    const l = d.lease;
    const mine = Boolean(l && l.isLive && l.deviceId === dev.current);
    const other = Boolean(l && l.isLive && l.deviceId !== dev.current);
    setV((s) => ({
      ready: true,
      gained: mine && !s.isController ? s.gained + 1 : s.gained,
      isController: mine,
      heldByOther: other,
      holderLabel: other ? (l?.deviceLabel ?? "another phone") : null,
      incomingRequest: mine && l?.transferRequest ? l.transferRequest : null,
      myRequestPending: Boolean(other && l?.transferRequest?.deviceId === dev.current),
      match: d.match,
      snapshot: d.snapshot,
    }));
  }, []);

  const poll = useCallback(async () => {
    if (disabled) return;
    try {
      apply(await api<StatePayload>(`/api/matches/${matchId}/state`));
    } catch {
      /* keep the last good look */
    }
  }, [matchId, disabled, apply]);

  const claim = useCallback(
    async (offlineFallback = false): Promise<boolean> => {
      const { ok, json } = await post(matchId, "claim", { deviceId: dev.current, deviceLabel: label() });
      if (!ok || !json) {
        setV((s) => ({ ...s, ready: true, isController: offlineFallback, heldByOther: false, holderLabel: null }));
        return offlineFallback;
      }
      if (json.controller) {
        setV((s) => ({ ...s, ready: true, isController: true, heldByOther: false, holderLabel: null, incomingRequest: null, myRequestPending: false, gained: s.gained + 1 }));
        return true;
      }
      const holder = json.holder as { deviceLabel?: string | null } | undefined;
      setV((s) => ({ ...s, ready: true, isController: false, heldByOther: true, holderLabel: holder?.deviceLabel ?? "another phone" }));
      return false;
    },
    [matchId],
  );

  const release = useCallback(async () => {
    await post(matchId, "release-lease", { deviceId: dev.current });
    void poll();
  }, [matchId, poll]);

  const requestControl = useCallback(async () => {
    const { ok } = await post(matchId, "request-control", { deviceId: dev.current, deviceLabel: label() });
    if (ok) setV((s) => ({ ...s, myRequestPending: true }));
  }, [matchId]);

  const respond = useCallback(
    async (accept: boolean) => {
      await post(matchId, "respond-control", { deviceId: dev.current, accept });
      void poll();
    },
    [matchId, poll],
  );

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

  return { ...v, claim, release, requestControl, respond, poll };
}
