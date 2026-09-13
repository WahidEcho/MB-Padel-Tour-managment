import { notFound } from "next/navigation";
import { getCourts, getTournament, listScreens } from "@/lib/data";
import { currentRole, can } from "@/lib/auth";
import { ensureMainScreen } from "@/lib/screens";
import AutoRefresh from "@/components/AutoRefresh";
import ControlRoom from "./ControlRoom";

export const dynamic = "force-dynamic";

export default async function ControlPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tournament = await getTournament(id);
  if (!tournament) notFound();

  // A tournament created before screens existed, or one whose main row was
  // removed, still needs its default screen. This is the only place a row is
  // created on a read, and it is behind the operator login.
  await ensureMainScreen(id);

  const [screens, courts, role] = await Promise.all([listScreens(id), getCourts(id), currentRole()]);

  return (
    <div className="space-y-4">
      {/* Slow: the thumbnails refresh themselves, so this only needs to catch
          screens added or removed elsewhere. */}
      <AutoRefresh seconds={20} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">{tournament.name} — control room</h1>
          <p className="text-sm text-muted">
            {screens.length} screen{screens.length === 1 ? "" : "s"} · each one shows its own courts
            and has its own link.
          </p>
        </div>
      </div>

      <ControlRoom
        tournamentId={id}
        slug={tournament.slug}
        screens={screens}
        courts={courts}
        publicAccess={tournament.public_access_enabled}
        canManage={can(role, "manage_screens")}
      />
    </div>
  );
}
