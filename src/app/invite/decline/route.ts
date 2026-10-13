import { NextResponse } from "next/server";
import { clearInviteCookie, sameOrigin } from "@/lib/orgs/invites";
import { currentStaff } from "@/lib/auth/staff";
import { staffHome } from "@/lib/auth/staffRedirect";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * "Not now" (or "Forget this invitation"): this browser forgets the invite. The
 * invite itself is untouched; its link still works for the invited person until it
 * is used, withdrawn or expires.
 */
export async function POST(request: Request) {
  const to = (path: string) => NextResponse.redirect(new URL(path, request.url), { status: 303, headers: NO_STORE });
  if (!sameOrigin(request)) return to("/invite");
  await clearInviteCookie();
  const staff = await currentStaff().catch(() => null);
  return to(staff ? staffHome(staff.role) : "/login");
}
