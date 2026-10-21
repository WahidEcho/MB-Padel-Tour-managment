/**
 * Signing the referee in with an event code, typed or from a court's QR
 * (`https://tour.mbeg.org/r#<code>`, migration 0034). Switching courts is never
 * blocked: the phone first tries to send its queued points, then signs in with the
 * new code, sending the token it had and the matches it still holds (unsent points,
 * or an unfinished match). For those the server hands back a carry-over token: the
 * old court's code for just those matches (never a new one), kept beside the new
 * session and dropped once they are sent and finished (`pruneCarry`).
 *
 * Referee PINs (migration 0035): every referee code (court, whole-event, master) also needs the
 * referee's own 4-digit PIN. Without one the server answers `pin_required` with the names to
 * pick from (audit H1); the screen then keeps the code in memory only (`pendingCode`, never
 * on disk or in a URL) and asks on /referee/pin who is signing in and their PIN, sent as
 * `{ code, refereeId, pin }` so the server checks that referee's PIN only.
 */
import type { RefereeChoice } from "@core";
import { api, ApiError, offlineMessage } from "../api/client";
import { session, saveStaff, saveStaffCarry, type StaffCarry } from "../state/session";
import { queue } from "./queue";
import { createSyncer } from "./sync";
import { tr } from "../i18n/t";

export type CodeSignInResult =
  | { ok: true; court: string | null; carried: number; referee: string | null; master: boolean }
  | { ok: false; message: string; pinRequired?: boolean; wrongPin?: boolean; locked?: boolean; court?: string | null; master?: boolean; referees?: RefereeChoice[] };

/** The code waiting for its PIN (memory only), set by the screen that read it, with the names to pick from. */
let pending: { code: string; court: string | null; master: boolean; referees: RefereeChoice[] } | null = null;
export const pendingCode = {
  set(code: string, court: string | null, master: boolean, referees: RefereeChoice[] = []) {
    pending = { code, court, master, referees };
  },
  get() {
    return pending;
  },
  clear() {
    pending = null;
  },
};

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

export async function signInWithCode(code: string, pin?: string, refereeId?: string | null): Promise<CodeSignInResult> {
  const pendingMatchIds = await sendQueuedNow().catch(() => queue().matchesWithPending());
  const openMatchIds = await queue().unfinished().catch(() => [] as string[]);
  const previous = session.get().staff;
  try {
    const installToken = session.get().installToken;
    const r = await api<{
      token: string;
      role: string;
      expiresAt: string;
      court?: { name: string } | null;
      carry?: StaffCarry | null;
      referee?: { name: string; role: "referee" | "master_referee" } | null;
    }>("/api/mobile/v1/staff/session", {
      body: {
        code: code.trim(),
        ...(pin ? { pin } : {}),
        ...(refereeId ? { refereeId } : {}),
        // The phone's scoring id (its leases): only matches it worked on are carried over.
        deviceId: session.get().installationId ?? undefined,
        previousToken: previous?.token ?? undefined,
        pendingMatchIds,
        openMatchIds,
      },
      // The phone, so a master referee's calls for assistance reach it.
      headers: installToken ? { "X-Install-Token": installToken } : undefined,
    });
    await saveStaff({ token: r.token, role: r.role, expiresAt: r.expiresAt, referee: r.referee ?? null, court: r.court?.name ?? null });
    pendingCode.clear();
    // Earlier carries stay (a second switch); the new one is added.
    const carries = [...session.get().staffCarry, ...(r.carry ? [r.carry] : [])];
    await saveStaffCarry(carries);
    await pruneCarry();
    return { ok: true, court: r.court?.name ?? null, carried: r.carry?.matchIds.length ?? 0, referee: r.referee?.name ?? null, master: r.referee?.role === "master_referee" };
  } catch (e) {
    const body = e instanceof ApiError ? (e.body as { code?: string; court?: { name: string } | null; master?: boolean; referees?: RefereeChoice[] } | null) : null;
    if (body?.code === "pin_required" || body?.code === "wrong_pin") {
      return {
        ok: false,
        message: e instanceof ApiError ? e.message : "",
        pinRequired: body.code === "pin_required",
        wrongPin: body.code === "wrong_pin",
        court: body.court?.name ?? null,
        master: Boolean(body.master),
        referees: Array.isArray(body.referees) ? body.referees : undefined,
      };
    }
    if (body?.code === "pin_locked" || body?.code === "pin_paused" || body?.code === "pin_busy") {
      return { ok: false, message: e instanceof ApiError ? e.message : "", locked: true };
    }
    return { ok: false, message: e instanceof ApiError && e.status !== 0 ? e.message : `${offlineMessage()} ${tr("referee.codeCheckedOnline")}` };
  }
}

/** Signing out: the server ends the referee's sign-in ("On court now"), then the phone forgets the token. */
export async function signOutReferee(): Promise<void> {
  const token = session.get().staff?.token;
  if (token) {
    await api("/api/mobile/v1/staff/session", { method: "DELETE", who: "staff", timeoutMs: 5_000 }).catch(() => undefined);
  }
  await saveStaff(null);
}
