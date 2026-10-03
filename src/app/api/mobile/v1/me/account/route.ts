import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { audit } from "@/lib/audit";
import { ownerOf } from "@/lib/mobile/identity";
import { authClient, openToken, revokeApple } from "@/lib/auth/users";
import { accountStatus, bearerOf, signOutAuth } from "@/lib/auth/accounts";
import { privateJson } from "@/lib/mobile/http";
import { unlinkMe } from "@/lib/players/claims";

export async function GET(request: Request) {
  const { owner } = await ownerOf(request);
  const token = bearerOf(request);
  if (owner?.kind !== "user" || !token) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { data } = await db().from("app_users").select("display_name, provider, created_at").eq("auth_user_id", owner.id).maybeSingle();
  const status = await accountStatus(owner.id, token);
  return privateJson({ user: { id: owner.id, ...(data ?? {}), registrationComplete: status.registrationComplete, pendingEmail: status.pendingEmail } });
}

/**
 * Deletes the account: Apple sign-in is revoked, follows, passes, player claims and
 * the account row are removed, phones are unlinked, every session is signed out,
 * and the sign-in identity itself is deleted from Supabase Auth.
 *
 * Deleting the identity needs the secret key (auth.admin). While production still
 * runs on the anon key that call fails: the rest is still done, the person's
 * sessions are revoked with their own token (so no phone stays signed in), and
 * the account is recorded in app_user_deletions for staff to purge once
 * SUPABASE_KEY is the secret key. The answer says which happened.
 */
export async function DELETE(request: Request) {
  const { owner } = await ownerOf(request);
  if (owner?.kind !== "user") return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const token = bearerOf(request);
  const { data } = await db().from("app_users").select("apple_refresh_token_enc, provider").eq("auth_user_id", owner.id).maybeSingle();
  const account = data as { apple_refresh_token_enc?: string | null; provider?: string | null } | null;
  const sealed = account?.apple_refresh_token_enc;
  if (sealed) {
    const t = openToken(sealed);
    if (t) await revokeApple(t);
  }
  await db().from("follows").delete().eq("owner_kind", "user").eq("owner_id", owner.id);
  await db().from("event_passes").delete().eq("owner_kind", "user").eq("owner_id", owner.id);
  await db().from("push_devices").update({ user_id: null }).eq("user_id", owner.id);
  await db().from("player_profiles").update({ auth_user_id: null, claim_status: "unclaimed" }).eq("auth_user_id", owner.id);
  // Lets go of the linked player; a photo the player uploaded is deleted with it.
  await unlinkMe(owner.id);
  await db().from("app_users").delete().eq("auth_user_id", owner.id);

  let identityDeleted = false;
  try {
    const { error } = await authClient().auth.admin.deleteUser(owner.id);
    identityDeleted = !error;
  } catch {
    identityDeleted = false;
  }
  // Without the secret key: end every session of this person with their own token.
  const sessionsRevoked = identityDeleted || (token ? await signOutAuth(token, "global") : false);
  await db()
    .from("app_user_deletions")
    .upsert({ auth_user_id: owner.id, provider: account?.provider ?? null, deleted_at: new Date().toISOString(), identity_deleted: identityDeleted }, { onConflict: "auth_user_id" });
  await audit({ action: "APP_ACCOUNT_DELETED", actor_role: "user", new_value: { user: owner.id, identityDeleted, sessionsRevoked } });
  return privateJson({
    deleted: true,
    identityDeleted,
    sessionsRevoked,
    ...(identityDeleted
      ? {}
      : { note: "Your data is deleted and you are signed out everywhere. The sign-in identity is removed by staff within 30 days (deleting it here needs the server's secret key)." }),
  });
}
