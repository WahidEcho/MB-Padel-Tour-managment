/**
 * Shared fixtures for the stand-in E2E scripts (scripts/localdb): pass/fail
 * bookkeeping, HTTP with a staff cookie or bearer, signed-in app users from the
 * stand-in's Supabase Auth, and the rows a match-day test needs — a tournament
 * with its match-day rules, teams with players, courts, matches, phones (push
 * devices), player links (player_claims), follows and another organisation's
 * referee. Every row made here is remembered and removed by `cleanup()`.
 *
 * Stand-in only: `assertStandIn()` refuses any SUPABASE_URL that is not local.
 */
import { createHash, randomBytes, randomUUID } from "crypto";
import { db } from "../../../src/lib/supabase";
import { generateEventCode, hashEventCode } from "../../../src/lib/orgs/codes";
import { newTournamentMatchDayRules } from "../../../src/lib/matchday/rules";
import { DEFAULT_SCORING_CONFIG, type Match } from "../../../src/lib/types";
import { BASE_URL, sessionToken, staffToken } from "./session";

export { BASE_URL };

const SUPA = process.env.SUPABASE_URL ?? "";

export function assertStandIn(script: string) {
  if (!/localhost|127\.0\.0\.1/.test(SUPA)) throw new Error(`${script} runs against the local stand-in only`);
  if (!process.env.STAFF_SESSION_SECRET) throw new Error("STAFF_SESSION_SECRET must be set (the server's, in .env.localdb)");
}

/* ---------------- bookkeeping ---------------- */

const tally = { passed: 0, failed: 0 };

export function check(ok: boolean, label: string, detail?: unknown) {
  if (ok) tally.passed++;
  else tally.failed++;
  const show = detail !== undefined && (!ok || process.env.VERBOSE);
  console.log(`${ok ? "✅" : "❌"} ${label}${show ? ` — ${typeof detail === "string" ? detail.slice(0, 400) : JSON.stringify(detail).slice(0, 400)}` : ""}`);
}

export const section = (s: string) => console.log(`\n— ${s}`);

export function finish(name: string): never {
  console.log(`\n${tally.failed === 0 ? "✅" : "❌"} ${name}: ${tally.passed} passed, ${tally.failed} failed`);
  process.exit(tally.failed === 0 ? 0 : 1);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns something truthy, or gives up after `ms` and returns the last value. */
export async function eventually<T>(fn: () => Promise<T>, ms = 6000, every = 250): Promise<T> {
  const until = Date.now() + ms;
  let last = await fn();
  while (!last && Date.now() < until) {
    await sleep(every);
    last = await fn();
  }
  return last;
}

/* ---------------- HTTP ---------------- */

export type Who = Record<string, string>;
export const cookie = (token: string): Who => ({ Cookie: `mb_session=${token}` });
export const bearer = (token: string): Who => ({ Authorization: `Bearer ${token}` });
/** Move Beyond's staff, through the shared role sessions. */
export const staff = (role: "admin" | "manager" | "referee" | "operator"): Who => cookie(sessionToken(role));

export async function http(method: string, path: string, who: Who = {}, body?: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    redirect: "manual",
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...who },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, text, json, cache: res.headers.get("cache-control") };
}

/* ---------------- app users (the stand-in's Supabase Auth) ---------------- */

/** A signed-in app user (Google through PKCE on the stand-in): the bearer token the app sends, and the user id. */
export async function appUser(email: string): Promise<{ token: string; userId: string }> {
  const verifier = randomBytes(40).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const a = await fetch(
    `${SUPA}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent("movescore://auth/callback")}&code_challenge=${challenge}&code_challenge_method=s256&login_hint=${encodeURIComponent(email)}`,
    { redirect: "manual" },
  );
  const code = new URL(a.headers.get("location")!).searchParams.get("code");
  const t = await fetch(`${SUPA}/auth/v1/token?grant_type=pkce`, {
    method: "POST",
    headers: { apikey: process.env.SUPABASE_KEY ?? "", "Content-Type": "application/json" },
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
  });
  const j = (await t.json()) as { access_token: string; user: { id: string } };
  return { token: j.access_token, userId: j.user.id };
}

/* ---------------- rows ---------------- */

export interface Created {
  tournaments: string[];
  orgs: string[];
  devices: string[];
  users: string[];
}

export function fixtures(tag: string) {
  const created: Created = { tournaments: [], orgs: [], devices: [], users: [] };

  async function tournament(opts: { name: string; rules?: Record<string, unknown>; scoring?: Record<string, unknown>; sport?: string }) {
    const sport = opts.sport ?? "padel";
    const base = newTournamentMatchDayRules(sport) as unknown as Record<string, unknown>;
    const rules = opts.rules ? deepMerge(base, opts.rules) : base;
    const { data, error } = await db()
      .from("tournaments")
      .insert({
        name: `${opts.name} ${tag}`,
        slug: `${opts.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${tag}`,
        sport,
        status: "active",
        is_demo: true,
        scoring_config: { ...DEFAULT_SCORING_CONFIG, ...(opts.scoring ?? {}) },
        match_day_rules: rules,
      })
      .select("id")
      .single();
    if (error) throw new Error(`tournament: ${error.message}`);
    const id = (data as { id: string }).id;
    created.tournaments.push(id);
    return id;
  }

  /** Teams of `perTeam` players each, in one published group. Player names only: no phone, email or code is set. */
  async function teams(tournamentId: string, names: string[], perTeam = 2) {
    const { data, error } = await db()
      .from("teams")
      .insert(names.map((n) => ({ tournament_id: tournamentId, team_name: `${n} ${tag}` })))
      .select("id, team_name");
    if (error) throw new Error(`teams: ${error.message}`);
    const rows = (data as { id: string; team_name: string }[]).sort((a, b) => names.indexOf(a.team_name.split(" ")[0]) - names.indexOf(b.team_name.split(" ")[0]));
    const { data: g } = await db().from("groups").insert({ tournament_id: tournamentId, group_name: "A", status: "published" }).select("id").single();
    const groupId = (g as { id: string }).id;
    await db().from("group_teams").insert(rows.map((t, i) => ({ tournament_id: tournamentId, group_id: groupId, team_id: t.id, position: i + 1 })));
    const out: { id: string; name: string; players: string[] }[] = [];
    for (const t of rows) {
      const { data: ps, error: pe } = await db()
        .from("players")
        .insert(Array.from({ length: perTeam }, (_, i) => ({ tournament_id: tournamentId, team_id: t.id, full_name: `${t.team_name.split(" ")[0]} Player${i + 1}`, player_order: i + 1 })))
        .select("id, player_order");
      if (pe) throw new Error(`players: ${pe.message}`);
      out.push({ id: t.id, name: t.team_name, players: ((ps ?? []) as { id: string; player_order: number }[]).sort((a, b) => a.player_order - b.player_order).map((p) => p.id) });
    }
    return { groupId, teams: out };
  }

  async function courts(tournamentId: string, n: number) {
    const { data, error } = await db()
      .from("courts")
      .insert(Array.from({ length: n }, (_, i) => ({ tournament_id: tournamentId, court_name: `Court ${i + 1}`, court_order: i + 1 })))
      .select("id, court_order");
    if (error) throw new Error(`courts: ${error.message}`);
    return ((data ?? []) as { id: string; court_order: number }[]).sort((a, b) => a.court_order - b.court_order).map((c) => c.id);
  }

  async function match(tournamentId: string, m: Partial<Match> & { team_a_id: string | null; team_b_id: string | null }) {
    const { data, error } = await db()
      .from("matches")
      .insert({ tournament_id: tournamentId, stage: "group", round_name: "Group A", match_order: 1, status: "scheduled", ...m })
      .select("*")
      .single();
    if (error) throw new Error(`match: ${error.message}`);
    return data as Match;
  }

  /** A phone with push on; `userId` makes it a signed-in account's phone. */
  async function device(name: string, opts: { userId?: string | null; prefs?: Record<string, unknown> } = {}) {
    const installationId = `e2e-${tag}-${name}-${randomUUID().slice(0, 8)}`;
    const { data, error } = await db()
      .from("push_devices")
      .insert({
        installation_id: installationId,
        platform: "ios",
        user_id: opts.userId ?? null,
        expo_push_token: `ExponentPushToken[e2e${tag}${name}${randomUUID().slice(0, 8)}]`.replace(/[^A-Za-z0-9_[\]-]/g, ""),
        prefs: opts.prefs ?? {},
      })
      .select("id")
      .single();
    if (error) throw new Error(`device: ${error.message}`);
    const id = (data as { id: string }).id;
    created.devices.push(id);
    return { id, installationId };
  }

  /** The account plays as this player (a claimed player code). */
  async function link(userId: string, playerId: string) {
    const { error } = await db().from("player_claims").insert({ user_id: userId, player_id: playerId });
    if (error) throw new Error(`player_claims: ${error.message}`);
    if (!created.users.includes(userId)) created.users.push(userId);
  }

  async function follow(installationId: string, kind: "match" | "player" | "tournament", key: string, tournamentId?: string) {
    const { error } = await db().from("follows").insert({ owner_kind: "install", owner_id: installationId, target_kind: kind, target_key: key, tournament_id: tournamentId ?? null });
    if (error) throw new Error(`follows: ${error.message}`);
  }

  /** A referee of another organisation, by event code (bearer), and that organisation's id. */
  async function otherOrgReferee(): Promise<{ who: Who; orgId: string }> {
    const { data: o, error } = await db().from("organizations").insert({ slug: `e2e-x-${tag}`, name: `E2E Other ${tag}`, status: "approved" }).select("id").single();
    if (error) throw new Error(`organizations: ${error.message}`);
    const orgId = (o as { id: string }).id;
    created.orgs.push(orgId);
    const code = generateEventCode();
    const { data: cr } = await db().from("organization_codes").insert({ organization_id: orgId, role: "referee", code_hash: hashEventCode(code), label: "e2e" }).select("id").single();
    return { who: bearer(staffToken({ kind: "code", codeId: (cr as { id: string }).id, orgId, role: "referee" })), orgId };
  }

  /** Removes everything made here (tournaments cascade to teams, players, matches, calls, alerts). */
  async function cleanup(): Promise<boolean> {
    const t = created.tournaments;
    if (t.length) {
      await db().from("audit_logs").delete().in("tournament_id", t);
      await db().from("follows").delete().in("tournament_id", t);
      await db().from("notification_events").delete().in("tournament_id", t);
      await db().from("tournaments").delete().in("id", t);
    }
    if (created.devices.length) await db().from("push_devices").delete().in("id", created.devices);
    if (created.users.length) await db().from("player_claims").delete().in("user_id", created.users);
    if (created.orgs.length) {
      await db().from("organization_codes").delete().in("organization_id", created.orgs);
      await db().from("audit_logs").delete().in("organization_id", created.orgs);
      await db().from("organizations").delete().in("id", created.orgs);
    }
    const { count } = t.length ? await db().from("tournaments").select("id", { count: "exact", head: true }).in("id", t) : { count: 0 };
    return (count ?? 0) === 0;
  }

  return { created, tournament, teams, courts, match, device, link, follow, otherOrgReferee, cleanup };
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && b && typeof b === "object" ? deepMerge(b as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}

/* ---------------- score events ---------------- */

export function scoreEvent(n: number, type: string, prev: unknown, next: unknown, extra: { team_id?: string | null; payload?: Record<string, unknown> | null } = {}) {
  return {
    client_event_id: randomUUID(),
    event_number: n,
    event_type: type,
    team_id: extra.team_id ?? null,
    previous_state: prev,
    new_state: next,
    payload: extra.payload ?? null,
    created_at_client: new Date().toISOString(),
  };
}

export async function lastEvent(matchId: string): Promise<{ n: number; state: unknown }> {
  const { data } = await db().from("match_score_snapshots").select("last_event_number, snapshot_json").eq("match_id", matchId).maybeSingle();
  const s = data as { last_event_number: number; snapshot_json: unknown } | null;
  return { n: s?.last_event_number ?? 0, state: s?.snapshot_json ?? null };
}

export function sendEvents(matchId: string, who: Who, events: unknown[], deviceId: string) {
  return http("POST", `/api/matches/${matchId}/events`, who, { deviceId, events });
}
