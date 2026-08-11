import Link from "next/link";
import { notFound } from "next/navigation";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import { estimateCapacity } from "@/lib/friendly/capacity";
import { listEntries, listPlayerProfiles, listSeasons, getSession } from "@/lib/friendly/data";
import { db } from "@/lib/supabase";
import type { FriendlyEntry, PlayerProfile } from "@/lib/types";
import ShareButton from "@/components/ShareButton";
import { checkFinalizeReady } from "@/lib/friendly/ops";
import PairsClient, { type PlayerLite } from "./PairsClient";
import {
  addPlayerAction,
  approveEntryAction,
  autoPairAction,
  finalizeSessionAction,
  generateScheduleAction,
  nextRoundAction,
  promoteWaitlistAction,
  releaseEntryAction,
  reopenSessionAction,
  setStatusAction,
} from "../actions";

export const dynamic = "force-dynamic";

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-border text-muted",
  open: "bg-warning/15 text-warning",
  scheduled: "bg-accent/15 text-accent",
  live: "bg-success/15 text-success",
  completed: "bg-accent/15 text-accent",
  finalized: "bg-success/15 text-success",
};

const APPROVAL_BADGE: Record<string, string> = {
  pending: "bg-warning/15 text-warning",
  approved: "bg-success/15 text-success",
  waitlisted: "bg-accent/15 text-accent",
  rejected: "bg-danger/15 text-danger",
  withdrawn: "bg-border text-muted",
};

function EntryRow({
  entry,
  profile,
  sessionId,
}: {
  entry: FriendlyEntry;
  profile: PlayerProfile | undefined;
  sessionId: string;
}) {
  const live = entry.approval === "pending" || entry.approval === "waitlisted";
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2 last:border-0">
      <div>
        <p className="font-semibold">
          {profile?.public_name ?? "Unknown player"}{" "}
          <span className={`badge ${APPROVAL_BADGE[entry.approval] ?? "bg-border text-muted"}`}>
            {entry.approval}
          </span>
          {entry.source === "admin" && <span className="badge ml-1 bg-border text-muted">added by admin</span>}
        </p>
        <p className="font-mono text-xs text-muted">{profile?.mobile_normalized ?? "no mobile"}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {live && (
          <form action={approveEntryAction}>
            <input type="hidden" name="entry_id" value={entry.id} />
            <input type="hidden" name="session_id" value={sessionId} />
            <button className="btn-secondary text-xs">Approve</button>
          </form>
        )}
        {entry.approval !== "rejected" && entry.approval !== "withdrawn" && (
          <form action={releaseEntryAction}>
            <input type="hidden" name="entry_id" value={entry.id} />
            <input type="hidden" name="session_id" value={sessionId} />
            <input type="hidden" name="next" value="rejected" />
            <button className="btn-secondary text-xs text-danger">Reject</button>
          </form>
        )}
      </div>
    </div>
  );
}

export default async function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) notFound();

  const [entries, profiles, seasons, courtsRes, pairsRes, matchesRes] = await Promise.all([
    listEntries(id),
    listPlayerProfiles(),
    listSeasons(),
    db().from("courts").select("id, court_name, court_order").eq("tournament_id", session.tournament_id).order("court_order"),
    db()
      .from("friendly_pairs")
      .select("id, player_one_profile_id, player_two_profile_id")
      .eq("session_id", id)
      .is("retired_after_round", null),
    db()
      .from("matches")
      .select("id, round_name, match_order, court_id, status, team_a_id, team_b_id")
      .eq("tournament_id", session.tournament_id)
      .eq("stage", "friendly")
      .order("match_order"),
  ]);

  const profileById = new Map(profiles.map((p) => [p.id, p]));
  const courtCount = (courtsRes.data ?? []).length;
  const approved = entries.filter((e) => e.approval === "approved");
  const pending = entries.filter((e) => e.approval === "pending");
  const waitlisted = entries.filter((e) => e.approval === "waitlisted");
  const season = seasons.find((s) => s.id === session.season_id);

  const capacity = estimateCapacity({
    // No time box set — estimate against a nominal 2 hours purely so the
    // "rounds that fit" hint has something to say. It never caps the draw.
    durationMinutes: session.duration_minutes ?? 120,
    expectedMatchMinutes: session.expected_match_minutes,
    turnoverMinutes: session.turnover_minutes,
    courts: courtCount,
    playerCount: approved.length,
  });

  const alreadyIn = new Set(entries.map((e) => e.player_profile_id));
  const addable = profiles.filter((p) => !alreadyIn.has(p.id));
  const registerUrl = `/f/${session.slug}/register`;

  // Pairing board data (fixed-partner sessions only).
  const approvedPlayers: PlayerLite[] = approved.map((e) => ({
    id: e.player_profile_id,
    name: profileById.get(e.player_profile_id)?.public_name ?? "Unknown",
  }));
  const initialCouples = ((pairsRes.data ?? []) as {
    player_one_profile_id: string;
    player_two_profile_id: string | null;
  }[]).map((p) => [p.player_one_profile_id, p.player_two_profile_id] as [string | null, string | null]);

  const matches = (matchesRes.data ?? []) as {
    id: string;
    round_name: string | null;
    match_order: number;
    court_id: string | null;
    status: string;
    team_a_id: string | null;
    team_b_id: string | null;
  }[];
  const anyStarted = matches.some((m) => m.status !== "scheduled");
  const allFinished =
    matches.length > 0 &&
    matches.every((m) =>
      ["completed", "walkover", "disqualified", "retired", "cancelled"].includes(m.status)
    );

  const courtName = new Map(
    ((courtsRes.data ?? []) as { id: string; court_name: string }[]).map((c) => [c.id, c.court_name])
  );

  // Team names for the schedule table.
  const teamIds = [...new Set(matches.flatMap((m) => [m.team_a_id, m.team_b_id]).filter(Boolean))] as string[];
  const { data: teamRows } = teamIds.length
    ? await db().from("teams").select("id, team_name").in("id", teamIds)
    : { data: [] };
  const teamName = new Map(
    ((teamRows ?? []) as { id: string; team_name: string }[]).map((t) => [t.id, t.team_name])
  );

  const rounds = [...new Set(matches.map((m) => m.round_name ?? "—"))];
  const finalizeCheck = await checkFinalizeReady(session.id);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">
            {session.name}{" "}
            <span className={`badge ${STATUS_BADGE[session.status] ?? "bg-border text-muted"}`}>
              {session.status}
            </span>
          </h1>
          <p className="text-xs text-muted">
            {session.pairing_mode} · {session.ranking_model === "games_won" ? "games won" : "win points"} ·{" "}
            {courtCount} court{courtCount === 1 ? "" : "s"} · {session.duration_minutes} min ·{" "}
            {season ? season.name : "no season (Lifetime only)"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {session.status === "draft" && (
            <form action={setStatusAction}>
              <input type="hidden" name="session_id" value={session.id} />
              <input type="hidden" name="status" value="open" />
              <button className="btn-primary text-xs">Open registration</button>
            </form>
          )}
          {session.status === "open" && (
            <form action={setStatusAction}>
              <input type="hidden" name="session_id" value={session.id} />
              <input type="hidden" name="status" value="scheduled" />
              <ConfirmSubmit className="btn-secondary text-xs" message="Close registration for this session?">
                Close registration
              </ConfirmSubmit>
            </form>
          )}
        </div>
      </div>

      {session.status === "open" && (
        <div className="card space-y-1 border-accent/40">
          <p className="text-xs font-bold uppercase text-muted">Share this link with players</p>
          <p className="font-mono text-sm break-all text-accent">{registerUrl}</p>
          <Link href={registerUrl} target="_blank" className="text-xs font-semibold text-accent">
            Open the registration page →
          </Link>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-4">
        {[
          { label: "Approved", value: approved.length },
          { label: "Pending", value: pending.length },
          { label: "Waitlist", value: waitlisted.length },
          { label: "Rounds that fit", value: capacity.roundsThatFit },
        ].map((s) => (
          <div key={s.label} className="card text-center">
            <p className="text-2xl font-bold">{s.value}</p>
            <p className="text-xs uppercase text-muted">{s.label}</p>
          </div>
        ))}
      </div>

      {capacity.warnings.length > 0 && (
        <div className="card space-y-1 border-warning/40">
          <p className="text-xs font-bold uppercase text-warning">Capacity notes</p>
          {capacity.warnings.map((w) => (
            <p key={w} className="text-sm text-muted">⚠ {w}</p>
          ))}
        </div>
      )}

      {pending.length > 0 && (
        <div className="card">
          <h2 className="mb-2 font-bold">Awaiting approval ({pending.length})</h2>
          {pending.map((e) => (
            <EntryRow key={e.id} entry={e} profile={profileById.get(e.player_profile_id)} sessionId={session.id} />
          ))}
        </div>
      )}

      {waitlisted.length > 0 && (
        <div className="card">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-bold">Waitlist ({waitlisted.length})</h2>
            <form action={promoteWaitlistAction}>
              <input type="hidden" name="session_id" value={session.id} />
              <button className="btn-secondary text-xs">Promote next</button>
            </form>
          </div>
          {waitlisted.map((e) => (
            <EntryRow key={e.id} entry={e} profile={profileById.get(e.player_profile_id)} sessionId={session.id} />
          ))}
        </div>
      )}

      <div className="card">
        <h2 className="mb-2 font-bold">Playing ({approved.length})</h2>
        {approved.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted">
            Nobody approved yet. Share the registration link, or add players directly below.
          </p>
        ) : (
          approved.map((e) => (
            <EntryRow key={e.id} entry={e} profile={profileById.get(e.player_profile_id)} sessionId={session.id} />
          ))
        )}
      </div>

      {session.pairing_mode === "fixed" && (
        <div className="card space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-bold">Pairs</h2>
              <p className="text-xs text-muted">
                Drag players into pairs. Partners stay together all session; opponents rotate.
              </p>
            </div>
            {!anyStarted && (
              <form action={autoPairAction}>
                <input type="hidden" name="session_id" value={session.id} />
                <button className="btn-secondary text-xs">Auto-pair the rest</button>
              </form>
            )}
          </div>
          {approved.length < 4 ? (
            <p className="text-sm text-muted">Approve at least 4 players before pairing.</p>
          ) : (
            <PairsClient
              sessionId={session.id}
              players={approvedPlayers}
              initialCouples={initialCouples}
              locked={anyStarted}
            />
          )}
        </div>
      )}

      <div className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-bold">Schedule</h2>
            <p className="text-xs text-muted">
              {session.pairing_mode === "mexicano"
                ? "Mexicano draws one round at a time — the next round's courts come from the current standings."
                : `${capacity.roundsThatFit} round(s) fit in ${session.duration_minutes} minutes on ${courtCount} court(s).`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {matches.length === 0 ? (
              <form action={generateScheduleAction}>
                <input type="hidden" name="session_id" value={session.id} />
                <button className="btn-primary text-xs" disabled={approved.length < 4}>
                  {session.pairing_mode === "mexicano" ? "Draw round 1" : "Generate schedule"}
                </button>
              </form>
            ) : (
              <>
                {session.pairing_mode === "mexicano" && allFinished && (
                  <form action={nextRoundAction}>
                    <input type="hidden" name="session_id" value={session.id} />
                    <button className="btn-primary text-xs">Draw next round</button>
                  </form>
                )}
                {!anyStarted && (
                  <form action={generateScheduleAction}>
                    <input type="hidden" name="session_id" value={session.id} />
                    <ConfirmSubmit
                      className="btn-secondary text-xs"
                      message="Rebuild the schedule? Matches that have not started will be replaced."
                    >
                      Regenerate
                    </ConfirmSubmit>
                  </form>
                )}
              </>
            )}
          </div>
        </div>

        {matches.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted">
            {approved.length < 4
              ? "At least 4 approved players are needed to build a schedule."
              : "No matches yet — generate the schedule to get started."}
          </p>
        ) : (
          <div className="space-y-3">
            {rounds.map((r) => (
              <div key={r}>
                <p className="mb-1 text-xs font-bold uppercase text-muted">{r}</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {matches
                    .filter((m) => (m.round_name ?? "—") === r)
                    .map((m) => (
                      <div
                        key={m.id}
                        className="flex items-center justify-between gap-2 rounded-xl border border-border bg-background px-2 py-1.5 text-sm"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-semibold">
                            {teamName.get(m.team_a_id ?? "") ?? "TBD"}
                          </p>
                          <p className="truncate text-xs text-muted">
                            v {teamName.get(m.team_b_id ?? "") ?? "TBD"}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-xs text-muted">{courtName.get(m.court_id ?? "") ?? "—"}</p>
                          <span className="badge bg-border text-muted">{m.status}</span>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {matches.length > 0 && (
        <div className="card space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-bold">
                Finalize{" "}
                {session.status === "finalized" && (
                  <span className="badge bg-success/15 text-success">official</span>
                )}
              </h2>
              <p className="text-xs text-muted">
                Finalizing publishes these points into the Season and Lifetime rankings.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <a
                href={`/api/f/${session.slug}/export`}
                className="btn-secondary text-xs"
              >
                Export CSV
              </a>
              {session.status === "finalized" ? (
                <form action={reopenSessionAction}>
                  <input type="hidden" name="session_id" value={session.id} />
                  <ConfirmSubmit
                    className="btn-secondary text-xs text-danger"
                    message="Reopen this session? Its points revert to provisional and drop out of the official rankings until you finalize again."
                  >
                    Reopen for corrections
                  </ConfirmSubmit>
                </form>
              ) : (
                <form action={finalizeSessionAction}>
                  <input type="hidden" name="session_id" value={session.id} />
                  <ConfirmSubmit
                    className="btn-primary text-xs"
                    message="Finalize this session? Its points become official and count toward Season and Lifetime rankings."
                  >
                    Finalize session
                  </ConfirmSubmit>
                </form>
              )}
            </div>
          </div>

          {finalizeCheck.blockers.length > 0 && session.status !== "finalized" && (
            <div className="space-y-1">
              {finalizeCheck.blockers.map((b) => (
                <p key={b} className="rounded-xl bg-danger/10 px-3 py-2 text-xs font-semibold text-danger">
                  ✕ {b}
                </p>
              ))}
            </div>
          )}
          {finalizeCheck.warnings.map((w) => (
            <p key={w} className="rounded-xl bg-warning/10 px-3 py-2 text-xs font-semibold text-warning">
              ⚠ {w}
            </p>
          ))}

          <div className="grid gap-2 border-t border-border pt-3 sm:grid-cols-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold uppercase text-muted">Live page</span>
              <ShareButton path={`/f/${session.slug}`} text={`${session.name} — live scores:`} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold uppercase text-muted">Standings</span>
              <ShareButton path={`/f/${session.slug}/rankings`} text={`${session.name} — standings:`} />
            </div>
          </div>
        </div>
      )}

      <details className="card">
        <summary className="cursor-pointer font-bold">Add a player directly</summary>
        {addable.length === 0 ? (
          <p className="mt-2 text-sm text-muted">
            Every player in the directory is already in this session.{" "}
            <Link href="/admin/players" className="font-semibold text-accent">Add a new player</Link>.
          </p>
        ) : (
          <form action={addPlayerAction} className="mt-3 flex flex-wrap items-end gap-2">
            <input type="hidden" name="session_id" value={session.id} />
            <div className="min-w-56 flex-1">
              <label className="label" htmlFor="add-player">Player</label>
              <select id="add-player" name="player_profile_id" className="input" required>
                {addable.map((p) => (
                  <option key={p.id} value={p.id}>{p.public_name}</option>
                ))}
              </select>
            </div>
            <button className="btn-secondary text-sm">Add to session</button>
          </form>
        )}
      </details>
    </div>
  );
}
