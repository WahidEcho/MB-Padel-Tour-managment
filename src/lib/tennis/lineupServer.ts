/**
 * Line-ups on match day, server side (Junior Finals 2026, owner's decisions):
 *
 * - who may enter them: the organiser's staff, a master referee for its events, and
 *   the court referee of the tie's court (court code + PIN). Nobody else (no
 *   whole-event referee code, no shared referee password, no operator).
 * - the court referee's picker (web console and app): the tie, both squads in order
 *   of merit, what is named now and which step it is on (singles before the tie,
 *   the doubles pair after the singles).
 * - applying both sides at once (picker, Excel sheet): every side checked first
 *   (problems refuse, warnings need accepting, a change after the lock needs a
 *   reason), then written through setLineup; the singles lock once both nations
 *   have named theirs.
 * - an accepted exception (order of merit, Reg 43; a retired player named again,
 *   Reg 50) is audited with the person's name and told at once to the master
 *   referees on duty (push, the referee push path of migration 0035) and to the
 *   organiser (the live banner, from these audit rows; and the admin log).
 *
 * Pure rules: lineupRules.ts. Player columns are listed explicitly: no phone, email
 * or code ever reaches a referee's phone.
 */
import { db } from "../supabase";
import { audit } from "../audit";
import { sendExpo, type ExpoMessage } from "../notify/drain";
import type { StaffPrincipal } from "../auth/staff";
import { isCourtReferee, isMasterReferee, isOrganiser } from "../referees/assistance";
import { mastersOnDuty } from "../referees/server";
import type { Match, RubberType, Tie } from "../types";
import { RUBBER_LABELS } from "./ties";
import { exceptionLine, lineupStep, rubberEditable, type LineupIssue, type LineupPickerModel, type PickerSide } from "./lineupRules";
import { lineupOfRubbers, lockLineups, setLineup, tieContext, type Lineup, type LineupRefusalCode } from "./tieOps";

export type LineupActorKind = "organiser" | "master" | "court";

export interface LineupActor {
  kind: LineupActorKind;
  /** How the notification names them: "Referee Sara", "Master referee Omar", "The tournament desk". */
  label: string;
}

/** Who may enter line-ups: null for anyone else (the routes answer 403). */
export function lineupActor(staff: StaffPrincipal): LineupActor | null {
  if (isOrganiser(staff)) return { kind: "organiser", label: "The tournament desk" };
  if (isMasterReferee(staff)) return { kind: "master", label: `Master referee ${staff.referee!.name}` };
  if (isCourtReferee(staff)) return { kind: "court", label: `Referee ${staff.referee!.name}` };
  return null;
}

export const EXCEPTION_ACTION = "LINEUP_EXCEPTION_ACCEPTED";

/* ---------------- the picker ---------------- */

export type { PickerSide, LineupPickerModel as LineupPicker } from "./lineupRules";

interface TieBundle {
  tie: Tie;
  tournamentName: string;
  court: string | null;
  rubbers: Match[];
  sides: Record<"A" | "B", PickerSide>;
}

async function tieBundle(tieId: string, tournamentId: string): Promise<TieBundle | null> {
  const { data: tieRow } = await db().from("ties").select("*").eq("id", tieId).eq("tournament_id", tournamentId).maybeSingle();
  const tie = tieRow as Tie | null;
  if (!tie || !tie.team_a_id || !tie.team_b_id) return null;
  const [{ data: t }, { data: court }, { data: rubbers }, { data: teams }, { data: players }] = await Promise.all([
    db().from("tournaments").select("name").eq("id", tournamentId).maybeSingle(),
    tie.court_id ? db().from("courts").select("court_name").eq("id", tie.court_id).maybeSingle() : Promise.resolve({ data: null }),
    db().from("matches").select("id, rubber_type, rubber_no, status, winner_team_id, team_a_player_ids, team_b_player_ids").eq("tie_id", tie.id).order("rubber_no"),
    db().from("teams").select("id, team_name, nation_code, iso2").in("id", [tie.team_a_id, tie.team_b_id]),
    db().from("players").select("id, team_id, full_name, player_order").in("team_id", [tie.team_a_id, tie.team_b_id]).order("player_order"),
  ]);
  const rs = (rubbers ?? []) as Match[];
  const side = (s: "A" | "B"): PickerSide => {
    const id = s === "A" ? tie.team_a_id! : tie.team_b_id!;
    const team = ((teams ?? []) as { id: string; team_name: string; nation_code: string | null; iso2: string | null }[]).find((x) => x.id === id);
    const ctx = tieContext(rs, tie, s);
    return {
      teamId: id,
      nation: team?.team_name ?? "?",
      code: team?.nation_code ?? null,
      iso2: team?.iso2 ?? null,
      squad: ((players ?? []) as { id: string; team_id: string; full_name: string }[]).filter((p) => p.team_id === id).map((p) => ({ id: p.id, name: p.full_name })),
      lineup: lineupOfRubbers(rs, s),
      retired: ctx.retired,
      open: ctx.open,
    };
  };
  return { tie, tournamentName: (t as { name: string } | null)?.name ?? "", court: (court as { court_name: string } | null)?.court_name ?? null, rubbers: rs, sides: { A: side("A"), B: side("B") } };
}

/** The court referee's line-up screen for the tie a rubber belongs to; null when the match is not a rubber. */
export async function lineupPicker(matchId: string, actor: LineupActor): Promise<LineupPickerModel | null> {
  const { data: m } = await db().from("matches").select("id, tie_id, tournament_id").eq("id", matchId).maybeSingle();
  const match = m as { id: string; tie_id: string | null; tournament_id: string } | null;
  if (!match?.tie_id) return null;
  const b = await tieBundle(match.tie_id, match.tournament_id);
  if (!b) return null;
  return {
    matchId,
    tie: { id: b.tie.id, tournamentId: b.tie.tournament_id, tournamentName: b.tournamentName, round: b.tie.round_name, court: b.court, locked: Boolean(b.tie.lineup_locked_at), status: b.tie.status },
    rubbers: b.rubbers.map((r) => ({ id: r.id, type: r.rubber_type as RubberType, label: RUBBER_LABELS[r.rubber_type as RubberType], status: r.status, editable: rubberEditable(r.status) })),
    sides: b.sides,
    step: lineupStep(b.rubbers.map((r) => ({ type: r.rubber_type as RubberType, status: r.status })), { A: b.sides.A.lineup, B: b.sides.B.lineup }),
    actor: actor.kind,
  };
}

/** The tie a match is a rubber of (for the routes that take a match id). */
export async function tieOfMatch(matchId: string): Promise<{ tieId: string; tournamentId: string } | null> {
  const { data } = await db().from("matches").select("tie_id, tournament_id").eq("id", matchId).maybeSingle();
  const m = data as { tie_id: string | null; tournament_id: string } | null;
  return m?.tie_id ? { tieId: m.tie_id, tournamentId: m.tournament_id } : null;
}

/* ---------------- applying ---------------- */

export interface SideIssue extends LineupIssue {
  side: "A" | "B";
}

export type ApplyResult =
  | { ok: true; changed: boolean; locked: boolean; accepted: SideIssue[]; alerted: number; late: boolean }
  | { ok: false; code: LineupRefusalCode; message: string; problems: SideIssue[]; warnings: SideIssue[] };

/**
 * Both sides of one tie at once: checked first (nothing is written if either side is
 * refused), then saved. `accept` names the warnings the person accepted (`A:<key>`);
 * `lock`: lock the singles once both nations have named theirs.
 */
export async function applyTieLineups(input: {
  actor: LineupActor;
  actorRole: string;
  tournamentId: string;
  tieId: string;
  lineups: Partial<Record<"A" | "B", Lineup>>;
  accept?: readonly string[];
  reason?: string | null;
  via: "court" | "desk" | "sheet";
  lock?: boolean;
  /** Check only: answer as a save would, write nothing. */
  check?: boolean;
}): Promise<ApplyResult> {
  const sides = (["A", "B"] as const).filter((s) => input.lineups[s]);
  const opts = { lateChangeReason: input.reason ?? undefined, accept: input.accept ?? [], via: input.via };
  const dry = await Promise.all(sides.map(async (s) => ({ s, r: await setLineup(input.tournamentId, input.tieId, s, input.lineups[s]!, input.actorRole, { ...opts, dryRun: true }) })));
  const refused = dry.filter((d) => !d.r.ok);
  if (refused.length) {
    const tag = (s: "A" | "B", list: LineupIssue[] | undefined): SideIssue[] => (list ?? []).map((i) => ({ ...i, side: s, key: `${s}:${i.key}` }));
    const first = refused.find((d) => !d.r.ok && d.r.code !== "warnings") ?? refused[0]!;
    const r = first.r as Extract<Awaited<ReturnType<typeof setLineup>>, { ok: false }>;
    return {
      ok: false,
      code: r.code,
      message: refused.map((d) => (d.r.ok ? "" : d.r.message)).filter(Boolean).join(" "),
      problems: refused.flatMap((d) => (d.r.ok ? [] : tag(d.s, d.r.problems))),
      warnings: refused.flatMap((d) => (d.r.ok ? [] : tag(d.s, d.r.warnings))),
    };
  }
  if (input.check) {
    const ok = dry.map((d) => d.r).filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
    return {
      ok: true,
      changed: ok.some((r) => r.changed.length > 0),
      locked: false,
      accepted: dry.flatMap((d) => (d.r.ok ? d.r.accepted.map((i) => ({ ...i, side: d.s })) : [])),
      alerted: 0,
      late: ok.some((r) => r.lateChange),
    };
  }
  const accepted: SideIssue[] = [];
  let changed = false;
  let late = false;
  for (const s of sides) {
    const r = await setLineup(input.tournamentId, input.tieId, s, input.lineups[s]!, input.actorRole, opts);
    if (!r.ok) {
      // Changed between the check and the write (another desk): say so, the rest stands.
      return { ok: false, code: r.code, message: r.message, problems: (r.problems ?? []).map((i) => ({ ...i, side: s })), warnings: (r.warnings ?? []).map((i) => ({ ...i, side: s })) };
    }
    changed ||= r.changed.length > 0;
    late ||= r.lateChange;
    accepted.push(...r.accepted.map((i) => ({ ...i, side: s })));
  }
  const b = await tieBundle(input.tieId, input.tournamentId);
  let locked = Boolean(b?.tie.lineup_locked_at);
  if (b && input.lock && !locked && (["A", "B"] as const).every((s) => b.sides[s].lineup.S1 && b.sides[s].lineup.S2)) {
    const l = await lockLineups(input.tournamentId, input.tieId, input.actorRole);
    locked = l.ok;
  }
  const alerted = accepted.length && b ? await recordException(input.actor, input.actorRole, b, accepted) : 0;
  return { ok: true, changed, locked, accepted, alerted, late };
}

/** The words the master referees and the organiser read. */
export function exceptionText(actor: Pick<LineupActor, "label">, court: string | null, issues: Pick<LineupIssue, "summary" | "message" | "reg">[]): string {
  return `${actor.label} accepted a line-up exception${court ? ` on ${court}` : ""}: ${issues.map(exceptionLine).join("; ")}`;
}

/** Audits an accepted exception (one row per tie) and alerts the master referees on duty. Returns the phones alerted. */
async function recordException(actor: LineupActor, actorRole: string, b: TieBundle, issues: SideIssue[]): Promise<number> {
  const text = exceptionText(actor, b.court, issues);
  const { data: t } = await db().from("tournaments").select("organization_id, event_group_id").eq("id", b.tie.tournament_id).maybeSingle();
  const tour = t as { organization_id: string; event_group_id: string | null } | null;
  let alerted = 0;
  if (tour) {
    const duty = await mastersOnDuty(tour.organization_id, { eventGroupId: tour.event_group_id, tournamentId: b.tie.tournament_id });
    if (duty.installationIds.length) {
      const { data } = await db()
        .from("push_devices")
        .select("id, expo_push_token")
        .in("installation_id", duty.installationIds.slice(0, 200))
        .is("disabled_at", null)
        .not("expo_push_token", "is", null);
      const messages: ExpoMessage[] = ((data ?? []) as { expo_push_token: string }[]).map((d) => ({
        to: d.expo_push_token,
        title: "Line-up exception",
        body: text,
        data: { url: "movescore://referee/master", kind: "lineup_exception", tieId: b.tie.id },
        sound: "default",
        channelId: "assistance",
        priority: "high",
        ttl: 1800,
      }));
      if (messages.length) {
        try {
          alerted = (await sendExpo(messages)).filter((x) => x.status === "ok").length;
        } catch (err) {
          console.error("[lineups] exception push failed", (err as Error).message);
        }
      }
    }
  }
  await audit({
    tournament_id: b.tie.tournament_id,
    actor_role: actorRole,
    action: EXCEPTION_ACTION,
    entity_type: "tie",
    entity_id: b.tie.id,
    new_value: {
      text,
      court: b.court,
      tie: `${b.sides.A.code ?? b.sides.A.nation} v ${b.sides.B.code ?? b.sides.B.nation}`,
      by: actor.label,
      actor: actor.kind,
      issues: issues.map((i) => ({ side: i.side, nation: b.sides[i.side].nation, code: i.code, reg: i.reg, message: i.message, summary: i.summary ?? null })),
      alerted,
    },
  });
  return alerted;
}

/* ---------------- the live banner ---------------- */

export interface LineupNotice {
  id: string;
  at: string;
  tournamentId: string | null;
  text: string;
  court: string | null;
  regs: string[];
}

/**
 * Accepted exceptions of the last 12 hours, newest first, for the master referees'
 * and the organiser's live banner: the organiser sees the organisation's, a master
 * referee its events'. Empty for everyone else.
 */
export async function lineupNotices(staff: StaffPrincipal, nowMs = Date.now()): Promise<LineupNotice[]> {
  const master = isMasterReferee(staff);
  if (!master && !isOrganiser(staff)) return [];
  if (master && !staff.scopeTournamentIds?.length) return [];
  let q = db()
    .from("audit_logs")
    .select("id, created_at, tournament_id, new_value")
    .eq("organization_id", staff.orgId)
    .eq("action", EXCEPTION_ACTION)
    .gte("created_at", new Date(nowMs - 12 * 3600_000).toISOString());
  if (master) q = q.in("tournament_id", staff.scopeTournamentIds!);
  const { data } = await q.order("created_at", { ascending: false }).limit(30);
  return ((data ?? []) as { id: string; created_at: string; tournament_id: string | null; new_value: { text?: string; court?: string | null; issues?: { reg?: string | null }[] } | null }[]).map((r) => ({
    id: r.id,
    at: r.created_at,
    tournamentId: r.tournament_id,
    text: String(r.new_value?.text ?? "A line-up exception was accepted."),
    court: r.new_value?.court ?? null,
    regs: [...new Set((r.new_value?.issues ?? []).map((i) => i.reg).filter((x): x is string => Boolean(x)))],
  }));
}

/** The body a picker or sheet sends for one side, cleaned: ids as strings or null. */
export function lineupFromBody(v: unknown): Lineup | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const id = (x: unknown) => (typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x) ? x : null);
  const d = Array.isArray(o.D) ? o.D.slice(0, 2).map(id) : [null, null];
  return { S1: id(o.S1), S2: id(o.S2), D: d.length === 2 ? d : [d[0] ?? null, null] };
}

/** The accepted warning keys a body sends (bounded). */
export function acceptedKeys(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length <= 200).slice(0, 20) : [];
}

export { tieBundle };
