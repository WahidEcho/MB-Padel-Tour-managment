import { courtsForScreen, getCourts, getMatches, getScreenSettings, getSnapshots, getTournament, listScreens } from "../data";
import { updateScreen, type WriteResult } from "../screens";
import type { ScreenSettings, Tournament } from "../types";
import { resolveScreenCommand, type CommandContext, type ScreenCommand } from "./commands";
import { ceremonyLastStep } from "./ceremonyServer";

/**
 * The facts a command needs about the tournament, read once however many screens
 * it goes to. Every screen is then resolved against the same instant, so a break
 * pushed to four walls ends at the same second on all of them and a ceremony step
 * builds on every wall together.
 */
async function sharedContext(tournament: Tournament, command: ScreenCommand, nowMs: number) {
  const base = { nowMs, isChess: tournament.sport === "chess" };
  if (command.kind !== "replay_entrance") return { ...base, courts: [] as Awaited<ReturnType<typeof getCourts>>, live: new Map<string, string | null>(), events: new Map<string, number>() };
  const [matches, snapshots, courts] = await Promise.all([
    getMatches(tournament.id),
    getSnapshots(tournament.id),
    getCourts(tournament.id),
  ]);
  return {
    ...base,
    courts,
    live: new Map(matches.filter((m) => m.status === "live" || m.status === "paused").map((m) => [m.id, m.court_id ?? null])),
    events: new Map(snapshots.map((s) => [s.match_id, s.last_event_number ?? 0])),
  };
}

type Shared = Awaited<ReturnType<typeof sharedContext>>;

async function contextFor(
  tournament: Tournament,
  command: ScreenCommand,
  screen: ScreenSettings,
  shared: Shared,
  lastStepByTier: Map<string, number>,
  expectedCeremonyStep?: number,
): Promise<CommandContext> {
  let last = 0;
  if (command.kind === "ceremony") {
    // Screens showing the same podiums share one ceremony; build it once per tier.
    const key = screen.bracket_tier;
    if (!lastStepByTier.has(key)) lastStepByTier.set(key, await ceremonyLastStep(tournament, screen));
    last = lastStepByTier.get(key)!;
  }
  return {
    nowMs: shared.nowMs,
    isChess: shared.isChess,
    ceremonyLastStep: last,
    liveMatchCourt: (id) => (shared.live.has(id) ? shared.live.get(id) : undefined),
    liveMatchEvent: (id) => shared.events.get(id) ?? 0,
    coveredCourtCount: courtsForScreen(screen, shared.courts).length,
    expectedCeremonyStep,
  };
}

export type CommandResult = WriteResult | { ok: false; skipped: true; message: string };

/**
 * Applies one live control to one screen, as a compare-and-swap on the revision
 * the operator's console was showing. Two operators pressing NEXT PLACE at the
 * same moment advance the ceremony once, and the second is told why.
 */
export async function applyScreenCommand(
  tournamentId: string,
  screenKey: string,
  expectedRevision: number,
  command: ScreenCommand,
  actorRole: string,
): Promise<CommandResult> {
  const [tournament, screen] = await Promise.all([getTournament(tournamentId), getScreenSettings(tournamentId, screenKey)]);
  if (!tournament) return { ok: false, message: "Tournament not found." };
  if (!screen) return { ok: false, message: "That screen has been deleted." };
  const shared = await sharedContext(tournament, command, Date.now());
  const resolved = resolveScreenCommand(command, screen, await contextFor(tournament, command, screen, shared, new Map()));
  if (!resolved.ok) return { ok: false, skipped: true, message: `Not applied: ${resolved.reason}.` };
  return updateScreen(tournamentId, screenKey, expectedRevision, resolved.patch, actorRole);
}

export interface ManyResult {
  updated: string[];
  conflicted: string[];
  skipped: { screen: string; reason: string }[];
  targets: number;
}

/**
 * Applies one live control to several screens, each against its own current
 * revision and its own state — the ceremony moves each screen from its own step,
 * and a replay reaches only the screens that can show it.
 *
 * `expectedSteps` carries, per screen key, the ceremony step the control room was
 * showing. A NEXT PLACE is relative, so a wall that has moved on since is reported
 * as changed rather than moved again.
 */
export async function applyCommandToScreens(
  tournamentId: string,
  screenKeys: string[],
  command: ScreenCommand,
  actorRole: string,
  opts: { expectedSteps?: Map<string, number> } = {},
): Promise<ManyResult> {
  const [tournament, screens] = await Promise.all([getTournament(tournamentId), listScreens(tournamentId)]);
  const targets = screenKeys.length > 0 ? screens.filter((s) => screenKeys.includes(s.screen_key)) : screens;
  const out: ManyResult = { updated: [], conflicted: [], skipped: [], targets: targets.length };
  if (!tournament) return out;

  const shared = await sharedContext(tournament, command, Date.now());
  const lastStepByTier = new Map<string, number>();
  // Resolve every screen first, then write: the writes are what take time, and no
  // screen's decision should wait on another's round trips.
  const plans = await Promise.all(
    targets.map(async (screen) => ({
      screen,
      resolved: resolveScreenCommand(
        command,
        screen,
        await contextFor(tournament, command, screen, shared, lastStepByTier, opts.expectedSteps?.get(screen.screen_key)),
      ),
    })),
  );
  for (const { screen, resolved } of plans) {
    const name = screen.screen_name ?? screen.screen_key;
    if (!resolved.ok) {
      if (resolved.conflict) out.conflicted.push(name);
      else out.skipped.push({ screen: name, reason: resolved.reason });
      continue;
    }
    const result = await updateScreen(tournamentId, screen.screen_key, screen.revision, resolved.patch, actorRole);
    if (result.ok) out.updated.push(name);
    else if ("conflict" in result && result.conflict) out.conflicted.push(name);
    else out.skipped.push({ screen: name, reason: result.message });
  }
  return out;
}
