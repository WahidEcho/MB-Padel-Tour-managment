/**
 * Which payment provider takes Move Score's online registration payments
 * (docs/xpay-direct.md; DECISIONS.md § 8):
 *
 *   xpay       directly through XPay (hosted checkouts, Move Score's own webhook endpoint);
 *              the owner's decision of 14 Oct 2026, so Move Tick's live ticket code is untouched
 *   move_tick  through Move Tick's partner API (docs/move-tick-partner-api.md), kept working
 *
 * PAYMENT_PROVIDER picks one; unset, XPay when XPAY_SECRET_KEY is set, else Move Tick
 * when it is configured. A provider that is named but not configured (or an unknown
 * name) gives none: online payment is then unavailable and fees are paid at the venue.
 * A payment always stays with the provider that took it (registration_payments.provider):
 * its webhooks, reconciliation and refund go there, whichever provider new checkouts use.
 */
import { moveTickConfig } from "../registration/moveTick";
import { xpayConfig } from "./xpay";

export type PaymentProvider = "xpay" | "move_tick";

export function paymentProvider(env: Record<string, string | undefined> = process.env): PaymentProvider | null {
  const want = (env.PAYMENT_PROVIDER ?? "").trim().toLowerCase();
  if (want === "xpay") return xpayConfig(env) ? "xpay" : null;
  if (want === "move_tick") return moveTickConfig(env) ? "move_tick" : null;
  if (want) return null;
  if ((env.XPAY_SECRET_KEY ?? "").trim()) return xpayConfig(env) ? "xpay" : null;
  return moveTickConfig(env) ? "move_tick" : null;
}
