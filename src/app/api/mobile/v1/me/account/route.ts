import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { audit } from "@/lib/audit";
import { ownerOf } from "@/lib/mobile/identity";
import { authClient, openToken, revokeApple } from "@/lib/auth/users";
import { accountStatus, bearerOf, signOutAuth } from "@/lib/auth/accounts";
import { privateJson } from "@/lib/mobile/http";
import { unlinkMe } from "@/lib/players/claims";
import { checkRateLimit } from "@/lib/ratelimit";
import { checkDisplayName } from "@/lib/auth/displayName";
import { accountUser, forgetAccountProfile, setAccountName } from "@/lib/auth/accountProfile";

export async function GET(request: Request) {
  const { owner } = await ownerOf(request);
  const token = bearerOf(request);
  if (owner?.kind !== "user" || !token) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { data } = await db().from("app_users").select("display_name, provider, created_at").eq("auth_user_id", owner.id).maybeSingle();
  const status = await accountStatus(owner.id, token);
  return privateJson({ user: { id: owner.id, ...(data ?? {}), registrationComplete: status.registrationComplete, pendingEmail: status.pendingEmail } });
}

/**
 * PATCH { displayName } → { user } (the GET /me shape, with avatarUrl): the name the
 * person chose on Account → Edit name and photo. Plain text, 1–60 characters
 * (checkDisplayName); any other field is refused. Kept in app_users.display_name and
 * the auth user's metadata, where a later Apple or Google sign-in never replaces it.
 * Anonymous player-code accounts may set one too.
 */
export async function PATCH(request: Request) {
  const { owner } = await ownerOf(request);
  const token = bearerOf(request);
  if (owner?.kind !== "user" || !token) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return privateJson({ error: "Send { displayName }." }, 400);
  const extra = Object.keys(body).filter((k) => k !== "displayName");
  if (extra.length) return privateJson({ error: `Unknown field: ${extra[0].slice(0, 40)}` }, 400);
  const name = checkDisplayName((body as { displayName?: unknown }).displayName);
  if (!name.ok) return privateJson({ error: name.error }, 400);
  const rl = await checkRateLimit({ key: `acctname:${owner.id}`, limit: 30, windowSeconds: 3600 });
  if (!rl.allowed) return privateJson({ error: "Too many changes. Try again later." }, 429);
  const done = await setAccountName(owner.id, token, name.name);
  if (!done.ok) return privateJson({ error: done.error }, done.status);
  await audit({ action: "APP_ACCOUNT_NAME_UPDATED", actor_role: "user", actor_user_id: owner.id, entity_type: "user", entity_id: owner.id, new_value: { length: [...name.name].length } });
  return privateJson({ user: await accountUser(owner.id, token) });
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
  await db().from("player_profiles").update({ auth_user_id: null, claim_status: "unclaimed", phone_verified_at: null }).eq("auth_user_id", owner.id);
  await db().from("phone_verifications").delete().eq("auth_user_id", owner.id);
  // Invite codes this account entered (migration 0031): the leagues they opened close again.
  await db().from("league_code_holders").delete().eq("auth_user_id", owner.id);
  // Registrations stay with the organiser (an entry, its payments and refunds), no longer tied to this account.
  await db().from("registrations").update({ auth_user_id: null, updated_at: new Date().toISOString() }).eq("auth_user_id", owner.id);
  // Lets go of the linked player; a photo the player uploaded is deleted with it.
  await unlinkMe(owner.id);
  // The account's own photo is deleted and its chosen name and photo cleared from the auth metadata.
  await forgetAccountProfile(token).catch(() => undefined);
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
