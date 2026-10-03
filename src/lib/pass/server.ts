import { db } from "../supabase";
import { verifyInstallToken, type Owner } from "../mobile/identity";
import type { MAttendedMatch, MPass, MPassAttendance } from "../mobile/contract";
import { RUBBER_LABELS } from "../tennis/ties";
import type { RubberType } from "../types";
import { allocateSerial } from "./serial";

interface PassRow {
  id: string;
  event_group_id: string;
  serial: number;
  edition: "spectator" | "staff";
  staff_role: string | null;
  nation_code: string | null;
  holder_name: string | null;
  onsite_unlocked_at: string | null;
}

const PASS_COLUMNS = "id, event_group_id, serial, edition, staff_role, nation_code, holder_name, onsite_unlocked_at";

const isUniqueViolation = (e: { code?: string; message: string }) => e.code === "23505" || /duplicate|unique/i.test(e.message);

export async function loadPass(groupId: string, owner: Owner): Promise<MPass | null> {
  const { data } = await db()
    .from("event_passes")
    .select(PASS_COLUMNS)
    .eq("event_group_id", groupId)
    .eq("owner_kind", owner.kind)
    .eq("owner_id", owner.id)
    .maybeSingle();
  const p = data as PassRow | null;
  if (!p) return null;
  const [{ data: stamps }, { data: pins }, attendance] = await Promise.all([
    db().from("pass_stamps").select("day").eq("pass_id", p.id).order("day"),
    db().from("pass_pins").select("pin_code").eq("pass_id", p.id),
    loadAttendance(p.id),
  ]);
  return {
    id: p.id,
    eventGroupId: p.event_group_id,
    serial: p.serial,
    // The pass is the attendee's, whatever an older server wrote (see migration 0019).
    edition: "spectator",
    staffRole: null,
    nationCode: p.nation_code,
    holderName: p.holder_name,
    onsiteUnlockedAt: p.onsite_unlocked_at,
    stamps: ((stamps ?? []) as { day: string }[]).map((s) => s.day),
    pins: ((pins ?? []) as { pin_code: string }[]).map((s) => s.pin_code),
    attendance,
  };
}

const LIST_LIMIT = 50;

/** Matches the pass checked in to (newest first) and its points. */
async function loadAttendance(passId: string): Promise<MPassAttendance> {
  const [{ data: rows, count }, { data: points }] = await Promise.all([
    db().from("pass_attendances").select("match_id, created_at", { count: "exact" }).eq("pass_id", passId).order("created_at", { ascending: false }).limit(LIST_LIMIT),
    db().from("pass_points").select("kind, ref_id, points").eq("pass_id", passId),
  ]);
  const attended = (rows ?? []) as { match_id: string; created_at: string }[];
  const ledger = (points ?? []) as { kind: string; ref_id: string; points: number }[];
  const pointsFor = new Map(ledger.filter((r) => r.kind === "attendance").map((r) => [r.ref_id, r.points]));
  const total = ledger.reduce((n, r) => n + r.points, 0);
  if (!attended.length) return { matches: count ?? 0, points: total, list: [] };
  const { data: ms } = await db()
    .from("matches")
    .select("id, team_a_id, team_b_id, rubber_type, round_name, tie_id")
    .in("id", attended.map((a) => a.match_id));
  const matches = (ms ?? []) as { id: string; team_a_id: string | null; team_b_id: string | null; rubber_type: RubberType | null; round_name: string | null; tie_id: string | null }[];
  const teamIds = [...new Set(matches.flatMap((m) => [m.team_a_id, m.team_b_id]).filter(Boolean) as string[])];
  const tieIds = [...new Set(matches.map((m) => m.tie_id).filter(Boolean) as string[])];
  const [{ data: ts }, { data: ties }] = await Promise.all([
    teamIds.length ? db().from("teams").select("id, team_name, nation_code").in("id", teamIds) : Promise.resolve({ data: [] }),
    tieIds.length ? db().from("ties").select("id, round_name").in("id", tieIds) : Promise.resolve({ data: [] }),
  ]);
  const team = new Map(((ts ?? []) as { id: string; team_name: string; nation_code: string | null }[]).map((t) => [t.id, { name: t.team_name, code: t.nation_code }]));
  const tieRound = new Map(((ties ?? []) as { id: string; round_name: string | null }[]).map((t) => [t.id, t.round_name]));
  const byId = new Map(matches.map((m) => [m.id, m]));
  const list: MAttendedMatch[] = attended.map((a) => {
    const m = byId.get(a.match_id);
    const round = m?.tie_id ? tieRound.get(m.tie_id) : m?.round_name;
    const label = [m?.rubber_type ? RUBBER_LABELS[m.rubber_type] : null, round].filter(Boolean).join(" · ");
    return {
      matchId: a.match_id,
      checkedInAt: a.created_at,
      points: pointsFor.get(a.match_id) ?? 0,
      a: (m?.team_a_id && team.get(m.team_a_id)) || null,
      b: (m?.team_b_id && team.get(m.team_b_id)) || null,
      label: label || "Match",
    };
  });
  return { matches: count ?? list.length, points: total, list };
}

/**
 * Creates the pass on first open (serials count up per event from 1), or returns the
 * one there is. Always the attendee's pass: no staff token reaches it.
 */
export async function createPass(groupId: string, owner: Owner, fields: { holderName: string | null; nationCode: string | null }): Promise<MPass | null> {
  const existing = await loadPass(groupId, owner);
  if (existing) return existing;
  await allocateSerial({
    highest: async () => {
      const { data } = await db().from("event_passes").select("serial").eq("event_group_id", groupId).order("serial", { ascending: false }).limit(1).maybeSingle();
      return (data as { serial: number } | null)?.serial ?? 0;
    },
    insert: async (serial) => {
      const { error } = await db().from("event_passes").insert({
        event_group_id: groupId,
        owner_kind: owner.kind,
        owner_id: owner.id,
        serial,
        edition: "spectator",
        nation_code: fields.nationCode,
        holder_name: fields.holderName,
      });
      if (!error) return "ok";
      return isUniqueViolation(error) ? "taken" : "error";
    },
    ownerHasPass: async () => Boolean(await loadPass(groupId, owner)),
  });
  return loadPass(groupId, owner);
}

/**
 * On sign-in, the guest pass this phone opened becomes the account's. If the
 * account already has a pass for that event, the guest pass's stamps, pins and
 * on-site unlock are added to it and the guest pass goes. The caller must have
 * proved it holds both the installation (its signed install token) and the account.
 */
export async function mergeInstallPasses(installationId: string, userId: string): Promise<number> {
  const user: Owner = { kind: "user", id: userId };
  const { data } = await db().from("event_passes").select(PASS_COLUMNS).eq("owner_kind", "install").eq("owner_id", installationId);
  let merged = 0;
  for (const guest of (data ?? []) as PassRow[]) {
    let mine = await loadPass(guest.event_group_id, user);
    if (!mine) {
      // Moving it keeps its serial. The old owner is in the match, so a second merge can't move it twice.
      const { error } = await db()
        .from("event_passes")
        .update({ owner_kind: "user", owner_id: userId })
        .eq("id", guest.id)
        .eq("owner_kind", "install")
        .eq("owner_id", installationId);
      if (!error) {
        merged++;
        continue;
      }
      mine = await loadPass(guest.event_group_id, user);
      if (!mine) continue;
    }
    const target = mine.id;
    const [{ data: stamps }, { data: pins }, { data: attended }, { data: points }] = await Promise.all([
      db().from("pass_stamps").select("day").eq("pass_id", guest.id),
      db().from("pass_pins").select("pin_code, source").eq("pass_id", guest.id),
      db().from("pass_attendances").select("match_id, via, created_at").eq("pass_id", guest.id),
      db().from("pass_points").select("kind, ref_id, points, detail, created_at").eq("pass_id", guest.id),
    ]);
    const dayRows = ((stamps ?? []) as { day: string }[]).map((s) => ({ pass_id: target, day: s.day }));
    const pinRows = ((pins ?? []) as { pin_code: string; source: string }[]).map((p) => ({ pass_id: target, pin_code: p.pin_code, source: p.source }));
    const attendRows = ((attended ?? []) as { match_id: string; via: string; created_at: string }[]).map((a) => ({ ...a, pass_id: target }));
    // A match both passes attended keeps the account's points: the ledger's unique key skips the guest's.
    const pointRows = ((points ?? []) as { kind: string; ref_id: string; points: number; detail: unknown; created_at: string }[]).map((r) => ({ ...r, pass_id: target }));
    if (dayRows.length) await db().from("pass_stamps").upsert(dayRows, { onConflict: "pass_id,day", ignoreDuplicates: true });
    if (pinRows.length) await db().from("pass_pins").upsert(pinRows, { onConflict: "pass_id,pin_code", ignoreDuplicates: true });
    if (attendRows.length) await db().from("pass_attendances").upsert(attendRows, { onConflict: "pass_id,match_id", ignoreDuplicates: true });
    if (pointRows.length) await db().from("pass_points").upsert(pointRows, { onConflict: "pass_id,kind,ref_id", ignoreDuplicates: true });
    const patch: Record<string, string> = {};
    if (!mine.onsiteUnlockedAt && guest.onsite_unlocked_at) patch.onsite_unlocked_at = guest.onsite_unlocked_at;
    if (!mine.holderName && guest.holder_name) patch.holder_name = guest.holder_name;
    if (!mine.nationCode && guest.nation_code) patch.nation_code = guest.nation_code;
    if (Object.keys(patch).length) await db().from("event_passes").update(patch).eq("id", target);
    await db().from("event_passes").delete().eq("id", guest.id);
    merged++;
  }
  return merged;
}

/**
 * For a signed-in caller that also sends this phone's install token: merges the
 * phone's guest passes into the account first. Idempotent, so it is safe on every
 * pass read; it also covers a read that races the sign-in's own merge.
 */
export async function mergeCallersGuestPasses(request: Request, owner: Owner): Promise<void> {
  if (owner.kind !== "user") return;
  const installationId = await verifyInstallToken(request.headers.get("x-install-token"));
  if (installationId) await mergeInstallPasses(installationId, owner.id);
}

/** Pins for every nation of this event the owner follows. Cosmetic; recomputed on demand. */
export async function syncFollowPins(pass: MPass, owner: Owner): Promise<void> {
  const [{ data: follows }, { data: nations }] = await Promise.all([
    db().from("follows").select("target_key").eq("owner_kind", owner.kind).eq("owner_id", owner.id).eq("target_kind", "nation"),
    db().from("tournaments").select("id, teams(nation_code)").eq("event_group_id", pass.eventGroupId),
  ]);
  const inEvent = new Set(
    ((nations ?? []) as { teams: { nation_code: string | null }[] }[]).flatMap((t) => t.teams.map((x) => x.nation_code).filter(Boolean) as string[]),
  );
  const rows = ((follows ?? []) as { target_key: string }[])
    .map((f) => f.target_key)
    .filter((c) => inEvent.has(c))
    .map((pin_code) => ({ pass_id: pass.id, pin_code, source: "follow" }));
  if (rows.length) await db().from("pass_pins").upsert(rows, { onConflict: "pass_id,pin_code", ignoreDuplicates: true });
}
