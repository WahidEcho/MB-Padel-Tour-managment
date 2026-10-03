"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { refuse, tournamentRowRefusal } from "@/lib/rowGuards";
import { fillMissingCodes, resetPlayerCode } from "@/lib/players/claims";
import { toE164 } from "@/lib/players/phone";
import { formatAccessCode } from "@/lib/players/accessCode";
import { pickContact } from "@/lib/messaging/audience";
import { appLink } from "@/lib/messaging/links";
import { sendTransactional } from "@/lib/messaging/queue";

const path = (id: string) => `/admin/tournaments/${id}/players`;

/** The player, if it belongs to this tournament: a form cannot reach another tournament's player. */
async function playerIn(tournamentId: string, playerId: string): Promise<{ id: string; full_name: string } | null> {
  const { data } = await db().from("players").select("id, full_name").eq("id", playerId).eq("tournament_id", tournamentId).maybeSingle();
  return (data as { id: string; full_name: string } | null) ?? null;
}

/** A new code; the old one stops working and the account it linked lets go. */
export async function resetCode(formData: FormData) {
  const role = await requirePermission("manage_players");
  const id = String(formData.get("tournament_id"));
  refuse(await tournamentRowRefusal(id));
  const player = await playerIn(id, String(formData.get("player_id")));
  if (!player) throw new Error("That player is not in this tournament.");
  await resetPlayerCode(player.id);
  await audit({ tournament_id: id, actor_role: role, action: "PLAYER_CODE_RESET", entity_type: "player", entity_id: player.id });
  revalidatePath(path(id));
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The player's own phone and email, which the share links use. */
export async function savePlayerContact(formData: FormData) {
  const role = await requirePermission("manage_players");
  const id = String(formData.get("tournament_id"));
  refuse(await tournamentRowRefusal(id));
  const player = await playerIn(id, String(formData.get("player_id")));
  if (!player) throw new Error("That player is not in this tournament.");
  const rawPhone = String(formData.get("phone") ?? "").trim();
  const rawEmail = String(formData.get("email") ?? "").trim().toLowerCase();
  const phone = rawPhone ? toE164(rawPhone) : null;
  if (rawPhone && !phone) throw new Error(`${player.full_name}: "${rawPhone}" is not a phone number. Use 01… for Egypt or +country code.`);
  if (rawEmail && (!EMAIL.test(rawEmail) || rawEmail.length > 254)) throw new Error(`${player.full_name}: "${rawEmail}" is not an email address.`);
  const { error } = await db()
    .from("players")
    .update({ phone, email: rawEmail || null, updated_at: new Date().toISOString() })
    .eq("id", player.id);
  if (error) throw new Error(error.message);
  await audit({ tournament_id: id, actor_role: role, action: "PLAYER_CONTACT_UPDATED", entity_type: "player", entity_id: player.id, new_value: { phone: Boolean(phone), email: Boolean(rawEmail) } });
  revalidatePath(path(id));
}

export interface SendCodeState {
  ok: boolean;
  message: string;
}

/**
 * Sends the player their code now, by email or WhatsApp, through the messaging
 * service (logged and tracked in message_deliveries like every other message).
 * Contact: the player's own, else their profile's, else (WhatsApp) the team's.
 */
export async function sendCode(_prev: SendCodeState | null, formData: FormData): Promise<SendCodeState> {
  const role = await requirePermission("send_messages");
  const id = String(formData.get("tournament_id"));
  refuse(await tournamentRowRefusal(id));
  const channel = formData.get("channel") === "whatsapp" ? "whatsapp" : "email";
  const { data } = await db()
    .from("players")
    .select("id, full_name, access_code, phone, email, player_profile_id, team_id")
    .eq("id", String(formData.get("player_id")))
    .eq("tournament_id", id)
    .maybeSingle();
  const p = data as { id: string; full_name: string; access_code: string | null; phone: string | null; email: string | null; player_profile_id: string | null; team_id: string } | null;
  if (!p) return { ok: false, message: "That player is not in this tournament." };
  if (!p.access_code) return { ok: false, message: "No code yet: make one first." };
  const [{ data: prof }, { data: team }, { data: t }] = await Promise.all([
    p.player_profile_id ? db().from("player_profiles").select("mobile_normalized, email").eq("id", p.player_profile_id).maybeSingle() : Promise.resolve({ data: null }),
    db().from("teams").select("phone").eq("id", p.team_id).maybeSingle(),
    db().from("tournaments").select("name").eq("id", id).maybeSingle(),
  ]);
  const c = pickContact(p, (prof as { mobile_normalized: string | null; email: string | null } | null) ?? undefined, (team as { phone: string | null } | null)?.phone);
  const to = channel === "email" ? c.email : c.phone;
  if (!to) return { ok: false, message: channel === "email" ? "No email address: add one below." : "No phone number: add one below." };
  const code = formatAccessCode(p.access_code);
  const r = await sendTransactional({
    to: to.value,
    channel,
    template: "access_code",
    vars: { name: p.full_name, code, tournament: (t as { name: string } | null)?.name ?? null, app_link: appLink() },
    // A double click within the same minute sends once.
    idempotencyKey: `player-code:${p.id}:${channel}:${p.access_code}:${new Date().toISOString().slice(0, 16)}`,
    recipient: { kind: "player", id: p.id, name: p.full_name },
  });
  await audit({ tournament_id: id, actor_role: role, action: "PLAYER_CODE_SENT", entity_type: "player", entity_id: p.id, new_value: { channel, ok: r.ok, source: to.source } });
  revalidatePath(path(id));
  const via = `${channel === "email" ? "email" : "WhatsApp"}${to.source === "team" ? " (team contact)" : to.source === "profile" ? " (profile)" : ""}`;
  return r.ok ? { ok: true, message: `Sent by ${via}.` } : { ok: false, message: `Not sent by ${via}: ${r.error ?? r.status}` };
}

/** Codes for any player without one. */
export async function fillCodes(formData: FormData) {
  const role = await requirePermission("manage_players");
  const id = String(formData.get("tournament_id"));
  refuse(await tournamentRowRefusal(id));
  const made = await fillMissingCodes(id);
  await audit({ tournament_id: id, actor_role: role, action: "PLAYER_CODES_FILLED", entity_type: "tournament", entity_id: id, new_value: { count: made } });
  revalidatePath(path(id));
}
