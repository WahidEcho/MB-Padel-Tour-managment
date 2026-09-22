/**
 * Scores a match through the real events endpoint, the way a referee's tablet
 * does.
 *
 * Clicking a seven-court day through the referee UI is not achievable in test
 * time, and landing two courts' points inside one two-second poll by hand is
 * luck. This drives the same route with the same ordered, idempotent events and
 * the same device lock, so everything downstream — snapshots, the undo
 * watermark, finalisation, advancement, the venue screen — sees exactly what a
 * real tablet would produce.
 *
 *   npx tsx --env-file=.env.local scripts/e2e/lib/driver.ts <matchId> point A
 *   npx tsx --env-file=.env.local scripts/e2e/lib/driver.ts <matchId> undo
 */
import { randomUUID } from "crypto";
import { db } from "../../../src/lib/supabase";
import { awardPoint, initialScoreState, type ScoreState } from "../../../src/lib/scoring/engine";
import { scoringConfigForMatch } from "../../../src/lib/scoring/rules";
import type { Match, MatchSnapshot, Tournament } from "../../../src/lib/types";
import { BASE_URL, authHeaders } from "./session";

export interface Driver {
  matchId: string;
  deviceId: string;
  state: ScoreState;
  history: ScoreState[];
  eventNumber: number;
  match: Match;
  tournament: Tournament;
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: authHeaders("admin", { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

/**
 * Takes the scoring lock for a match and resumes from its stored state, so a
 * driver can pick up a match a referee left half-scored.
 */
export async function openDriver(matchId: string, deviceId = `e2e-${randomUUID()}`): Promise<Driver> {
  const { data: match } = await db().from("matches").select("*").eq("id", matchId).single();
  if (!match) throw new Error(`No match ${matchId}`);
  const { data: tournament } = await db().from("tournaments").select("*").eq("id", match.tournament_id).single();
  const { data: snapshot } = await db().from("match_score_snapshots").select("*").eq("match_id", matchId).maybeSingle();

  // Release any stale lease so the driver can claim it, exactly as an admin would.
  await db().from("scoring_leases").delete().eq("match_id", matchId);
  const claim = await post(`/api/matches/${matchId}/claim`, { deviceId });
  if (claim.status !== 200 || !claim.json.controller) {
    throw new Error(`Could not claim ${matchId}: ${JSON.stringify(claim.json)}`);
  }

  const stored = (snapshot as MatchSnapshot | null)?.snapshot_json as ScoreState | undefined;
  const state = stored?.teamA ? stored : initialScoreState("A");
  return {
    matchId,
    deviceId,
    state,
    history: [],
    eventNumber: (snapshot as MatchSnapshot | null)?.last_event_number ?? 0,
    match: match as Match,
    tournament: tournament as Tournament,
  };
}

async function send(d: Driver, eventType: string, next: ScoreState, teamId: string | null) {
  d.eventNumber += 1;
  const res = await post(`/api/matches/${d.matchId}/events`, {
    deviceId: d.deviceId,
    events: [
      {
        client_event_id: randomUUID(),
        event_number: d.eventNumber,
        event_type: eventType,
        team_id: teamId,
        previous_state: d.state,
        new_state: next,
        payload: null,
        created_at_client: new Date().toISOString(),
      },
    ],
  });
  if (res.status !== 200) {
    d.eventNumber -= 1;
    throw new Error(`${eventType} rejected (${res.status}): ${JSON.stringify(res.json)}`);
  }
  d.history.push(d.state);
  d.state = next;
  return res.json;
}

export async function point(d: Driver, side: "A" | "B") {
  const rules = scoringConfigForMatch(d.tournament, d.match);
  const next = awardPoint(d.state, side, rules);
  return send(d, "POINT_AWARDED", next, side === "A" ? d.match.team_a_id : d.match.team_b_id);
}

export async function undo(d: Driver) {
  const prev = d.history.pop();
  if (!prev) throw new Error("Nothing to undo");
  // An undo is a new event carrying the earlier state; it does not rewind the
  // event number. That is the property the venue screen's watermark exists for.
  const saved = d.history;
  await send(d, "UNDO", prev, null);
  d.history = saved; // send() pushed the pre-undo state; an undo should not be re-undoable into it
  return;
}

async function main() {
  const [matchId, action, sideArg] = process.argv.slice(2);
  if (!matchId || !action) {
    process.stderr.write("usage: driver.ts <matchId> point <A|B> | undo\n");
    process.exit(1);
  }
  const d = await openDriver(matchId);
  if (action === "point") await point(d, sideArg === "B" ? "B" : "A");
  else if (action === "undo") await undo(d);
  const { data } = await db()
    .from("match_score_snapshots")
    .select("team_a_point_label, team_b_point_label, team_a_games, team_b_games, last_event_number, last_undo_event_number, last_event_type")
    .eq("match_id", matchId)
    .single();
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

if (process.argv[1]?.endsWith("driver.ts")) void main();
