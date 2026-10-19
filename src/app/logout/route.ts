import { NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/auth";
import { currentStaffIfAny } from "@/lib/auth/staff";
import { endRefereeSession } from "@/lib/referees/server";

export async function GET(request: Request) {
  // A referee signed in with their PIN (migration 0035) leaves "On court now" at once.
  const staff = await currentStaffIfAny();
  if (staff?.referee) await endRefereeSession(staff.referee.sessionId, "signed_out");
  await clearSessionCookie();
  return NextResponse.redirect(new URL("/", request.url));
}
