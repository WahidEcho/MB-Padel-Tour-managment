/**
 * National team coaches (migration 0037): signing in with the team's code (typed, or from
 * the card's QR `https://tour.mbeg.org/c#<code>`), the coach's reads, and signing out.
 * Every coach of a team signs in with the same code, each on their own phone; the phone's
 * install token goes with the sign-in so the team's alerts reach it. A coach is never staff
 * and never the person's account: the token travels only on coach calls (api/headers.ts).
 */
import { useQuery } from "@tanstack/react-query";
import type { MCoachMatch, MCoachSession, MCoachTeamView, MCoachTie } from "@core";
import { api, ApiError, OFFLINE_MESSAGE } from "../api/client";
import { useScreenFocused } from "../api/queries";
import { saveCoach, session } from "../state/session";
import { registerDevice } from "../push/register";

export type CoachSignInResult = { ok: true; team: string } | { ok: false; message: string };

export async function signInCoach(code: string): Promise<CoachSignInResult> {
  // The phone must be known to the server first, so the team's alerts can reach it.
  if (!session.get().installToken) await registerDevice(false).catch(() => undefined);
  try {
    const r = await api<MCoachSession>("/api/mobile/v1/coach/session", { body: { code: code.trim() }, who: "coach" });
    await saveCoach({ token: r.token, expiresAt: r.expiresAt, team: r.team, event: r.event });
    refusal = null;
    return { ok: true, team: r.team.name };
  } catch (e) {
    if (e instanceof ApiError && e.status !== 0) return { ok: false, message: e.message };
    return { ok: false, message: OFFLINE_MESSAGE };
  }
}

export async function signOutCoach(): Promise<void> {
  try {
    await api("/api/mobile/v1/coach/session", { method: "DELETE", who: "coach", timeoutMs: 6000 });
  } catch {
    // Offline: the sign-in ends on its own; this phone forgets it now.
  }
  await saveCoach(null);
}

/** Why this phone was last signed out by the server (code replaced, revoked or expired), for the sign-in screen. */
let refusal: string | null = null;
export const lastCoachRefusal = () => refusal;

/** A 401 from a coach read: the code was replaced, revoked or expired. This phone signs out (the message says why). */
async function coachRead<T>(path: string): Promise<T> {
  try {
    return await api<T>(path, { who: "coach" });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      refusal = e.message;
      await saveCoach(null);
    }
    throw e;
  }
}

export function useCoachTeam() {
  const coach = session.use((s) => s.coach);
  const focused = useScreenFocused();
  return useQuery<MCoachTeamView>({
    queryKey: ["coach-team", coach?.token],
    queryFn: () => coachRead<MCoachTeamView>("/api/mobile/v1/coach/team"),
    enabled: Boolean(coach),
    refetchInterval: focused ? 15_000 : false,
    retry: (n, e) => !(e instanceof ApiError && (e.status === 401 || e.status === 404)) && n < 2,
  });
}

export function useCoachTie(id: string | undefined) {
  const coach = session.use((s) => s.coach);
  const focused = useScreenFocused();
  return useQuery<MCoachTie>({
    queryKey: ["coach-tie", id, coach?.token],
    queryFn: () => coachRead<MCoachTie>(`/api/mobile/v1/coach/ties/${id}`),
    enabled: Boolean(coach && id),
    refetchInterval: focused ? 8_000 : false,
    retry: (n, e) => !(e instanceof ApiError && (e.status === 401 || e.status === 404)) && n < 2,
  });
}

export function useCoachMatch(id: string | undefined) {
  const coach = session.use((s) => s.coach);
  const focused = useScreenFocused();
  return useQuery<MCoachMatch>({
    queryKey: ["coach-match", id, coach?.token],
    queryFn: () => coachRead<MCoachMatch>(`/api/mobile/v1/coach/matches/${id}`),
    enabled: Boolean(coach && id),
    refetchInterval: focused ? 5_000 : false,
    retry: (n, e) => !(e instanceof ApiError && (e.status === 401 || e.status === 404)) && n < 2,
  });
}
