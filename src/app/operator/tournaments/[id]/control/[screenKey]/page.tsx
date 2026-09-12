import Link from "next/link";
import { notFound } from "next/navigation";
import {
  courtsForScreen,
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

  const [courts, matches, teams, role] = await Promise.all([
    getCourts(id),
    getMatches(id),
    getTeams(id),
    currentRole(),
  ]);
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
      />
    </div>
  );
}
