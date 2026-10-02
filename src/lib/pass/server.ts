import { db } from "../supabase";
import { verifyInstallToken, type Owner } from "../mobile/identity";
import type { MPass } from "../mobile/contract";
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

/**
 * A spectator pass becomes the accreditation once the phone shows a valid staff
 * token. Never the other way: an expired staff token leaves the pass as it is.
 */
async function upgradeToStaff(pass: MPass, staffRole: string | null): Promise<MPass> {
  if (!staffRole || pass.edition !== "spectator") return pass;
  const { error } = await db().from("event_passes").update({ edition: "staff", staff_role: staffRole }).eq("id", pass.id).eq("edition", "spectator");
  return error ? pass : { ...pass, edition: "staff", staffRole };
}

/** Creates the pass on first open (serials count up per event from 1), or returns the one there is. */
export async function createPass(
  groupId: string,
  owner: Owner,
  fields: { holderName: string | null; nationCode: string | null; staffRole: string | null },
): Promise<MPass | null> {
  const existing = await loadPass(groupId, owner);
  if (existing) return upgradeToStaff(existing, fields.staffRole);
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
        edition: fields.staffRole ? "staff" : "spectator",
        staff_role: fields.staffRole,
        nation_code: fields.nationCode,
        holder_name: fields.holderName,
      });
      if (!error) return "ok";
      return isUniqueViolation(error) ? "taken" : "error";
    },
    ownerHasPass: async () => Boolean(await loadPass(groupId, owner)),
  });
  const pass = await loadPass(groupId, owner);
  return pass ? upgradeToStaff(pass, fields.staffRole) : null;
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
    const [{ data: stamps }, { data: pins }] = await Promise.all([
      db().from("pass_stamps").select("day").eq("pass_id", guest.id),
      db().from("pass_pins").select("pin_code, source").eq("pass_id", guest.id),
    ]);
    const dayRows = ((stamps ?? []) as { day: string }[]).map((s) => ({ pass_id: target, day: s.day }));
    const pinRows = ((pins ?? []) as { pin_code: string; source: string }[]).map((p) => ({ pass_id: target, pin_code: p.pin_code, source: p.source }));
    if (dayRows.length) await db().from("pass_stamps").upsert(dayRows, { onConflict: "pass_id,day", ignoreDuplicates: true });
    if (pinRows.length) await db().from("pass_pins").upsert(pinRows, { onConflict: "pass_id,pin_code", ignoreDuplicates: true });
    const patch: Record<string, string> = {};
    if (!mine.onsiteUnlockedAt && guest.onsite_unlocked_at) patch.onsite_unlocked_at = guest.onsite_unlocked_at;
    if (mine.edition === "spectator" && guest.edition === "staff") {
      patch.edition = "staff";
      if (guest.staff_role) patch.staff_role = guest.staff_role;
    }
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
