import { db } from "./supabase";
import { currentStaffIfAny, type StaffPrincipal } from "./auth/staff";
import { orgOfTournament } from "./orgs/scope";

/** Roles of flows no staff member performs (public forms, app users' own account routes). */
export const PUBLIC_ACTORS = new Set(["public", "user"]);

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
  const staff = publicFlow ? null : await currentStaffIfAny();
  const organizationId =
    entry.organization_id ?? (entry.tournament_id ? await orgOfTournament(entry.tournament_id).catch(() => null) : null) ?? staff?.orgId ?? null;
  const { error } = await db().from("audit_logs").insert({
    tournament_id: entry.tournament_id ?? null,
    organization_id: organizationId,
    actor_user_id: actorUserId(staff),
    // The organisation role (owner, not the admin it acts as) when a staff member did
    // it; an explicit "system" (automatic follow-up work) keeps its own label.
    actor_role: entry.actor_role === "system" ? "system" : (staff?.orgRole ?? entry.actor_role ?? null),
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
