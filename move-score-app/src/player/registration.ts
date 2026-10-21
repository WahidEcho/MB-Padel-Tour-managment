/** A registration's status and payments in the app's language (the shared rules in src/lib/registration/rules.ts speak English). */
import { moneyLabel, type MRegistration } from "@core";
import { fmt, tr as trNow, type Key } from "../i18n/t";

export const day = (iso: string | null) => (iso ? fmt().custom(iso, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : null);

const STATUS_KEYS: Record<string, Key> = {
  unconfirmed: "account.regUnconfirmed",
  pending_approval: "account.regPendingApproval",
  awaiting_payment: "account.regAwaitingPayment",
  confirmed: "account.regConfirmed",
  refused: "account.regRefused",
  cancelled: "account.regCancelled",
  refunded: "account.regRefunded",
};

/** The entry's status in the app's language (the server's English label for anything new). */
export function registrationStatus(r: Pick<MRegistration, "status" | "statusLabel">): string {
  const k = STATUS_KEYS[r.status];
  return k ? trNow(k) : r.statusLabel;
}

/** The online payments of an entry, as the player reads them (src/lib/registration/rules.ts onlinePaymentLines, "player"). */
export function paymentLines(amountOnline: number, payments: NonNullable<MRegistration["payments"]>): string[] {
  const taken = payments.filter((p) => p.status === "paid" || p.status === "needs_review" || p.status === "refund_pending" || p.status === "refunded");
  if (!taken.length) return amountOnline > 0 ? [trNow("account.payOnline", { amount: moneyLabel(amountOnline) })] : [];
  return taken.map((p) => {
    if (p.status === "refunded") {
      const amount = moneyLabel(p.refundAmount ?? p.amount);
      return p.refundedAt ? trNow("account.payRefundedOn", { amount, when: day(p.refundedAt) ?? "" }) : trNow("account.payRefunded", { amount });
    }
    if (p.status === "refund_pending") return trNow("account.payRefundPending", { amount: moneyLabel(p.refundAmount ?? p.amount) });
    if (p.status === "needs_review") return trNow("account.payToRefund", { amount: moneyLabel(p.amount) });
    return trNow("account.payPaid", { amount: moneyLabel(p.amount) });
  });
}

export function awaitingNote(r: { approved: boolean; holdUntil: string | null }): string {
  if (r.approved) {
    if (r.holdUntil && Date.parse(r.holdUntil) > Date.now()) return trNow("account.holdUntil", { when: day(r.holdUntil) ?? "" });
    return trNow("account.holdPassed");
  }
  return trNow("account.payToConfirm");
}