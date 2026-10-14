import { NextResponse } from "next/server";
import { ownerOf } from "@/lib/mobile/identity";
import { privateJson } from "@/lib/mobile/http";
import { strictBody } from "@/lib/players/http";
import { takeRateLimit } from "@/lib/ratelimit";
import { cancelOwn, ownPublicRegistration, payOwn, requestRefundOwn } from "@/lib/registration/server";
import type { MRegistrationResult } from "@/lib/mobile/contract";

/**
 * The account's own registration actions: pay (an online checkout), cancel,
 * ask for a refund. Another account's registration and a missing one get the same
 * 404. Bodies must be empty objects (or absent).
 */
export async function ownAction(request: Request, id: string, kind: "pay" | "cancel" | "refund-request") {
  const { owner } = await ownerOf(request);
  if (owner?.kind !== "user") return NextResponse.json({ error: "Sign in first" }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  const limit = await takeRateLimit({ key: `reg-act:${owner.id}`, limit: 30, windowSeconds: 3600 });
  if (!limit.allowed) return privateJson({ error: "Too many tries. Wait a little and try again.", code: "too_many" }, 429);
  const text = await request.clone().text().catch(() => "");
  if (text.trim() && !(await strictBody(request, [], 200))) return privateJson({ error: "That request isn't one this server understands." }, 400);
  let checkoutUrl: string | null = null;
  let message: string;
  if (kind === "pay") {
    const r = await payOwn(owner.id, id);
    if (!r.ok) return privateJson({ error: r.error, code: r.code }, r.status);
    checkoutUrl = r.value.checkoutUrl;
    message = "Opening the payment page.";
  } else {
    const r = kind === "cancel" ? await cancelOwn(owner.id, id) : await requestRefundOwn(owner.id, id);
    if (!r.ok) return privateJson({ error: r.error, code: r.code }, r.status);
    message = kind === "cancel" ? "Registration cancelled." : "Refund asked for: the organiser decides.";
  }
  const registration = await ownPublicRegistration(owner.id, id);
  if (!registration) return privateJson({ error: "Not found" }, 404);
  const out: MRegistrationResult = { registration, checkoutUrl, message };
  return privateJson(out);
}
