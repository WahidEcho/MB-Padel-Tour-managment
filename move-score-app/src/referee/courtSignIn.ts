/**
 * Signing the referee in with an event code, typed or from a court's QR
 * (`https://tour.mbeg.org/r#<code>`, migration 0034). Switching courts is never
 * blocked: the phone first tries to send its queued points, then signs in with the
 * new code, sending the token it had and the matches it still holds (unsent points,
 * or an unfinished match). For those the server hands back a carry-over token: the
 * old court's code for just those matches (never a new one), kept beside the new
 * session and dropped once they are sent and finished (`pruneCarry`).
 */
import { api, ApiError, OFFLINE_MESSAGE } from "../api/client";
import { session, saveStaff, saveStaffCarry, type StaffCarry } from "../state/session";
import { queue } from "./queue";
import { createSyncer } from "./sync";

export type CodeSignInResult = { ok: true; court: string | null; carried: number } | { ok: false; message: string };

/** Sends every match's queued points now (signed in only). The matches still holding points afterwards. */
export async function sendQueuedNow(): Promise<string[]> {
  const pending = await queue().matchesWithPending();
  const s = session.get();
  if (!pending.length || !s.staff) return pending;
  const deviceId = s.installationId ?? "unknown";
  for (const id of pending) {
    const syncer = createSyncer(id, deviceId, () => {});
    try {
      await syncer.flush();
    } finally {
      syncer.stop();
    }
  }
  return queue().matchesWithPending();
}

/** Drops carried matches that are sent and finished on this phone, and carry-over tokens that ran out. */
export async function pruneCarry(): Promise<void> {
  const carries = session.get().staffCarry;
  if (!carries.length) return;
  const keep = new Set([...(await queue().matchesWithPending()), ...(await queue().unfinished())]);
  const next = carries.map((c) => ({ ...c, matchIds: c.matchIds.filter((id) => keep.has(id)) }));
  if (JSON.stringify(next) !== JSON.stringify(carries)) await saveStaffCarry(next);
  else if (carries.some((c) => Date.parse(c.expiresAt) <= Date.now())) await saveStaffCarry(carries);
}

export async function signInWithCode(code: string): Promise<CodeSignInResult> {
  const pendingMatchIds = await sendQueuedNow().catch(() => queue().matchesWithPending());
  const openMatchIds = await queue().unfinished().catch(() => [] as string[]);
  const previous = session.get().staff;
  try {
    const r = await api<{ token: string; role: string; expiresAt: string; court?: { name: string } | null; carry?: StaffCarry | null }>("/api/mobile/v1/staff/session", {
      body: { code: code.trim(), previousToken: previous?.token ?? undefined, pendingMatchIds, openMatchIds },
    });
    await saveStaff({ token: r.token, role: r.role, expiresAt: r.expiresAt });
    // Earlier carries stay (a second switch); the new one is added.
    const carries = [...session.get().staffCarry, ...(r.carry ? [r.carry] : [])];
    await saveStaffCarry(carries);
    await pruneCarry();
    return { ok: true, court: r.court?.name ?? null, carried: r.carry?.matchIds.length ?? 0 };
  } catch (e) {
    return { ok: false, message: e instanceof ApiError && e.status !== 0 ? e.message : `${OFFLINE_MESSAGE} The code is checked online once; scoring then works offline.` };
  }
}
