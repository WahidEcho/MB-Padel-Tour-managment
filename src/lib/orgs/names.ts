/**
 * Organisation names against each other (server-only): an organisation cannot
 * take Move Beyond's names or another organisation's (case, accents, spaces and
 * punctuation ignored; src/lib/orgs/profile.ts `orgNameProblem`).
 */
import { db } from "../supabase";
import { orgNameProblem } from "./profile";
import { MOVE_BEYOND_SLUG, isUuid } from "./roles";

/**
 * The names `name` must not equal: every other organisation that is approved or
 * suspended, and their pending renames. (Applications and turned-down ones hold
 * no name: approving one checks it again.)
 */
async function otherNames(exceptId: string | null): Promise<string[]> {
  const { data } = await db().from("organizations").select("id, name, pending_name").in("status", ["approved", "suspended"]).limit(10000);
  return ((data ?? []) as { id: string; name: string; pending_name: string | null }[])
    .filter((o) => !isUuid(exceptId) || o.id !== exceptId)
    .flatMap((o) => [o.name, o.pending_name].filter((x): x is string => Boolean(x)));
}

/** Why `name` cannot be this organisation's (null when it can). Move Beyond itself may keep its own names. */
export async function orgNameRefusal(name: string, org: { id: string | null; slug?: string | null } = { id: null }): Promise<string | null> {
  return orgNameProblem(name, await otherNames(org.id), { allowReserved: org.slug === MOVE_BEYOND_SLUG });
}
