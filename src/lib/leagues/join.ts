/**
 * Joining a league (Phase 7): the organiser picks how players get in.
 *
 *   open          anyone signed in joins at once
 *   approval      the request waits for the organiser
 *   paid          a membership fee is paid first. Paid joining is paid
 *                 online for the Move Beyond organisation only; elsewhere the
 *                 fee is paid at the venue (the player joins, flagged unpaid).
 *   invite_code   the player must give the league's code
 *
 * A league may combine modes: the code is checked first, then approval, then
 * payment (payment after approval, so nobody pays for a request that is turned
 * down). "open" with any other mode means nothing: the other modes decide.
 *
 * The server checks the code against its stored hash and passes the verdict in;
 * nothing here sees a stored code.
 *
 * Pure: shared with the Move Score app through move-score-app/src/core/index.ts.
 */

export type JoinMode = "open" | "approval" | "paid" | "invite_code";
export const JOIN_MODES: readonly JoinMode[] = ["open", "approval", "paid", "invite_code"];

/** The modes a league stores, cleaned: known modes once each, "open" dropped beside any other. */
export function normalizeJoinModes(raw: unknown): JoinMode[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const modes = JOIN_MODES.filter((m) => list.includes(m));
  return modes.length > 1 ? modes.filter((m) => m !== "open") : modes;
}

/** An invite code as typed: upper case, letters and digits only. The server hashes this form. */
export function normalizeInviteCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Where a player stands with the league already. */
export type MembershipStatus = "pending" | "awaiting_payment" | "active" | "removed";

export interface JoinLeague {
  joinModes: JoinMode[] | unknown;
  /** Not taking members (draft, closed or archived league). */
  closed?: boolean;
  /** Membership fee; 0 or absent means no fee even when "paid" is a mode. */
  membershipFee?: { amount: number; currency: string } | null;
  /** Paid joining online (the Move Beyond organisation only, for now). */
  paymentsEnabled: boolean;
}

export interface JoinApplicant {
  signedIn: boolean;
  membership?: MembershipStatus | null;
  /** The code the player gave, as the server judged it; absent when none was given. */
  inviteCode?: { valid: boolean } | null;
  /** The membership fee is paid (the payment provider confirmed it). */
  paid?: boolean;
}

export type JoinRefusal =
  | "sign_in"
  | "closed"
  | "already_member"
  | "already_pending"
  | "removed"
  | "invite_code_required"
  | "invite_code_wrong";

export type JoinDecision =
  | { outcome: "join"; payAtVenue: boolean }
  | { outcome: "pending_approval"; thenPayment: boolean; payAtVenue: boolean }
  | { outcome: "payment_required"; amount: number; currency: string }
  | { outcome: "refused"; reason: JoinRefusal };

/** What happens when this player asks to join this league now. */
export function joinDecision(league: JoinLeague, applicant: JoinApplicant): JoinDecision {
  if (!applicant.signedIn) return { outcome: "refused", reason: "sign_in" };
  const modes = normalizeJoinModes(league.joinModes);
  const status = applicant.membership ?? null;
  if (status === "active") return { outcome: "refused", reason: "already_member" };
  if (status === "pending") return { outcome: "refused", reason: "already_pending" };
  if (status === "removed") return { outcome: "refused", reason: "removed" };
  if (league.closed || modes.length === 0) return { outcome: "refused", reason: "closed" };

  const fee = league.membershipFee && league.membershipFee.amount > 0 ? league.membershipFee : null;
  const needsFee = modes.includes("paid") && fee !== null;
  const payOnline = needsFee && league.paymentsEnabled;
  const payAtVenue = needsFee && !league.paymentsEnabled;

  // Approved (or not needing approval) and only the payment left.
  if (status === "awaiting_payment") {
    if (payOnline && !applicant.paid) return { outcome: "payment_required", amount: fee!.amount, currency: fee!.currency };
    return { outcome: "join", payAtVenue };
  }

  if (modes.includes("invite_code")) {
    if (!applicant.inviteCode) return { outcome: "refused", reason: "invite_code_required" };
    if (!applicant.inviteCode.valid) return { outcome: "refused", reason: "invite_code_wrong" };
  }
  if (modes.includes("approval")) return { outcome: "pending_approval", thenPayment: payOnline && !applicant.paid, payAtVenue };
  if (payOnline && !applicant.paid) return { outcome: "payment_required", amount: fee!.amount, currency: fee!.currency };
  return { outcome: "join", payAtVenue };
}

/**
 * The membership status an organiser's approval leads to: straight to active, or
 * waiting for the online payment.
 */
export function statusAfterApproval(league: JoinLeague, paid = false): MembershipStatus {
  const modes = normalizeJoinModes(league.joinModes);
  const fee = league.membershipFee && league.membershipFee.amount > 0;
  return modes.includes("paid") && fee && league.paymentsEnabled && !paid ? "awaiting_payment" : "active";
}
