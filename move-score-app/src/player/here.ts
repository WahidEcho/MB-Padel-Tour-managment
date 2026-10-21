/**
 * "I'm at court" (plan Phase 5): the signed-in player marks themselves present
 * for their own called match (POST /api/mobile/v1/me/matches/:id/here). The
 * server decides which side they are on (their claimed player code) and answers
 * "Not found" for anyone else's match. GET says what the phone shows next to
 * the player's own match: the call's deadline and who is already there.
 */
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { queryClient, useScreenFocused } from "../api/queries";
import { session } from "../state/session";
import { tr } from "../i18n/t";

export interface MyCall {
  side: "A" | "B";
  /** The organiser uses "I'm at court" (and court calls). */
  imAtCourt: boolean;
  call: { status: "called" | "started" | "walkover" | "cancelled"; calledAt: string; deadlineAt: string; presentA: boolean; presentB: boolean } | null;
}

const key = (matchId: string) => ["my-call", matchId];

/** The call of the player's own match; polled while the screen is in view and the match is waiting. */
export function useMyCall(matchId: string | undefined, enabled: boolean) {
  const signedIn = session.use((s) => Boolean(s.user));
  const focused = useScreenFocused();
  return useQuery<MyCall | null>({
    queryKey: key(matchId ?? ""),
    queryFn: async () => {
      try {
        return await api<MyCall>(`/api/mobile/v1/me/matches/${matchId}/here`, { who: "me" });
      } catch (e) {
        // Not this player's match (or no longer): nothing to show.
        if (e instanceof ApiError && (e.status === 404 || e.status === 401)) return null;
        throw e;
      }
    },
    enabled: Boolean(matchId) && enabled && signedIn,
    refetchInterval: focused && enabled ? 15_000 : false,
    retry: 1,
  });
}

/** Marks the player at the court. Resolves with the call as the server now holds it, or throws a message to show. */
export async function markHere(matchId: string): Promise<MyCall> {
  try {
    const r = await api<Pick<MyCall, "side" | "call">>(`/api/mobile/v1/me/matches/${matchId}/here`, { who: "me", body: {}, method: "POST" });
    const next: MyCall = { imAtCourt: true, ...r };
    queryClient.setQueryData(key(matchId), next);
    void queryClient.invalidateQueries({ queryKey: ["courts-live"] });
    return next;
  } catch (e) {
    if (e instanceof ApiError && e.status === 0) throw new Error(tr("player.hereNoSignal"));
    if (e instanceof ApiError && e.status === 401) throw new Error(tr("player.hereSignIn"));
    throw new Error(e instanceof ApiError ? e.message : tr("player.hereWrong"));
  }
}
