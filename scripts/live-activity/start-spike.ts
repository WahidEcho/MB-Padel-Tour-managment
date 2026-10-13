/**
 * Gate 6 spike: puts one match's card on ONE iPhone's lock screen by
 * push-to-start, with the app closed. Owner-run, against a test tournament.
 *
 *   npx tsx --env-file=.env.local scripts/live-activity/start-spike.ts <matchId> <installationId> [soon|called|live] [minutes]
 *
 * Needs APNS_KEY_P8, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID in the env (and
 * APNS_SANDBOX unset for ad-hoc / TestFlight / App Store builds), and the phone's
 * push-to-start token in live_activity_start_tokens (the app registers it at
 * launch on iOS 17.2+). The installation id is the phone's row in push_devices.
 *
 * Re-running for the same match, phone and phase sends again: the script clears
 * that one live_activity_starts row first. It never prints a token.
 * See move-score-app/docs/device-install.md for the checklist around it.
 */
import { db } from "../../src/lib/supabase";
import { pushToStart } from "../../src/lib/notify/apns";
import { liveState, upcomingState } from "../../src/lib/notify/liveActivity";
import { toScore } from "../../src/lib/mobile/projection";
import { getSnapshot } from "../../src/lib/data";
import type { Match } from "../../src/lib/types";

async function main() {
  const [matchId, installationId, phaseArg = "called", minutesArg = "5"] = process.argv.slice(2);
  if (!matchId || !installationId) throw new Error("usage: start-spike.ts <matchId> <installationId> [soon|called|live] [minutes]");
  const phase = phaseArg === "soon" || phaseArg === "live" ? phaseArg : "called";
  for (const k of ["APNS_KEY_P8", "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_BUNDLE_ID"]) if (!process.env[k]) throw new Error(`${k} is not set`);

  const { data: m } = await db().from("matches").select("*").eq("id", matchId).maybeSingle();
  const match = m as Match | null;
  if (!match) throw new Error("No such match");
  const { data: token } = await db().from("live_activity_start_tokens").select("updated_at, disabled_at").eq("installation_id", installationId).maybeSingle();
  if (!token) throw new Error("This installation has no push-to-start token yet: open the app once on iOS 17.2+ with Live Activities allowed.");
  if ((token as { disabled_at: string | null }).disabled_at) throw new Error("This installation's push-to-start token was disabled (Apple said it is gone, or the phone turned it off).");

  const teamIds = [match.team_a_id, match.team_b_id].filter(Boolean) as string[];
  const [{ data: teams }, { data: court }] = await Promise.all([
    db().from("teams").select("id, team_name, nation_code").in("id", teamIds),
    match.court_id ? db().from("courts").select("court_name").eq("id", match.court_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const label = (id: string | null) => {
    const t = ((teams ?? []) as { id: string; team_name: string; nation_code: string | null }[]).find((x) => x.id === id);
    return t?.nation_code ?? t?.team_name ?? "";
  };
  const courtName = (court as { court_name?: string } | null)?.court_name ?? "";
  const now = Date.now();
  const state =
    phase === "live"
      ? liveState(toScore(match, await getSnapshot(match.id)), { a: label(match.team_a_id), b: label(match.team_b_id), court: courtName, status: "Live" }, { matchId })
      : upcomingState({ matchId, phase, a: label(match.team_a_id), b: label(match.team_b_id), court: courtName, until: now + Number(minutesArg) * 60_000, from: now });

  await db().from("live_activity_starts").delete().eq("installation_id", installationId).eq("match_id", matchId).eq("phase", phase);
  const { sent } = await pushToStart(matchId, state, [installationId]);
  console.log(sent ? `Sent a ${phase} start for ${state.a} v ${state.b}. Lock the phone and look.` : "Nothing sent: the phone already shows this match (open update token), or Apple refused (see the [apns] log line).");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
