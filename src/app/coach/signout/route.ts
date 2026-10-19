import { NextResponse } from "next/server";
import { clearCoachCookie, currentCoachResolution, endCoachSession } from "@/lib/coaches/server";

/** Signs this browser's coach out (its sign-in ends at once); the team's code keeps working for the others. */
export async function POST(request: Request) {
  const me = await currentCoachResolution();
  if (me.ok) await endCoachSession(me.coach.sessionId, "signed_out");
  await clearCoachCookie();
  return NextResponse.redirect(new URL("/coach", request.url), 303);
}
