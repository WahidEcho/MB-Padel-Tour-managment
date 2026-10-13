"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { NOT_ALLOWED, NOT_FOUND, requireStaffPermission, type StaffPrincipal } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { normalizeMobile } from "@/lib/friendly/mobile";
import { mergePlayerProfiles } from "@/lib/friendly/ops";
import { ensureOrgPlayer, orgsOfProfile, profileInOrg } from "@/lib/orgs/scope";
import { DEFAULT_FOCAL } from "@/lib/portrait";

/*
 * A player profile is the player's own (name, photo, phone, email, birth year,
 * gender); approval, notes and level are each organisation's own
 * (organization_players). An organisation changes the person's own fields only
 * while it is the only organisation that has the player, or as a platform admin:
 * otherwise one organisation could rewrite another's player.
 */

/** The staff member, once the profile is one of their organisation's players ("not found" otherwise). */
async function requireOwnProfile(profileId: string): Promise<{ staff: StaffPrincipal; onlyOrg: boolean }> {
  const staff = await requireStaffPermission("manage_players");
  if (!(await profileInOrg(staff.orgId, profileId))) throw new Error(NOT_FOUND);
  const orgs = await orgsOfProfile(profileId);
  return { staff, onlyOrg: orgs.every((o) => o === staff.orgId) };
}

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
    person: {
      email,
      birth_year: birthYear,
      gender,
      ...photoFields(formData),
    },
    org: {
      level: text("skill_level"),
      notes: text("notes"),
    },
  };
}

/**
 * Reads a PlayerPhotoField's hidden inputs. The field uploads on pick, so the
 * action only stores the resulting URL and its framing; an empty URL means the
 * photo was removed.
 */
function photoFields(formData: FormData) {
  if (!formData.has("player_photo_url")) return {};
  const url = String(formData.get("player_photo_url") ?? "").trim();
  const focal = (axis: "x" | "y", fallback: number) => {
    const raw = Number(formData.get(`player_focal_${axis}`));
    return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : fallback;
  };
  return {
    photo_url: url || null,
    focal_x: focal("x", DEFAULT_FOCAL[0]),
    focal_y: focal("y", DEFAULT_FOCAL[1]),
  };
}

/** Merging two people's profiles is Move Beyond's (platform admins only). */
export async function mergePlayersAction(formData: FormData) {
  const staff = await requireStaffPermission("manage_players");
  if (!staff.platformAdmin) throw new Error(NOT_ALLOWED);
  const survivorId = String(formData.get("survivor_id") ?? "");
  const absorbedId = String(formData.get("absorbed_id") ?? "");
  if (!survivorId || !absorbedId) throw new Error("Pick both players to merge");
  if (!(await profileInOrg(staff.orgId, survivorId)) || !(await profileInOrg(staff.orgId, absorbedId))) throw new Error(NOT_FOUND);

  await mergePlayerProfiles(survivorId, absorbedId, staff.role);
  // The survivor keeps the absorbed player's organisations.
  for (const org of await orgsOfProfile(absorbedId)) await ensureOrgPlayer(org, survivorId, "link", "approved");
  revalidatePath("/admin/players");
  revalidatePath("/admin/rankings");
}

export async function createPlayerProfile(formData: FormData) {
  const staff = await requireStaffPermission("manage_players");
  const role = staff.role;
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
      // Only name the existing player when they are already this organisation's.
      if (await profileInOrg(staff.orgId, existing.id)) {
        throw new Error(`That mobile already belongs to "${existing.public_name}". Edit that profile instead.`);
      }
      throw new Error("That mobile already belongs to a player on Move Score. Ask Move Beyond to add them to your organisation.");
    }
  }

  const details = detailFields(formData);
  const { data, error } = await db()
    .from("player_profiles")
    .insert({
      public_name: publicName,
      mobile_normalized: mobile,
      // Admin-created players are trusted immediately; only self-registrations
      // sit in the pending queue.
      approval_status: "approved",
      ...details.person,
      skill_level: details.org.level,
      notes: details.org.notes,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  await db().from("organization_players").insert({
    organization_id: staff.orgId,
    player_profile_id: data.id,
    approval_status: "approved",
    notes: details.org.notes,
    level: details.org.level,
    source: "admin",
  });

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
  const id = String(formData.get("profile_id") ?? "");
  if (!id) throw new Error("Player is required");
  const { staff, onlyOrg } = await requireOwnProfile(id);
  const role = staff.role;
  const publicName = String(formData.get("public_name") ?? "").trim();
  if (!publicName) throw new Error("Player name is required");

  const rawMobile = String(formData.get("mobile") ?? "").trim();
  const mobile = rawMobile ? normalizeMobile(rawMobile) : null;
  if (rawMobile && !mobile) {
    throw new Error("That mobile number doesn't look valid. Use digits, optionally with a + country code.");
  }
  const details = detailFields(formData);
  const now = new Date().toISOString();

  // The organisation's own part, always.
  const { error: orgError } = await db()
    .from("organization_players")
    .update({ notes: details.org.notes, level: details.org.level, updated_at: now })
    .eq("organization_id", staff.orgId)
    .eq("player_profile_id", id);
  if (orgError) throw new Error(orgError.message);

  // The person's own fields: only while no other organisation has the player.
  if (onlyOrg || staff.platformAdmin) {
    if (mobile) {
      const { data: clash } = await db()
        .from("player_profiles")
        .select("id, public_name")
        .eq("mobile_normalized", mobile)
        .neq("id", id)
        .maybeSingle();
      if (clash) {
        throw new Error((await profileInOrg(staff.orgId, clash.id)) ? `That mobile already belongs to "${clash.public_name}".` : "That mobile already belongs to another player.");
      }
    }
    const { error } = await db()
      .from("player_profiles")
      .update({
        public_name: publicName,
        mobile_normalized: mobile,
        ...details.person,
        // Mirrored for the pages that still read them from the profile.
        skill_level: details.org.level,
        notes: details.org.notes,
        updated_at: now,
      })
      .eq("id", id);
    if (error) throw new Error(error.message);
  }

  await audit({
    actor_role: role,
    action: "PLAYER_PROFILE_UPDATED",
    entity_type: "player_profile",
    entity_id: id,
    new_value: { public_name: publicName, has_mobile: Boolean(mobile), person_fields: onlyOrg || staff.platformAdmin },
  });
  revalidatePath("/admin/players");
}

export async function setPlayerApproval(formData: FormData) {
  const id = String(formData.get("profile_id") ?? "");
  const status = String(formData.get("approval_status") ?? "");
  if (!id) throw new Error("Player is required");
  if (!["pending", "approved", "rejected"].includes(status)) {
    throw new Error("Unknown approval status");
  }
  const { staff, onlyOrg } = await requireOwnProfile(id);
  const now = new Date().toISOString();

  const { error } = await db()
    .from("organization_players")
    .update({ approval_status: status, updated_at: now })
    .eq("organization_id", staff.orgId)
    .eq("player_profile_id", id);
  if (error) throw new Error(error.message);
  // The profile's own approval gates the player's photo on public pages; an
  // organisation sets it only for a player no other organisation has.
  if (onlyOrg || staff.platformAdmin) {
    await db().from("player_profiles").update({ approval_status: status, updated_at: now }).eq("id", id).neq("approval_status", "merged");
  }

  await audit({
    actor_role: staff.role,
    action: "PLAYER_APPROVAL_CHANGED",
    entity_type: "player_profile",
    entity_id: id,
    new_value: { approval_status: status },
  });
  revalidatePath("/admin/players");
}

/**
 * Record or withdraw consent for one messaging channel. Consent is the
 * player's own, so it follows the same rule as the person's fields.
 */
export async function setPlayerConsent(formData: FormData) {
  const id = String(formData.get("profile_id") ?? "");
  const channel = String(formData.get("channel") ?? "");
  const granted = formData.get("granted") === "1";
  if (!id) throw new Error("Player is required");
  if (!["whatsapp", "web_push", "email"].includes(channel)) {
    throw new Error("Unknown messaging channel");
  }
  const { staff, onlyOrg } = await requireOwnProfile(id);
  if (!onlyOrg && !staff.platformAdmin) throw new Error("This player's consent is their own; they change it in the Move Score app.");

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
    actor_role: staff.role,
    action: granted ? "PLAYER_CONSENT_GRANTED" : "PLAYER_CONSENT_REVOKED",
    entity_type: "player_profile",
    entity_id: id,
    new_value: { channel, granted },
  });
  revalidatePath("/admin/players");
}
