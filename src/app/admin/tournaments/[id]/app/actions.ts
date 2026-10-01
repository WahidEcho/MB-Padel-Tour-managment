"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { notifyAnnouncement } from "@/lib/notify/hooks";
import { hashClaimCode, newClaimCode } from "@/lib/pass/claim";
import { refuse, tournamentRowRefusal } from "@/lib/rowGuards";

const HEX = /^#[0-9a-fA-F]{6}$/;
const path = (id: string) => `/admin/tournaments/${id}/app`;
const text = (f: FormData, k: string, max = 120) => String(f.get(k) ?? "").trim().slice(0, max) || null;

/** Where and when, the event group, and the look inside the app. */
export async function saveAppSettings(formData: FormData) {
  const role = await requirePermission("manage_tournament");
  const id = String(formData.get("tournament_id"));
  // A friendly session's hidden row has no app settings of its own.
  refuse(await tournamentRowRefusal(id));
  let groupId = text(formData, "event_group_id", 40);
  const newGroup = text(formData, "new_group_name", 80);
  if (newGroup) {
    const slug = newGroup.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 50) || `event-${Date.now()}`;
    const { data } = await db()
      .from("event_groups")
      .upsert({ slug, name: newGroup }, { onConflict: "slug" })
      .select("id")
      .single();
    groupId = (data as { id: string } | null)?.id ?? groupId;
  }
  const seedA = text(formData, "seed_a", 7);
  const seedB = text(formData, "seed_b", 7);
  const mode = text(formData, "skin_mode", 5);
  const tz = text(formData, "timezone", 60) ?? "Africa/Cairo";
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    throw new Error("Unknown time zone. Use a name like Africa/Cairo.");
  }
  const patch = {
    event_group_id: groupId,
    venue_name: text(formData, "venue_name"),
    city: text(formData, "city", 60),
    country_code: text(formData, "country_code", 2)?.toUpperCase() ?? null,
    timezone: tz,
    starts_on: text(formData, "starts_on", 10),
    ends_on: text(formData, "ends_on", 10),
    app_skin: {
      seedA: seedA && HEX.test(seedA) ? seedA : null,
      seedB: seedB && HEX.test(seedB) ? seedB : null,
      mode: mode === "light" || mode === "dark" ? mode : null,
      artworkUrl: text(formData, "artwork_url", 500),
      showPhotos: formData.get("show_photos") === "on",
    },
    updated_at: new Date().toISOString(),
  };
  const { error } = await db().from("tournaments").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
  await audit({ tournament_id: id, actor_role: role, action: "APP_SETTINGS_EDITED", entity_type: "tournament", entity_id: id, new_value: patch });
  revalidatePath(path(id));
}

/** Featured on Discover (lower first), plus the group's own details. */
export async function saveEventGroup(formData: FormData) {
  const role = await requirePermission("manage_tournament");
  const id = String(formData.get("tournament_id"));
  // A friendly session's hidden row has no app settings of its own.
  refuse(await tournamentRowRefusal(id));
  const groupId = String(formData.get("group_id"));
  const rank = String(formData.get("featured_rank") ?? "").trim();
  const patch = {
    name: text(formData, "name", 80) ?? "Event",
    subtitle: text(formData, "subtitle", 120),
    venue_name: text(formData, "venue_name"),
    city: text(formData, "city", 60),
    country_code: text(formData, "country_code", 2)?.toUpperCase() ?? null,
    timezone: text(formData, "timezone", 60) ?? "Africa/Cairo",
    starts_on: text(formData, "starts_on", 10),
    ends_on: text(formData, "ends_on", 10),
    artwork_url: text(formData, "artwork_url", 500),
    featured_rank: rank === "" ? null : Math.max(0, Math.min(99, parseInt(rank, 10) || 0)),
    updated_at: new Date().toISOString(),
  };
  await db().from("event_groups").update(patch).eq("id", groupId);
  await audit({ tournament_id: id, actor_role: role, action: "EVENT_GROUP_EDITED", entity_type: "event_group", entity_id: groupId, new_value: patch });
  revalidatePath(path(id));
}

export async function postAnnouncement(formData: FormData) {
  const role = await requirePermission("manage_tournament");
  const id = String(formData.get("tournament_id"));
  // A friendly session's hidden row has no app settings of its own.
  refuse(await tournamentRowRefusal(id));
  const title = text(formData, "title", 120);
  if (!title) throw new Error("An announcement needs a title");
  const level = formData.get("level") === "major" ? "major" : "info";
  const scope = formData.get("scope") === "group" ? "group" : "tournament";
  const { data: t } = await db().from("tournaments").select("event_group_id").eq("id", id).single();
  const groupId = (t as { event_group_id: string | null } | null)?.event_group_id ?? null;
  const { data, error } = await db()
    .from("announcements")
    .insert({
      tournament_id: scope === "tournament" ? id : null,
      event_group_id: scope === "group" ? groupId : null,
      title,
      body: text(formData, "body", 600),
      level,
      created_by_role: role,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  await audit({ tournament_id: id, actor_role: role, action: "ANNOUNCEMENT_POSTED", entity_type: "announcement", entity_id: (data as { id: string }).id, new_value: { title, level } });
  if (level === "major") await notifyAnnouncement((data as { id: string }).id);
  revalidatePath(path(id));
}

export async function deleteAnnouncement(formData: FormData) {
  await requirePermission("manage_tournament");
  const id = String(formData.get("tournament_id"));
  // A friendly session's hidden row has no app settings of its own.
  refuse(await tournamentRowRefusal(id));
  await db().from("announcements").delete().eq("id", String(formData.get("announcement_id")));
  revalidatePath(path(id));
}

/** One-time player codes, shown once. Only their hashes are stored. */
export async function makeClaimCodes(formData: FormData): Promise<void> {
  const role = await requirePermission("manage_players");
  const id = String(formData.get("tournament_id"));
  // A friendly session's hidden row has no app settings of its own.
  refuse(await tournamentRowRefusal(id));
  const { data } = await db().from("players").select("id").eq("tournament_id", id);
  const players = (data ?? []) as { id: string }[];
  const rows: { player_id: string; code_hash: string; created_by_role: string }[] = [];
  const shown: { player_id: string; code: string }[] = [];
  for (const p of players) {
    const code = newClaimCode();
    rows.push({ player_id: p.id, code_hash: hashClaimCode(code), created_by_role: role });
    shown.push({ player_id: p.id, code });
  }
  await db().from("player_claim_codes").update({ revoked_at: new Date().toISOString() }).in("player_id", players.map((p) => p.id)).is("used_at", null);
  if (rows.length) await db().from("player_claim_codes").insert(rows);
  await audit({ tournament_id: id, actor_role: role, action: "PLAYER_CODES_ISSUED", entity_type: "tournament", entity_id: id, new_value: { count: rows.length } });
  // Shown on the next render only: kept in a short-lived row the page reads and deletes.
  await db().from("platform_settings").upsert({ key: `claim-codes:${id}`, value_json: { at: Date.now(), codes: shown } }, { onConflict: "key" });
  revalidatePath(path(id));
}
