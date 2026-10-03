import { NextResponse } from "next/server";
import { ownerOf } from "@/lib/mobile/identity";
import { privateJson } from "@/lib/mobile/http";
import { accountStatus, bearerOf } from "@/lib/auth/accounts";

/**
 * GET → { user: { id, displayName, email, provider, registrationComplete, pendingEmail } }.
 *
 * registrationComplete is false only for a player who signed in with their code
 * and has not confirmed an email yet; the app shows "Complete your registration"
 * until it turns true. The first call after the email is confirmed also sets the
 * password the player chose.
 */
export async function GET(request: Request) {
  const { owner } = await ownerOf(request);
  const token = bearerOf(request);
  if (owner?.kind !== "user" || !token) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const s = await accountStatus(owner.id, token);
  return privateJson({ user: { id: owner.id, ...s } });
}
