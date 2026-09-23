import { db } from "./supabase";

export async function audit(entry: {
  tournament_id?: string | null;
  actor_role?: string | null;
  action: string;
  entity_type?: string;
  entity_id?: string | null;
  old_value?: unknown;
  new_value?: unknown;
}) {
  // entity_id is a uuid column, but some entities are keyed by name — a screen
  // by its key ("tv-1"). Those used to fail the whole insert, so no screen
  // action was ever recorded; the key now rides in new_value instead.
  const id = entry.entity_id ?? null;
  const isUuid = id === null || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const newValue = isUuid
    ? (entry.new_value ?? null)
    : { entity_key: id, ...(entry.new_value && typeof entry.new_value === "object" ? entry.new_value : { value: entry.new_value ?? null }) };
  const { error } = await db().from("audit_logs").insert({
    tournament_id: entry.tournament_id ?? null,
    actor_role: entry.actor_role ?? null,
    action: entry.action,
    entity_type: entry.entity_type ?? null,
    entity_id: isUuid ? id : null,
    old_value: entry.old_value ?? null,
    new_value: newValue,
  });
  // Audit failures must never break the operation itself
  if (error) console.error("audit log failed", error.message);
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "tournament"
  );
}
