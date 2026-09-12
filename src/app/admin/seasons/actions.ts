"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePermission } from "@/lib/guard";
import { audit } from "@/lib/audit";

/** Only one season may be active at a time (enforced in the DB too). */
async function closeOtherActiveSeasons(exceptId: string | null) {
  let q = db().from("seasons").update({ status: "closed", updated_at: new Date().toISOString() }).eq("status", "active");
  if (exceptId) q = q.neq("id", exceptId);
  await q;
}

export async function createSeason(formData: FormData) {
  const role = await requirePermission("manage_seasons");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Season name is required");

  const startsOn = String(formData.get("starts_on") ?? "").trim() || null;
  const endsOn = String(formData.get("ends_on") ?? "").trim() || null;
  if (startsOn && endsOn && endsOn < startsOn) {
    throw new Error("End date cannot be before the start date");
  }
  const makeActive = formData.get("make_active") === "on";

  if (makeActive) await closeOtherActiveSeasons(null);

  const { data, error } = await db()
    .from("seasons")
    .insert({
      name,
      starts_on: startsOn,
      ends_on: endsOn,
      status: makeActive ? "active" : "upcoming",
    })
    .select()
    .single();
  if (error) throw new Error(error.message);

  await audit({
    actor_role: role,
    action: "SEASON_CREATED",
    entity_type: "season",
    entity_id: data.id,
    new_value: { name, status: data.status },
  });
  revalidatePath("/admin/seasons");
}

export async function updateSeason(formData: FormData) {
  const role = await requirePermission("manage_seasons");
  const id = String(formData.get("season_id") ?? "");
  if (!id) throw new Error("Season is required");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Season name is required");

  const startsOn = String(formData.get("starts_on") ?? "").trim() || null;
  const endsOn = String(formData.get("ends_on") ?? "").trim() || null;
  if (startsOn && endsOn && endsOn < startsOn) {
    throw new Error("End date cannot be before the start date");
  }

  const { error } = await db()
    .from("seasons")
    .update({ name, starts_on: startsOn, ends_on: endsOn, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);

  await audit({
    actor_role: role,
    action: "SEASON_UPDATED",
    entity_type: "season",
    entity_id: id,
    new_value: { name, starts_on: startsOn, ends_on: endsOn },
  });
  revalidatePath("/admin/seasons");
}

export async function setSeasonStatus(formData: FormData) {
  const role = await requirePermission("manage_seasons");
  const id = String(formData.get("season_id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id) throw new Error("Season is required");
  if (!["upcoming", "active", "closed"].includes(status)) {
    throw new Error("Unknown season status");
  }

  // Activating a season closes whichever one was active.
  if (status === "active") await closeOtherActiveSeasons(id);

  const { error } = await db()
    .from("seasons")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);

  await audit({
    actor_role: role,
    action: "SEASON_STATUS_CHANGED",
    entity_type: "season",
    entity_id: id,
    new_value: { status },
  });
  revalidatePath("/admin/seasons");
}

export async function deleteSeason(formData: FormData) {
  const role = await requirePermission("manage_seasons");
  const id = String(formData.get("season_id") ?? "");
  if (!id) throw new Error("Season is required");

  // A season with sessions attached is history — refuse rather than orphan it.
  const { count } = await db()
    .from("friendly_sessions")
    .select("id", { count: "exact", head: true })
    .eq("season_id", id);
  if ((count ?? 0) > 0) {
    throw new Error(
      `This season has ${count} session(s) attached. Close it instead of deleting it.`
    );
  }

  const { error } = await db().from("seasons").delete().eq("id", id);
  if (error) throw new Error(error.message);

  await audit({
    actor_role: role,
    action: "SEASON_DELETED",
    entity_type: "season",
    entity_id: id,
  });
  revalidatePath("/admin/seasons");
}
