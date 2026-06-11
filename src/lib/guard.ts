import { redirect } from "next/navigation";
import { currentRole, can } from "./auth";
import type { Role } from "./types";

/** Page guard: redirects to login when the visitor lacks one of the roles. */
export async function requireRole(roles: Role[], nextUrl: string): Promise<Role> {
  const role = await currentRole();
  if (!role || !roles.includes(role)) {
    redirect(`/login?next=${encodeURIComponent(nextUrl)}`);
  }
  return role;
}

/** Action/route guard: throws instead of redirecting. */
export async function requirePermission(action: Parameters<typeof can>[1]): Promise<Role> {
  const role = await currentRole();
  if (!can(role, action)) throw new Error("Not allowed");
  return role as Role;
}
