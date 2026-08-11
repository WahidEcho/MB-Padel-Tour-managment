import { db } from "@/lib/supabase";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import { listPlayerProfiles } from "@/lib/friendly/data";
import PlayerCard from "./PlayerCard";
import { createPlayerProfile, mergePlayersAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function PlayersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; level?: string }>;
}) {
  const { q, status, level } = await searchParams;
  const all = await listPlayerProfiles(q);

  const profiles = all
    .filter((p) => (status && status !== "all" ? p.approval_status === status : true))
    .filter((p) => (level && level !== "all" ? (p.skill_level ?? "") === level : true));

  const { data: consentRows } = await db()
    .from("player_consents")
    .select("player_profile_id, channel, granted");
  const consents = new Map<string, Set<string>>();
  for (const c of (consentRows ?? []) as {
    player_profile_id: string;
    channel: string;
    granted: boolean;
  }[]) {
    if (!c.granted) continue;
    if (!consents.has(c.player_profile_id)) consents.set(c.player_profile_id, new Set());
    consents.get(c.player_profile_id)!.add(c.channel);
  }

  // Flag shared mobiles: the identity key is the number, so a repeat almost
  // always means the same person registered twice under different spellings.
  const byMobile = new Map<string, string[]>();
  for (const p of all) {
    if (!p.mobile_normalized) continue;
    byMobile.set(p.mobile_normalized, [...(byMobile.get(p.mobile_normalized) ?? []), p.public_name]);
  }
  const duplicateName = new Map<string, string>();
  for (const p of all) {
    const sharing = (byMobile.get(p.mobile_normalized ?? "") ?? []).filter((n) => n !== p.public_name);
    if (sharing.length > 0) duplicateName.set(p.id, sharing.join(", "));
  }

  const pendingCount = all.filter((p) => p.approval_status === "pending").length;
  const levels = [...new Set(all.map((p) => p.skill_level).filter(Boolean))] as string[];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Players</h1>
        <div className="flex flex-wrap gap-2">
          {pendingCount > 0 && (
            <span className="badge bg-warning/15 text-warning">{pendingCount} awaiting approval</span>
          )}
          <span className="badge bg-border text-muted">{all.length} total</span>
        </div>
      </div>

      <p className="text-xs text-muted">
        One profile per person, shared across every session. The mobile number is their identity —
        it is never shown on public pages. &ldquo;Can contact via&rdquo; records what each player agreed to;
        nothing is sent yet.
      </p>

      <form className="card flex flex-wrap items-end gap-2" action="/admin/players">
        <div className="min-w-44 flex-1">
          <label className="label" htmlFor="player-search">Search by name</label>
          <input id="player-search" name="q" defaultValue={q ?? ""} className="input" placeholder="e.g. Omar" />
        </div>
        <div>
          <label className="label" htmlFor="player-status">Status</label>
          <select id="player-status" name="status" defaultValue={status ?? "all"} className="input w-auto">
            {["all", "pending", "approved", "rejected", "merged"].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        {levels.length > 0 && (
          <div>
            <label className="label" htmlFor="player-level">Level</label>
            <select id="player-level" name="level" defaultValue={level ?? "all"} className="input w-auto">
              <option value="all">all</option>
              {levels.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </div>
        )}
        <button className="btn-secondary text-sm">Filter</button>
      </form>

      <details className="card">
        <summary className="cursor-pointer font-bold">Add a player</summary>
        <form action={createPlayerProfile} className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="np-name">Name</label>
            <input id="np-name" name="public_name" className="input" required />
          </div>
          <div>
            <label className="label" htmlFor="np-mobile">Mobile</label>
            <input id="np-mobile" name="mobile" className="input" placeholder="01001234567" />
          </div>
          <div>
            <label className="label" htmlFor="np-level">Level</label>
            <input id="np-level" name="skill_level" className="input" placeholder="e.g. B, 4.5" />
          </div>
          <div>
            <label className="label" htmlFor="np-birth">Birth year</label>
            <input id="np-birth" name="birth_year" type="number" min={1900} max={2100} className="input" placeholder="1994" />
          </div>
          <div>
            <label className="label" htmlFor="np-gender">Gender</label>
            <select id="np-gender" name="gender" defaultValue="" className="input">
              <option value="">not recorded</option>
              <option value="male">male</option>
              <option value="female">female</option>
              <option value="other">other</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="np-email">Email</label>
            <input id="np-email" name="email" type="email" className="input" />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="np-notes">Notes</label>
            <input id="np-notes" name="notes" className="input" placeholder="admin-only" />
          </div>
          <div className="sm:col-span-2">
            <button className="btn-primary text-sm">Add player</button>
          </div>
        </form>
      </details>

      {profiles.length === 0 ? (
        <p className="card p-8 text-center text-muted">
          {all.length === 0 ? "No players yet." : "No players match that filter."}
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {profiles.map((p) => (
            <PlayerCard
              key={p.id}
              player={p}
              granted={consents.get(p.id) ?? new Set()}
              duplicateOf={duplicateName.get(p.id)}
            />
          ))}
        </div>
      )}

      {all.length > 1 && (
        <details className="card">
          <summary className="cursor-pointer font-bold">Merge duplicate players</summary>
          <p className="mt-2 text-xs text-muted">
            All results move to the surviving profile and their fire streak is rebuilt over the
            combined history — the two banked totals are not simply added, because two separate runs
            of wins are not one long run.
          </p>
          <form action={mergePlayersAction} className="mt-3 grid gap-2 sm:grid-cols-3">
            <div>
              <label className="label" htmlFor="merge-survivor">Keep this player</label>
              <select id="merge-survivor" name="survivor_id" className="input text-sm" required>
                {all.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.public_name}{p.mobile_normalized ? ` · ${p.mobile_normalized}` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="merge-absorbed">Merge in (removed)</label>
              <select id="merge-absorbed" name="absorbed_id" className="input text-sm" required>
                {all.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.public_name}{p.mobile_normalized ? ` · ${p.mobile_normalized}` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <ConfirmSubmit
                className="btn-secondary text-xs text-danger"
                message="Merge these two players? All results move to the surviving profile. This cannot be undone automatically."
              >
                Merge players
              </ConfirmSubmit>
            </div>
          </form>
        </details>
      )}
    </div>
  );
}
