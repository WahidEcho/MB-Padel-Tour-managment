/**
 * Checking in to a match with its code (src/lib/pass/venueCode.ts): records that
 * the pass attended it, once, and books the points (src/lib/pass/attendance.ts).
 * Being at a match is being on site, so the check-in also does what the venue
 * code does: unlocks the on-site edition and stamps the event day.
 */
import { db } from "../supabase";
import type { Owner } from "../mobile/identity";
import type { MCheckInRefusal, MCheckInReply } from "../mobile/contract";
import { attendancePoints, checkInWindow, isDecidingRubber, isFinal } from "./attendance";
import { checkMatchCode, eventDay, isEventDay } from "./venueCode";
import { createPass, loadPass } from "./server";

export type CheckInOutcome = { ok: true; reply: MCheckInReply } | { ok: false; status: number; code: MCheckInRefusal; error: string; opensAt?: string | null };

const refuse = (status: number, code: MCheckInRefusal, error: string, extra: { opensAt?: string | null } = {}): CheckInOutcome => ({ ok: false, status, code, error, ...extra });

const isUniqueViolation = (e: { code?: string; message: string }) => e.code === "23505" || /duplicate|unique/i.test(e.message);

interface MatchRow {
  id: string;
  tournament_id: string;
  status: string;
  scheduled_time: string | null;
  ended_at: string | null;
  round_name: string | null;
  tie_id: string | null;
  team_a_id: string | null;
  team_b_id: string | null;
}

export async function checkInToMatch(owner: Owner, matchId: string, code: { c?: string | null; p?: string | null }, nowMs = Date.now()): Promise<CheckInOutcome> {
  if (!/^[0-9a-f-]{36}$/i.test(matchId)) return refuse(404, "not_found", "That code is not for a match in Move Score.");
  const verdict = checkMatchCode(matchId, code, nowMs);
  if (!verdict.ok) {
    return verdict.reason === "code_expired"
      ? refuse(410, "code_expired", "That code has changed. Scan the screen at the court again.")
      : refuse(400, "bad_code", "That code is not for a match in Move Score.");
  }
  const { data: m } = await db()
    .from("matches")
    .select("id, tournament_id, status, scheduled_time, ended_at, round_name, tie_id, team_a_id, team_b_id")
    .eq("id", matchId)
    .maybeSingle();
  const match = m as MatchRow | null;
  if (!match) return refuse(404, "not_found", "That match is not in Move Score any more.");
  const { data: t } = await db().from("tournaments").select("id, event_group_id, public_access_enabled").eq("id", match.tournament_id).maybeSingle();
  const tournament = t as { id: string; event_group_id: string | null; public_access_enabled: boolean | null } | null;
  if (!tournament || tournament.public_access_enabled === false) return refuse(404, "not_found", "That match is not in Move Score any more.");
  if (!tournament.event_group_id) return refuse(409, "no_event", "This match has no event pass to collect it on.");
  const { data: g } = await db().from("event_groups").select("id, timezone, starts_on, ends_on").eq("id", tournament.event_group_id).maybeSingle();
  const group = g as { id: string; timezone: string | null; starts_on: string | null; ends_on: string | null } | null;
  if (!group) return refuse(409, "no_event", "This match has no event pass to collect it on.");

  const pass = (await loadPass(group.id, owner)) ?? (await createPass(group.id, owner, { holderName: null, nationCode: null }));
  if (!pass) return refuse(500, "failed", "Could not open your pass. Try again.");

  // Already there: say so, whatever the time (a fan who scans again on the way out).
  const { data: seen } = await db().from("pass_attendances").select("match_id").eq("pass_id", pass.id).eq("match_id", matchId).maybeSingle();
  if (seen) return { ok: true, reply: { status: "already_checked_in", matchId, points: 0, parts: [], stampedDay: null, pass: (await loadPass(group.id, owner)) ?? pass } };

  // A tie's own time is the "not before" the referee works to; a rubber rarely has its own.
  type TieRow = { scheduled_time: string | null; places_from: number | null; places_to: number | null; round_name: string | null };
  let tie: TieRow | null = null;
  let rubbers: { id: string; winner: "A" | "B" | null }[] = [];
  if (match.tie_id) {
    const [{ data: tr }, { data: rs }] = await Promise.all([
      db().from("ties").select("scheduled_time, places_from, places_to, round_name").eq("id", match.tie_id).maybeSingle(),
      db().from("matches").select("id, team_a_id, winner_team_id, status").eq("tie_id", match.tie_id),
    ]);
    tie = tr as TieRow | null;
    rubbers = ((rs ?? []) as { id: string; team_a_id: string | null; winner_team_id: string | null; status: string }[])
      .filter((r) => r.status !== "cancelled")
      .map((r) => ({ id: r.id, winner: r.winner_team_id ? (r.winner_team_id === r.team_a_id ? "A" : "B") : null }));
  }
  const window = checkInWindow({ status: match.status, scheduledAt: match.scheduled_time ?? tie?.scheduled_time ?? null, endedAt: match.ended_at }, nowMs);
  if (window.state === "too_early") {
    return refuse(409, "too_early", "Too early: check-in opens when the match is about to start.", { opensAt: window.opensAt });
  }
  if (window.state === "closed") return refuse(409, "closed", "Check-in for this match has closed.");

  const score = attendancePoints({
    final: isFinal({ placesFrom: tie?.places_from, placesTo: tie?.places_to, roundName: tie?.round_name ?? match.round_name }),
    deciding: match.tie_id ? isDecidingRubber(matchId, rubbers) : false,
  });
  const { error } = await db().from("pass_attendances").insert({ pass_id: pass.id, match_id: matchId, via: verdict.via });
  if (error) {
    // Two scans of the same frame at once: the first one counted.
    if (isUniqueViolation(error)) return { ok: true, reply: { status: "already_checked_in", matchId, points: 0, parts: [], stampedDay: null, pass: (await loadPass(group.id, owner)) ?? pass } };
    return refuse(500, "failed", "Could not check you in. Try again.");
  }
  await db()
    .from("pass_points")
    .upsert({ pass_id: pass.id, kind: "attendance", ref_id: matchId, points: score.points, detail: { parts: score.parts, via: verdict.via } }, { onConflict: "pass_id,kind,ref_id", ignoreDuplicates: true });

  const timeZone = group.timezone || "Africa/Cairo";
  const day = eventDay(timeZone, nowMs);
  let stampedDay: string | null = null;
  if (isEventDay(day, group.starts_on, group.ends_on) && !pass.stamps.includes(day)) {
    await db().from("pass_stamps").upsert({ pass_id: pass.id, day }, { onConflict: "pass_id,day", ignoreDuplicates: true });
    stampedDay = day;
  }
  if (!pass.onsiteUnlockedAt) await db().from("event_passes").update({ onsite_unlocked_at: new Date(nowMs).toISOString() }).eq("id", pass.id);
  return { ok: true, reply: { status: "checked_in", matchId, points: score.points, parts: score.parts, stampedDay, pass: (await loadPass(group.id, owner)) ?? pass } };
}
