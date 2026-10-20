"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { clientIpFrom } from "@/lib/ratelimit";
import { audit } from "@/lib/audit";
import { coachLoginAttempt, setCoachCookie, signInWithCoachCode } from "@/lib/coaches/server";
import { COACH_WEB_HOURS } from "@/lib/coaches/token";

/**
 * Coach sign-in on the web (/coach, and "Open in this browser" on the QR page /c): the
 * team's code exchanged for an HttpOnly coach cookie. Brakes: failed attempts only, per
 * address and per code prefix, atomic (coachLoginAttempt). Never a staff session.
 */
export async function coachSignInAction(formData: FormData) {
  const code = String(formData.get("code") ?? "").slice(0, 60);
  const ip = clientIpFrom(await headers());
  const gate = await coachLoginAttempt(ip, code);
  if (!gate.allowed) redirect("/coach?error=rate_limited");
  const r = await signInWithCoachCode(code, { hours: COACH_WEB_HOURS, via: "web" });
  if (!r.ok) {
    if (r.reason === "unavailable") await gate.refund();
    redirect(`/coach?error=${r.reason}`);
  }
  await gate.refund();
  await setCoachCookie(r.token, r.expiresAt);
  // Never the code: which code (by id), which team, via the web.
  await audit({ organization_id: r.orgId, tournament_id: r.event.tournamentId, actor_role: "coach", action: "COACH_LOGIN", entity_type: "coach_code", entity_id: r.codeId, new_value: { via: "web", team_id: r.team.id } });
  redirect("/coach/team");
}
