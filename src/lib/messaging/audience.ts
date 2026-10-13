/**
 * Who an announcement is for, resolved against the database — always inside the
 * announcement's organisation: an organisation messages only its own players.
 *
 * - all_players: every one of the organisation's players (organization_players)
 *   it has approved or not yet decided on (not rejected, not merged away), whose
 *   person fields it may see (src/lib/orgs/personFields.ts): another
 *   organisation's player it only matched by a number typed on its public form is
 *   left out. Contact details live on the profile (email, mobile_normalized).
 * - tournament / nation: the players entered in one of the organisation's
 *   tournaments, or in its teams carrying a nation code. Contact: the player's own phone/email (players.phone,
 *   players.email), else their linked profile's, else the team's contact phone. A linked
 *   profile the organisation does not vouch for while another organisation has it
 *   (hiddenPersonFields: it only matched it by a typed mobile, or a link joined its row
 *   to someone else's profile) is never a contact source, and is named as typed on
 *   the organisation's own form.
 * - app_users: Move Score app installs; reachable by push only.
 * - list: pasted names, emails and phone numbers.
 *
 * A player profile with a player_consents row saying granted = false for a
 * channel is not messaged on it (recorded as "not sent", with the reason).
 */
import { db } from "../supabase";
import { formatAccessCode } from "../players/accessCode";
import { revealCode } from "../players/codeVault";
import { appLink, tournamentLink } from "./links";
import { parsePastedList, type Recipient } from "./recipients";
import { orgTournamentIds, resolveEntity } from "../orgs/scope";
import { hiddenPersonFields, matchedElsewhere, UNNAMED_MATCHED, visiblePersonFields } from "../orgs/personFields";
import type { Channel } from "./status";
import type { Audience } from "./audienceSpec";

export { AUDIENCE_LABEL, channelsFor, parseAudience, type Audience } from "./audienceSpec";

interface ProfileRow {
  id: string;
  public_name: string;
  mobile_normalized: string | null;
  email: string | null;
}
interface PlayerRow {
  id: string;
  full_name: string;
  team_id: string;
  tournament_id: string;
  player_profile_id: string | null;
  access_code?: string | null;
  access_code_hash?: string | null;
  access_code_sealed?: string | null;
  /** The player's own contact (0018), set by organisers or by the player in the app. */
  phone?: string | null;
  email?: string | null;
}

const PAGE = 1000;

async function pageAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

async function inChunks<T>(ids: string[], fetch: (chunk: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await fetch(ids.slice(i, i + 200));
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

/** Channels each profile declined. */
async function declined(profileIds: string[]): Promise<Map<string, Channel[]>> {
  const rows = await inChunks<{ player_profile_id: string; channel: string }>(profileIds, (c) =>
    db().from("player_consents").select("player_profile_id, channel").eq("granted", false).in("player_profile_id", c),
  );
  const out = new Map<string, Channel[]>();
  for (const r of rows) {
    if (r.channel !== "email" && r.channel !== "whatsapp") continue;
    out.set(r.player_profile_id, [...(out.get(r.player_profile_id) ?? []), r.channel]);
  }
  return out;
}

/** players.access_code may not exist yet (migration 0018/0020 not applied): treat as no codes. */
async function selectPlayers(filter: (cols: string) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<PlayerRow[]> {
  // Newest schema first; older databases (before 0018/0020) lack the contact and code columns.
  const base = "id, full_name, team_id, tournament_id, player_profile_id";
  const tries = [`${base}, access_code, access_code_hash, access_code_sealed, phone, email`, `${base}, access_code, phone, email`, `${base}, access_code`, base];
  let last = "";
  for (const cols of tries) {
    const r = await filter(cols);
    if (!r.error) return (r.data ?? []) as PlayerRow[];
    last = r.error.message;
    if (!/access_code|phone|email|column/.test(last)) break;
  }
  throw new Error(last);
}

/**
 * The player's code for the message (in memory only: the send queue stores
 * `code_ref`, the player row, and reads the code again when it sends).
 */
function codeVars(p: PlayerRow): { code: string | null; code_ref: string | null } {
  const code = revealCode(p);
  return code ? { code: formatAccessCode(code), code_ref: p.id } : { code: null, code_ref: null };
}

/** Where a contact came from, best first: the player row, their platform profile, the team contact. */
export function pickContact(
  p: { phone?: string | null; email?: string | null },
  prof: { mobile_normalized: string | null; email: string | null } | undefined,
  teamPhone: string | null | undefined,
) {
  const email = p.email ? { value: p.email, source: "player" as const } : prof?.email ? { value: prof.email, source: "profile" as const } : null;
  const phone = p.phone
    ? { value: p.phone, source: "player" as const }
    : prof?.mobile_normalized
      ? { value: prof.mobile_normalized, source: "profile" as const }
      : teamPhone
        ? { value: teamPhone, source: "team" as const }
        : null;
  return { email, phone };
}

async function playersToRecipients(players: PlayerRow[], orgId: string): Promise<Recipient[]> {
  const teamIds = [...new Set(players.map((p) => p.team_id))];
  const tournamentIds = [...new Set(players.map((p) => p.tournament_id))];
  const profileIds = [...new Set(players.map((p) => p.player_profile_id).filter((x): x is string => !!x))];
  // Person fields this organisation may not use (src/lib/orgs/personFields.ts): no contact
  // from those profiles, and the name typed on its own form instead of anything else.
  const [hidden, typedNames] = await Promise.all([hiddenPersonFields(orgId, profileIds), matchedElsewhere(orgId, profileIds)]);
  const usable = profileIds.filter((id) => !hidden.has(id));
  const [teams, tournaments, profiles, optOut] = await Promise.all([
    inChunks<{ id: string; phone: string | null; team_status: string | null }>(teamIds, (c) => db().from("teams").select("id, phone, team_status").in("id", c)),
    inChunks<{ id: string; name: string; slug: string }>(tournamentIds, (c) => db().from("tournaments").select("id, name, slug").in("id", c)),
    inChunks<ProfileRow>(usable, (c) => db().from("player_profiles").select("id, public_name, mobile_normalized, email").in("id", c)),
    // A player's own "no" is honoured whoever's profile it is.
    declined(profileIds),
  ]);
  const teamOf = new Map(teams.map((t) => [t.id, t]));
  const tOf = new Map(tournaments.map((t) => [t.id, t]));
  const profOf = new Map(profiles.map((p) => [p.id, p]));
  return players
    .filter((p) => teamOf.get(p.team_id)?.team_status !== "withdrawn")
    .map((p) => {
      const isHidden = Boolean(p.player_profile_id && hidden.has(p.player_profile_id));
      const prof = p.player_profile_id && !isHidden ? profOf.get(p.player_profile_id) : undefined;
      const t = tOf.get(p.tournament_id);
      const c = pickContact(p, prof, teamOf.get(p.team_id)?.phone);
      const name = isHidden ? (typedNames.get(p.player_profile_id!) ?? (p.full_name?.trim() || UNNAMED_MATCHED)) : p.full_name;
      return {
        kind: "player" as const,
        id: p.id,
        name,
        email: c.email?.value ?? null,
        phone: c.phone?.value ?? null,
        sources: { email: c.email?.source ?? null, phone: c.phone?.source ?? null },
        vars: { name, ...codeVars(p), tournament: t?.name ?? null, link: t ? tournamentLink(t.slug) : null, app_link: appLink() },
        optedOut: p.player_profile_id ? optOut.get(p.player_profile_id) : undefined,
      };
    });
}

export interface Resolved {
  recipients: Recipient[];
  /** Pasted lines that had neither an email nor a phone. */
  rejected: string[];
}

export async function resolveAudience(a: Audience, orgId: string): Promise<Resolved> {
  switch (a.type) {
    case "all_players": {
      const mine = await pageAll<{ player_profile_id: string }>((from, to) =>
        db()
          .from("organization_players")
          .select("player_profile_id")
          .eq("organization_id", orgId)
          .in("approval_status", ["approved", "pending"])
          .order("created_at")
          .range(from, to),
      );
      const reachable = await visiblePersonFields(orgId, mine.map((m) => m.player_profile_id));
      const profiles = (
        await inChunks<ProfileRow & { approval_status: string; created_at: string }>(
          mine.map((m) => m.player_profile_id).filter((id) => reachable.has(id)),
          (c) => db().from("player_profiles").select("id, public_name, mobile_normalized, email, approval_status, created_at").in("id", c),
        )
      )
        .filter((p) => p.approval_status !== "merged")
        .sort((x, y) => x.created_at.localeCompare(y.created_at));
      const orgTournaments = new Set(await orgTournamentIds(orgId));
      const ids = profiles.map((p) => p.id);
      const optOut = await declined(ids);
      // Each profile's most recent access code, if the player-codes feature has issued one.
      const coded = await pageAll<PlayerRow>((from, to) =>
        db()
          .from("players")
          .select("id, full_name, team_id, tournament_id, player_profile_id, access_code, access_code_hash, access_code_sealed")
          .or("access_code.not.is.null,access_code_hash.not.is.null")
          .not("player_profile_id", "is", null)
          .order("created_at", { ascending: false })
          .range(from, to),
      ).catch(() => [] as PlayerRow[]);
      const codeOf = new Map<string, { code: string | null; code_ref: string | null }>();
      // Only codes from this organisation's own tournaments.
      for (const p of coded) {
        if (!orgTournaments.has(p.tournament_id)) continue;
        if (p.player_profile_id && !codeOf.has(p.player_profile_id)) {
          const v = codeVars(p);
          if (v.code) codeOf.set(p.player_profile_id, v);
        }
      }
      return {
        recipients: profiles.map((p) => ({
          kind: "player_profile",
          id: p.id,
          name: p.public_name,
          email: p.email,
          phone: p.mobile_normalized,
          vars: { name: p.public_name, code: codeOf.get(p.id)?.code ?? null, code_ref: codeOf.get(p.id)?.code_ref ?? null, app_link: appLink() },
          optedOut: optOut.get(p.id),
        })),
        rejected: [],
      };
    }
    case "tournament": {
      // Another organisation's tournament reaches nobody.
      if ((await resolveEntity({ tournament: a.tournamentId }))?.orgId !== orgId) return { recipients: [], rejected: [] };
      const players = await selectPlayers((cols) => db().from("players").select(cols).eq("tournament_id", a.tournamentId).order("created_at").limit(5000));
      return { recipients: await playersToRecipients(players, orgId), rejected: [] };
    }
    case "nation": {
      const { data: teams, error } = await db().from("teams").select("id, tournament_id").eq("nation_code", a.nationCode);
      if (error) throw new Error(error.message);
      const own = new Set(await orgTournamentIds(orgId));
      const teamIds = ((teams ?? []) as { id: string; tournament_id: string }[]).filter((t) => own.has(t.tournament_id)).map((t) => t.id);
      const players: PlayerRow[] = [];
      for (let i = 0; i < teamIds.length; i += 200) {
        const chunk = teamIds.slice(i, i + 200);
        players.push(...(await selectPlayers((cols) => db().from("players").select(cols).in("team_id", chunk))));
      }
      return { recipients: await playersToRecipients(players, orgId), rejected: [] };
    }
    case "app_users":
      return { recipients: [], rejected: [] };
    case "list": {
      const { recipients, rejected } = parsePastedList(a.list);
      return { recipients: recipients.map((r) => ({ ...r, vars: { ...r.vars, app_link: appLink() } })), rejected };
    }
  }
}

/** Nation codes that have teams in the organisation's tournaments, for the audience picker. */
export async function nationOptions(orgId: string): Promise<{ code: string; teams: number }[]> {
  const { data } = await db().from("teams").select("nation_code, tournament_id").not("nation_code", "is", null).limit(5000);
  const own = new Set(await orgTournamentIds(orgId));
  const counts = new Map<string, number>();
  for (const r of (data ?? []) as { nation_code: string; tournament_id: string }[]) {
    if (own.has(r.tournament_id)) counts.set(r.nation_code, (counts.get(r.nation_code) ?? 0) + 1);
  }
  return [...counts].map(([code, teams]) => ({ code, teams })).sort((x, y) => x.code.localeCompare(y.code));
}
