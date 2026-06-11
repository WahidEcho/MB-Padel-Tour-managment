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
  const { error } = await db().from("audit_logs").insert({
    tournament_id: entry.tournament_id ?? null,
    actor_role: entry.actor_role ?? null,
    action: entry.action,
    entity_type: entry.entity_type ?? null,
    entity_id: entry.entity_id ?? null,
    old_value: entry.old_value ?? null,
    new_value: entry.new_value ?? null,
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
