import Link from "next/link";
import { notFound } from "next/navigation";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import { estimateCapacity } from "@/lib/friendly/capacity";
import { listEntries, listPlayerProfiles, listSeasons, getSession } from "@/lib/friendly/data";
import { requireEntityPage } from "@/lib/guard";
import { db } from "@/lib/supabase";
import type { FriendlyEntry, PlayerProfile } from "@/lib/types";
import ShareButton from "@/components/ShareButton";
import { checkFinalizeReady } from "@/lib/friendly/ops";
import PairsClient, { type PlayerLite } from "./PairsClient";
import AddPlayersDialog from "./AddPlayersDialog";
import ActionButton from "@/components/ActionButton";
import BrandingForm from "@/app/admin/tournaments/[id]/settings/BrandingForm";
import { getSnapshots, getTournament } from "@/lib/data";
import NightTableView from "@/components/friendly/NightTableView";
import { nightTableFor } from "@/lib/friendly/nights";
import ResultEntryButton from "@/app/admin/tournaments/[id]/matches/ResultEntryButton";
import { scoringConfigForMatch } from "@/lib/scoring/rules";
import { matchDayRules, resolveScoringMode } from "@/lib/matchday/rules";
import { sportOf } from "@/lib/sports/registry";
import { enteredSetsFromState } from "@/lib/scoring/finalScore";
import { chessCompetitionFor, finalResultAllowed } from "@/lib/scoring/resultEntry";
import type { MatchSnapshot } from "@/lib/types";
import {
  approveEntryAction,
  autoPairAction,
  enterSessionResult,
  publishNightTableAction,
  finalizeSessionAction,
  generateScheduleAction,
  nextRoundAction,
  promoteWaitlistAction,
  releaseEntryAction,
  reopenSessionAction,
  setSessionPodiumDepthAction,
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
        <p className="font-mono text-xs text-muted">{profile?.person_hidden ? "contact details hidden" : (profile?.mobile_normalized ?? "no mobile")}</p>
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
  // Re-checked on every request: the session's organisation (through its hidden tournament) must be the staff member's.
  const { staff } = await requireEntityPage({ session: id }, ["admin", "manager"], `/admin/friendly-sessions/${id}`);
  const session = await getSession(id);
  if (!session) notFound();

  const [entries, profiles, seasons, courtsRes, pairsRes, matchesRes] = await Promise.all([
    listEntries(id),
    listPlayerProfiles(staff.orgId, undefined, { platformAdmin: staff.platformAdmin }),
    listSeasons(staff.orgId),
    db().from("courts").select("id, court_name, court_order").eq("tournament_id", session.tournament_id).order("court_order"),
    db()
      .from("friendly_pairs")
      .select("id, player_one_profile_id, player_two_profile_id")
      .eq("session_id", id)
      .is("retired_after_round", null),
    db()
      .from("matches")
      .select("id, round_name, match_order, court_id, status, team_a_id, team_b_id, scoring_mode_override, stage, bracket_id")
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
    scoring_mode_override: "point_by_point" | "final_score" | "either" | null;
    stage: string;
    bracket_id: string | null;
  }[];
  const anyStarted = matches.some((m) => m.status !== "scheduled");
  const allFinished =
    matches.length > 0 &&
    matches.every((m) =>
      ["completed", "walkover", "disqualified", "retired", "cancelled"].includes(m.status)
    );

  // Team names for the schedule table.
  const teamIds = [...new Set(matches.flatMap((m) => [m.team_a_id, m.team_b_id]).filter(Boolean))] as string[];
  const { data: teamRows } = teamIds.length
    ? await db().from("teams").select("id, team_name").in("id", teamIds)
    : { data: [] };
  const teamName = new Map(
    ((teamRows ?? []) as { id: string; team_name: string }[]).map((t) => [t.id, t.team_name])
  );

  const [finalizeCheck, backing, night, snapshots] = await Promise.all([
    checkFinalizeReady(session.id),
    getTournament(session.tournament_id),
    nightTableFor(session.tournament_id),
    getSnapshots(session.tournament_id),
  ]);
  const publishedAt = backing?.format_config?.nightTable?.publishedAt ?? null;
  const timeZone = backing?.timezone || "Africa/Cairo";

  // Final-result entry on the night (Phase 2): where the session (or the match) allows it.
  const snapByMatch = new Map(snapshots.map((x) => [x.match_id, x] as const));
  const engine = sportOf(backing ?? undefined).engine;
  const rulesOfDay = backing ? matchDayRules(backing.match_day_rules, backing) : null;
  const resultActions = new Map<string, React.ReactNode>();
  for (const m of matches) {
    const scoreLink = (
      <Link key="score" href={`/referee/matches/${m.id}/score`} className="btn-secondary px-2 py-0.5 text-[11px]">
        Score
      </Link>
    );
    const allowed =
      backing &&
      rulesOfDay &&
      m.team_a_id &&
      m.team_b_id &&
      m.status !== "cancelled" &&
      finalResultAllowed(resolveScoringMode({ matchOverride: m.scoring_mode_override, sessionMode: session.scoring_mode, rules: rulesOfDay }));
    if (!allowed) {
      resultActions.set(m.id, <div className="flex gap-1">{scoreLink}</div>);
      continue;
    }
    const snap = snapByMatch.get(m.id) as MatchSnapshot | undefined;
    const state = (snap?.snapshot_json ?? null) as Record<string, unknown> | null;
    resultActions.set(
      m.id,
      <div className="flex gap-1">
        {scoreLink}
        <ResultEntryButton
          tournamentId={session.tournament_id}
          matchId={m.id}
          engine={engine}
          rules={scoringConfigForMatch(backing!, m as never, null, { doubles: true })}
          legs={1}
          competition={chessCompetitionFor(m.stage)}
          sideA={teamName.get(m.team_a_id ?? "") ?? "Side A"}
          sideB={teamName.get(m.team_b_id ?? "") ?? "Side B"}
          initial={Array.isArray(state?.completedSets) && (state!.completedSets as unknown[]).length > 0 ? { sets: enteredSetsFromState(state as never) } : null}
          correcting={(snap?.last_event_number ?? 0) > 0}
          enter={enterSessionResult.bind(null, session.id, m.id)}
        />
      </div>,
    );
  }
  const canPublish = !anyStarted && approved.length >= 4 && session.status !== "finalized";

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
            {courtCount} court{courtCount === 1 ? "" : "s"} ·{" "}
            {session.duration_minutes ? `${session.duration_minutes} min · ` : "no time limit · "}
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
              <ActionButton pendingLabel="Promoting…">Promote next</ActionButton>
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
                <ActionButton pendingLabel="Pairing…">Auto-pair the rest</ActionButton>
              </form>
            )}
          </div>
          {approved.length < 4 ? (
            <p className="text-sm text-muted">Approve at least 4 players before pairing.</p>
          ) : (
            <PairsClient
              // The board keeps its own drag state, so it must remount when the
              // server sends different pairs — otherwise auto-pair and the
              // player picker appear to do nothing until a manual reload.
              key={initialCouples.flat().join("|")}
              sessionId={session.id}
              players={approvedPlayers}
              initialCouples={initialCouples}
              locked={anyStarted}
            />
          )}
        </div>
      )}

      {canPublish && (
        <form action={publishNightTableAction} className="card space-y-3 border-accent/40" data-testid="publish-night-table">
          <input type="hidden" name="session_id" value={session.id} />
          <input type="hidden" name="confirm_players" value="1" />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-bold">
                Confirm players and publish table{" "}
                {publishedAt && <span className="badge bg-success/15 text-success">published</span>}
              </h2>
              <p className="text-xs text-muted">
                Untick anyone not playing tonight. Publishing builds the order of play per court with estimated
                times (each match starts when its court is free) and tells the players linked to the app.
                {publishedAt ? " Publishing again rebuilds the table until the first match starts." : ""}
              </p>
            </div>
          </div>
          <div className="grid gap-1 sm:grid-cols-3">
            {approved.map((e) => (
              <label key={e.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="playing" value={e.player_profile_id} defaultChecked />
                {profileById.get(e.player_profile_id)?.public_name ?? "Unknown player"}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="label" htmlFor="pub-minutes">Minutes per match</label>
              <input id="pub-minutes" name="match_minutes" type="number" min={5} max={240} defaultValue={session.expected_match_minutes} className="input w-24 text-sm" />
            </div>
            <div>
              <label className="label" htmlFor="pub-changeover">Changeover</label>
              <input id="pub-changeover" name="changeover_minutes" type="number" min={0} max={60} defaultValue={session.turnover_minutes} className="input w-24 text-sm" />
            </div>
            <p className="pb-2 text-xs text-muted">
              {session.starts_at
                ? `Starts ${new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(session.starts_at))}`
                : "No start time: the table has no estimated times."}
            </p>
            <ConfirmSubmit className="btn-primary ml-auto text-xs" message="Publish tonight's table? The players linked to the app are told their court and time.">
              {publishedAt ? "Publish again" : "Confirm players and publish table"}
            </ConfirmSubmit>
          </div>
        </form>
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
            {session.pairing_mode === "mexicano" && matches.length > 0 && allFinished && (
              <form action={nextRoundAction}>
                <input type="hidden" name="session_id" value={session.id} />
                <ActionButton className="btn-primary text-xs" pendingLabel="Drawing…">Draw next round</ActionButton>
              </form>
            )}
          </div>
        </div>

        {(!anyStarted || matches.length === 0) && approved.length >= 4 && (
          <form action={generateScheduleAction} className="grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-4">
            <input type="hidden" name="session_id" value={session.id} />
            <div className="sm:col-span-2">
              <label className="label" htmlFor="gen-format">Draw format</label>
              <select id="gen-format" name="format" defaultValue="rotating" className="input text-sm">
                <option value="rotating">
                  {session.pairing_mode === "fixed"
                    ? "Round robin — every pair plays every other"
                    : session.pairing_mode === "mexicano"
                      ? "Mexicano — one round at a time from standings"
                      : "Americano — partners rotate each round"}
                </option>
                <option value="group_stage">Group stage — random draw into groups</option>
                <option value="knockout">Knockout bracket — single elimination</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="gen-groups">Groups</label>
              <input id="gen-groups" name="group_count" type="number" min={1} max={12} defaultValue={2} className="input text-sm" />
              <p className="mt-1 text-xs text-muted">Group stage only</p>
            </div>
            <div className="flex flex-col justify-end gap-1">
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" name="fit" />
                Trim to time
              </label>
              {matches.length === 0 ? (
                <ActionButton className="btn-primary text-xs" pendingLabel="Generating…">Generate matches</ActionButton>
              ) : (
                <ConfirmSubmit
                  className="btn-secondary text-xs"
                  message="Rebuild the draw? Matches that have not started will be replaced."
                >
                  Regenerate
                </ConfirmSubmit>
              )}
            </div>
          </form>
        )}

        {matches.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted">
            {approved.length < 4
              ? "At least 4 approved players are needed to build a schedule."
              : "No matches yet — pick a format above and generate."}
          </p>
        ) : (
          <div className="space-y-2">
            {night && (
              <p className="text-xs text-muted">
                Order of play per court{session.starts_at ? ", with estimated times (re-estimated as matches finish)" : ""}.
                {publishedAt ? " Published to the players." : " Not published yet."}
              </p>
            )}
            {night && <NightTableView table={night.table} actions={resultActions} />}
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

      {/* A session's wall is its backing tournament's wall: same screens, same
          control room, same sponsors. */}
      {backing && (
        <details className="card space-y-3">
          <summary className="cursor-pointer font-bold">TV screens &amp; sponsors</summary>
          <div className="flex flex-wrap gap-2 pt-2 text-sm">
            <Link href={`/admin/tournaments/${backing.id}/screens`} className="btn-secondary text-xs">
              Manage screens
            </Link>
            <Link href={`/operator/tournaments/${backing.id}/control`} className="btn-secondary text-xs">
              Open control room
            </Link>
            <Link href={`/t/${backing.slug}/screen`} target="_blank" className="btn-secondary text-xs">
              Main TV screen ↗
            </Link>
          </div>
          <form action={setSessionPodiumDepthAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="session_id" value={session.id} />
            <div>
              <label className="label">Closing ceremony podium</label>
              <select
                name="podium_depth"
                defaultValue={String(backing.format_config?.tiers?.cup?.podiumDepth ?? 3)}
                className="input w-auto"
              >
                <option value="1">Champion only</option>
                <option value="2">Top 2</option>
                <option value="3">Top 3</option>
                <option value="4">Top 4</option>
              </select>
            </div>
            <button className="btn-secondary text-xs">Save</button>
            <p className="w-full text-xs text-muted">
              Revealed place by place from the session ranking. Tied players share a step.
            </p>
          </form>
          <BrandingForm
            tournamentId={backing.id}
            branding={backing.branding_config}
            returnPath={`/admin/friendly-sessions/${session.id}`}
          />
        </details>
      )}

      <div className="card flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-bold">Add players</h2>
          <p className="text-xs text-muted">
            {session.pairing_mode === "fixed"
              ? "Pick players two at a time — each consecutive pair becomes a team."
              : "Pick as many as you like; partners rotate automatically in this format."}
          </p>
        </div>
        {addable.length === 0 ? (
          <p className="text-sm text-muted">
            Everyone is already in.{" "}
            <Link href="/admin/players" className="font-semibold text-accent">Add a new player</Link>
          </p>
        ) : (
          <AddPlayersDialog
            sessionId={session.id}
            pairThem={session.pairing_mode === "fixed"}
            players={profiles.map((p) => ({
              id: p.id,
              name: p.public_name,
              mobile: p.mobile_normalized,
              level: p.skill_level,
              inSession: alreadyIn.has(p.id),
            }))}
          />
        )}
      </div>
    </div>
  );
}
