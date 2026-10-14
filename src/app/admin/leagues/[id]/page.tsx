import StateForm from "@/components/StateForm";
import Link from "next/link";
import { db } from "@/lib/supabase";
import { requireEntityPage } from "@/lib/guard";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import { orgDisplayNames } from "@/lib/orgs/personFields";
import { leaguePointsRules } from "@/lib/leagues/points";
import { normalizeJoinModes } from "@/lib/leagues/join";
import {
  BOARD_LABELS,
  dayLabel,
  LEAGUE_STATUS_LABELS,
  LEAGUE_STATUSES,
  leagueFee,
  leaguePeriods,
  monthLabel,
  nightTemplate,
  shiftMonth,
} from "@/lib/leagues/settings";
import { BOARD_LENGTHS } from "@/lib/leagues/boards";
import { LEAGUE_VISIBILITY_OPTIONS, leagueVisibility } from "@/lib/leagues/visibility";
import { boardPeriod, getDivisions, getFixtures, getLeague, getMembers, leagueBoards, todayIn } from "@/lib/leagues/server";
import { isPlayedStatus } from "@/lib/leagues/fixtures";
import InviteCodeForm from "./InviteCodeForm";
import {
  addDivisionAction,
  addMemberAction,
  clearInviteCodeAction,
  createNightAction,
  decideMemberAction,
  deleteDivisionAction,
  deleteNightAction,
  generateFixturesAction,
  recalculateLeagueAction,
  renameDivisionAction,
  saveLeagueSettings,
  saveNightTemplate,
  savePeriods,
  savePointsRules,
  setCountsTowardAction,
  setFixtureDateAction,
  setMemberDivisionAction,
  setMemberPartnerAction,
} from "../actions";

export const dynamic = "force-dynamic";

const MODE_LABELS: Record<string, string> = {
  open: "Open: anyone signed in joins at once",
  approval: "Approval: the organiser approves each request",
  paid: "Paid: a membership fee",
  invite_code: "Invite code: players need the league's code",
};

const MEMBER_BADGE: Record<string, string> = {
  pending: "bg-warning/15 text-warning",
  awaiting_payment: "bg-warning/15 text-warning",
  active: "bg-success/15 text-success",
  removed: "bg-border text-muted",
};

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="card space-y-3" data-testid={testId}>
      <h2 className="text-lg font-bold">{title}</h2>
      {children}
    </section>
  );
}

export default async function LeaguePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ period?: string; month?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { staff } = await requireEntityPage({ league: id }, ["admin", "manager"], `/admin/leagues/${id}`);
  const league = (await getLeague(id))!;
  const [divisions, members, fixtures] = await Promise.all([getDivisions(id), getMembers(id), getFixtures(id)]);
  const divName = new Map(divisions.map((d) => [d.id, d.name]));

  // Names only, as this organisation may show them (src/lib/orgs/personFields.ts).
  const { data: orgPlayerRows } = await db()
    .from("organization_players")
    .select("player_profile_id")
    .eq("organization_id", staff.orgId)
    .eq("approval_status", "approved")
    .limit(1000);
  const orgPlayerIds = ((orgPlayerRows ?? []) as { player_profile_id: string }[]).map((r) => r.player_profile_id);
  const profileIds = [...new Set([...members.flatMap((m) => [m.player_profile_id, m.partner_profile_id ?? ""]), ...orgPlayerIds].filter(Boolean))];
  const { names } = await orgDisplayNames(staff.orgId, profileIds, { platformAdmin: staff.platformAdmin });
  const nameOf = (pid: string | null | undefined) => (pid ? (names.get(pid) ?? "Player") : "—");
  const memberIds = new Set(members.map((m) => m.player_profile_id));
  const addable = orgPlayerIds.filter((pid) => !memberIds.has(pid)).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));

  // Nights and season fixtures.
  const nightFixtures = fixtures.filter((f) => f.kind === "night");
  const matchFixtures = fixtures.filter((f) => f.kind === "match");
  const sessionIds = [...new Set(nightFixtures.map((f) => f.session_id!).filter(Boolean))];
  const { data: sessionRows } = sessionIds.length ? await db().from("friendly_sessions").select("id, name, tournament_id, status").in("id", sessionIds) : { data: [] };
  const sessions = new Map(((sessionRows ?? []) as { id: string; name: string; tournament_id: string; status: string }[]).map((s) => [s.id, s]));
  const nightTournaments = [...sessions.values()].map((s) => s.tournament_id);
  const { data: nightMatchRows } = nightTournaments.length ? await db().from("matches").select("tournament_id, status").in("tournament_id", nightTournaments) : { data: [] };
  const nightMatches = (nightMatchRows ?? []) as { tournament_id: string; status: string }[];
  const fixtureMatchIds = matchFixtures.map((f) => f.match_id!).filter(Boolean);
  const { data: fMatchRows } = fixtureMatchIds.length ? await db().from("matches").select("id, status").in("id", fixtureMatchIds) : { data: [] };
  const fStatus = new Map(((fMatchRows ?? []) as { id: string; status: string }[]).map((m) => [m.id, m.status]));
  const memberById = new Map(members.map((m) => [m.id, m]));
  const entrantName = (memberId: string | null) => {
    const m = memberId ? memberById.get(memberId) : null;
    return m ? [m.player_profile_id, m.partner_profile_id].filter(Boolean).map((p) => nameOf(p)).join(" & ") : "—";
  };

  // Tournaments that may count toward a division: the organisation's own.
  const { data: tRows } = await db()
    .from("tournaments")
    .select("id, name, status, starts_on, counts_toward")
    .eq("organization_id", staff.orgId)
    .eq("kind", "tournament")
    .in("status", ["draft", "active", "completed"])
    .order("created_at", { ascending: false })
    .limit(200);
  const tournaments = (tRows ?? []) as { id: string; name: string; status: string; starts_on: string | null; counts_toward: string | null }[];
  const counting = tournaments.filter((t) => t.counts_toward && divName.has(t.counts_toward));

  const rules = leaguePointsRules(league.points_rules);
  const periods = leaguePeriods(league.periods);
  const fee = leagueFee(league.fee);
  const tpl = nightTemplate(league.night_template);
  const modes = normalizeJoinModes(league.join_modes);
  const visibility = leagueVisibility(league.visibility);
  const period = boardPeriod(league, sp.period, sp.month);
  const boards = await leagueBoards(league, period);
  const today = todayIn(league.timezone);
  const { data: o } = await db().from("organizations").select("slug").eq("id", staff.orgId).maybeSingle();
  const payOnline = (o as { slug: string } | null)?.slug === "move-beyond" && Boolean(process.env.MOVE_TICK_API_URL);

  const pending = members.filter((m) => m.status === "pending" || m.status === "awaiting_payment");
  const active = members.filter((m) => m.status === "active");
  const removed = members.filter((m) => m.status === "removed");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link href="/admin/leagues" className="text-xs text-muted hover:text-foreground">← Leagues</Link>
          <h1 className="text-2xl font-bold">{league.name}</h1>
          <p className="text-xs text-muted">
            {league.kind === "season" ? "Season fixtures" : "Recurring nights"} · <span className="capitalize">{league.sport}</span> · app link movescore://league/{league.slug}
          </p>
        </div>
        <span className="badge bg-accent/15 text-accent" data-testid="league-status">{LEAGUE_STATUS_LABELS[league.status]}</span>
      </div>

      <Section title="Settings" testId="league-settings">
        <StateForm action={saveLeagueSettings} className="grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="league_id" value={league.id} />
          <div className="sm:col-span-2">
            <label className="label" htmlFor="l-name">Name</label>
            <input id="l-name" name="name" className="input" defaultValue={league.name} required maxLength={120} />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="l-about">About</label>
            <textarea id="l-about" name="about" className="input" defaultValue={league.about ?? ""} rows={3} maxLength={4000} />
          </div>
          <div>
            <label className="label" htmlFor="l-status">Status</label>
            <select id="l-status" name="status" className="input" defaultValue={league.status}>
              {LEAGUE_STATUSES.map((s) => (
                <option key={s} value={s}>{LEAGUE_STATUS_LABELS[s]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="l-sport">Sport</label>
            <select id="l-sport" name="sport" className="input" defaultValue={league.sport}>
              <option value="padel">Padel</option>
              <option value="tennis">Tennis</option>
              <option value="chess">Chess</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="l-tz">Time zone (a result counts in its night&apos;s month here)</label>
            <select id="l-tz" name="timezone" className="input" defaultValue={league.timezone}>
              {["Africa/Cairo", "Asia/Dubai", "Asia/Riyadh", "Europe/London", "Europe/Paris", "UTC"].map((z) => (
                <option key={z} value={z}>{z}</option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="counts_toward_top_of_all" defaultChecked={league.counts_toward_top_of_all} />
            Counts toward the top boards{visibility !== "everyone" ? " (only while everyone can see the league)" : ""}
          </label>
          <fieldset className="sm:col-span-2" data-testid="league-visibility">
            <legend className="label">Who can see this league</legend>
            {LEAGUE_VISIBILITY_OPTIONS.map((o) => (
              <label key={o.value} className="flex items-start gap-2 py-1 text-sm">
                <input type="radio" name="visibility" value={o.value} defaultChecked={visibility === o.value} className="mt-1" />
                <span>
                  <span className="font-semibold">{o.label}</span>
                  <span className="block text-xs text-muted">{o.help}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset className="sm:col-span-2">
            <legend className="label">Joining (combine as you like: code first, then approval, then payment)</legend>
            {Object.entries(MODE_LABELS).map(([m, label]) => (
              <label key={m} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="join_modes" value={m} defaultChecked={modes.includes(m as never)} /> {label}
              </label>
            ))}
            {!payOnline && <p className="mt-1 text-xs text-muted">Online payment is not available for this organisation yet: a paid league is paid at the venue.</p>}
          </fieldset>
          <div>
            <label className="label" htmlFor="l-fee">Membership fee</label>
            <input id="l-fee" name="fee_membership" type="number" min={0} className="input" defaultValue={fee.membership?.amount ?? ""} />
          </div>
          <div>
            <label className="label" htmlFor="l-night">Fee per night</label>
            <input id="l-night" name="fee_per_night" type="number" min={0} className="input" defaultValue={fee.perNight?.amount ?? ""} />
          </div>
          <div>
            <label className="label" htmlFor="l-cur">Currency</label>
            <input id="l-cur" name="currency" className="input" defaultValue={fee.membership?.currency ?? fee.perNight?.currency ?? "EGP"} maxLength={3} />
          </div>
          <div className="flex items-end sm:col-span-2">
            <button className="btn-primary">Save settings</button>
          </div>
        </StateForm>
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Points rules" testId="league-points-rules">
          <form action={savePointsRules} className="grid grid-cols-2 gap-3">
            <input type="hidden" name="league_id" value={league.id} />
            {(
              [
                ["win", "Win", rules.win],
                ["loss", "Loss", rules.loss],
                ["draw", "Draw (chess)", rules.draw],
                ["walkover_win", "Walkover win", rules.walkoverWin],
                ["walkover_loss", "Walkover loss", rules.walkoverLoss],
              ] as const
            ).map(([name, label, value]) => (
              <div key={name}>
                <label className="label" htmlFor={`p-${name}`}>{label}</label>
                <input id={`p-${name}`} name={name} type="number" step={0.5} min={0} max={100} className="input" defaultValue={value} />
              </div>
            ))}
            <label className="col-span-2 flex items-center gap-2 text-sm">
              <input type="checkbox" name="streak_on" defaultChecked={rules.streak.on} /> Streak bonus (this league&apos;s own streak)
            </label>
            <div>
              <label className="label" htmlFor="p-bonus">Bonus per win</label>
              <input id="p-bonus" name="streak_bonus" type="number" step={0.5} min={0} className="input" defaultValue={rules.streak.bonus} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label" htmlFor="p-from">From win</label>
                <input id="p-from" name="streak_from" type="number" min={1} className="input" defaultValue={rules.streak.from} />
              </div>
              <div>
                <label className="label" htmlFor="p-to">To win</label>
                <input id="p-to" name="streak_to" type="number" min={1} className="input" defaultValue={rules.streak.to} />
              </div>
            </div>
            <p className="col-span-2 text-xs text-muted">Saving recalculates every result already in the league.</p>
            <div className="col-span-2">
              <button className="btn-primary">Save points rules</button>
            </div>
          </form>
        </Section>

        <Section title="Periods and boards" testId="league-periods">
          <form action={savePeriods} className="space-y-3">
            <input type="hidden" name="league_id" value={league.id} />
            <div className="flex flex-wrap gap-3">
              {BOARD_LENGTHS.map((l) => (
                <label key={l} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="boards" value={l} defaultChecked={periods.boards.includes(l)} disabled={l === 1} />
                  {BOARD_LABELS[l]}
                </label>
              ))}
            </div>
            <div>
              <label className="label" htmlFor="p-year">The league&apos;s year starts in</label>
              <select id="p-year" name="year_start_month" className="input" defaultValue={periods.yearStartMonth}>
                {Array.from({ length: 12 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>{monthLabel(`2026-${String(i + 1).padStart(2, "0")}`).split(" ")[0]}</option>
                ))}
              </select>
            </div>
            <p className="text-xs text-muted">The monthly board resets each month; longer boards are sums of months, in blocks of the league&apos;s year.</p>
            <button className="btn-primary">Save boards</button>
          </form>
        </Section>
      </div>

      <Section title={`Board · ${period.label} · ${period.months.length > 1 ? `${monthLabel(period.months[0])} – ${monthLabel(period.months[period.months.length - 1])}` : monthLabel(period.month)}`} testId="league-board">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Link className="btn-secondary text-xs" href={`?period=${period.length}&month=${shiftMonth(period.month, -period.length)}`}>← Earlier</Link>
          {periods.boards.map((l) => (
            <Link key={l} className={`btn-secondary text-xs ${l === period.length ? "border-accent text-accent" : ""}`} href={`?period=${l}&month=${period.month}`}>{BOARD_LABELS[l]}</Link>
          ))}
          <Link className="btn-secondary text-xs" href={`?period=${period.length}&month=${shiftMonth(period.month, period.length)}`}>Later →</Link>
          <form action={recalculateLeagueAction} className="ml-auto">
            <input type="hidden" name="league_id" value={league.id} />
            <button className="btn-secondary text-xs">Recalculate points</button>
          </form>
        </div>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr><th className="py-1">#</th><th>Player</th><th>Pts</th><th>W</th><th>L</th><th>P</th><th>+/-</th></tr>
          </thead>
          <tbody>
            {boards.board.slice(0, 30).map((l) => (
              <tr key={l.profileId} className="border-t border-border">
                <td className="py-1">{l.rank}</td>
                <td>{boards.names.get(l.profileId) ?? nameOf(l.profileId)}</td>
                <td className="font-semibold">{l.points}</td>
                <td>{l.wins}</td>
                <td>{l.losses}</td>
                <td>{l.played}</td>
                <td>{l.gameDiff}</td>
              </tr>
            ))}
            {boards.board.length === 0 && (
              <tr><td colSpan={7} className="py-3 text-center text-muted">No results in this period yet.</td></tr>
            )}
          </tbody>
        </table>
      </Section>

      <Section title="Divisions" testId="league-divisions">
        <ul className="space-y-2">
          {divisions.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2">
              <StateForm action={renameDivisionAction} className="flex flex-wrap gap-2">
                <input type="hidden" name="division_id" value={d.id} />
                <input name="name" className="input" defaultValue={d.name} maxLength={80} />
                <button className="btn-secondary text-xs">Rename</button>
              </StateForm>
              <span className="text-xs text-muted">{active.filter((m) => m.division_id === d.id).length} members</span>
              {divisions.length > 1 && (
                <StateForm action={deleteDivisionAction}>
                  <input type="hidden" name="division_id" value={d.id} />
                  <ConfirmSubmit message="Remove this division? Its members stay in the league without a division." className="btn-secondary text-xs text-danger">Remove</ConfirmSubmit>
                </StateForm>
              )}
            </li>
          ))}
        </ul>
        <StateForm action={addDivisionAction} className="flex flex-wrap gap-2">
          <input type="hidden" name="league_id" value={league.id} />
          <input name="name" className="input" placeholder="Division 2" maxLength={80} required />
          <button className="btn-secondary">Add division</button>
        </StateForm>
      </Section>

      <Section title={`Members · ${active.length} active${pending.length ? ` · ${pending.length} waiting` : ""}`} testId="league-members">
        {pending.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Waiting</h3>
            {pending.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold">{nameOf(m.player_profile_id)}</span>
                <span className={`badge ${MEMBER_BADGE[m.status]}`}>{m.status === "pending" ? "asks to join" : "awaiting payment"}</span>
                <span className="text-xs text-muted">{m.division_id ? divName.get(m.division_id) : "no division"}</span>
                <form action={decideMemberAction} className="inline">
                  <input type="hidden" name="member_id" value={m.id} />
                  <input type="hidden" name="decision" value="approve" />
                  <button className="btn-primary text-xs">Approve</button>
                </form>
                <form action={decideMemberAction} className="inline">
                  <input type="hidden" name="member_id" value={m.id} />
                  <input type="hidden" name="decision" value="remove" />
                  <button className="btn-secondary text-xs text-danger">Turn down</button>
                </form>
              </div>
            ))}
          </div>
        )}
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr><th className="py-1">Player</th><th>Division</th>{league.kind === "season" && <th>Partner</th>}<th>Fee</th><th /></tr>
          </thead>
          <tbody>
            {active.map((m) => (
              <tr key={m.id} className="border-t border-border">
                <td className="py-1 font-semibold">{nameOf(m.player_profile_id)}</td>
                <td>
                  <form action={setMemberDivisionAction} className="flex gap-1">
                    <input type="hidden" name="member_id" value={m.id} />
                    <select name="division_id" className="input text-xs" defaultValue={m.division_id ?? ""}>
                      <option value="">—</option>
                      {divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                    <button className="btn-secondary text-xs">Move</button>
                  </form>
                </td>
                {league.kind === "season" && (
                  <td>
                    <form action={setMemberPartnerAction} className="flex gap-1">
                      <input type="hidden" name="member_id" value={m.id} />
                      <select name="partner_profile_id" className="input text-xs" defaultValue={m.partner_profile_id ?? ""}>
                        <option value="">Plays alone</option>
                        {orgPlayerIds.filter((p) => p !== m.player_profile_id).map((p) => <option key={p} value={p}>{nameOf(p)}</option>)}
                      </select>
                      <button className="btn-secondary text-xs">Set</button>
                    </form>
                  </td>
                )}
                <td className="text-xs">
                  {m.pay_at_venue ? (
                    <form action={decideMemberAction} className="inline">
                      <input type="hidden" name="member_id" value={m.id} />
                      <input type="hidden" name="decision" value="paid" />
                      <button className="btn-secondary text-xs">Paid at venue</button>
                    </form>
                  ) : m.paid_until ? `paid to ${m.paid_until}` : "—"}
                </td>
                <td className="text-right">
                  <form action={decideMemberAction} className="inline">
                    <input type="hidden" name="member_id" value={m.id} />
                    <input type="hidden" name="decision" value="remove" />
                    <ConfirmSubmit message="Remove this player from the league? Their points leave its boards." className="btn-secondary text-xs text-danger">Remove</ConfirmSubmit>
                  </form>
                </td>
              </tr>
            ))}
            {active.length === 0 && <tr><td colSpan={5} className="py-3 text-center text-muted">No members yet.</td></tr>}
          </tbody>
        </table>
        {removed.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-muted">{removed.length} removed</summary>
            {removed.map((m) => (
              <form key={m.id} action={decideMemberAction} className="flex items-center gap-2 text-sm">
                <input type="hidden" name="member_id" value={m.id} />
                <input type="hidden" name="decision" value="restore" />
                <span>{nameOf(m.player_profile_id)}</span>
                <button className="btn-secondary text-xs">Restore</button>
              </form>
            ))}
          </details>
        )}
        <form action={addMemberAction} className="flex flex-wrap gap-2">
          <input type="hidden" name="league_id" value={league.id} />
          <select name="profile_id" className="input" required defaultValue="">
            <option value="" disabled>Add one of your players…</option>
            {addable.map((p) => <option key={p} value={p}>{nameOf(p)}</option>)}
          </select>
          <select name="division_id" className="input" defaultValue={divisions[0]?.id ?? ""}>
            {divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <button className="btn-secondary">Add member</button>
        </form>
      </Section>

      <Section title="Invite code" testId="league-invite">
        <p className="text-xs text-muted">
          {league.invite_code_set_at ? `A code is set (since ${dayLabel(league.invite_code_set_at.slice(0, 10))}).` : "No code set."}{" "}
          {modes.includes("invite_code") ? "Players need it to join." : "Add “Invite code” to the joining modes for players to need it."}
          {visibility === "invite_only" ? " This league is invite only: people who enter the code in the app (Leagues → Enter an invite code) can see it. A new or removed code closes it to them again (members stay)." : ""}
        </p>
        <InviteCodeForm leagueId={league.id} hasCode={Boolean(league.invite_code_set_at)} />
        {league.invite_code_set_at && (
          <form action={clearInviteCodeAction}>
            <input type="hidden" name="league_id" value={league.id} />
            <button className="btn-secondary text-xs text-danger">Remove the code</button>
          </form>
        )}
      </Section>

      <Section title="Night template" testId="league-night-template">
        <form action={saveNightTemplate} className="grid gap-3 sm:grid-cols-4">
          <input type="hidden" name="league_id" value={league.id} />
          <div>
            <label className="label" htmlFor="t-time">Starts at</label>
            <input id="t-time" name="start_time" type="time" className="input" defaultValue={tpl.startTime} />
          </div>
          <div>
            <label className="label" htmlFor="t-dur">Minutes</label>
            <input id="t-dur" name="duration_minutes" type="number" min={30} max={600} className="input" defaultValue={tpl.durationMinutes} />
          </div>
          <div>
            <label className="label" htmlFor="t-courts">Courts</label>
            <input id="t-courts" name="courts" type="number" min={1} max={20} className="input" defaultValue={tpl.courts} />
          </div>
          <div>
            <label className="label" htmlFor="t-max">Max players</label>
            <input id="t-max" name="max_players" type="number" min={4} max={200} className="input" defaultValue={tpl.maxPlayers ?? ""} />
          </div>
          <div>
            <label className="label" htmlFor="t-pair">Format</label>
            <select id="t-pair" name="pairing_mode" className="input" defaultValue={tpl.pairingMode}>
              <option value="americano">Americano</option>
              <option value="mexicano">Mexicano</option>
              <option value="fixed">Fixed partners</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="t-rank">Night table by</label>
            <select id="t-rank" name="ranking_model" className="input" defaultValue={tpl.rankingModel}>
              <option value="win_points">Wins</option>
              <option value="games_won">Games won</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="t-sets">Sets to win</label>
            <input id="t-sets" name="sets_to_win_match" type="number" min={1} max={3} className="input" defaultValue={tpl.setsToWinMatch} />
          </div>
          <div>
            <label className="label" htmlFor="t-games">Games per set</label>
            <input id="t-games" name="games_to_win_set" type="number" min={1} max={9} className="input" defaultValue={tpl.gamesToWinSet} />
          </div>
          <div>
            <label className="label" htmlFor="t-score">Scoring</label>
            <select id="t-score" name="scoring_mode" className="input" defaultValue={tpl.scoringMode}>
              <option value="either">Referee picks</option>
              <option value="point_by_point">Point by point</option>
              <option value="final_score">Final result</option>
            </select>
          </div>
          <div className="flex items-end">
            <button className="btn-primary">Save template</button>
          </div>
        </form>
      </Section>

      {league.kind === "nights" ? (
        <Section title="Nights" testId="league-nights">
          <StateForm action={createNightAction} className="flex flex-wrap gap-2">
            <select name="division_id" className="input" defaultValue={divisions[0]?.id ?? ""}>
              {divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <input name="date" type="date" className="input" defaultValue={today} required />
            <button className="btn-primary">Create night</button>
          </StateForm>
          <p className="text-xs text-muted">A night is a session made from the template, with the division&apos;s members entered. Build its table on the session&apos;s page.</p>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr><th className="py-1">Date</th><th>Division</th><th>Session</th><th>Matches</th><th /></tr>
            </thead>
            <tbody>
              {[...nightFixtures].sort((a, b) => (a.date < b.date ? 1 : -1)).map((f) => {
                const s = sessions.get(f.session_id!);
                const ms = nightMatches.filter((m) => m.tournament_id === s?.tournament_id);
                const played = ms.filter((m) => isPlayedStatus(m.status)).length;
                return (
                  <tr key={f.id} className="border-t border-border">
                    <td className="py-1">
                      <StateForm action={setFixtureDateAction} className="flex flex-wrap gap-1">
                        <input type="hidden" name="fixture_id" value={f.id} />
                        <input name="date" type="date" className="input text-xs" defaultValue={f.date} />
                        <button className="btn-secondary text-xs">Move</button>
                      </StateForm>
                    </td>
                    <td className="text-xs">{divName.get(f.division_id)}</td>
                    <td>{s ? <Link className="text-accent hover:underline" href={`/admin/friendly-sessions/${s.id}`}>{s.name}</Link> : "—"}</td>
                    <td className="text-xs">{played}/{ms.length}</td>
                    <td className="text-right">
                      {played === 0 && (
                        <StateForm action={deleteNightAction} className="inline">
                          <input type="hidden" name="fixture_id" value={f.id} />
                          <ConfirmSubmit message="Remove this night and its session?" className="btn-secondary text-xs text-danger">Remove</ConfirmSubmit>
                        </StateForm>
                      )}
                    </td>
                  </tr>
                );
              })}
              {nightFixtures.length === 0 && <tr><td colSpan={5} className="py-3 text-center text-muted">No nights yet.</td></tr>}
            </tbody>
          </table>
        </Section>
      ) : (
        <Section title="Season fixtures" testId="league-fixtures">
          {divisions.map((d) => {
            const own = matchFixtures.filter((f) => f.division_id === d.id);
            return (
              <div key={d.id} className="space-y-2">
                <h3 className="text-sm font-semibold">{d.name} · {own.length} fixtures</h3>
                <StateForm action={generateFixturesAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="division_id" value={d.id} />
                  <div>
                    <label className="label" htmlFor={`dates-${d.id}`}>Round dates (one per line; later rounds follow weekly)</label>
                    <textarea id={`dates-${d.id}`} name="dates" className="input" rows={2} defaultValue={today} />
                  </div>
                  <button className="btn-primary">{own.length ? "Regenerate unplayed fixtures" : "Generate fixtures"}</button>
                </StateForm>
                {own.length > 0 && (
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase tracking-wide text-muted">
                      <tr><th className="py-1">Round</th><th>Date</th><th>Fixture</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {own.map((f) => (
                        <tr key={f.id} className="border-t border-border">
                          <td className="py-1">{f.round ?? "—"}</td>
                          <td>
                            <StateForm action={setFixtureDateAction} className="flex flex-wrap gap-1">
                              <input type="hidden" name="fixture_id" value={f.id} />
                              <input name="date" type="date" className="input text-xs" defaultValue={f.date} />
                              <button className="btn-secondary text-xs">Move</button>
                            </StateForm>
                          </td>
                          <td>{entrantName(f.home_member_id)} v {entrantName(f.away_member_id)}</td>
                          <td className="text-xs">{fStatus.get(f.match_id ?? "") ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </Section>
      )}

      <Section title="Tournaments that count toward this league" testId="league-tournaments">
        <ul className="space-y-1 text-sm">
          {counting.map((t) => (
            <li key={t.id} className="flex items-center gap-2">
              <span className="font-semibold">{t.name}</span>
              <span className="text-xs text-muted">→ {divName.get(t.counts_toward!)}</span>
              <form action={setCountsTowardAction}>
                <input type="hidden" name="tournament_id" value={t.id} />
                <input type="hidden" name="division_id" value="" />
                <button className="btn-secondary text-xs">Stop counting</button>
              </form>
            </li>
          ))}
          {counting.length === 0 && <li className="text-xs text-muted">None. A tournament counts toward one division, off by default; only that division&apos;s active members get points.</li>}
        </ul>
        <form action={setCountsTowardAction} className="flex flex-wrap gap-2">
          <select name="tournament_id" className="input" required defaultValue="">
            <option value="" disabled>Pick a tournament…</option>
            {tournaments.filter((t) => !counting.includes(t)).map((t) => <option key={t.id} value={t.id}>{t.name}{t.counts_toward ? " (counts elsewhere)" : ""}</option>)}
          </select>
          <select name="division_id" className="input" defaultValue={divisions[0]?.id ?? ""}>
            {divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <button className="btn-secondary">Count it</button>
        </form>
      </Section>
    </div>
  );
}
