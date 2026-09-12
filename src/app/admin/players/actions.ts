"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { normalizeMobile } from "@/lib/friendly/mobile";
import { mergePlayerProfiles } from "@/lib/friendly/ops";

/**
 * Optional player details, shared by create and update.
 * Empty inputs become null rather than empty strings so "not recorded" and
 * "recorded as blank" don't end up looking the same in the directory.
 */
function detailFields(formData: FormData) {
  const text = (key: string) => String(formData.get(key) ?? "").trim() || null;

  const birthRaw = String(formData.get("birth_year") ?? "").trim();
  const birthYear = birthRaw ? parseInt(birthRaw, 10) : null;
  if (birthYear !== null && (!Number.isFinite(birthYear) || birthYear < 1900 || birthYear > 2100)) {
    throw new Error("Birth year must be a four-digit year, e.g. 1994.");
  }

  const email = text("email");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("That email address doesn't look valid.");
  }

  const gender = text("gender");
  if (gender && !["male", "female", "other"].includes(gender)) {
    throw new Error("Unknown gender value");
  }

  return {
    email,
    birth_year: birthYear,
    skill_level: text("skill_level"),
    gender,
    notes: text("notes"),
  };
}

export async function mergePlayersAction(formData: FormData) {
  const role = await requirePermission("manage_players");
  const survivorId = String(formData.get("survivor_id") ?? "");
  const absorbedId = String(formData.get("absorbed_id") ?? "");
  if (!survivorId || !absorbedId) throw new Error("Pick both players to merge");

  await mergePlayerProfiles(survivorId, absorbedId, role);
  revalidatePath("/admin/players");
  revalidatePath("/admin/rankings");
}

export async function createPlayerProfile(formData: FormData) {
  const role = await requirePermission("manage_players");
  const publicName = String(formData.get("public_name") ?? "").trim();
  if (!publicName) throw new Error("Player name is required");

  const rawMobile = String(formData.get("mobile") ?? "").trim();
  const mobile = rawMobile ? normalizeMobile(rawMobile) : null;
  if (rawMobile && !mobile) {
    throw new Error("That mobile number doesn't look valid. Use digits, optionally with a + country code.");
  }

  if (mobile) {
    const { data: existing } = await db()
      .from("player_profiles")
      .select("id, public_name")
      .eq("mobile_normalized", mobile)
      .maybeSingle();
    if (existing) {
      throw new Error(`That mobile already belongs to "${existing.public_name}". Edit that profile instead.`);
    }
  }

  const { data, error } = await db()
    .from("player_profiles")
    .insert({
      public_name: publicName,
      mobile_normalized: mobile,
      // Admin-created players are trusted immediately; only self-registrations
      // sit in the pending queue.
      approval_status: "approved",
      ...detailFields(formData),
    })
    .select()
    .single();
  if (error) throw new Error(error.message);

  await audit({
    actor_role: role,
    action: "PLAYER_PROFILE_CREATED",
    entity_type: "player_profile",
    entity_id: data.id,
    new_value: { public_name: publicName, has_mobile: Boolean(mobile) },
  });
  revalidatePath("/admin/players");
}

export async function updatePlayerProfile(formData: FormData) {
  const role = await requirePermission("manage_players");
  const id = String(formData.get("profile_id") ?? "");
  if (!id) throw new Error("Player is required");
  const publicName = String(formData.get("public_name") ?? "").trim();
  if (!publicName) throw new Error("Player name is required");

  const rawMobile = String(formData.get("mobile") ?? "").trim();
  const mobile = rawMobile ? normalizeMobile(rawMobile) : null;
  if (rawMobile && !mobile) {
    throw new Error("That mobile number doesn't look valid. Use digits, optionally with a + country code.");
  }

  if (mobile) {
    const { data: clash } = await db()
      .from("player_profiles")
      .select("id, public_name")
      .eq("mobile_normalized", mobile)
      .neq("id", id)
      .maybeSingle();
    if (clash) {
      throw new Error(`That mobile already belongs to "${clash.public_name}".`);
    }
  }

  const { error } = await db()
    .from("player_profiles")
    .update({
      public_name: publicName,
      mobile_normalized: mobile,
      ...detailFields(formData),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new Error(error.message);

  await audit({
    actor_role: role,
    action: "PLAYER_PROFILE_UPDATED",
    entity_type: "player_profile",
    entity_id: id,
    new_value: { public_name: publicName, has_mobile: Boolean(mobile) },
  });
  revalidatePath("/admin/players");
}

export async function setPlayerApproval(formData: FormData) {
  const role = await requirePermission("manage_players");
  const id = String(formData.get("profile_id") ?? "");
  const status = String(formData.get("approval_status") ?? "");
  if (!id) throw new Error("Player is required");
  if (!["pending", "approved", "rejected"].includes(status)) {
    throw new Error("Unknown approval status");
  }

  const { error } = await db()
    .from("player_profiles")
    .update({ approval_status: status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);

  await audit({
    actor_role: role,
    action: "PLAYER_APPROVAL_CHANGED",
    entity_type: "player_profile",
    entity_id: id,
    new_value: { approval_status: status },
  });
  revalidatePath("/admin/players");
}

/**
 * Record or withdraw consent for one messaging channel.
 * Nothing sends messages yet — this exists so consent is captured from the
 * start rather than retrofitted across an existing player base (PDPL).
 */
export async function setPlayerConsent(formData: FormData) {
  const role = await requirePermission("manage_players");
  const id = String(formData.get("profile_id") ?? "");
  const channel = String(formData.get("channel") ?? "");
  const granted = formData.get("granted") === "1";
  if (!id) throw new Error("Player is required");
  if (!["whatsapp", "web_push", "email"].includes(channel)) {
    throw new Error("Unknown messaging channel");
  }

  const now = new Date().toISOString();
  const { error } = await db().from("player_consents").upsert(
    {
      player_profile_id: id,
      channel,
      granted,
      granted_at: granted ? now : null,
      revoked_at: granted ? null : now,
      source: "admin",
      updated_at: now,
    },
    { onConflict: "player_profile_id,channel" }
  );
  if (error) throw new Error(error.message);

  await audit({
    actor_role: role,
    action: granted ? "PLAYER_CONSENT_GRANTED" : "PLAYER_CONSENT_REVOKED",
    entity_type: "player_profile",
    entity_id: id,
    new_value: { channel, granted },
  });
  revalidatePath("/admin/players");
}
