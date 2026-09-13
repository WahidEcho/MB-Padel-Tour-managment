import Link from "next/link";
import { notFound } from "next/navigation";
import {
  courtsForScreen,
  getBrackets,
  getCourts,
  getMatches,
  getScreenSettings,
  getTeams,
  getTournament,
  teamMap,
} from "@/lib/data";
import { can, currentRole } from "@/lib/auth";
import { isValidScreenKey } from "@/lib/screens";
import AutoRefresh from "@/components/AutoRefresh";
import ScreenControls from "./ScreenControls";
import { buildCeremony } from "@/lib/tv/ceremonyServer";
import { ceremonySteps, describeStep, shortTiers, stepAt } from "@/lib/tv/ceremony";
import { breakMinutesLeft, replayUnavailable } from "@/lib/tv/commands";

export const dynamic = "force-dynamic";

export default async function ScreenControlPage({
  params,
}: {
  params: Promise<{ id: string; screenKey: string }>;
}) {
  const { id, screenKey } = await params;
  if (!isValidScreenKey(screenKey)) notFound();

  const tournament = await getTournament(id);
  if (!tournament) notFound();
  const screen = await getScreenSettings(id, screenKey);
  if (!screen) notFound();

  const [courts, matches, teams, role, brackets] = await Promise.all([
    getCourts(id),
    getMatches(id),
    getTeams(id),
    currentRole(),
    getBrackets(id),
  ]);
  const hasPlate = brackets.some((b) => b.tier === "plate" && b.status === "published");
  const ceremonyOnAir = screen.display_mode === "ceremony";
  // Off air, describe what going on air will start. Every way onto air uses one
  // rule: Plate then Cup when a Plate bracket is published, unless the tier is
  // chosen explicitly in the ceremony card. On air, describe what is showing.
  const tiers = await buildCeremony(tournament, ceremonyOnAir ? screen : { bracket_tier: hasPlate ? "both" : "cup" });
  const steps = ceremonySteps(tiers);
  const { index: stepIndex } = stepAt(steps, ceremonyOnAir ? (screen.ceremony_step ?? 0) : 0);
  const tm = teamMap(teams);

  // What "follow live" currently resolves to, so the operator can read it before
  // it goes to air rather than discovering it on the wall.
  const covered = courtsForScreen(screen, courts);
  const coveredIds = new Set(covered.map((c) => c.id));
  const liveHere = matches.find(
    (m) => ["live", "paused"].includes(m.status) && m.court_id && coveredIds.has(m.court_id),
  );
  const liveCourtName = liveHere
    ? [
        courts.find((c) => c.id === liveHere.court_id)?.court_name ?? "a court",
        liveHere.round_name,
        [liveHere.team_a_id, liveHere.team_b_id]
          .map((t) => (t ? tm.get(t)?.team_name : null))
          .filter(Boolean)
          .join(" v "),
      ]
        .filter(Boolean)
        .join(" — ")
    : null;

  // Only matches the wall could actually replay: the same checks the command makes.
  const replayContext = { coveredCourtCount: covered.length, isChess: tournament.sport === "chess" };
  const screenReplayBlock = replayUnavailable(screen, "__any__", replayContext);
  const liveMatches = matches
    .filter((m) => ["live", "paused"].includes(m.status))
    .filter((m) => !replayUnavailable({ ...screen, display_mode: "live", mute_animations: false }, m.court_id ?? null, replayContext))
    .map((m) => ({
      id: m.id,
      label: [
        courts.find((c) => c.id === m.court_id)?.court_name ?? "No court",
        [m.team_a_id, m.team_b_id].map((t) => (t ? tm.get(t)?.team_name : "TBD")).join(" v "),
      ].join(": "),
    }));

  const url = screenKey === "main" ? `/t/${tournament.slug}/screen` : `/t/${tournament.slug}/screen/${screenKey}`;

  return (
    <div className="space-y-4">
      <AutoRefresh seconds={10} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link href={`/operator/tournaments/${id}/control`} className="text-xs text-muted hover:text-foreground">
            ← All screens
          </Link>
          <h1 className="text-xl font-bold">
            {screen.screen_name ?? (screenKey === "main" ? "Main screen" : screenKey)}
          </h1>
          <p className="text-xs text-muted">
            {tournament.name} · <code>{url}</code>
          </p>
        </div>
        <a href={url} target="_blank" rel="noreferrer" className="btn-secondary text-xs">
          Open this screen ↗
        </a>
      </div>

      <ScreenControls
        tournamentId={id}
        screen={screen}
        courts={courts}
        liveCourtName={liveCourtName}
        canRename={can(role, "manage_screens")}
        liveMatches={liveMatches}
        replayBlockedReason={
          screenReplayBlock && screenReplayBlock !== "that court is not on it" && screenReplayBlock !== "it is pinned to another court"
            ? screenReplayBlock
            : null
        }
        ceremony={{
          description: describeStep(tiers, steps, ceremonyOnAir ? (screen.ceremony_step ?? 0) : 0),
          index: stepIndex,
          last: Math.max(0, steps.length - 1),
          notes: shortTiers(tiers),
          hasPlate,
        }}
        breakMinutesLeft={breakMinutesLeft(screen.break_ends_at)}
      />
    </div>
  );
}
