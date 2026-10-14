import StateForm from "@/components/StateForm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/supabase";
import { requireStaff } from "@/lib/guard";
import { can } from "@/lib/auth";
import { LEAGUE_STATUS_LABELS, type LeagueStatus } from "@/lib/leagues/settings";
import { LEAGUE_VISIBILITY_BADGE, leagueVisibility } from "@/lib/leagues/visibility";
import { createLeagueAction } from "./actions";

export const dynamic = "force-dynamic";

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-warning/15 text-warning",
  active: "bg-success/15 text-success",
  closed: "bg-border text-muted",
  archived: "bg-border text-muted",
};

/** The organisation's leagues: recurring nights or season fixtures, with their own points and boards. */
export default async function LeaguesPage() {
  const staff = await requireStaff(["admin", "manager"], "/admin/leagues");
  if (!can(staff.role, "manage_leagues")) notFound();
  const { data } = await db()
    .from("leagues")
    .select("id, slug, name, kind, sport, status, visibility, created_at")
    .eq("organization_id", staff.orgId)
    .order("created_at", { ascending: false })
    .limit(200);
  const leagues = (data ?? []) as { id: string; slug: string; name: string; kind: string; sport: string; status: LeagueStatus; visibility: string }[];
  const ids = leagues.map((l) => l.id);
  const { data: memberRows } = ids.length
    ? await db().from("league_members").select("league_id, status").in("league_id", ids).limit(10000)
    : { data: [] };
  const members = (memberRows ?? []) as { league_id: string; status: string }[];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Leagues</h1>
      <p className="text-xs text-muted">
        A league runs as recurring <strong>nights</strong> (each a session made from the league&apos;s night template) or as
        <strong> season fixtures</strong> (a dated round robin per division). Every result counts at once on the league&apos;s
        points rules, in the month of its night or fixture date; an undo or a correction takes its points back.
      </p>

      <details className="card" open={leagues.length === 0}>
        <summary className="cursor-pointer font-bold">New league</summary>
        <StateForm action={createLeagueAction} className="mt-3 grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-3">
            <label className="label" htmlFor="league-name">Name</label>
            <input id="league-name" name="name" className="input" placeholder="Tuesday Padel League" required maxLength={120} />
          </div>
          <div>
            <label className="label" htmlFor="league-kind">Runs as</label>
            <select id="league-kind" name="kind" className="input" defaultValue="nights">
              <option value="nights">Recurring nights</option>
              <option value="season">Season fixtures</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="league-sport">Sport</label>
            <select id="league-sport" name="sport" className="input" defaultValue="padel">
              <option value="padel">Padel</option>
              <option value="tennis">Tennis</option>
              <option value="chess">Chess</option>
            </select>
          </div>
          <div className="flex items-end">
            <button className="btn-primary w-full">Create league</button>
          </div>
        </StateForm>
      </details>

      <div className="overflow-x-auto rounded-[20px] border border-border">
        <table className="w-full text-sm" data-testid="leagues">
          <thead className="bg-card text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2">League</th>
              <th className="px-3 py-2">Runs as</th>
              <th className="px-3 py-2">Members</th>
              <th className="px-3 py-2">Waiting</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {leagues.map((l) => (
              <tr key={l.id} className="border-t border-border">
                <td className="px-3 py-2">
                  <Link href={`/admin/leagues/${l.id}`} className="font-semibold text-accent hover:underline">{l.name}</Link>
                  <span className="ml-2 text-xs capitalize text-muted">{l.sport}</span>
                </td>
                <td className="px-3 py-2 text-xs">{l.kind === "season" ? "Season fixtures" : "Nights"}</td>
                <td className="px-3 py-2 text-xs">{members.filter((m) => m.league_id === l.id && m.status === "active").length}</td>
                <td className="px-3 py-2 text-xs">{members.filter((m) => m.league_id === l.id && (m.status === "pending" || m.status === "awaiting_payment")).length || "—"}</td>
                <td className="px-3 py-2">
                  <span className={`badge ${STATUS_BADGE[l.status] ?? ""}`}>{LEAGUE_STATUS_LABELS[l.status] ?? l.status}</span>
                  {LEAGUE_VISIBILITY_BADGE[leagueVisibility(l.visibility)] && (
                    <span className="badge ml-1 bg-border text-muted">{LEAGUE_VISIBILITY_BADGE[leagueVisibility(l.visibility)]}</span>
                  )}
                </td>
              </tr>
            ))}
            {leagues.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted">No leagues yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
