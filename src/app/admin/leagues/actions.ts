"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireScopedPermission, requireStaffPermission, requireTournamentPermission, NOT_FOUND } from "@/lib/guard";
import { profileInOrg } from "@/lib/orgs/scope";
import { tournamentRowRefusal, refuse } from "@/lib/rowGuards";
import { isUuid } from "@/lib/orgs/roles";
import { leaguePointsRules, storedLeaguePointsRules } from "@/lib/leagues/points";
import { JOIN_MODES, normalizeJoinModes } from "@/lib/leagues/join";
import {
  isLeagueKind,
  isLeagueStatus,
  leaguePeriods,
  nightTemplate,
  storedLeagueFee,
  storedLeaguePeriods,
  storedNightTemplate,
  isIsoDate,
} from "@/lib/leagues/settings";
import { SPORTS } from "@/lib/sports/registry";
import {
  addDivision,
  addMember,
  clearInviteCode,
  createLeague,
  createNight,
  decideMember,
  deleteDivision,
  deleteNight,
  generateSeasonFixtures,
  renameDivision,
  resetInviteCode,
  setCountsToward,
  setFixtureDate,
  setMemberDivision,
  setMemberPartner,
  updateLeague,
  type MemberDecision,
} from "@/lib/leagues/ops";
import { recomputeLeague } from "@/lib/leagues/server";

const page = (id: string) => `/admin/leagues/${id}`;
const text = (v: FormDataEntryValue | null, max: number) => String(v ?? "").trim().slice(0, max);
const num = (v: FormDataEntryValue | null) => {
  const s = String(v ?? "").trim();
  return s === "" ? undefined : Number(s);
};
const TIME_ZONES = new Set(["Africa/Cairo", "Asia/Dubai", "Asia/Riyadh", "Europe/London", "Europe/Paris", "UTC"]);
const sportOk = (s: string) => Object.keys(SPORTS).includes(s);

/** A new league in the caller's own organisation, with one division. */
export async function createLeagueAction(formData: FormData) {
  const staff = await requireStaffPermission("manage_leagues");
  const name = text(formData.get("name"), 120);
  const kind = String(formData.get("kind") ?? "nights");
  const sport = String(formData.get("sport") ?? "padel");
  if (!name) throw new Error("Give the league a name.");
  if (!isLeagueKind(kind)) throw new Error("Pick nights or a season.");
  const league = await createLeague({
    organizationId: staff.orgId,
    name,
    kind,
    sport: sportOk(sport) ? sport : "padel",
    createdBy: staff.userId ?? null,
    actorRole: staff.role,
  });
  revalidatePath("/admin/leagues");
  redirect(page(league.id));
}

export async function saveLeagueSettings(formData: FormData) {
  const leagueId = String(formData.get("league_id") ?? "");
  const { staff } = await requireScopedPermission("manage_leagues", { league: leagueId });
  const name = text(formData.get("name"), 120);
  if (!name) throw new Error("Give the league a name.");
  const status = String(formData.get("status") ?? "");
  if (!isLeagueStatus(status)) throw new Error("Pick a status.");
  const sport = String(formData.get("sport") ?? "padel");
  const tz = String(formData.get("timezone") ?? "Africa/Cairo");
  const modes = normalizeJoinModes(formData.getAll("join_modes").map(String).filter((m) => (JOIN_MODES as readonly string[]).includes(m)));
  const currency = text(formData.get("currency"), 3).toUpperCase() || "EGP";
  const fee = storedLeagueFee({
    membership: (num(formData.get("fee_membership")) ?? 0) > 0 ? { amount: Math.round(num(formData.get("fee_membership"))!), currency } : null,
    perNight: (num(formData.get("fee_per_night")) ?? 0) > 0 ? { amount: Math.round(num(formData.get("fee_per_night"))!), currency } : null,
  });
  await updateLeague(
    leagueId,
    {
      name,
      about: text(formData.get("about"), 4000) || null,
      status,
      sport: sportOk(sport) ? sport : "padel",
      timezone: TIME_ZONES.has(tz) ? tz : "Africa/Cairo",
      join_modes: modes.length ? modes : ["open"],
      fee,
      counts_toward_top_of_all: formData.get("counts_toward_top_of_all") === "on",
    },
    staff.role,
  );
  revalidatePath(page(leagueId));
}

export async function savePointsRules(formData: FormData) {
  const leagueId = String(formData.get("league_id") ?? "");
  const { staff } = await requireScopedPermission("manage_leagues", { league: leagueId });
  const rules = leaguePointsRules({
    win: num(formData.get("win")),
    draw: num(formData.get("draw")),
    loss: num(formData.get("loss")),
    walkover_win: num(formData.get("walkover_win")),
    walkover_loss: num(formData.get("walkover_loss")),
    streak: { on: formData.get("streak_on") === "on", bonus: num(formData.get("streak_bonus")), from: num(formData.get("streak_from")), to: num(formData.get("streak_to")) },
  });
  await updateLeague(leagueId, { points_rules: storedLeaguePointsRules(rules) }, staff.role);
  revalidatePath(page(leagueId));
}

export async function savePeriods(formData: FormData) {
  const leagueId = String(formData.get("league_id") ?? "");
  const { staff } = await requireScopedPermission("manage_leagues", { league: leagueId });
  const periods = leaguePeriods({ boards: formData.getAll("boards").map(Number), year_start_month: num(formData.get("year_start_month")) });
  await updateLeague(leagueId, { periods: storedLeaguePeriods(periods) }, staff.role);
  revalidatePath(page(leagueId));
}

export async function saveNightTemplate(formData: FormData) {
  const leagueId = String(formData.get("league_id") ?? "");
  const { staff } = await requireScopedPermission("manage_leagues", { league: leagueId });
  const tpl = nightTemplate({
    start_time: String(formData.get("start_time") ?? ""),
    duration_minutes: num(formData.get("duration_minutes")),
    courts: num(formData.get("courts")),
    pairing_mode: String(formData.get("pairing_mode") ?? ""),
    ranking_model: String(formData.get("ranking_model") ?? ""),
    sets_to_win_match: num(formData.get("sets_to_win_match")),
    games_to_win_set: num(formData.get("games_to_win_set")),
    max_players: num(formData.get("max_players")) ?? null,
    scoring_mode: String(formData.get("scoring_mode") ?? ""),
  });
  await updateLeague(leagueId, { night_template: storedNightTemplate(tpl) }, staff.role);
  revalidatePath(page(leagueId));
}

export type InviteCodeState = { ok: true; code: string } | { ok: false; message: string } | null;

/** A new invite code, shown once here; only its hash is kept. Setting one replaces the old. */
export async function setInviteCodeAction(_prev: InviteCodeState, formData: FormData): Promise<InviteCodeState> {
  const leagueId = String(formData.get("league_id") ?? "");
  const { staff } = await requireScopedPermission("manage_leagues", { league: leagueId });
  try {
    const code = await resetInviteCode(leagueId, staff.role);
    revalidatePath(page(leagueId));
    return { ok: true, code };
  } catch (err) {
    console.error("league invite code:", (err as Error).message);
    return { ok: false, message: "Could not set a code. Try again." };
  }
}

export async function clearInviteCodeAction(formData: FormData) {
  const leagueId = String(formData.get("league_id") ?? "");
  const { staff } = await requireScopedPermission("manage_leagues", { league: leagueId });
  await clearInviteCode(leagueId, staff.role);
  revalidatePath(page(leagueId));
}

export async function addDivisionAction(formData: FormData) {
  const leagueId = String(formData.get("league_id") ?? "");
  const { staff } = await requireScopedPermission("manage_leagues", { league: leagueId });
  await addDivision(leagueId, text(formData.get("name"), 80), staff.role);
  revalidatePath(page(leagueId));
}

export async function renameDivisionAction(formData: FormData) {
  const divisionId = String(formData.get("division_id") ?? "");
  const { staff } = await requireScopedPermission("manage_leagues", { division: divisionId });
  await renameDivision(divisionId, text(formData.get("name"), 80), staff.role);
  revalidatePath("/admin/leagues", "layout");
}

export async function deleteDivisionAction(formData: FormData) {
  const divisionId = String(formData.get("division_id") ?? "");
  const { staff } = await requireScopedPermission("manage_leagues", { division: divisionId });
  await deleteDivision(divisionId, staff.role);
  revalidatePath("/admin/leagues", "layout");
}

export async function decideMemberAction(formData: FormData) {
  const memberId = String(formData.get("member_id") ?? "");
  const { staff } = await requireScopedPermission("manage_leagues", { leagueMember: memberId });
  const decision = String(formData.get("decision") ?? "");
  if (!["approve", "remove", "restore", "paid"].includes(decision)) throw new Error("Pick approve, remove, restore or paid.");
  await decideMember(memberId, decision as MemberDecision, { role: staff.role, userId: staff.userId ?? null });
  revalidatePath("/admin/leagues", "layout");
}

/** Moves a member to another division of the same league. */
export async function setMemberDivisionAction(formData: FormData) {
  const memberId = String(formData.get("member_id") ?? "");
  const { staff, scope } = await requireScopedPermission("manage_leagues", { leagueMember: memberId });
  const divisionId = String(formData.get("division_id") ?? "") || null;
  if (divisionId) {
    const target = await requireScopedPermission("manage_leagues", { division: divisionId });
    if (target.scope.orgId !== scope.orgId) throw new Error(NOT_FOUND);
  }
  // The database refuses a division of another league (trigger league_rows_same_org).
  await setMemberDivision(memberId, divisionId, staff.role);
  revalidatePath("/admin/leagues", "layout");
}

/** A partner for season fixtures played as pairs: one of the organisation's players. */
export async function setMemberPartnerAction(formData: FormData) {
  const memberId = String(formData.get("member_id") ?? "");
  const { staff } = await requireScopedPermission("manage_leagues", { leagueMember: memberId });
  const partnerId = String(formData.get("partner_profile_id") ?? "") || null;
  if (partnerId && !(await profileInOrg(staff.orgId, partnerId))) throw new Error(NOT_FOUND);
  await setMemberPartner(memberId, partnerId, staff.role);
  revalidatePath("/admin/leagues", "layout");
}

/** Adds one of the organisation's players to the league (active at once). */
export async function addMemberAction(formData: FormData) {
  const leagueId = String(formData.get("league_id") ?? "");
  const { staff } = await requireScopedPermission("manage_leagues", { league: leagueId });
  const profileId = String(formData.get("profile_id") ?? "");
  if (!(await profileInOrg(staff.orgId, profileId))) throw new Error(NOT_FOUND);
  const divisionId = String(formData.get("division_id") ?? "") || null;
  if (divisionId) await requireScopedPermission("manage_leagues", { division: divisionId });
  await addMember(leagueId, profileId, divisionId, staff.role);
  revalidatePath(page(leagueId));
}

/** A night from the league's template, on a date, in a division. */
export async function createNightAction(formData: FormData) {
  const divisionId = String(formData.get("division_id") ?? "");
  const { staff } = await requireScopedPermission("manage_leagues", { division: divisionId });
  const date = String(formData.get("date") ?? "");
  if (!isIsoDate(date)) throw new Error("Pick the night's date.");
  await createNight(divisionId, date, staff.role);
  revalidatePath("/admin/leagues", "layout");
}

export async function deleteNightAction(formData: FormData) {
  const fixtureId = String(formData.get("fixture_id") ?? "");
  const { staff } = await requireScopedPermission("manage_leagues", { fixture: fixtureId });
  await deleteNight(fixtureId, staff.role);
  revalidatePath("/admin/leagues", "layout");
}

export async function setFixtureDateAction(formData: FormData) {
  const fixtureId = String(formData.get("fixture_id") ?? "");
  const { staff } = await requireScopedPermission("manage_leagues", { fixture: fixtureId });
  const date = String(formData.get("date") ?? "");
  if (!isIsoDate(date)) throw new Error("Pick a date.");
  await setFixtureDate(fixtureId, date, staff.role);
  revalidatePath("/admin/leagues", "layout");
}

/** Generates (or regenerates the unplayed part of) a season division's fixtures. Dates: one per line or comma-separated. */
export async function generateFixturesAction(formData: FormData) {
  const divisionId = String(formData.get("division_id") ?? "");
  const { staff } = await requireScopedPermission("manage_leagues", { division: divisionId });
  const dates = String(formData.get("dates") ?? "")
    .split(/[\s,;]+/)
    .map((d) => d.trim())
    .filter(isIsoDate)
    .slice(0, 200);
  await generateSeasonFixtures(divisionId, dates, staff.role);
  revalidatePath("/admin/leagues", "layout");
}

/**
 * A tournament of this organisation counts toward one division (or none). Both
 * rows are checked: the tournament's organisation and the division's must both be
 * the caller's (and the database refuses a mismatch too).
 */
export async function setCountsTowardAction(formData: FormData) {
  const tournamentId = String(formData.get("tournament_id") ?? "");
  const { staff, scope } = await requireTournamentPermission("manage_leagues", tournamentId);
  refuse(await tournamentRowRefusal(tournamentId));
  const divisionId = String(formData.get("division_id") ?? "") || null;
  if (divisionId) {
    const target = await requireScopedPermission("manage_leagues", { division: divisionId });
    if (target.scope.orgId !== scope.orgId) throw new Error(NOT_FOUND);
  }
  await setCountsToward(tournamentId, divisionId, staff.role);
  revalidatePath("/admin/leagues", "layout");
}

export async function recalculateLeagueAction(formData: FormData) {
  const leagueId = String(formData.get("league_id") ?? "");
  await requireScopedPermission("manage_leagues", { league: leagueId });
  if (!isUuid(leagueId)) throw new Error(NOT_FOUND);
  await recomputeLeague(leagueId);
  revalidatePath(page(leagueId));
}
