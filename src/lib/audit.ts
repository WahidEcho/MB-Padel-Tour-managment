import { db } from "./supabase";
import { currentStaffIfAny, principalForMatch, type StaffPrincipal } from "./auth/staff";
import { orgOfTournament } from "./orgs/scope";

/** Roles of flows no staff member performs (public forms, app users' own account routes, team coaches signing in). */
export const PUBLIC_ACTORS = new Set(["public", "user", "coach"]);
/** Labels an explicit caller sets that a staff principal never overrides. */
const KEEP_ROLE = new Set(["system", "platform"]);

/** Who did it, for the audit row: a member's user id, or "code:<id>" for an event code. */
function actorUserId(staff: StaffPrincipal | null): string | null {
  if (!staff) return null;
  if (staff.userId) return staff.userId;
  if (staff.codeId) return `code:${staff.codeId}`;
  return null;
}

/**
 * Records a state change. The actor's user (or event code), organisation and role
 * come from this request's staff principal; the organisation is the tournament's
 * when the row hangs off one. Outside a request (scripts) they are left as given.
 */
export async function audit(entry: {
  tournament_id?: string | null;
  organization_id?: string | null;
  actor_role?: string | null;
  /**
   * The person who did it when no staff cookie says so: an app user's own flow
   * (accepting an invite they were sent, say), checked by the caller.
   */
  actor_user_id?: string | null;
  /** The referee who did it when no staff credential of this request says so (their sign-in). */
  actor_referee?: { id: string; name: string } | null;
  /** Who did it, by name, for a flow with no staff credential (a team coach: "Coach of Egypt"). */
  actor_name?: string | null;
  action: string;
  entity_type?: string;
  entity_id?: string | null;
  old_value?: unknown;
  new_value?: unknown;
}) {
  // entity_id is a uuid column, but some entities are keyed by name — a screen
  // by its key ("tv-1"). Those used to fail the whole insert, so no screen
  // action was ever recorded; the key now rides in new_value instead.
  const id = entry.entity_id ?? null;
  const isUuid = id === null || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const newValue = isUuid
    ? (entry.new_value ?? null)
    : { entity_key: id, ...(entry.new_value && typeof entry.new_value === "object" ? entry.new_value : { value: entry.new_value ?? null }) };
  // A public or app-user flow (a registration form, the app's own account
  // routes) is never a staff action, even when the browser also carries a staff
  // cookie: no staff role, user or organisation is stamped on it.
  const publicFlow = PUBLIC_ACTORS.has(entry.actor_role ?? "");
  const signedIn = publicFlow ? null : await currentStaffIfAny();
  // A match a carry-over credential acts on (the old court's code after switching courts): that code, not the new one.
  const staff =
    signedIn && entry.entity_type === "match" && entry.entity_id && /^[0-9a-f-]{36}$/i.test(entry.entity_id)
      ? ((await principalForMatch(signedIn, entry.entity_id).catch(() => null)) ?? signedIn)
      : signedIn;
  const explicitUser = typeof entry.actor_user_id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.actor_user_id) ? entry.actor_user_id : null;
  const organizationId =
    entry.organization_id ?? (entry.tournament_id ? await orgOfTournament(entry.tournament_id).catch(() => null) : null) ?? staff?.orgId ?? null;
  const { error } = await db().from("audit_logs").insert({
    tournament_id: entry.tournament_id ?? null,
    organization_id: organizationId,
    actor_user_id: explicitUser ?? actorUserId(staff),
    // The organisation role (owner, not the admin it acts as) when a staff member did
    // it; an explicit "system" (automatic follow-up work) or "platform" (Move Beyond's
    // platform admins acting on an organisation) keeps its own label, and so does a
    // platform admin's action on an organisation other than the one they are signed
    // in for (they are not its owner).
    actor_role: KEEP_ROLE.has(entry.actor_role ?? "")
      ? entry.actor_role
      : staff?.platformAdmin && organizationId && organizationId !== staff.orgId
        ? "platform"
        : (staff?.orgRole ?? entry.actor_role ?? null),
    // The referee signed in with their PIN (court and master codes, migration 0035).
    ...((staff?.referee ?? entry.actor_referee) ? { actor_name: (staff?.referee ?? entry.actor_referee)!.name, actor_referee_id: (staff?.referee ?? entry.actor_referee)!.id } : {}),
    ...(!(staff?.referee ?? entry.actor_referee) && entry.actor_name ? { actor_name: entry.actor_name.slice(0, 120) } : {}),
    action: entry.action,
    entity_type: entry.entity_type ?? null,
    entity_id: isUuid ? id : null,
    old_value: entry.old_value ?? null,
    new_value: newValue,
  });
  // Audit failures must never break the operation itself
  if (error) console.error("audit log failed", error.message);
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "tournament"
  );
}
