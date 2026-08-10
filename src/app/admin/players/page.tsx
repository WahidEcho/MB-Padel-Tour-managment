import { db } from "@/lib/supabase";
import { listPlayerProfiles } from "@/lib/friendly/data";
import type { PlayerConsent } from "@/lib/types";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import {
  createPlayerProfile,
  mergePlayersAction,
  setPlayerApproval,
  setPlayerConsent,
  updatePlayerProfile,
} from "./actions";

export const dynamic = "force-dynamic";

const APPROVAL_BADGE: Record<string, string> = {
  pending: "bg-warning/15 text-warning",
  approved: "bg-success/15 text-success",
  rejected: "bg-danger/15 text-danger",
  merged: "bg-border text-muted",
};

const CHANNELS: { key: PlayerConsent["channel"]; label: string }[] = [
  { key: "whatsapp", label: "WhatsApp" },
  { key: "web_push", label: "Push" },
  { key: "email", label: "Email" },
];

export default async function PlayersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const { q, status } = await searchParams;
  const all = await listPlayerProfiles(q);
  const profiles = status && status !== "all" ? all.filter((p) => p.approval_status === status) : all;

  const { data: consentRows } = await db()
    .from("player_consents")
    .select("player_profile_id, channel, granted");
  const consents = new Map<string, Set<string>>();
  for (const c of (consentRows ?? []) as { player_profile_id: string; channel: string; granted: boolean }[]) {
    if (!c.granted) continue;
    if (!consents.has(c.player_profile_id)) consents.set(c.player_profile_id, new Set());
    consents.get(c.player_profile_id)!.add(c.channel);
  }

  const pendingCount = all.filter((p) => p.approval_status === "pending").length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Players</h1>
        {pendingCount > 0 && (
          <span className="badge bg-warning/15 text-warning">{pendingCount} awaiting approval</span>
        )}
      </div>

      <p className="text-xs text-muted">
        Persistent player profiles shared across all friendly sessions. A player&apos;s mobile number is
        their identity — it is never shown on public pages. Consent is recorded per channel; nothing
        sends messages yet.
      </p>

      <form className="card flex flex-wrap items-end gap-2" action="/admin/players">
        <div className="flex-1 min-w-48">
          <label className="label" htmlFor="player-search">Search by name</label>
          <input id="player-search" name="q" defaultValue={q ?? ""} className="input" placeholder="e.g. Omar" />
        </div>
        <div>
          <label className="label" htmlFor="player-status">Status</label>
          <select id="player-status" name="status" defaultValue={status ?? "all"} className="input w-auto">
            {["all", "pending", "approved", "rejected"].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <button className="btn-secondary text-sm">Filter</button>
      </form>

      <details className="card">
        <summary className="cursor-pointer font-bold">Add a player manually</summary>
        <form action={createPlayerProfile} className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="new-player-name">Public name</label>
            <input id="new-player-name" name="public_name" className="input" required />
          </div>
          <div>
            <label className="label" htmlFor="new-player-mobile">Mobile (optional)</label>
            <input id="new-player-mobile" name="mobile" className="input" placeholder="01001234567" />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="new-player-notes">Notes (admin only)</label>
            <input id="new-player-notes" name="notes" className="input" />
          </div>
          <div className="sm:col-span-2">
            <button className="btn-primary text-sm">Add player</button>
          </div>
        </form>
      </details>

      {all.length > 1 && (
        <details className="card">
          <summary className="cursor-pointer font-bold">Merge duplicate players</summary>
          <p className="mt-2 text-xs text-muted">
            If the same person registered twice, merge them. All results move to the surviving profile
            and their fire streak is rebuilt over the combined history — the two banked totals are not
            simply added, because two separate runs of wins are not one long run.
          </p>
          <form action={mergePlayersAction} className="mt-3 grid gap-2 sm:grid-cols-3">
            <div>
              <label className="label" htmlFor="merge-survivor">Keep this player</label>
              <select id="merge-survivor" name="survivor_id" className="input text-sm" required>
                {all.map((p) => (
                  <option key={p.id} value={p.id}>{p.public_name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="merge-absorbed">Merge in (removed)</label>
              <select id="merge-absorbed" name="absorbed_id" className="input text-sm" required>
                {all.map((p) => (
                  <option key={p.id} value={p.id}>{p.public_name}</option>
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

      {profiles.length === 0 && (
        <p className="card p-8 text-center text-muted">
          {q || status ? "No players match that filter." : "No players yet."}
        </p>
      )}

      <div className="space-y-2">
        {profiles.map((p) => {
          const granted = consents.get(p.id) ?? new Set<string>();
          return (
            <div key={p.id} className="card space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="font-bold">
                    {p.public_name}{" "}
                    <span className={`badge ${APPROVAL_BADGE[p.approval_status] ?? "bg-border text-muted"}`}>
                      {p.approval_status}
                    </span>
                    {p.active_streak > 0 && (
                      <span className="badge ml-1 bg-accent/15 text-accent">🔥 {p.active_streak}</span>
                    )}
                  </h2>
                  <p className="font-mono text-xs text-muted">{p.mobile_normalized ?? "no mobile on file"}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {p.approval_status !== "approved" && (
                    <form action={setPlayerApproval}>
                      <input type="hidden" name="profile_id" value={p.id} />
                      <input type="hidden" name="approval_status" value="approved" />
                      <button className="btn-secondary text-xs">Approve</button>
                    </form>
                  )}
                  {p.approval_status !== "rejected" && (
                    <form action={setPlayerApproval}>
                      <input type="hidden" name="profile_id" value={p.id} />
                      <input type="hidden" name="approval_status" value="rejected" />
                      <button className="btn-secondary text-xs text-danger">Reject</button>
                    </form>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold uppercase text-muted">Consent</span>
                {CHANNELS.map((c) => {
                  const on = granted.has(c.key);
                  return (
                    <form key={c.key} action={setPlayerConsent}>
                      <input type="hidden" name="profile_id" value={p.id} />
                      <input type="hidden" name="channel" value={c.key} />
                      <input type="hidden" name="granted" value={on ? "0" : "1"} />
                      <button
                        className={`badge cursor-pointer ${on ? "bg-success/15 text-success" : "bg-border text-muted"}`}
                        title={on ? `Withdraw ${c.label} consent` : `Record ${c.label} consent`}
                      >
                        {on ? "✓" : "✕"} {c.label}
                      </button>
                    </form>
                  );
                })}
              </div>

              <details>
                <summary className="cursor-pointer text-xs font-semibold text-muted">Edit</summary>
                <form action={updatePlayerProfile} className="mt-2 grid gap-2 sm:grid-cols-3">
                  <input type="hidden" name="profile_id" value={p.id} />
                  <input name="public_name" defaultValue={p.public_name} className="input text-sm" required />
                  <input
                    name="mobile"
                    defaultValue={p.mobile_normalized ?? ""}
                    className="input text-sm"
                    placeholder="mobile"
                  />
                  <input name="notes" defaultValue={p.notes ?? ""} className="input text-sm" placeholder="notes" />
                  <div className="sm:col-span-3">
                    <button className="btn-secondary text-xs">Save changes</button>
                  </div>
                </form>
              </details>
            </div>
          );
        })}
      </div>
    </div>
  );
}
