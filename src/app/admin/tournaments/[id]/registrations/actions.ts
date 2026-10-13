"use server";

import { revalidatePath } from "next/cache";
import { requireScopedPermission, requireTournamentPermission, type StaffPrincipal } from "@/lib/guard";
import { refuse, tournamentOrSessionRefusal } from "@/lib/rowGuards";
import { zonedToIso } from "@/lib/tennis/ties";
import { minorFromMajor, registrationSettings } from "@/lib/registration/rules";
import { decide, eventById, markVenuePaid, pairRegistrations, refund, saveSettings } from "@/lib/registration/server";

/**
 * Registrations (Phase 9) for a tournament or a friendly session's hidden row:
 * both take registrations, so every action uses the session-aware refusal
 * (any real tournament or session row, nothing else). The organisation is always
 * resolved from the row itself: the event for the settings, the registration for
 * everything done to one (src/lib/guard.ts). Refunds need refund_registrations
 * (admins with their own account) and are audited.
 */

const path = (id: string) => `/admin/tournaments/${id}/registrations`;
const actorOf = (staff: StaffPrincipal) => ({
  role: staff.role,
  label: staff.userId ? `user:${staff.userId}` : staff.codeId ? `code:${staff.codeId}` : `shared:${staff.role}`,
});
const text = (v: FormDataEntryValue | null, max: number) => String(v ?? "").trim().slice(0, max);

export async function saveRegistrationSettings(formData: FormData) {
  const id = String(formData.get("tournament_id") ?? "");
  const { staff } = await requireTournamentPermission("manage_registrations", id);
  refuse(await tournamentOrSessionRefusal(id));
  const event = await eventById(id);
  if (!event) throw new Error("Not found");
  const fee = minorFromMajor(text(formData.get("fee"), 12));
  if (fee === null) throw new Error("Enter the fee in pounds, like 250 or 250.50.");
  const closes = text(formData.get("closes_at"), 20);
  const closesAt = closes ? zonedToIso(closes, event.timezone ?? "Africa/Cairo") : null;
  if (closes && !closesAt) throw new Error("Pick a valid closing time.");
  const settings = registrationSettings({
    open: formData.get("open") === "on",
    entryType: text(formData.get("entry_type"), 20),
    teamSize: text(formData.get("team_size"), 2),
    approvalMode: text(formData.get("approval_mode"), 20),
    feeAmount: fee,
    payment: text(formData.get("payment"), 20),
    teamPayer: text(formData.get("team_payer"), 20),
    refundFeePercent: Number(text(formData.get("refund_fee_percent"), 6) || 0),
    capacity: text(formData.get("capacity"), 6),
    closesAt,
    note: text(formData.get("note"), 1000),
  });
  await saveSettings(event, settings, actorOf(staff));
  revalidatePath(path(id));
}

export async function decideRegistrationAction(formData: FormData) {
  const regId = String(formData.get("registration_id") ?? "");
  const { staff, scope } = await requireScopedPermission("manage_registrations", { registration: regId });
  refuse(await tournamentOrSessionRefusal(scope.tournamentId ?? ""));
  const decision = String(formData.get("decision") ?? "");
  if (decision !== "approve" && decision !== "refuse") throw new Error("Pick approve or refuse.");
  await decide(regId, decision, text(formData.get("note"), 500) || null, actorOf(staff));
  revalidatePath(path(scope.tournamentId!));
}

export async function markVenuePaidAction(formData: FormData) {
  const regId = String(formData.get("registration_id") ?? "");
  const { staff, scope } = await requireScopedPermission("manage_registrations", { registration: regId });
  refuse(await tournamentOrSessionRefusal(scope.tournamentId ?? ""));
  await markVenuePaid(regId, actorOf(staff));
  revalidatePath(path(scope.tournamentId!));
}

/** Refunds the online payment through Move Tick (until 24 h before the start). Needs a typed confirmation. */
export async function refundRegistrationAction(formData: FormData) {
  const regId = String(formData.get("registration_id") ?? "");
  const { staff, scope } = await requireScopedPermission("refund_registrations", { registration: regId });
  refuse(await tournamentOrSessionRefusal(scope.tournamentId ?? ""));
  if (text(formData.get("confirm"), 10).toUpperCase() !== "REFUND") throw new Error('Type REFUND to confirm.');
  await refund(regId, actorOf(staff), text(formData.get("reason"), 200) || null);
  revalidatePath(path(scope.tournamentId!));
}

/** Two confirmed individual entries of a padel tournament become one team. */
export async function pairRegistrationsAction(formData: FormData) {
  const id = String(formData.get("tournament_id") ?? "");
  await requireTournamentPermission("manage_registrations", id);
  refuse(await tournamentOrSessionRefusal(id));
  const ids = formData.getAll("registration_ids").map(String).slice(0, 3);
  if (ids.length !== 2) throw new Error("Pick exactly two players to pair.");
  const { staff, scope } = await requireScopedPermission("manage_registrations", { registration: ids[0]! });
  const second = await requireScopedPermission("manage_registrations", { registration: ids[1]! });
  if (scope.tournamentId !== id || second.scope.tournamentId !== id) throw new Error("Not found");
  await pairRegistrations([ids[0]!, ids[1]!], id, actorOf(staff));
  revalidatePath(path(id));
}
