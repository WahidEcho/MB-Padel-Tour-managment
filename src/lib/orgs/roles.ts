/**
 * Organisation roles. Pure: no Node, browser or Next.js APIs.
 *
 * An organisation member has one of five roles. The permission matrix in
 * src/lib/auth.ts (`can`) is written for the four staff roles the console has
 * always had; an owner holds every admin permission there, plus the few that are
 * the owner's alone (OWNER_ONLY, used by the members pages).
 */
import type { Role } from "../types";

export const ORG_ROLES = ["owner", "admin", "manager", "referee", "operator"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** Event codes are for the people on court and at the screens, never for the office. */
export const CODE_ROLES = ["referee", "operator"] as const;
export type CodeRole = (typeof CODE_ROLES)[number];

export const ORG_STATUSES = ["applied", "approved", "rejected", "suspended"] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];

export const isOrgRole = (r: unknown): r is OrgRole => typeof r === "string" && (ORG_ROLES as readonly string[]).includes(r);
export const isCodeRole = (r: unknown): r is CodeRole => typeof r === "string" && (CODE_ROLES as readonly string[]).includes(r);

/** The console role an organisation role acts as in the permission matrix. */
export function permissionRole(role: OrgRole): Role {
  return role === "owner" ? "admin" : role;
}

/** The slug of the organisation that owns everything that existed before organisations. */
export const MOVE_BEYOND_SLUG = "move-beyond";

/** Slugs: lowercase letters, digits and inner hyphens, 2–60 characters. */
export const isOrgSlug = (s: unknown): s is string => typeof s === "string" && /^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/.test(s);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A well-formed uuid. Ids that are not are refused before any query (same answer as "not found"). */
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

/** Roles only an owner may give (or take away): the office of the organisation. */
export const OWNER_GRANTED: readonly OrgRole[] = ["owner", "admin"];

/**
 * Whether `actor` may give `next` to a member who now holds `current` (null: a
 * new invite). Owners may give any role; admins only manager, referee and
 * operator, and only to people who hold one of those (an admin cannot touch an
 * owner or another admin). Nobody else manages members. The last owner is the
 * database's rule too (trigger organization_members_keep_owner).
 */
export function mayAssignRole(actor: OrgRole, current: OrgRole | null, next: OrgRole): boolean {
  if (actor === "owner") return true;
  if (actor !== "admin") return false;
  if (OWNER_GRANTED.includes(next)) return false;
  return current === null || !OWNER_GRANTED.includes(current);
}

/** Whether `actor` may remove a member who holds `current`. */
export function mayRemoveMember(actor: OrgRole, current: OrgRole): boolean {
  if (actor === "owner") return true;
  return actor === "admin" && !OWNER_GRANTED.includes(current);
}

/** Whether demoting or removing a member who holds `current` would leave no owner. */
export function wouldLeaveNoOwner(current: OrgRole, next: OrgRole | "removed", activeOwners: number): boolean {
  return current === "owner" && next !== "owner" && activeOwners <= 1;
}

export const ROLE_LABELS: Record<OrgRole, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  referee: "Referee",
  operator: "Screen operator",
};
