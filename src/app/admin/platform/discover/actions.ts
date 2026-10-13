"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { DEFAULT_FLAGS } from "@/lib/mobile/server";
import { DISCOVER_ORDER_KEY, MAX_DISCOVER_ITEMS } from "@/lib/platform/discoverOrder";

const PATH = "/admin/platform/discover";
const FLAG_NAME = /^[a-z][a-z0-9_]{1,39}$/;

async function saveSetting(key: string, value: unknown, role: string) {
  const { error } = await db()
    .from("platform_settings")
    .upsert({ key, value_json: value, updated_at: new Date().toISOString(), updated_by: role }, { onConflict: "key" });
  if (error) throw new Error(error.message);
}

/**
 * The hero's order: event groups and stand-alone tournaments, by the position
 * typed next to each (blank = after the ordered ones). Only ids that exist are
 * kept, whatever the form posts. A group's "Featured" box is its featured_rank,
 * kept in step with the order so older app builds see the same thing.
 */
export async function saveDiscoverOrder(formData: FormData) {
  const role = await requirePermission("manage_platform");
  const [groupsRes, tournamentsRes] = await Promise.all([
    db().from("event_groups").select("id"),
    db().from("tournaments").select("id").eq("kind", "tournament").is("event_group_id", null),
  ]);
  const groupIds = new Set(((groupsRes.data ?? []) as { id: string }[]).map((g) => g.id));
  const known = new Set([...groupIds, ...((tournamentsRes.data ?? []) as { id: string }[]).map((t) => t.id)]);
  const posted = formData.getAll("item").map(String).filter((id) => known.has(id)).slice(0, MAX_DISCOVER_ITEMS);
  const placed = posted
    .map((id, i) => ({ id, i, pos: parseInt(String(formData.get(`pos.${id}`) ?? ""), 10) }))
    .filter((x) => Number.isFinite(x.pos) && x.pos >= 0)
    .sort((a, b) => a.pos - b.pos || a.i - b.i);
  const order = [...new Set(placed.map((x) => x.id))];
  const featured = new Set(formData.getAll("featured").map(String).filter((id) => groupIds.has(id)));

  await saveSetting(DISCOVER_ORDER_KEY, order, role);
  // featured_rank follows the order: featured groups first by their place, then any featured group left unplaced.
  const featuredInOrder = [...order.filter((id) => featured.has(id)), ...[...featured].filter((id) => !order.includes(id))];
  for (const id of groupIds) {
    const rank = featuredInOrder.indexOf(id);
    await db().from("event_groups").update({ featured_rank: rank === -1 ? null : rank + 1, updated_at: new Date().toISOString() }).eq("id", id);
  }
  await audit({ actor_role: role, action: "DISCOVER_ORDER_EDITED", entity_type: "platform_settings", new_value: { order, featured: featuredInOrder } });
  revalidatePath(PATH);
}

/** The app's feature switches. Every known flag is saved as on or off; a new one may be added by name. */
export async function saveFlags(formData: FormData) {
  const role = await requirePermission("manage_platform");
  const { data } = await db().from("platform_settings").select("value_json").eq("key", "flags").maybeSingle();
  const stored = ((data as { value_json: Record<string, unknown> } | null)?.value_json ?? {}) as Record<string, unknown>;
  const names = new Set([...Object.keys(DEFAULT_FLAGS), ...Object.keys(stored)].filter((k) => FLAG_NAME.test(k)));
  const added = String(formData.get("new_flag") ?? "").trim().toLowerCase();
  if (added) {
    if (!FLAG_NAME.test(added)) throw new Error("A flag name is 2–40 lowercase letters, digits or underscores.");
    names.add(added);
  }
  const flags: Record<string, boolean> = {};
  for (const k of [...names].sort()) flags[k] = formData.get(`flag.${k}`) === "on" || (k === added && formData.get("new_flag_on") === "on");
  await saveSetting("flags", flags, role);
  await audit({ actor_role: role, action: "APP_FLAGS_EDITED", entity_type: "platform_settings", old_value: stored, new_value: flags });
  revalidatePath(PATH);
}
