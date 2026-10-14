"use server";

import { revalidatePath } from "next/cache";
import { requireScopedPermission, requireTournamentPermission, type StaffPrincipal } from "@/lib/guard";
import { refuse, tournamentOrSessionRefusal } from "@/lib/rowGuards";
import { zonedToIso } from "@/lib/tennis/ties";
import { minorFromMajor, registrationSettings } from "@/lib/registration/rules";
import { decide, eventById, markVenuePaid, pairRegistrations, refund, saveSettings } from "@/lib/registration/server";
import { formResult, refusal, type FormState } from "@/lib/refusal";

/**
 * Registrations (Phase 9) for a tournament or a friendly session's hidden row:
 * both take registrations, so every action uses the session-aware refusal
 * (any real tournament or session row, nothing else). The organisation is always
 * resolved from the row itself: the event for the settings, the registration for
 * everything done to one (src/lib/guard.ts). Refunds need refund_registrations
 * (admins with their own account), are always in full and are audited.
 *
 * Each action answers its form (StateForm): an expected refusal ("Type REFUND to
 * confirm.", "The event is full…") comes back as an inline message next to the
 * button instead of an error page. Guards refusing another organisation's row and
 * genuine failures still throw.
 */

const path = (id: string) => `/admin/tournaments/${id}/registrations`;
const actorOf = (staff: StaffPrincipal) => ({
  role: staff.role,
  label: staff.userId ? `user:${staff.userId}` : staff.codeId ? `code:${staff.codeId}` : `shared:${staff.role}`,
});
const text = (v: FormDataEntryValue | null, max: number) => String(v ?? "").trim().slice(0, max);

export async function saveRegistrationSettings(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get("tournament_id") ?? "");
  const { staff } = await requireTournamentPermission("manage_registrations", id);
  refuse(await tournamentOrSessionRefusal(id));
  return formResult(async () => {
    const event = await eventById(id);
    if (!event) throw new Error("Not found");
    const fee = minorFromMajor(text(formData.get("fee"), 12));
    if (fee === null) refusal("Enter the fee in pounds, like 250 or 250.50.");
    const closes = text(formData.get("closes_at"), 20);
    const closesAt = closes ? zonedToIso(closes, event.timezone ?? "Africa/Cairo") : null;
    if (closes && !closesAt) refusal("Pick a valid closing time.");
    const settings = registrationSettings({
      open: formData.get("open") === "on",
      entryType: text(formData.get("entry_type"), 20),
      teamSize: text(formData.get("team_size"), 2),
      approvalMode: text(formData.get("approval_mode"), 20),
      feeAmount: fee,
      payment: text(formData.get("payment"), 20),
      teamPayer: text(formData.get("team_payer"), 20),
      capacity: text(formData.get("capacity"), 6),
      closesAt,
      note: text(formData.get("note"), 1000),
    });
    await saveSettings(event, settings, actorOf(staff));
    revalidatePath(path(id));
    return "Saved.";
  });
}

export async function decideRegistrationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const regId = String(formData.get("registration_id") ?? "");
  const { staff, scope } = await requireScopedPermission("manage_registrations", { registration: regId });
  refuse(await tournamentOrSessionRefusal(scope.tournamentId ?? ""));
  return formResult(async () => {
    const decision = String(formData.get("decision") ?? "");
    if (decision !== "approve" && decision !== "refuse") refusal("Pick approve or refuse.");
    const done = await decide(regId, decision, text(formData.get("note"), 500) || null, actorOf(staff));
    revalidatePath(path(scope.tournamentId!));
    return done;
  });
}

export async function markVenuePaidAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const regId = String(formData.get("registration_id") ?? "");
  const { staff, scope } = await requireScopedPermission("manage_registrations", { registration: regId });
  refuse(await tournamentOrSessionRefusal(scope.tournamentId ?? ""));
  return formResult(async () => {
    const done = await markVenuePaid(regId, actorOf(staff));
    revalidatePath(path(scope.tournamentId!));
    return done;
  });
}

/**
 * Refunds one online payment through its provider (XPay, or Move Tick for its own), named by its id (a registration can
 * hold a second payment to refund). Until 24 h before the start for the payment
 * that confirmed the entry; any time for one held for review. Needs a typed confirmation.
 */
export async function refundRegistrationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const regId = String(formData.get("registration_id") ?? "");
  const paymentId = String(formData.get("payment_id") ?? "");
  const { staff, scope } = await requireScopedPermission("refund_registrations", { registration: regId });
  refuse(await tournamentOrSessionRefusal(scope.tournamentId ?? ""));
  return formResult(async () => {
    // Checked here whatever the browser did with the field's required + pattern.
    if (text(formData.get("confirm"), 10).toUpperCase() !== "REFUND") refusal("Type REFUND to confirm.");
    const done = await refund(regId, paymentId, actorOf(staff), text(formData.get("reason"), 200) || null);
    revalidatePath(path(scope.tournamentId!));
    return done;
  });
}

/** Two confirmed individual entries of a padel tournament become one team. */
export async function pairRegistrationsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get("tournament_id") ?? "");
  await requireTournamentPermission("manage_registrations", id);
  refuse(await tournamentOrSessionRefusal(id));
  const ids = formData.getAll("registration_ids").map(String).slice(0, 3);
  if (ids.length !== 2) return { ok: false, message: "Tick exactly two players to pair." };
  const { staff, scope } = await requireScopedPermission("manage_registrations", { registration: ids[0]! });
  const second = await requireScopedPermission("manage_registrations", { registration: ids[1]! });
  if (scope.tournamentId !== id || second.scope.tournamentId !== id) throw new Error("Not found");
  return formResult(async () => {
    const done = await pairRegistrations([ids[0]!, ids[1]!], id, actorOf(staff));
    revalidatePath(path(id));
    return done;
  });
}
