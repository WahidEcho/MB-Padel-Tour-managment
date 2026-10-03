/**
 * Who an announcement is for, resolved against the database.
 *
 * - all_players: every player profile on the platform that is approved or
 *   awaiting approval (not rejected, not merged away). Contact details live on
 *   the profile (email, mobile_normalized).
 * - tournament / nation: the players entered in a tournament, or in every team
 *   carrying a nation code. Their contact details come from the linked profile;
 *   a player without one falls back to the team's contact phone.
 * - app_users: Move Score app installs; reachable by push only.
 * - list: pasted names, emails and phone numbers.
 *
 * A player profile with a player_consents row saying granted = false for a
 * channel is not messaged on it (recorded as "not sent", with the reason).
 */
import { db } from "../supabase";
import { appLink, tournamentLink } from "./links";
import { parsePastedList, type Recipient } from "./recipients";
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
  const withCode = await filter("id, full_name, team_id, tournament_id, player_profile_id, access_code");
  if (!withCode.error) return (withCode.data ?? []) as PlayerRow[];
  if (!/access_code/.test(withCode.error.message)) throw new Error(withCode.error.message);
  const plain = await filter("id, full_name, team_id, tournament_id, player_profile_id");
  if (plain.error) throw new Error(plain.error.message);
  return (plain.data ?? []) as PlayerRow[];
}

async function playersToRecipients(players: PlayerRow[]): Promise<Recipient[]> {
  const teamIds = [...new Set(players.map((p) => p.team_id))];
  const tournamentIds = [...new Set(players.map((p) => p.tournament_id))];
  const profileIds = [...new Set(players.map((p) => p.player_profile_id).filter((x): x is string => !!x))];
  const [teams, tournaments, profiles, optOut] = await Promise.all([
    inChunks<{ id: string; phone: string | null; team_status: string | null }>(teamIds, (c) => db().from("teams").select("id, phone, team_status").in("id", c)),
    inChunks<{ id: string; name: string; slug: string }>(tournamentIds, (c) => db().from("tournaments").select("id, name, slug").in("id", c)),
    inChunks<ProfileRow>(profileIds, (c) => db().from("player_profiles").select("id, public_name, mobile_normalized, email").in("id", c)),
    declined(profileIds),
  ]);
  const teamOf = new Map(teams.map((t) => [t.id, t]));
  const tOf = new Map(tournaments.map((t) => [t.id, t]));
  const profOf = new Map(profiles.map((p) => [p.id, p]));
  return players
    .filter((p) => teamOf.get(p.team_id)?.team_status !== "withdrawn")
    .map((p) => {
      const prof = p.player_profile_id ? profOf.get(p.player_profile_id) : undefined;
      const t = tOf.get(p.tournament_id);
      return {
        kind: "player" as const,
        id: p.id,
        name: p.full_name,
        email: prof?.email ?? null,
        phone: prof?.mobile_normalized ?? teamOf.get(p.team_id)?.phone ?? null,
        vars: { name: p.full_name, code: p.access_code ?? null, tournament: t?.name ?? null, link: t ? tournamentLink(t.slug) : null, app_link: appLink() },
        optedOut: p.player_profile_id ? optOut.get(p.player_profile_id) : undefined,
      };
    });
}

export interface Resolved {
  recipients: Recipient[];
  /** Pasted lines that had neither an email nor a phone. */
  rejected: string[];
}

export async function resolveAudience(a: Audience): Promise<Resolved> {
  switch (a.type) {
    case "all_players": {
      const profiles = await pageAll<ProfileRow>((from, to) =>
        db().from("player_profiles").select("id, public_name, mobile_normalized, email").in("approval_status", ["approved", "pending"]).order("created_at").range(from, to),
      );
      const ids = profiles.map((p) => p.id);
      const optOut = await declined(ids);
      // Each profile's most recent access code, if the player-codes feature has issued one.
      const coded = await pageAll<PlayerRow>((from, to) =>
        db()
          .from("players")
          .select("id, full_name, team_id, tournament_id, player_profile_id, access_code")
          .not("access_code", "is", null)
          .not("player_profile_id", "is", null)
          .order("created_at", { ascending: false })
          .range(from, to),
      ).catch(() => [] as PlayerRow[]);
      const codeOf = new Map<string, string>();
      for (const p of coded) if (p.access_code && p.player_profile_id && !codeOf.has(p.player_profile_id)) codeOf.set(p.player_profile_id, p.access_code);
      return {
        recipients: profiles.map((p) => ({
          kind: "player_profile",
          id: p.id,
          name: p.public_name,
          email: p.email,
          phone: p.mobile_normalized,
          vars: { name: p.public_name, code: codeOf.get(p.id) ?? null, app_link: appLink() },
          optedOut: optOut.get(p.id),
        })),
        rejected: [],
      };
    }
    case "tournament": {
      const players = await selectPlayers((cols) => db().from("players").select(cols).eq("tournament_id", a.tournamentId).order("created_at").limit(5000));
      return { recipients: await playersToRecipients(players), rejected: [] };
    }
    case "nation": {
      const { data: teams, error } = await db().from("teams").select("id").eq("nation_code", a.nationCode);
      if (error) throw new Error(error.message);
      const teamIds = ((teams ?? []) as { id: string }[]).map((t) => t.id);
      const players: PlayerRow[] = [];
      for (let i = 0; i < teamIds.length; i += 200) {
        const chunk = teamIds.slice(i, i + 200);
        players.push(...(await selectPlayers((cols) => db().from("players").select(cols).in("team_id", chunk))));
      }
      return { recipients: await playersToRecipients(players), rejected: [] };
    }
    case "app_users":
      return { recipients: [], rejected: [] };
    case "list": {
      const { recipients, rejected } = parsePastedList(a.list);
      return { recipients: recipients.map((r) => ({ ...r, vars: { ...r.vars, app_link: appLink() } })), rejected };
    }
  }
}

/** Nation codes that have teams, for the audience picker. */
export async function nationOptions(): Promise<{ code: string; teams: number }[]> {
  const { data } = await db().from("teams").select("nation_code").not("nation_code", "is", null).limit(5000);
  const counts = new Map<string, number>();
  for (const r of (data ?? []) as { nation_code: string }[]) counts.set(r.nation_code, (counts.get(r.nation_code) ?? 0) + 1);
  return [...counts].map(([code, teams]) => ({ code, teams })).sort((x, y) => x.code.localeCompare(y.code));
}
