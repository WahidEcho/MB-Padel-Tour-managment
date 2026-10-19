/**
 * Court referee codes (migration 0034), server side: what a court code reaches,
 * read fresh from the database on every request, and the organiser's tools
 * (Admin → Event codes → Court codes). Pure rules: src/lib/orgs/courtScope.ts.
 */
import { db } from "../supabase";
import { courtIdsNamed, courtKey, physicalCourts, type CourtScope } from "./courtScope";
import { isUuid } from "./roles";

interface CodeScopeRow {
  organization_id: string;
  tournament_id: string | null;
  event_group_id: string | null;
  court_name: string | null;
}

/**
 * The tournaments a court code covers: the event group's (of the code's own
 * organisation, kind "tournament"), or its one tournament.
 */
async function scopeTournaments(row: Pick<CodeScopeRow, "organization_id" | "tournament_id" | "event_group_id">): Promise<{ id: string; timezone: string | null }[]> {
  let q = db().from("tournaments").select("id, timezone").eq("organization_id", row.organization_id).eq("kind", "tournament");
  if (row.event_group_id) q = q.eq("event_group_id", row.event_group_id);
  else if (row.tournament_id) q = q.eq("id", row.tournament_id);
  else return [];
  const { data } = await q.limit(50);
  return (data ?? []) as { id: string; timezone: string | null }[];
}

/** What a court code reaches right now; an empty scope (reaches nothing) when its event is gone. */
export async function resolveCourtScope(row: CodeScopeRow): Promise<CourtScope> {
  const name = (row.court_name ?? "").trim();
  const tournaments = await scopeTournaments(row);
  const tournamentIds = tournaments.map((t) => t.id);
  let courtIds: string[] = [];
  let withCourt: string[] = [];
  if (tournamentIds.length && name) {
    const { data } = await db().from("courts").select("id, tournament_id, court_name").in("tournament_id", tournamentIds).limit(500);
    const rows = (data ?? []) as { id: string; tournament_id: string; court_name: string }[];
    courtIds = courtIdsNamed(rows, tournamentIds, name);
    const named = new Set(courtIds);
    withCourt = tournamentIds.filter((id) => rows.some((c) => c.tournament_id === id && named.has(c.id)));
  }
  return { name, key: courtKey(name), eventGroupId: row.event_group_id, tournamentIds, courtIds, withCourt };
}

/** An event the organiser makes court codes for: its group (both events) when it has one. */
export interface CourtCodeEvent {
  /** The tournament picked on the page. */
  tournamentId: string;
  eventGroupId: string | null;
  /** "Junior Team Finals · Cairo 2026" (the group) or the tournament's own name. */
  title: string;
  tournaments: { id: string; name: string }[];
  /** The last day of the event (its tournaments' latest ends_on), or null when none is set. */
  endsOn: string | null;
}

/** The event (and its group's tournaments) a court-codes page is for; null when not the organisation's. */
export async function courtCodeEvent(orgId: string, tournamentId: string): Promise<CourtCodeEvent | null> {
  if (!isUuid(tournamentId)) return null;
  const { data: t } = await db()
    .from("tournaments")
    .select("id, name, kind, event_group_id")
    .eq("id", tournamentId)
    .eq("organization_id", orgId)
    .maybeSingle();
  const row = t as { id: string; name: string; kind: string; event_group_id: string | null } | null;
  if (!row || row.kind !== "tournament") return null;
  const ends = async (ids: string[]) => {
    const { data } = await db().from("tournaments").select("ends_on, starts_on").in("id", ids);
    const days = ((data ?? []) as { ends_on: string | null; starts_on: string | null }[]).map((x) => x.ends_on ?? x.starts_on).filter((d): d is string => Boolean(d));
    return days.length ? days.sort().at(-1)! : null;
  };
  if (!row.event_group_id) return { tournamentId: row.id, eventGroupId: null, title: row.name, tournaments: [{ id: row.id, name: row.name }], endsOn: await ends([row.id]) };
  const [{ data: g }, { data: ts }] = await Promise.all([
    db().from("event_groups").select("id, name, organization_id").eq("id", row.event_group_id).maybeSingle(),
    db()
      .from("tournaments")
      .select("id, name")
      .eq("organization_id", orgId)
      .eq("kind", "tournament")
      .eq("event_group_id", row.event_group_id)
      .order("created_at", { ascending: true })
      .limit(50),
  ]);
  const group = g as { id: string; name: string; organization_id: string | null } | null;
  // A group that is not this organisation's own (it should never happen): the tournament alone.
  if (!group || group.organization_id !== orgId) return { tournamentId: row.id, eventGroupId: null, title: row.name, tournaments: [{ id: row.id, name: row.name }], endsOn: await ends([row.id]) };
  const tournaments = (ts ?? []) as { id: string; name: string }[];
  return { tournamentId: row.id, eventGroupId: group.id, title: group.name, tournaments, endsOn: await ends(tournaments.map((x) => x.id)) };
}

/** The physical courts of an event (one per name across its tournaments), in court order. */
export async function eventCourts(ev: CourtCodeEvent) {
  const ids = ev.tournaments.map((t) => t.id);
  if (!ids.length) return [];
  const { data } = await db().from("courts").select("id, tournament_id, court_name, court_order, is_active").in("tournament_id", ids).limit(500);
  const rows = ((data ?? []) as { id: string; tournament_id: string; court_name: string; court_order: number | null; is_active: boolean | null }[]).filter((c) => c.is_active !== false);
  return physicalCourts(rows);
}

export interface CourtCodeRow {
  id: string;
  label: string | null;
  court_name: string;
  tournament_id: string | null;
  event_group_id: string | null;
  code_sealed: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

/** The court codes made for this event (its group's, or its tournament's), newest first. */
export async function courtCodesOf(orgId: string, ev: CourtCodeEvent): Promise<CourtCodeRow[]> {
  let q = db()
    .from("organization_codes")
    .select("id, label, court_name, tournament_id, event_group_id, code_sealed, expires_at, revoked_at, last_used_at, created_at")
    .eq("organization_id", orgId)
    .eq("role", "referee")
    .not("court_name", "is", null);
  q = ev.eventGroupId ? q.eq("event_group_id", ev.eventGroupId) : q.eq("tournament_id", ev.tournamentId);
  const { data } = await q.order("created_at", { ascending: false }).limit(200);
  return (data ?? []) as CourtCodeRow[];
}

/** Whether a code still signs in. */
export function codeWorks(c: Pick<CourtCodeRow, "revoked_at" | "expires_at">, now = Date.now()): boolean {
  return !c.revoked_at && !(c.expires_at && Date.parse(c.expires_at) <= now);
}

/** When a court code made now stops working by default: the end of the event's last day (Cairo), or never without dates. */
export function eventEndExpiry(ev: Pick<CourtCodeEvent, "endsOn">, zonedToIso: (local: string) => string | null): string | null {
  return ev.endsOn ? zonedToIso(`${ev.endsOn}T23:59`) : null;
}
