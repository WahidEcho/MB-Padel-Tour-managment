import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { audit } from "@/lib/audit";
import { ownerOf } from "@/lib/mobile/identity";
import { authClient, openToken, revokeApple } from "@/lib/auth/users";
import { privateJson } from "@/lib/mobile/http";

export async function GET(request: Request) {
  const { owner } = await ownerOf(request);
  if (owner?.kind !== "user") return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { data } = await db().from("app_users").select("display_name, provider, created_at").eq("auth_user_id", owner.id).maybeSingle();
  return privateJson({ user: { id: owner.id, ...(data ?? {}) } });
}

/**
 * Deletes the account: Apple sign-in is revoked, follows, passes, player claims and
 * the account row are removed, phones are unlinked, and the sign-in identity itself
 * is deleted.
 */
export async function DELETE(request: Request) {
  const { owner } = await ownerOf(request);
  if (owner?.kind !== "user") return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { data } = await db().from("app_users").select("apple_refresh_token_enc").eq("auth_user_id", owner.id).maybeSingle();
  const sealed = (data as { apple_refresh_token_enc?: string | null } | null)?.apple_refresh_token_enc;
  if (sealed) {
    const token = openToken(sealed);
    if (token) await revokeApple(token);
  }
  await db().from("follows").delete().eq("owner_kind", "user").eq("owner_id", owner.id);
  await db().from("event_passes").delete().eq("owner_kind", "user").eq("owner_id", owner.id);
  await db().from("push_devices").update({ user_id: null }).eq("user_id", owner.id);
  await db().from("player_profiles").update({ auth_user_id: null, claim_status: "unclaimed" }).eq("auth_user_id", owner.id);
  await db().from("player_claims").delete().eq("user_id", owner.id);
  await db().from("app_users").delete().eq("auth_user_id", owner.id);
  // Deleting the identity needs the secret key; until the gate closes it is queued for staff.
  const { error } = await authClient().auth.admin.deleteUser(owner.id);
  await audit({ action: "APP_ACCOUNT_DELETED", actor_role: "user", new_value: { user: owner.id, identityDeleted: !error } });
  return privateJson({ deleted: true, identityDeleted: !error });
}
