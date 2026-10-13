/**
 * Which organisation a row belongs to, always read from the row itself
 * (match → tournament → organisation, session → tournament → organisation),
 * never from an id a form or request posted alongside it.
 *
 * Server-only. Unknown ids, malformed ids and rows of another organisation all
 * come back as null, so every caller answers "not found" and "not yours" the
 * same way.
 */
import { db } from "../supabase";
import { isUuid } from "./roles";
import type { StaffPrincipal } from "../auth/staff";
import type { OrgPlayerSource } from "./personFields";

export type EntityRef =
  | { tournament: string }
  | { match: string }
  | { session: string }
  | { entry: string }
  | { announcement: string }
  | { appAnnouncement: string }
  | { eventGroup: string }
  | { season: string }
  | { category: string }
  | { code: string }
  | { member: string }
  | { invite: string };

export interface EntityScope {
  orgId: string;
  /** The tournament (or a session's hidden tournament) the row hangs off, when it has one. */
  tournamentId: string | null;
  /** tournaments.kind when the row is or hangs off a tournament. */
  kind: string | null;
}

async function one<T>(table: string, columns: string, id: string): Promise<T | null> {
  const { data } = await db().from(table).select(columns).eq("id", id).maybeSingle();
  return (data as T | null) ?? null;
}

async function tournamentScope(id: string | null | undefined): Promise<EntityScope | null> {
  if (!isUuid(id)) return null;
  const t = await one<{ id: string; organization_id: string; kind: string }>("tournaments", "id, organization_id, kind", id);
  return t ? { orgId: t.organization_id, tournamentId: t.id, kind: t.kind } : null;
}

/** The organisation (and tournament) a row belongs to; null when there is no such row. */
export async function resolveEntity(ref: EntityRef): Promise<EntityScope | null> {
  if ("tournament" in ref) return tournamentScope(ref.tournament);
  if ("match" in ref) {
    if (!isUuid(ref.match)) return null;
    return tournamentScope((await one<{ tournament_id: string }>("matches", "tournament_id", ref.match))?.tournament_id);
  }
  if ("session" in ref) {
    if (!isUuid(ref.session)) return null;
    return tournamentScope((await one<{ tournament_id: string }>("friendly_sessions", "tournament_id", ref.session))?.tournament_id);
  }
  if ("entry" in ref) {
    if (!isUuid(ref.entry)) return null;
    const e = await one<{ session_id: string }>("friendly_entries", "session_id", ref.entry);
    return e ? resolveEntity({ session: e.session_id }) : null;
  }
  if ("appAnnouncement" in ref) {
    if (!isUuid(ref.appAnnouncement)) return null;
    const a = await one<{ tournament_id: string | null; event_group_id: string | null }>("announcements", "tournament_id, event_group_id", ref.appAnnouncement);
    if (!a) return null;
    if (a.tournament_id) return tournamentScope(a.tournament_id);
    return a.event_group_id ? resolveEntity({ eventGroup: a.event_group_id }) : null;
  }
  const direct: [string, string, string | undefined] =
    "announcement" in ref
      ? ["message_announcements", "organization_id, tournament_id", ref.announcement]
      : "eventGroup" in ref
        ? ["event_groups", "organization_id", ref.eventGroup]
        : "season" in ref
          ? ["seasons", "organization_id", ref.season]
          : "category" in ref
            ? ["ranking_categories", "organization_id", ref.category]
            : "member" in ref
              ? ["organization_members", "organization_id", ref.member]
              : "invite" in ref
                ? ["organization_invites", "organization_id", ref.invite]
                : ["organization_codes", "organization_id, tournament_id", ref.code];
  const [table, columns, id] = direct;
  if (!isUuid(id)) return null;
  const row = await one<{ organization_id: string; tournament_id?: string | null }>(table, columns, id);
  return row ? { orgId: row.organization_id, tournamentId: row.tournament_id ?? null, kind: null } : null;
}

/** Whether a principal may reach a resolved row: same organisation, and inside a code's tournament scope. */
export function principalReaches(staff: Pick<StaffPrincipal, "orgId" | "scopeTournamentId">, scope: EntityScope | null): scope is EntityScope {
  if (!scope || scope.orgId !== staff.orgId) return false;
  if (staff.scopeTournamentId && scope.tournamentId !== staff.scopeTournamentId) return false;
  return true;
}

/** The row's scope when the principal may reach it; null otherwise (not found and not yours alike). */
export async function entityInScope(staff: StaffPrincipal, ref: EntityRef): Promise<EntityScope | null> {
  const scope = await resolveEntity(ref);
  return principalReaches(staff, scope) ? scope : null;
}

/** An organisation's tournament ids (optionally of some kinds), for scoping lists of child rows. */
export async function orgTournamentIds(orgId: string, kinds?: string[]): Promise<string[]> {
  let q = db().from("tournaments").select("id").eq("organization_id", orgId);
  if (kinds?.length) q = q.in("kind", kinds);
  const { data } = await q.limit(5000);
  return ((data ?? []) as { id: string }[]).map((r) => r.id);
}

/** An approved organisation by slug (public pages); null for unknown or not approved. */
export async function approvedOrgBySlug(slug: string): Promise<{ id: string; slug: string; name: string } | null> {
  if (!/^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/.test(slug)) return null;
  const { data } = await db().from("organizations").select("id, slug, name, status").eq("slug", slug).maybeSingle();
  const o = data as { id: string; slug: string; name: string; status: string } | null;
  return o && o.status === "approved" ? { id: o.id, slug: o.slug, name: o.name } : null;
}

/** The organisation of a tournament, for audit rows and derived writes. */
export async function orgOfTournament(tournamentId: string | null | undefined): Promise<string | null> {
  return (await tournamentScope(tournamentId))?.orgId ?? null;
}

/** Whether a player profile is one of the organisation's players. */
export async function profileInOrg(orgId: string, profileId: string): Promise<boolean> {
  if (!isUuid(profileId)) return false;
  const { data } = await db()
    .from("organization_players")
    .select("player_profile_id")
    .eq("organization_id", orgId)
    .eq("player_profile_id", profileId)
    .maybeSingle();
  return Boolean(data);
}

/** The profile ids among `ids` that are the organisation's players. */
export async function profilesInOrg(orgId: string, ids: string[]): Promise<Set<string>> {
  const wanted = [...new Set(ids.filter(isUuid))];
  const out = new Set<string>();
  for (let i = 0; i < wanted.length; i += 200) {
    const { data } = await db()
      .from("organization_players")
      .select("player_profile_id")
      .eq("organization_id", orgId)
      .in("player_profile_id", wanted.slice(i, i + 200));
    for (const r of (data ?? []) as { player_profile_id: string }[]) out.add(r.player_profile_id);
  }
  return out;
}

/** Records that a player is one of an organisation's (idempotent; never changes an existing row). */
export async function ensureOrgPlayer(
  orgId: string,
  profileId: string,
  source: Exclude<OrgPlayerSource, "backfill">,
  approval: "pending" | "approved" = "pending",
  typedName: string | null = null,
): Promise<void> {
  if (!isUuid(orgId) || !isUuid(profileId)) return;
  const typed = typedName?.trim().slice(0, 80) || null;
  await db()
    .from("organization_players")
    .upsert(
      { organization_id: orgId, player_profile_id: profileId, source, approval_status: approval, ...(typed ? { typed_name: typed } : {}) },
      { onConflict: "organization_id,player_profile_id", ignoreDuplicates: true },
    );
}

/** The organisations that have this player (to decide whether person fields may be edited by one of them). */
export async function orgsOfProfile(profileId: string): Promise<string[]> {
  if (!isUuid(profileId)) return [];
  const { data } = await db().from("organization_players").select("organization_id").eq("player_profile_id", profileId);
  return ((data ?? []) as { organization_id: string }[]).map((r) => r.organization_id);
}
