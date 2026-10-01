import { db } from "../supabase";
import type { Owner } from "../mobile/identity";
import type { MPass } from "../mobile/contract";

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

export async function loadPass(groupId: string, owner: Owner): Promise<MPass | null> {
  const { data } = await db()
    .from("event_passes")
    .select("id, event_group_id, serial, edition, staff_role, nation_code, holder_name, onsite_unlocked_at")
    .eq("event_group_id", groupId)
    .eq("owner_kind", owner.kind)
    .eq("owner_id", owner.id)
    .maybeSingle();
  const p = data as PassRow | null;
  if (!p) return null;
  const [{ data: stamps }, { data: pins }] = await Promise.all([
    db().from("pass_stamps").select("day").eq("pass_id", p.id).order("day"),
    db().from("pass_pins").select("pin_code").eq("pass_id", p.id),
  ]);
  return {
    id: p.id,
    eventGroupId: p.event_group_id,
    serial: p.serial,
    edition: p.edition,
    staffRole: p.staff_role,
    nationCode: p.nation_code,
    holderName: p.holder_name,
    onsiteUnlockedAt: p.onsite_unlocked_at,
    stamps: ((stamps ?? []) as { day: string }[]).map((s) => s.day),
    pins: ((pins ?? []) as { pin_code: string }[]).map((s) => s.pin_code),
  };
}

/** Creates the pass on first open. Serials count up per event from 1. */
export async function createPass(
  groupId: string,
  owner: Owner,
  fields: { holderName: string | null; nationCode: string | null; staffRole: string | null },
): Promise<MPass | null> {
  const existing = await loadPass(groupId, owner);
  if (existing) return existing;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { count } = await db().from("event_passes").select("id", { count: "exact", head: true }).eq("event_group_id", groupId);
    const { error } = await db().from("event_passes").insert({
      event_group_id: groupId,
      owner_kind: owner.kind,
      owner_id: owner.id,
      serial: (count ?? 0) + 1 + attempt,
      edition: fields.staffRole ? "staff" : "spectator",
      staff_role: fields.staffRole,
      nation_code: fields.nationCode,
      holder_name: fields.holderName,
    });
    if (!error) break;
    if (!/duplicate|unique/i.test(error.message)) return null;
    const again = await loadPass(groupId, owner);
    if (again) return again;
  }
  return loadPass(groupId, owner);
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
