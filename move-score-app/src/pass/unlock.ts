import type { MCheckInReply, MPass } from "@core";
import { api } from "../api/client";
import { rememberPass } from "./usePass";
import { fmt, tr } from "../i18n/t";

/** Parses the venue code's link: https://<site>/v/<event>?c=<code> */
export function parseVenueLink(data: string): { groupSlug: string; code: string } | null {
  const m = /\/v\/([a-z0-9-]+)\?(?:.*&)?c=([A-Za-z0-9]+)/i.exec(data);
  return m ? { groupSlug: decodeURIComponent(m[1]!), code: m[2]! } : null;
}

/**
 * Parses a match's check-in link: https://<site>/m/<match id>?c=<code> (the court
 * TV's rotating code) or ?p=<code> (the printed one at the court).
 */
export function parseMatchLink(data: string): { matchId: string; c?: string; p?: string } | null {
  const m = /\/m\/([0-9a-f-]{36})\?(?:.*&)?([cp])=([A-Za-z0-9]+)/i.exec(data);
  if (!m) return null;
  return m[2]!.toLowerCase() === "p" ? { matchId: m[1]!, p: m[3]! } : { matchId: m[1]!, c: m[3]! };
}

/** stampedDay is null when the scan unlocked the on-site edition outside the event's days. */
export async function unlockWith(groupSlug: string, code: string): Promise<{ pass: MPass; stampedDay: string | null }> {
  const r = await api<{ pass: MPass; stampedDay: string | null }>("/api/mobile/v1/passes/unlock", { who: "me", body: { groupSlug, code } });
  rememberPass(r.pass.eventGroupId, { pass: r.pass });
  return r;
}

/** Checks the pass in to a match. Refusals throw ApiError with body { code } (see MCheckInRefusal). */
export async function checkInWith(link: { matchId: string; c?: string; p?: string }): Promise<MCheckInReply> {
  const r = await api<MCheckInReply>(`/api/mobile/v1/matches/${link.matchId}/checkin`, { who: "me", body: link.p ? { p: link.p } : { c: link.c } });
  rememberPass(r.pass.eventGroupId, { pass: r.pass });
  return r;
}

/** What to tell the fan after a check-in, and how the phone should feel it. */
export function checkInFeedback(r: MCheckInReply | { code?: string; error?: string; opensAt?: string | null }): { text: string; haptic: "success" | "warning" | "error" } {
  if ("status" in r) {
    if (r.status === "already_checked_in") return { text: tr("pass.checkAlready"), haptic: "warning" };
    return { text: tr("pass.checkedIn", { points: r.points }), haptic: "success" };
  }
  switch (r.code) {
    case "too_early": {
      const time = r.opensAt ? fmt().time(r.opensAt) || null : null;
      return { text: time ? tr("pass.checkTooEarlyAt", { time }) : tr("pass.checkTooEarly"), haptic: "warning" };
    }
    case "code_expired":
      return { text: tr("pass.checkExpired"), haptic: "error" };
    case "closed":
      return { text: tr("pass.checkClosed"), haptic: "error" };
    default:
      return { text: r.error ?? tr("pass.checkNotMatch"), haptic: "error" };
  }
}
