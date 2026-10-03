import { audit } from "@/lib/audit";
import { authClient } from "@/lib/auth/users";
import { accountRow, finishSignIn } from "@/lib/auth/accounts";
import { authJson, ipAllowed, settle, tooMany } from "@/lib/auth/limits";
import { clientIpFrom } from "@/lib/ratelimit";
import { verifyInstallToken } from "@/lib/mobile/identity";
import { readJson } from "@/lib/mobile/http";
import { getConfig } from "@/lib/mobile/server";
import { claimBlocked, findPlayerByCode, linkPlayer, playerHolder, releaseClaims } from "@/lib/players/claims";

/**
 * POST { code } → a session for the player, without signing up first:
 * { ...session (as Apple/Google), provider: "player_code", player, registrationComplete: false }.
 *
 * The tournament already has the player's name and phone; the code they were sent
 * proves who they are. The server makes a Supabase anonymous user (works with the
 * anon key), links the player exactly as a claim does, and the app then asks them
 * to complete their registration by adding an email (POST /auth/complete).
 *
 * The code cannot take over a finished account: if its player is linked to a
 * registered account (or one waiting for its email to be confirmed), it is refused.
 * If it is linked to another phone's player-code account that never registered,
 * the link moves to a new account made here. (Signing in as that same anonymous
 * user would need the other phone's refresh token or an admin API; anonymous users
 * have no credentials of their own.)
 *
 * Same brake as the claim route: wrong codes count per phone and per network,
 * every answer takes the same minimum time, and a wrong code gets the generic answer.
 */
export async function POST(request: Request) {
  const started = Date.now();
  const config = await getConfig();
  if (!config.flags.player_claim) return authJson({ error: "Player codes are not open yet." }, 403);
  if (!(await ipAllowed(request, "pcsignin", 60, 600))) return tooMany();
  const installationId = verifyInstallToken(request.headers.get("x-install-token"));
  const caller = { userId: null, installationId, ip: clientIpFrom(request.headers) };
  if (await claimBlocked(caller)) {
    await settle(started);
    return authJson({ error: "Too many tries. Wait an hour, or ask the tournament desk." }, 429);
  }
  const body = await readJson<{ code?: unknown }>(request);
  const found = await findPlayerByCode(caller, typeof body?.code === "string" ? body.code.slice(0, 200) : "");
  if (!found.ok) {
    await settle(started);
    return authJson({ error: found.error }, found.status);
  }
  const row = found.row;

  const holder = await playerHolder(row.id);
  if (holder) {
    const held = await accountRow(holder);
    const anonymous = held?.provider === "player_code" && held.registration_complete === false;
    if (!anonymous) {
      await settle(started);
      return authJson({ error: "This player code is already registered. Sign in with your email.", code: "code_registered" }, 409);
    }
    if (held.pending_email) {
      await settle(started);
      return authJson(
        {
          error: "This player is waiting for an email to be confirmed. Open the link we emailed, then sign in with your email, or ask the tournament desk to reset the code.",
          code: "code_pending_email",
        },
        409,
      );
    }
  }

  const { data, error } = await authClient().auth.signInAnonymously({ options: { data: { full_name: row.full_name, signed_in_with: "player_code" } } });
  if (error || !data.session || !data.user) {
    await settle(started);
    if (error?.code === "anonymous_provider_disabled") return authJson({ error: "Signing in with a player code isn't switched on yet. Sign in another way, then enter your code." }, 503);
    return authJson({ error: "Can't sign you in right now. Try again in a moment." }, error?.status === 429 ? 429 : 503);
  }

  // The player's earlier, unregistered account (another phone) lets go; this one takes the player.
  if (holder) await releaseClaims(holder);
  const linked = await linkPlayer(data.user.id, row);
  if (!linked.ok) {
    await settle(started);
    return authJson({ error: linked.error }, linked.status);
  }
  const reply = await finishSignIn({ session: data.session, user: data.user, provider: "player_code", displayName: row.full_name, registrationComplete: false });
  await audit({
    action: "PLAYER_CODE_SIGNIN",
    actor_role: "user",
    entity_type: "player",
    entity_id: row.id,
    new_value: { user: data.user.id, linked: linked.linked, movedFrom: holder },
  });
  await settle(started);
  return authJson({ ...reply, player: linked.player, linked: linked.linked, registrationComplete: false });
}
