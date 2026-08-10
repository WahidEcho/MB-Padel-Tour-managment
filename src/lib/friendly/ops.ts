/**
 * Server mutations for friendly sessions.
 * Mirrors `src/lib/ops.ts`: calls `db()` directly, framework-free, and is the
 * single place cross-entity friendly logic lives.
 */
import { db } from "../supabase";
import { audit, slugify } from "../audit";
import { getCourts } from "../data";
import { DEFAULT_SCORING_CONFIG, type PairingMode, type RankingModel, type ScoringConfig } from "../types";
import type { CompletedSet, Match, MatchSnapshot } from "../types";
import { normalizeMobile } from "./mobile";
import {
  rebuildFromResults,
  resultKindFor,
  BASE_WIN_POINTS,
  type FireResultInput,
} from "./fire";
import { estimateCapacity } from "./capacity";
import {
  generateAmericanoSchedule,
  generateFixedSchedule,
  nextMexicanoRound,
  type FixedPair,
  type MexicanoPairing,
  type ScheduledRound,
} from "./scheduler";
import { buildRanking, toMexicanoStandings, type LedgerEntry, type PlayerMatchStat } from "./ranking";

/* ------------------------------------------------------------------ */
/* Session creation                                                    */
/* ------------------------------------------------------------------ */

export interface CreateSessionInput {
  name: string;
  seasonId: string | null;
  startsAt: string | null;
  durationMinutes: number;
  courtCount: number;
  pairingMode: PairingMode;
  rankingModel: RankingModel;
  /** Sets needed to win a match. Rotation sessions default to 1 (one set to 6). */
  setsToWinMatch: number;
  gamesToWinSet: number;
  maxPlayers: number | null;
  registrationDeadline: string | null;
  actorRole: string;
}

/**
 * Create a friendly session and the hidden `tournaments` row that backs it.
 *
 * The backing row is what lets the entire existing scoring stack — referee
 * screen, offline queue, events sync, device locks, snapshots, TV modes — work
 * for friendly matches without modification. It is marked
 * `kind = 'friendly_session'` so it never appears in any tournament list.
 */
export async function createFriendlySession(input: CreateSessionInput) {
  const name = input.name.trim();
  if (!name) throw new Error("Session name is required");

  const courtCount = Math.min(20, Math.max(1, input.courtCount));
  const scoringConfig: ScoringConfig = {
    ...DEFAULT_SCORING_CONFIG,
    setsToWinMatch: Math.min(3, Math.max(1, input.setsToWinMatch)),
    gamesToWinSet: Math.min(9, Math.max(1, input.gamesToWinSet)),
  };

  const suffix = Math.random().toString(36).slice(2, 6);
  const slug = `${slugify(name)}-${suffix}`;

  // 1. Backing tournament row.
  const { data: backing, error: tErr } = await db()
    .from("tournaments")
    .insert({
      name: `[Session] ${name}`,
      slug: `fs-${slug}`,
      sport: "padel",
      kind: "friendly_session",
      status: "active",
      scoring_config: scoringConfig,
      public_access_enabled: true,
      created_by: input.actorRole,
    })
    .select()
    .single();
  if (tErr) throw new Error(tErr.message);

  // 2. Courts on the backing row — the scheduler assigns matches to these.
  await db()
    .from("courts")
    .insert(
      Array.from({ length: courtCount }, (_, i) => ({
        tournament_id: backing.id,
        court_name: `Court ${i + 1}`,
        court_order: i + 1,
      }))
    );
  await db().from("screen_settings").insert({ tournament_id: backing.id, screen_key: "main" });

  // 3. The session itself.
  const { data: session, error: sErr } = await db()
    .from("friendly_sessions")
    .insert({
      tournament_id: backing.id,
      season_id: input.seasonId,
      slug,
      name,
      status: "draft",
      starts_at: input.startsAt,
      duration_minutes: input.durationMinutes,
      registration_deadline: input.registrationDeadline,
      expected_match_minutes: scoringConfig.setsToWinMatch > 1 ? 60 : 30,
      pairing_mode: input.pairingMode,
      ranking_model: input.rankingModel,
      max_players: input.maxPlayers,
      // Stored so a regenerated round-1 draw reproduces exactly.
      draw_seed: Math.floor(Math.random() * 2_147_483_647),
    })
    .select()
    .single();
  if (sErr) {
    // Don't strand an orphan backing row if the session insert fails.
    await db().from("tournaments").delete().eq("id", backing.id);
    throw new Error(sErr.message);
  }

  await audit({
    tournament_id: backing.id,
    actor_role: input.actorRole,
    action: "FRIENDLY_SESSION_CREATED",
    entity_type: "friendly_session",
    entity_id: session.id,
    new_value: { name, slug, pairing_mode: input.pairingMode, ranking_model: input.rankingModel },
  });

  return session;
}

/* ------------------------------------------------------------------ */
/* Public registration                                                 */
/* ------------------------------------------------------------------ */

export interface RegistrationInput {
  sessionId: string;
  publicName: string;
  mobile: string;
  preferredPartnerName?: string | null;
  /** Explicit opt-in. Unticked by default on the form (PDPL). */
  consentWhatsapp: boolean;
}

export type RegistrationOutcome =
  | { ok: true }
  | { ok: false; reason: "closed" | "invalid_name" | "invalid_mobile" };

/**
 * Register a player for a session from the public form.
 *
 * Returns an intentionally opaque result: callers must not be able to tell
 * whether a mobile number already belongs to an existing player, whether the
 * player was already registered, or whether they landed on the waitlist.
 * Duplicate handling is admin-only. The only distinctions surfaced are ones
 * the submitter can fix themselves (bad name, bad number, closed session).
 */
export async function registerForSession(input: RegistrationInput): Promise<RegistrationOutcome> {
  const publicName = input.publicName.trim();
  if (publicName.length < 2 || publicName.length > 80) return { ok: false, reason: "invalid_name" };

  const mobile = normalizeMobile(input.mobile);
  if (!mobile) return { ok: false, reason: "invalid_mobile" };

  const { data: session } = await db()
    .from("friendly_sessions")
    .select("id, status, registration_deadline")
    .eq("id", input.sessionId)
    .maybeSingle();
  if (!session) return { ok: false, reason: "closed" };
  if (session.status !== "open") return { ok: false, reason: "closed" };
  if (session.registration_deadline && new Date(session.registration_deadline) < new Date()) {
    return { ok: false, reason: "closed" };
  }

  // Find-or-create the profile. A self-registration always starts pending;
  // an existing profile keeps whatever status it already had.
  const { data: existing } = await db()
    .from("player_profiles")
    .select("id")
    .eq("mobile_normalized", mobile)
    .maybeSingle();

  let profileId = existing?.id as string | undefined;
  if (!profileId) {
    const { data: created, error } = await db()
      .from("player_profiles")
      .insert({
        public_name: publicName,
        mobile_normalized: mobile,
        approval_status: "pending",
      })
      .select("id")
      .single();
    // A concurrent submit may have created it first; fall back to a re-read.
    if (error) {
      const { data: raced } = await db()
        .from("player_profiles")
        .select("id")
        .eq("mobile_normalized", mobile)
        .maybeSingle();
      if (!raced) throw new Error(error.message);
      profileId = raced.id;
    } else {
      profileId = created.id;
    }
  }

  // Consent is per-player, not per-session, and only ever recorded on an
  // explicit tick. Never upgrade an existing grant to a revoke or vice versa
  // without the player asking.
  if (input.consentWhatsapp) {
    const now = new Date().toISOString();
    await db().from("player_consents").upsert(
      {
        player_profile_id: profileId,
        channel: "whatsapp",
        granted: true,
        granted_at: now,
        revoked_at: null,
        source: "registration",
        updated_at: now,
      },
      { onConflict: "player_profile_id,channel" }
    );
  }

  // Idempotent: re-submitting the same form does not create a second entry
  // and does not reveal that the player was already in.
  await db().from("friendly_entries").upsert(
    {
      session_id: input.sessionId,
      player_profile_id: profileId,
      source: "self",
      approval: "pending",
    },
    { onConflict: "session_id,player_profile_id", ignoreDuplicates: true }
  );

  await audit({
    actor_role: "public",
    action: "FRIENDLY_REGISTRATION_SUBMITTED",
    entity_type: "friendly_session",
    entity_id: input.sessionId,
    new_value: { player_profile_id: profileId },
  });

  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Entry lifecycle                                                     */
/* ------------------------------------------------------------------ */

async function approvedCount(sessionId: string): Promise<number> {
  const { count } = await db()
    .from("friendly_entries")
    .select("id", { count: "exact", head: true })
    .eq("session_id", sessionId)
    .eq("approval", "approved");
  return count ?? 0;
}

/**
 * Approve an entry, respecting session capacity.
 * Returns the status actually applied — an approval past capacity becomes a
 * waitlist place rather than silently overfilling the session.
 */
export async function approveEntry(
  entryId: string,
  actorRole: string
): Promise<"approved" | "waitlisted"> {
  const { data: entry } = await db()
    .from("friendly_entries")
    .select("id, session_id, player_profile_id")
    .eq("id", entryId)
    .maybeSingle();
  if (!entry) throw new Error("Registration not found");

  const { data: session } = await db()
    .from("friendly_sessions")
    .select("max_players")
    .eq("id", entry.session_id)
    .maybeSingle();

  const cap = session?.max_players ?? null;
  const status: "approved" | "waitlisted" =
    cap !== null && (await approvedCount(entry.session_id)) >= cap ? "waitlisted" : "approved";

  await db()
    .from("friendly_entries")
    .update({ approval: status, updated_at: new Date().toISOString() })
    .eq("id", entryId);

  // Approving a player also approves their profile — an admin vouching for
  // someone in a session is vouching for the person.
  if (status === "approved") {
    await db()
      .from("player_profiles")
      .update({ approval_status: "approved", updated_at: new Date().toISOString() })
      .eq("id", entry.player_profile_id)
      .eq("approval_status", "pending");
  }

  await audit({
    actor_role: actorRole,
    action: status === "approved" ? "FRIENDLY_ENTRY_APPROVED" : "FRIENDLY_ENTRY_WAITLISTED",
    entity_type: "friendly_entry",
    entity_id: entryId,
  });
  return status;
}

/**
 * Move an entry out of the active roster, then pull the longest-waiting
 * player off the waitlist to fill the place.
 */
export async function releaseEntry(
  entryId: string,
  next: "rejected" | "withdrawn",
  actorRole: string
): Promise<{ promotedEntryId: string | null }> {
  const { data: entry } = await db()
    .from("friendly_entries")
    .select("id, session_id, approval")
    .eq("id", entryId)
    .maybeSingle();
  if (!entry) throw new Error("Registration not found");

  await db()
    .from("friendly_entries")
    .update({ approval: next, updated_at: new Date().toISOString() })
    .eq("id", entryId);

  await audit({
    actor_role: actorRole,
    action: next === "rejected" ? "FRIENDLY_ENTRY_REJECTED" : "FRIENDLY_ENTRY_WITHDRAWN",
    entity_type: "friendly_entry",
    entity_id: entryId,
  });

  // Only frees a place if the entry actually held one.
  if (entry.approval !== "approved") return { promotedEntryId: null };
  return { promotedEntryId: await promoteFromWaitlist(entry.session_id, actorRole) };
}

/** Promote the earliest-registered waitlisted entry, if there is room. */
export async function promoteFromWaitlist(
  sessionId: string,
  actorRole: string
): Promise<string | null> {
  const { data: session } = await db()
    .from("friendly_sessions")
    .select("max_players")
    .eq("id", sessionId)
    .maybeSingle();
  const cap = session?.max_players ?? null;
  if (cap !== null && (await approvedCount(sessionId)) >= cap) return null;

  const { data: nextUp } = await db()
    .from("friendly_entries")
    .select("id, player_profile_id")
    .eq("session_id", sessionId)
    .eq("approval", "waitlisted")
    .order("registered_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!nextUp) return null;

  await db()
    .from("friendly_entries")
    .update({ approval: "approved", updated_at: new Date().toISOString() })
    .eq("id", nextUp.id);

  await audit({
    actor_role: actorRole,
    action: "FRIENDLY_ENTRY_PROMOTED_FROM_WAITLIST",
    entity_type: "friendly_entry",
    entity_id: nextUp.id,
  });
  return nextUp.id;
}

/** Admin adds a player directly, bypassing the public form. */
export async function addEntryForProfile(
  sessionId: string,
  playerProfileId: string,
  actorRole: string
): Promise<void> {
  const { error } = await db().from("friendly_entries").upsert(
    {
      session_id: sessionId,
      player_profile_id: playerProfileId,
      source: "admin",
      approval: "approved",
    },
    { onConflict: "session_id,player_profile_id" }
  );
  if (error) throw new Error(error.message);

  await audit({
    actor_role: actorRole,
    action: "FRIENDLY_ENTRY_ADDED_BY_ADMIN",
    entity_type: "friendly_session",
    entity_id: sessionId,
    new_value: { player_profile_id: playerProfileId },
  });
}

/* ------------------------------------------------------------------ */
/* Pairs and scheduling                                                */
/* ------------------------------------------------------------------ */

/** Stable key for an unordered pair of players. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

interface PairTeam {
  teamId: string;
  pairId: string;
}

/**
 * Resolve a pair of players to the `teams` row they play as, creating it on
 * first use. In rotation formats the same two players may partner again in a
 * later round; reusing the row keeps team counts sane and makes "who did I
 * partner with" answerable from one place.
 */
async function ensurePairTeam(
  sessionId: string,
  tournamentId: string,
  profileA: string,
  profileB: string,
  names: Map<string, string>,
  cache: Map<string, PairTeam>,
  round: number
): Promise<PairTeam> {
  const key = pairKey(profileA, profileB);
  const cached = cache.get(key);
  if (cached) return cached;

  const nameA = names.get(profileA) ?? "Player";
  const nameB = names.get(profileB) ?? "Player";

  const { data: team, error: teamErr } = await db()
    .from("teams")
    .insert({ tournament_id: tournamentId, team_name: `${nameA} & ${nameB}` })
    .select("id")
    .single();
  if (teamErr) throw new Error(teamErr.message);

  await db().from("players").insert([
    {
      tournament_id: tournamentId,
      team_id: team.id,
      player_order: 1,
      full_name: nameA,
      player_profile_id: profileA,
    },
    {
      tournament_id: tournamentId,
      team_id: team.id,
      player_order: 2,
      full_name: nameB,
      player_profile_id: profileB,
    },
  ]);

  const { data: pair, error: pairErr } = await db()
    .from("friendly_pairs")
    .insert({
      session_id: sessionId,
      team_id: team.id,
      player_one_profile_id: profileA,
      player_two_profile_id: profileB,
      label: `${nameA} & ${nameB}`,
      active_from_round: round,
    })
    .select("id")
    .single();
  if (pairErr) throw new Error(pairErr.message);

  const resolved = { teamId: team.id, pairId: pair.id };
  cache.set(key, resolved);
  return resolved;
}

/** Load a session plus everything scheduling needs. */
async function loadSessionContext(sessionId: string) {
  const { data: session } = await db()
    .from("friendly_sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();
  if (!session) throw new Error("Session not found");

  const { data: entries } = await db()
    .from("friendly_entries")
    .select("player_profile_id")
    .eq("session_id", sessionId)
    .eq("approval", "approved");

  const profileIds = (entries ?? []).map((e) => e.player_profile_id as string);
  const { data: profiles } = await db()
    .from("player_profiles")
    .select("id, public_name")
    .in("id", profileIds.length > 0 ? profileIds : ["00000000-0000-0000-0000-000000000000"]);

  const names = new Map(
    ((profiles ?? []) as { id: string; public_name: string }[]).map((p) => [p.id, p.public_name])
  );
  const courts = await getCourts(session.tournament_id);

  return { session, profileIds, names, courts };
}

/**
 * Delete the not-yet-started friendly matches of a session.
 * Matches that have begun are history and are never touched — a partner change
 * or a regenerate only rebuilds the remaining schedule.
 */
async function clearUnstartedMatches(tournamentId: string): Promise<number> {
  const { data: removable } = await db()
    .from("matches")
    .select("id")
    .eq("tournament_id", tournamentId)
    .eq("stage", "friendly")
    .eq("status", "scheduled");
  const ids = (removable ?? []).map((m) => m.id as string);
  if (ids.length === 0) return 0;

  await db().from("friendly_match_participants").delete().in("match_id", ids);
  await db().from("matches").delete().in("id", ids);
  return ids.length;
}

/** Turn scheduler output into real `matches` + participant snapshots. */
async function persistRounds(
  sessionId: string,
  tournamentId: string,
  rounds: ScheduledRound[],
  names: Map<string, string>,
  courts: { id: string }[],
  startingOrder: number
): Promise<number> {
  const cache = new Map<string, PairTeam>();
  let order = startingOrder;
  let created = 0;

  for (const round of rounds) {
    for (const m of round.matches) {
      const a = await ensurePairTeam(sessionId, tournamentId, m.teamA[0], m.teamA[1], names, cache, round.round);
      const b = await ensurePairTeam(sessionId, tournamentId, m.teamB[0], m.teamB[1], names, cache, round.round);

      const { data: match, error } = await db()
        .from("matches")
        .insert({
          tournament_id: tournamentId,
          stage: "friendly",
          round_name: `R${round.round}`,
          match_order: order++,
          court_id: courts[m.courtIndex]?.id ?? null,
          team_a_id: a.teamId,
          team_b_id: b.teamId,
          status: "scheduled",
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);

      // Written at creation and immutable thereafter: this is the record of
      // who actually played, even if pairs are re-versioned later.
      await db().from("friendly_match_participants").insert({
        match_id: match.id,
        session_id: sessionId,
        pair_a_id: a.pairId,
        pair_b_id: b.pairId,
        team_a_player_one: m.teamA[0],
        team_a_player_two: m.teamA[1],
        team_b_player_one: m.teamB[0],
        team_b_player_two: m.teamB[1],
        round_number: round.round,
      });
      created++;
    }
  }
  return created;
}

export interface ScheduleResult {
  matchesCreated: number;
  roundsCreated: number;
  removedUnstarted: number;
  warnings: string[];
}

/**
 * Generate (or regenerate) a session's schedule.
 *
 * Americano and fixed produce the whole schedule up front. Mexicano produces
 * round 1 only — later rounds depend on live standings and are generated one
 * at a time via `generateNextMexicanoRound`.
 */
export async function generateSchedule(
  sessionId: string,
  actorRole: string
): Promise<ScheduleResult> {
  const { session, profileIds, names, courts } = await loadSessionContext(sessionId);
  if (profileIds.length < 4) throw new Error("At least 4 approved players are needed to build a schedule");
  if (courts.length === 0) throw new Error("This session has no courts");

  const capacity = estimateCapacity({
    durationMinutes: session.duration_minutes,
    expectedMatchMinutes: session.expected_match_minutes,
    turnoverMinutes: session.turnover_minutes,
    courts: courts.length,
    playerCount: profileIds.length,
  });
  const roundLimit = Math.max(1, capacity.roundsThatFit);

  const removedUnstarted = await clearUnstartedMatches(session.tournament_id);

  const { count: playedCount } = await db()
    .from("matches")
    .select("id", { count: "exact", head: true })
    .eq("tournament_id", session.tournament_id)
    .eq("stage", "friendly");
  const startingOrder = (playedCount ?? 0) + 1;

  let rounds: ScheduledRound[] = [];

  if (session.pairing_mode === "mexicano") {
    // Round 1 only — a seeded random draw, reproducible from `draw_seed`.
    const standings = profileIds.map((playerProfileId) => ({
      playerProfileId,
      points: 0,
      gameDiff: 0,
    }));
    rounds = [
      nextMexicanoRound(standings, 1, {
        courts: courts.length,
        convention: session.mexicano_pairing as MexicanoPairing,
        drawSeed: session.draw_seed ?? 1,
      }),
    ];
  } else if (session.pairing_mode === "americano") {
    rounds = generateAmericanoSchedule(profileIds, {
      courts: courts.length,
      rounds: roundLimit,
      maxRounds: roundLimit,
    });
  } else {
    // Fixed partners: pairs must already exist, set on the Pairs tab.
    const { data: existingPairs } = await db()
      .from("friendly_pairs")
      .select("id, player_one_profile_id, player_two_profile_id")
      .eq("session_id", sessionId)
      .is("retired_after_round", null);

    const pairs: FixedPair[] = ((existingPairs ?? []) as {
      id: string;
      player_one_profile_id: string;
      player_two_profile_id: string | null;
    }[])
      .filter((p) => p.player_two_profile_id)
      .map((p) => ({
        id: p.id,
        players: [p.player_one_profile_id, p.player_two_profile_id!] as [string, string],
      }));

    if (pairs.length < 2) {
      throw new Error("Create at least 2 pairs on the Pairs tab before generating a fixed-partner schedule");
    }
    rounds = generateFixedSchedule(pairs, { courts: courts.length, maxRounds: roundLimit });
  }

  const matchesCreated = await persistRounds(
    sessionId,
    session.tournament_id,
    rounds,
    names,
    courts,
    startingOrder
  );

  await db()
    .from("friendly_sessions")
    .update({ status: "scheduled", updated_at: new Date().toISOString() })
    .eq("id", sessionId);

  await audit({
    tournament_id: session.tournament_id,
    actor_role: actorRole,
    action: "FRIENDLY_SCHEDULE_GENERATED",
    entity_type: "friendly_session",
    entity_id: sessionId,
    new_value: { mode: session.pairing_mode, rounds: rounds.length, matches: matchesCreated },
  });

  return {
    matchesCreated,
    roundsCreated: rounds.length,
    removedUnstarted,
    warnings: capacity.warnings,
  };
}

/**
 * Generate the next Mexicano round from the live standings.
 * Refuses while any match is still unfinished, because the whole point of the
 * format is that the next round's pairings reflect the completed results.
 */
export async function generateNextMexicanoRound(
  sessionId: string,
  actorRole: string
): Promise<ScheduleResult> {
  const { session, profileIds, names, courts } = await loadSessionContext(sessionId);
  if (session.pairing_mode !== "mexicano") {
    throw new Error("This session does not use Mexicano pairing");
  }

  const { data: matches } = await db()
    .from("matches")
    .select("id, status, round_name")
    .eq("tournament_id", session.tournament_id)
    .eq("stage", "friendly");

  const rows = (matches ?? []) as { status: string; round_name: string | null }[];
  const unfinished = rows.filter(
    (m) => !["completed", "walkover", "disqualified", "retired", "cancelled"].includes(m.status)
  );
  if (unfinished.length > 0) {
    throw new Error(`${unfinished.length} match(es) still to finish before the next round can be drawn`);
  }

  const lastRound = rows.reduce((max, m) => {
    const n = parseInt((m.round_name ?? "R0").replace(/^R/, ""), 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);

  // Standings so far drive the next round's courts and pairings.
  const [{ data: ledger }, { data: participants }] = await Promise.all([
    db().from("player_score_ledger").select("*").eq("session_id", sessionId).order("id"),
    db().from("friendly_match_participants").select("*").eq("session_id", sessionId),
  ]);

  const ranked = buildRanking(toLedgerEntries(ledger ?? []), [] as PlayerMatchStat[], {
    scope: { kind: "session", sessionId },
    officialOnly: false,
  });

  const known = new Map(toMexicanoStandings(ranked).map((s) => [s.playerProfileId, s]));
  const standings = profileIds.map(
    (id) => known.get(id) ?? { playerProfileId: id, points: 0, gameDiff: 0 }
  );

  // Rest counts so far, so the next round sits out whoever has rested least.
  const playedRounds = new Map<string, Set<number>>();
  for (const p of (participants ?? []) as {
    round_number: number | null;
    team_a_player_one: string;
    team_a_player_two: string | null;
    team_b_player_one: string;
    team_b_player_two: string | null;
  }[]) {
    if (p.round_number === null) continue;
    for (const id of [p.team_a_player_one, p.team_a_player_two, p.team_b_player_one, p.team_b_player_two]) {
      if (!id) continue;
      if (!playedRounds.has(id)) playedRounds.set(id, new Set());
      playedRounds.get(id)!.add(p.round_number);
    }
  }
  const rests = new Map<string, number>(
    profileIds.map((id) => [id, lastRound - (playedRounds.get(id)?.size ?? 0)])
  );

  const round = nextMexicanoRound(standings, lastRound + 1, {
    courts: courts.length,
    convention: session.mexicano_pairing as MexicanoPairing,
    drawSeed: session.draw_seed ?? 1,
  }, rests);

  const matchesCreated = await persistRounds(
    sessionId,
    session.tournament_id,
    [round],
    names,
    courts,
    rows.length + 1
  );

  await audit({
    tournament_id: session.tournament_id,
    actor_role: actorRole,
    action: "FRIENDLY_MEXICANO_ROUND_GENERATED",
    entity_type: "friendly_session",
    entity_id: sessionId,
    new_value: { round: lastRound + 1, matches: matchesCreated },
  });

  return { matchesCreated, roundsCreated: 1, removedUnstarted: 0, warnings: [] };
}

/**
 * Replace a fixed-partner session's pairs with the given player couples.
 *
 * Only legal while no match has started: once play begins, pairs are history
 * and a partner change must go through the versioned replacement flow instead.
 */
export async function setFixedPairs(
  sessionId: string,
  couples: [string, string][],
  actorRole: string
): Promise<{ pairsCreated: number }> {
  const { session, names } = await loadSessionContext(sessionId);

  const { count: started } = await db()
    .from("matches")
    .select("id", { count: "exact", head: true })
    .eq("tournament_id", session.tournament_id)
    .eq("stage", "friendly")
    .neq("status", "scheduled");
  if ((started ?? 0) > 0) {
    throw new Error("Matches have already started — pairs can no longer be rebuilt wholesale");
  }

  // A player may only appear in one pair.
  const seen = new Set<string>();
  for (const [a, b] of couples) {
    if (a === b) throw new Error("A player cannot partner themselves");
    for (const p of [a, b]) {
      if (seen.has(p)) throw new Error(`${names.get(p) ?? "A player"} appears in more than one pair`);
      seen.add(p);
    }
  }

  await clearUnstartedMatches(session.tournament_id);

  // Drop the old pairs and the team rows they used.
  const { data: oldPairs } = await db()
    .from("friendly_pairs")
    .select("team_id")
    .eq("session_id", sessionId);
  const oldTeamIds = (oldPairs ?? []).map((p) => p.team_id as string);
  await db().from("friendly_pairs").delete().eq("session_id", sessionId);
  if (oldTeamIds.length > 0) {
    await db().from("players").delete().in("team_id", oldTeamIds);
    await db().from("teams").delete().in("id", oldTeamIds);
  }

  const cache = new Map<string, PairTeam>();
  for (const [a, b] of couples) {
    await ensurePairTeam(sessionId, session.tournament_id, a, b, names, cache, 1);
  }

  await audit({
    tournament_id: session.tournament_id,
    actor_role: actorRole,
    action: "FRIENDLY_PAIRS_SET",
    entity_type: "friendly_session",
    entity_id: sessionId,
    new_value: { pairs: couples.length },
  });

  return { pairsCreated: couples.length };
}

/**
 * Pair up every approved player who is not yet in a pair.
 * Deterministic (name order) so repeated clicks give the same answer.
 */
export async function autoPair(sessionId: string, actorRole: string): Promise<number> {
  const { profileIds, names } = await loadSessionContext(sessionId);

  const { data: pairs } = await db()
    .from("friendly_pairs")
    .select("player_one_profile_id, player_two_profile_id")
    .eq("session_id", sessionId);

  const taken = new Set<string>();
  const couples: [string, string][] = [];
  for (const p of (pairs ?? []) as { player_one_profile_id: string; player_two_profile_id: string | null }[]) {
    taken.add(p.player_one_profile_id);
    if (p.player_two_profile_id) taken.add(p.player_two_profile_id);
    if (p.player_two_profile_id) couples.push([p.player_one_profile_id, p.player_two_profile_id]);
  }

  const free = profileIds
    .filter((id) => !taken.has(id))
    .sort((a, b) => (names.get(a) ?? "").localeCompare(names.get(b) ?? ""));

  for (let i = 0; i + 1 < free.length; i += 2) couples.push([free[i], free[i + 1]]);

  await setFixedPairs(sessionId, couples, actorRole);
  return couples.length;
}

/* ------------------------------------------------------------------ */
/* Scoring: turning a finished match into ranking points                */
/* ------------------------------------------------------------------ */

/** Games won by each side, from the score snapshot. */
function gamesFromSnapshot(
  snap: MatchSnapshot | null,
  walkoverGames: number,
  winnerIsA: boolean,
  isWalkover: boolean
): { a: number; b: number } {
  const completed: CompletedSet[] = Array.isArray(snap?.completed_sets) ? snap!.completed_sets : [];
  let a = 0;
  let b = 0;
  for (const s of completed) {
    a += s.teamAGames ?? 0;
    b += s.teamBGames ?? 0;
  }
  // A force-ended match may hold games in the unfinished current set.
  const live = (snap?.team_a_games ?? 0) + (snap?.team_b_games ?? 0);
  if (live > 0) {
    const last = completed[completed.length - 1];
    const alreadyCounted =
      last && last.teamAGames === snap!.team_a_games && last.teamBGames === snap!.team_b_games;
    if (!alreadyCounted) {
      a += snap!.team_a_games;
      b += snap!.team_b_games;
    }
  }
  if (a === 0 && b === 0 && isWalkover) {
    return winnerIsA ? { a: walkoverGames, b: 0 } : { a: 0, b: walkoverGames };
  }
  return { a, b };
}

const FINISHED_STATUSES = ["completed", "walkover", "disqualified", "retired"];

/** A `player_score_ledger` row as Postgres returns it. */
interface LedgerRowDb {
  player_profile_id: string;
  match_id: string;
  component: string;
  points: number;
  source: string;
  status: string;
  session_id: string | null;
  season_id: string | null;
}

/**
 * Map DB rows to the ranking module's shape.
 * The two differ (snake_case vs camelCase) and a blind cast silently produces
 * undefined keys, which aggregates to zero points — do not shortcut this.
 */
function toLedgerEntries(rows: unknown[]): LedgerEntry[] {
  return (rows as LedgerRowDb[]).map((r) => ({
    playerProfileId: r.player_profile_id,
    matchId: r.match_id,
    component: r.component as LedgerEntry["component"],
    points: r.points,
    source: r.source as LedgerEntry["source"],
    status: r.status as LedgerEntry["status"],
    sessionId: r.session_id,
    seasonId: r.season_id,
  }));
}

/**
 * Rebuild one player's entire fire history from the ledger.
 *
 * Fire depends on the ORDER of a player's results, and the authoritative order
 * is ascending `player_score_ledger.id` — never a client timestamp, because
 * offline devices sync late and their clocks drift. Rather than trying to patch
 * the streak incrementally, every write replays the whole history. It is cheap
 * at club scale and it means a late sync, an admin correction and a profile
 * merge all converge on the same answer through one code path.
 */
export async function recomputePlayerFire(playerProfileId: string): Promise<string[]> {
  // Base rows establish which matches this player played, and in what order.
  const { data: baseRows } = await db()
    .from("player_score_ledger")
    .select("id, match_id, component")
    .eq("player_profile_id", playerProfileId)
    .in("component", ["base_win", "games"])
    .order("id", { ascending: true });

  const ordered = (baseRows ?? []) as { id: number; match_id: string; component: string }[];
  const matchIds = [...new Set(ordered.map((r) => r.match_id))];

  if (matchIds.length === 0) {
    await db()
      .from("player_profiles")
      .update({ active_streak: 0, streak_last_ledger_id: null, updated_at: new Date().toISOString() })
      .eq("id", playerProfileId);
    return [];
  }

  // Sessions whose fire rows this replay changes. A streak spans sessions, so
  // a result today can add or remove a fire point recorded weeks ago — those
  // sessions' ranking snapshots go stale unless the caller refreshes them.
  const touchedSessions = new Set<string>();

  const [{ data: matches }, { data: parts }] = await Promise.all([
    db().from("matches").select("id, status, winner_team_id, team_a_id, team_b_id").in("id", matchIds),
    db()
      .from("friendly_match_participants")
      .select("match_id, team_a_player_one, team_a_player_two, team_b_player_one, team_b_player_two")
      .in("match_id", matchIds),
  ]);

  const matchById = new Map(
    ((matches ?? []) as { id: string; status: string; winner_team_id: string | null; team_a_id: string | null }[]).map(
      (m) => [m.id, m]
    )
  );
  const sideByMatch = new Map<string, "A" | "B">();
  for (const p of (parts ?? []) as Record<string, string | null>[]) {
    const onA = p.team_a_player_one === playerProfileId || p.team_a_player_two === playerProfileId;
    sideByMatch.set(p.match_id as string, onA ? "A" : "B");
  }

  // Replay in ledger order.
  const inputs: FireResultInput[] = [];
  for (const row of ordered) {
    const m = matchById.get(row.match_id);
    const side = sideByMatch.get(row.match_id);
    if (!m || !side) continue;
    const playerWon = Boolean(m.winner_team_id) && (side === "A"
      ? m.winner_team_id === m.team_a_id
      : m.winner_team_id !== m.team_a_id);
    inputs.push({ matchId: row.match_id, kind: resultKindFor(m.status, playerWon) });
  }

  const replay = rebuildFromResults(inputs);
  const fireByMatch = new Map(replay.awards.map((a) => [a.matchId, a.firePoints]));

  // Reconcile fire rows against the replay: the ledger must end up exactly
  // matching the recomputed history, with no leftovers from a prior version.
  const { data: existingFire } = await db()
    .from("player_score_ledger")
    .select("id, match_id, points, session_id")
    .eq("player_profile_id", playerProfileId)
    .eq("component", "fire");

  const existing = new Map(
    ((existingFire ?? []) as { id: number; match_id: string; points: number; session_id: string | null }[]).map(
      (r) => [r.match_id, r]
    )
  );

  const staleIds: number[] = [];
  for (const [matchId, row] of existing) {
    if ((fireByMatch.get(matchId) ?? 0) === 0) {
      staleIds.push(row.id);
      if (row.session_id) touchedSessions.add(row.session_id);
    }
  }
  if (staleIds.length > 0) {
    await db().from("player_score_ledger").delete().in("id", staleIds);
  }

  const baseByMatch = new Map(ordered.map((r) => [r.match_id, r]));
  for (const [matchId, points] of fireByMatch) {
    if (points === 0) continue;
    const already = existing.get(matchId);
    if (already && already.points === points) continue;

    const base = baseByMatch.get(matchId);
    const { data: sessionRow } = await db()
      .from("player_score_ledger")
      .select("session_id, season_id, source, status")
      .eq("id", base!.id)
      .single();

    await db().from("player_score_ledger").upsert(
      {
        player_profile_id: playerProfileId,
        match_id: matchId,
        component: "fire",
        points,
        source: sessionRow!.source,
        session_id: sessionRow!.session_id,
        season_id: sessionRow!.season_id,
        status: sessionRow!.status,
      },
      { onConflict: "match_id,player_profile_id,component" }
    );
    if (sessionRow!.session_id) touchedSessions.add(sessionRow!.session_id);
  }

  const lastBase = ordered[ordered.length - 1];
  await db()
    .from("player_profiles")
    .update({
      active_streak: replay.state.consecutiveWins,
      streak_last_ledger_id: lastBase?.id ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", playerProfileId);

  return [...touchedSessions];
}

/**
 * Undo everything a friendly match awarded.
 *
 * Called when a referee undoes past the end of a finished match. The ledger
 * rows must go, and every affected player's fire history has to be replayed —
 * removing a result changes the whole sequence after it, which can strip a fire
 * point earned in a completely different session.
 */
export async function revertFriendlyResult(matchId: string, actorRole: string): Promise<void> {
  const { data: parts } = await db()
    .from("friendly_match_participants")
    .select("*")
    .eq("match_id", matchId)
    .maybeSingle();
  if (!parts) return;

  const players = [
    parts.team_a_player_one,
    parts.team_a_player_two,
    parts.team_b_player_one,
    parts.team_b_player_two,
  ].filter(Boolean) as string[];

  await db().from("player_score_ledger").delete().eq("match_id", matchId);

  const affected = new Set<string>([parts.session_id as string]);
  for (const p of players) {
    for (const s of await recomputePlayerFire(p)) affected.add(s);
  }
  for (const s of affected) await recalcSessionRanking(s);

  await audit({
    actor_role: actorRole,
    action: "FRIENDLY_RESULT_REVERTED",
    entity_type: "match",
    entity_id: matchId,
    new_value: { players: players.length, sessions_recalculated: affected.size },
  });
}

/**
 * Award points for a finished friendly match.
 *
 * Called from `finalizeMatch` — the single completion path shared with
 * tournaments. Ledger writes are idempotent on
 * `(match_id, player_profile_id, component)`, so a retried offline sync can
 * never double-award.
 */
export async function applyFriendlyResult(
  match: Match,
  opts: { status: string; winnerTeamId: string; actorRole: string }
): Promise<void> {
  const { data: parts } = await db()
    .from("friendly_match_participants")
    .select("*")
    .eq("match_id", match.id)
    .maybeSingle();
  // A friendly match without a participant snapshot cannot be scored — bail
  // rather than guessing who played.
  if (!parts) return;

  const { data: session } = await db()
    .from("friendly_sessions")
    .select("id, season_id, ranking_model, tournament_id")
    .eq("id", parts.session_id)
    .maybeSingle();
  if (!session) return;

  const { data: snapshot } = await db()
    .from("match_score_snapshots")
    .select("*")
    .eq("match_id", match.id)
    .maybeSingle();

  const { data: tournament } = await db()
    .from("tournaments")
    .select("scoring_config")
    .eq("id", session.tournament_id)
    .maybeSingle();
  const walkoverGames =
    parseInt(String(tournament?.scoring_config?.walkoverScore ?? "6-0").split("-")[0], 10) || 6;

  const winnerIsA = opts.winnerTeamId === match.team_a_id;
  const isWalkover = opts.status === "walkover" || opts.status === "disqualified";
  const games = gamesFromSnapshot(
    (snapshot ?? null) as MatchSnapshot | null,
    walkoverGames,
    winnerIsA,
    isWalkover
  );

  const sides: { profileId: string | null; onA: boolean }[] = [
    { profileId: parts.team_a_player_one, onA: true },
    { profileId: parts.team_a_player_two, onA: true },
    { profileId: parts.team_b_player_one, onA: false },
    { profileId: parts.team_b_player_two, onA: false },
  ];

  const useGames = session.ranking_model === "games_won";

  for (const { profileId, onA } of sides) {
    if (!profileId) continue;
    const won = onA === winnerIsA;

    // A row is written for every player of every finished match, even when it
    // scores zero, so "matches played" is derivable from the ledger alone.
    const points = useGames
      ? onA
        ? games.a
        : games.b
      : won
        ? BASE_WIN_POINTS
        : 0;

    const { error } = await db().from("player_score_ledger").upsert(
      {
        player_profile_id: profileId,
        match_id: match.id,
        component: useGames ? "games" : "base_win",
        points,
        source: "friendly",
        session_id: session.id,
        tournament_id: null,
        season_id: session.season_id,
        status: "provisional",
      },
      { onConflict: "match_id,player_profile_id,component" }
    );
    if (error) throw new Error(error.message);
  }

  // Fire is replayed per player after the base rows exist, so the ordering is
  // driven by the ledger ids just assigned. A streak spans sessions, so a fire
  // point can appear or vanish in an earlier session — refresh every snapshot
  // the replay touched, not just this one.
  const affected = new Set<string>([session.id]);
  for (const { profileId } of sides) {
    if (!profileId) continue;
    for (const s of await recomputePlayerFire(profileId)) affected.add(s);
  }
  for (const s of affected) await recalcSessionRanking(s);

  await audit({
    tournament_id: match.tournament_id,
    actor_role: opts.actorRole,
    action: "FRIENDLY_RESULT_APPLIED",
    entity_type: "match",
    entity_id: match.id,
    new_value: { ranking_model: session.ranking_model, status: opts.status },
  });
}

/**
 * Recalculate the stored ranking snapshot for a session.
 * Mirrors the tournament standings pattern: delete the scope's rows and
 * reinsert, so the snapshot can never drift from the ledger.
 */
export async function recalcSessionRanking(sessionId: string): Promise<void> {
  const { data: session } = await db()
    .from("friendly_sessions")
    .select("id, season_id, tournament_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (!session) return;

  const [{ data: ledger }, { data: parts }, { data: matches }, { data: profiles }] = await Promise.all([
    db().from("player_score_ledger").select("*").eq("session_id", sessionId).order("id"),
    db().from("friendly_match_participants").select("*").eq("session_id", sessionId),
    db()
      .from("matches")
      .select("id, status, winner_team_id, team_a_id")
      .eq("tournament_id", session.tournament_id)
      .eq("stage", "friendly"),
    db().from("player_profiles").select("id, active_streak"),
  ]);

  const matchById = new Map(
    ((matches ?? []) as { id: string; status: string; winner_team_id: string | null; team_a_id: string | null }[]).map(
      (m) => [m.id, m]
    )
  );

  // Per-player match stats drive the tiebreaker columns.
  const stats: PlayerMatchStat[] = [];
  for (const p of (parts ?? []) as Record<string, string | null>[]) {
    const m = matchById.get(p.match_id as string);
    if (!m || !FINISHED_STATUSES.includes(m.status)) continue;

    const { data: snap } = await db()
      .from("match_score_snapshots")
      .select("*")
      .eq("match_id", p.match_id as string)
      .maybeSingle();
    const winnerIsA = m.winner_team_id === m.team_a_id;
    const g = gamesFromSnapshot(
      (snap ?? null) as MatchSnapshot | null,
      6,
      winnerIsA,
      m.status === "walkover" || m.status === "disqualified"
    );

    for (const [id, onA] of [
      [p.team_a_player_one, true],
      [p.team_a_player_two, true],
      [p.team_b_player_one, false],
      [p.team_b_player_two, false],
    ] as [string | null, boolean][]) {
      if (!id) continue;
      stats.push({
        playerProfileId: id,
        matchId: p.match_id as string,
        won: onA === winnerIsA,
        gamesWon: onA ? g.a : g.b,
        gamesLost: onA ? g.b : g.a,
        sessionId,
        seasonId: session.season_id,
      });
    }
  }

  const streaks = new Map(
    ((profiles ?? []) as { id: string; active_streak: number }[]).map((p) => [p.id, p.active_streak])
  );

  const lines = buildRanking(toLedgerEntries(ledger ?? []), stats, {
    scope: { kind: "session", sessionId },
    officialOnly: false,
    activeStreaks: streaks,
  });

  await db()
    .from("friendly_ranking_snapshots")
    .delete()
    .eq("scope", "session")
    .eq("scope_id", sessionId);

  if (lines.length > 0) {
    const { error } = await db()
      .from("friendly_ranking_snapshots")
      .insert(
        lines.map((l) => ({
          scope: "session",
          scope_id: sessionId,
          player_profile_id: l.playerProfileId,
          rank: l.rank,
          points: l.totalPoints,
          base_points: l.basePoints,
          fire_points: l.firePoints,
          wins: l.wins,
          losses: l.losses,
          games_won: l.gamesWon,
          games_lost: l.gamesLost,
          game_diff: l.gameDiff,
          matches_played: l.matchesPlayed,
          active_streak: l.activeStreak ?? 0,
        }))
      );
    if (error) throw new Error(error.message);
  }
}

/**
 * Rebuild the season and lifetime ranking snapshots.
 * Both are derived wholly from the ledger, so this can be run at any time and
 * always converges on the same answer.
 */
export async function recalcSeasonAndLifetime(seasonId: string | null): Promise<void> {
  const { data: profiles } = await db().from("player_profiles").select("id, active_streak");
  const streaks = new Map(
    ((profiles ?? []) as { id: string; active_streak: number }[]).map((p) => [p.id, p.active_streak])
  );

  const scopes: { scope: "season" | "lifetime"; scopeId: string | null }[] = [
    { scope: "lifetime", scopeId: null },
  ];
  if (seasonId) scopes.push({ scope: "season", scopeId: seasonId });

  for (const { scope, scopeId } of scopes) {
    let q = db().from("player_score_ledger").select("*").eq("status", "official");
    if (scope === "season" && scopeId) q = q.eq("season_id", scopeId);
    const { data: ledger } = await q.order("id");

    const lines = buildRanking(toLedgerEntries(ledger ?? []), [], {
      scope: scope === "lifetime" ? { kind: "lifetime" } : { kind: "season", seasonId: scopeId! },
      officialOnly: true,
      activeStreaks: streaks,
    });

    // Matches played and win/loss come from the ledger's base rows, since
    // official rankings span sessions and re-deriving per match would be slow.
    const perPlayer = new Map<string, { played: number; wins: number }>();
    for (const e of toLedgerEntries(ledger ?? [])) {
      if (e.component === "fire") continue;
      const cur = perPlayer.get(e.playerProfileId) ?? { played: 0, wins: 0 };
      cur.played += 1;
      if (e.points > 0) cur.wins += 1;
      perPlayer.set(e.playerProfileId, cur);
    }

    let del = db().from("friendly_ranking_snapshots").delete().eq("scope", scope);
    del = scopeId === null ? del.is("scope_id", null) : del.eq("scope_id", scopeId);
    await del;

    if (lines.length === 0) continue;
    const { error } = await db()
      .from("friendly_ranking_snapshots")
      .insert(
        lines.map((l) => {
          const agg = perPlayer.get(l.playerProfileId) ?? { played: 0, wins: 0 };
          return {
            scope,
            scope_id: scopeId,
            player_profile_id: l.playerProfileId,
            rank: l.rank,
            points: l.totalPoints,
            base_points: l.basePoints,
            fire_points: l.firePoints,
            wins: agg.wins,
            losses: Math.max(0, agg.played - agg.wins),
            games_won: l.gamesWon,
            games_lost: l.gamesLost,
            game_diff: l.gameDiff,
            matches_played: agg.played,
            active_streak: l.activeStreak ?? 0,
          };
        })
      );
    if (error) throw new Error(error.message);
  }
}

/* ------------------------------------------------------------------ */
/* Finalization, corrections and merges                                */
/* ------------------------------------------------------------------ */

export interface FinalizeCheck {
  ready: boolean;
  blockers: string[];
  warnings: string[];
}

/** Can this session be finalized yet? */
export async function checkFinalizeReady(sessionId: string): Promise<FinalizeCheck> {
  const { data: session } = await db()
    .from("friendly_sessions")
    .select("id, status, tournament_id, season_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (!session) return { ready: false, blockers: ["Session not found"], warnings: [] };

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (session.status === "finalized") blockers.push("This session is already finalized.");

  const { data: matches } = await db()
    .from("matches")
    .select("id, status, is_pending_sync")
    .eq("tournament_id", session.tournament_id)
    .eq("stage", "friendly");

  const rows = (matches ?? []) as { status: string; is_pending_sync: boolean }[];
  const unfinished = rows.filter(
    (m) => !["completed", "walkover", "disqualified", "retired", "cancelled"].includes(m.status)
  );
  const pending = rows.filter((m) => m.is_pending_sync);

  if (rows.length === 0) blockers.push("No matches have been played.");
  if (unfinished.length > 0) {
    blockers.push(`${unfinished.length} match(es) are still live or unplayed.`);
  }
  if (pending.length > 0) {
    blockers.push(`${pending.length} match(es) are waiting to sync from a referee device.`);
  }
  if (!session.season_id) {
    warnings.push("No season is attached — these points will count toward Lifetime rankings only.");
  }

  return { ready: blockers.length === 0, blockers, warnings };
}

/**
 * Finalize a session: its provisional points become official and start
 * counting toward Season and Lifetime rankings.
 * Idempotent — running it twice changes nothing the second time.
 */
export async function finalizeSession(sessionId: string, actorRole: string): Promise<void> {
  const check = await checkFinalizeReady(sessionId);
  if (!check.ready) throw new Error(check.blockers.join(" "));

  const { data: session } = await db()
    .from("friendly_sessions")
    .select("id, season_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (!session) throw new Error("Session not found");

  const { error } = await db()
    .from("player_score_ledger")
    .update({ status: "official" })
    .eq("session_id", sessionId)
    .eq("status", "provisional");
  if (error) throw new Error(error.message);

  await db()
    .from("friendly_sessions")
    .update({
      status: "finalized",
      finalized_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", sessionId);

  await recalcSessionRanking(sessionId);
  await recalcSeasonAndLifetime(session.season_id);

  await audit({
    actor_role: actorRole,
    action: "FRIENDLY_SESSION_FINALIZED",
    entity_type: "friendly_session",
    entity_id: sessionId,
  });
}

/** Reopen a finalized session so results can be corrected. */
export async function reopenSession(sessionId: string, actorRole: string): Promise<void> {
  const { data: session } = await db()
    .from("friendly_sessions")
    .select("id, season_id, status")
    .eq("id", sessionId)
    .maybeSingle();
  if (!session) throw new Error("Session not found");
  if (session.status !== "finalized") throw new Error("This session is not finalized");

  await db()
    .from("player_score_ledger")
    .update({ status: "provisional" })
    .eq("session_id", sessionId);

  await db()
    .from("friendly_sessions")
    .update({ status: "completed", finalized_at: null, updated_at: new Date().toISOString() })
    .eq("id", sessionId);

  await recalcSessionRanking(sessionId);
  await recalcSeasonAndLifetime(session.season_id);

  await audit({
    actor_role: actorRole,
    action: "FRIENDLY_SESSION_REOPENED",
    entity_type: "friendly_session",
    entity_id: sessionId,
  });
}

/**
 * Merge one player profile into another.
 *
 * The loser's ledger rows and entries move to the survivor, then the survivor's
 * fire history is replayed over the UNION of both. It must never sum the two
 * banked totals — a 3-win run and a 2-win run are not a 5-win run unless they
 * were actually consecutive in ledger order.
 */
export async function mergePlayerProfiles(
  survivorId: string,
  absorbedId: string,
  actorRole: string
): Promise<{ sessionsRecalculated: number }> {
  if (survivorId === absorbedId) throw new Error("Cannot merge a player into themselves");

  const [{ data: survivor }, { data: absorbed }] = await Promise.all([
    db().from("player_profiles").select("id, public_name").eq("id", survivorId).maybeSingle(),
    db().from("player_profiles").select("id, public_name").eq("id", absorbedId).maybeSingle(),
  ]);
  if (!survivor || !absorbed) throw new Error("Both players must exist");

  // Sessions where both profiles played the same match would create a
  // duplicate ledger key; refuse rather than silently dropping a result.
  const { data: clash } = await db()
    .from("player_score_ledger")
    .select("match_id")
    .eq("player_profile_id", absorbedId);
  const absorbedMatches = new Set((clash ?? []).map((r) => r.match_id as string));
  const { data: survivorRows } = await db()
    .from("player_score_ledger")
    .select("match_id")
    .eq("player_profile_id", survivorId);
  const overlap = (survivorRows ?? []).filter((r) => absorbedMatches.has(r.match_id as string));
  if (overlap.length > 0) {
    throw new Error(
      "These two profiles both played the same match, so they cannot be the same person. Correct the results first."
    );
  }

  const affected = new Set<string>();
  const { data: moving } = await db()
    .from("player_score_ledger")
    .select("session_id")
    .eq("player_profile_id", absorbedId);
  for (const r of (moving ?? []) as { session_id: string | null }[]) {
    if (r.session_id) affected.add(r.session_id);
  }

  await db()
    .from("player_score_ledger")
    .update({ player_profile_id: survivorId })
    .eq("player_profile_id", absorbedId);

  // Entries, pairs and participant snapshots follow the person.
  await db()
    .from("friendly_entries")
    .update({ player_profile_id: survivorId })
    .eq("player_profile_id", absorbedId);
  await db().from("players").update({ player_profile_id: survivorId }).eq("player_profile_id", absorbedId);

  await db()
    .from("player_profiles")
    .update({
      approval_status: "merged",
      merged_into_profile_id: survivorId,
      mobile_normalized: null, // free the unique key for the survivor
      updated_at: new Date().toISOString(),
    })
    .eq("id", absorbedId);

  for (const s of await recomputePlayerFire(survivorId)) affected.add(s);
  for (const s of affected) await recalcSessionRanking(s);
  await recalcSeasonAndLifetime(null);

  await audit({
    actor_role: actorRole,
    action: "PLAYER_PROFILES_MERGED",
    entity_type: "player_profile",
    entity_id: survivorId,
    old_value: { absorbed: absorbedId, name: absorbed.public_name },
    new_value: { survivor: survivorId, sessions_recalculated: affected.size },
  });

  return { sessionsRecalculated: affected.size };
}

/** Open or close public registration for a session. */
export async function setSessionStatus(
  sessionId: string,
  status: "draft" | "open" | "scheduled" | "live" | "completed" | "finalized",
  actorRole: string
): Promise<void> {
  const { error } = await db()
    .from("friendly_sessions")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", sessionId);
  if (error) throw new Error(error.message);

  await audit({
    actor_role: actorRole,
    action: "FRIENDLY_SESSION_STATUS_CHANGED",
    entity_type: "friendly_session",
    entity_id: sessionId,
    new_value: { status },
  });
}
