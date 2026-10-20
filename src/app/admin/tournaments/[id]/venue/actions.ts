"use server";

import { revalidatePath } from "next/cache";
import { requireTournamentPermission } from "@/lib/guard";
import { refuse, tournamentRowRefusal } from "@/lib/rowGuards";
import { audit } from "@/lib/audit";
import { formResult, refusal, type FormState } from "@/lib/refusal";
import { PHOTO_TYPES, imageDimensions, uploadImage } from "@/lib/upload";
import { parseVenue } from "@/lib/venue/validate";
import { parseUnderlay } from "@/lib/venue/underlay";
import { applySurvey } from "@/lib/venue/survey";
import { emptyVenue, sampleVenue } from "@/lib/venue/sample";
import { saveVenueDoc, saveVenueUnderlay, venueOwnerOf, venueRowOf, type VenueOwner } from "@/lib/venue/server";
import type { VenueDoc } from "@/lib/venue/types";

/**
 * The venue map editor (migration 0039). Every action names only the
 * tournament: the venue is that tournament's event group's (or its own), read
 * from the tournament row, so no posted id can reach another organisation's map.
 * Admins and managers of the organisation (manage_tournament).
 */

const MAX_DOC_CHARS = 900_000;
const MAX_UNDERLAY_CHARS = 7_000_000;

async function ownerOf(tournamentId: string, orgId: string): Promise<VenueOwner> {
  const owner = await venueOwnerOf(tournamentId);
  if (!owner || owner.orgId !== orgId) throw new Error("Not found");
  return owner;
}

function revalidate(id: string) {
  revalidatePath(`/admin/tournaments/${id}/venue`);
  revalidatePath(`/admin/tournaments/${id}/venue/survey`);
}

/** Saves the whole venue document from the editor (or an imported JSON file). */
export async function saveVenueAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get("tournament_id") ?? "");
  const { staff, scope } = await requireTournamentPermission("manage_tournament", id);
  refuse(await tournamentRowRefusal(id));
  return formResult(async () => {
    const raw = String(formData.get("doc") ?? "");
    if (raw.length > MAX_DOC_CHARS) refusal("The venue is too large to save (over 900 kB of JSON).");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      refusal("That is not valid JSON.");
    }
    const parsed = parseVenue(json);
    if (!parsed.ok || !parsed.doc) refusal(`Not saved: ${parsed.problems.slice(0, 4).join(" ")}${parsed.problems.length > 4 ? ` (+${parsed.problems.length - 4} more)` : ""}`);
    const owner = await ownerOf(id, scope.orgId);
    const published = formData.get("published") === "on";
    const row = await saveVenueDoc(owner, parsed.doc!, published, staff.role);
    await audit({
      tournament_id: id,
      organization_id: owner.orgId,
      actor_role: staff.role,
      action: "VENUE_MAP_SAVED",
      entity_type: "venue_map",
      entity_id: row.id,
      new_value: { courts: parsed.doc!.courts.length, pois: parsed.doc!.pois.length, nodes: parsed.doc!.walkways.nodes.length, published, version: row.version },
    });
    revalidate(id);
    return `Saved (version ${row.version})${published ? " and published" : ", not published yet"}.`;
  });
}

/** Replaces the venue with the sample layout (kept unpublished unless the venue already was). */
export async function loadSampleVenueAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get("tournament_id") ?? "");
  const { staff, scope } = await requireTournamentPermission("manage_tournament", id);
  refuse(await tournamentRowRefusal(id));
  return formResult(async () => {
    const owner = await ownerOf(id, scope.orgId);
    const existing = await venueRowOf(owner);
    const row = await saveVenueDoc(owner, sampleVenue(), existing?.published ?? false, staff.role);
    await audit({ tournament_id: id, organization_id: owner.orgId, actor_role: staff.role, action: "VENUE_MAP_SAMPLE_LOADED", entity_type: "venue_map", entity_id: row.id });
    revalidate(id);
    return "The sample layout is loaded. Replace it with the real club plan.";
  });
}

/** Survey mode: the averaged GPS position of where the organiser stands, for one feature. */
export async function surveySpotAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get("tournament_id") ?? "");
  const { staff, scope } = await requireTournamentPermission("manage_tournament", id);
  refuse(await tournamentRowRefusal(id));
  return formResult(async () => {
    const owner = await ownerOf(id, scope.orgId);
    const row = await venueRowOf(owner);
    if (!row) refusal("Save the venue first (or load the sample).");
    const parsed = parseVenue(row!.doc);
    if (!parsed.doc) refusal("The stored venue cannot be read; open the editor and save it again.");
    const n = (k: string) => Number(formData.get(k));
    const lat = n("lat");
    const lng = n("lng");
    const accuracy = n("accuracy");
    const samples = Math.max(1, Math.round(n("samples") || 1));
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) refusal("No position yet: wait for the phone's location.");
    if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > 100) refusal("The position is too vague (over 100 m). Move into the open and try again.");
    const feature = String(formData.get("feature") ?? "").slice(0, 60);
    const mode = formData.get("mode") === "align" ? "align" : "move";
    const result = applySurvey(parsed.doc!, feature, { lat, lng, accuracy: Math.round(accuracy * 10) / 10, samples }, mode, { fitScale: formData.get("fit_scale") === "on" });
    if ("error" in result) refusal(result.error);
    const ok = result as { doc: VenueDoc; message: string };
    const saved = await saveVenueDoc(owner, ok.doc, row!.published, staff.role);
    await audit({ tournament_id: id, organization_id: owner.orgId, actor_role: staff.role, action: "VENUE_MAP_SURVEYED", entity_type: "venue_map", entity_id: saved.id, new_value: { feature, mode, accuracy, samples } });
    revalidate(id);
    return ok.message;
  });
}

/** An aerial photo or a scanned site plan as the underlay (JPEG, PNG or WebP). */
export async function uploadUnderlayImageAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get("tournament_id") ?? "");
  const { staff, scope } = await requireTournamentPermission("manage_tournament", id);
  refuse(await tournamentRowRefusal(id));
  return formResult(async () => {
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) refusal("Choose an image first.");
    const owner = await ownerOf(id, scope.orgId);
    let row = await venueRowOf(owner);
    if (!row) row = await saveVenueDoc(owner, emptyVenue(), false, staff.role);
    const head = new Uint8Array(await (file as File).slice(0, 262144).arrayBuffer());
    const dims = imageDimensions(head, (file as File).type);
    let url: string;
    try {
      url = await uploadImage(file as File, `venue/${owner.orgId}`, { allow: PHOTO_TYPES, maxBytes: 8 * 1024 * 1024, maxPixels: 10000 });
    } catch (e) {
      refusal(e instanceof Error ? e.message : "Upload failed.");
    }
    const width = dims?.width ?? 2000;
    const height = dims?.height ?? 1500;
    const parsed = parseVenue(row.doc);
    const courts = parsed.doc?.courts ?? [];
    const cx = courts.length ? courts.reduce((s, c) => s + c.center.x, 0) / courts.length : 0;
    const cy = courts.length ? courts.reduce((s, c) => s + c.center.y, 0) / courts.length : 0;
    // A first guess: 350 m across. The organiser scales it to the plan.
    await saveVenueUnderlay(row, { kind: "image", url: url!, width, height, center: { x: cx, y: cy }, rotationDeg: 0, scale: 350 / width, opacity: 0.6 }, staff.role);
    await audit({ tournament_id: id, organization_id: owner.orgId, actor_role: staff.role, action: "VENUE_MAP_UNDERLAY", entity_type: "venue_map", entity_id: row.id, new_value: { kind: "image" } });
    revalidate(id);
    return "Image uploaded. Scale, turn and move it until it matches the courts, then save the site plan.";
  });
}

/** The underlay as the editor has it (an imported DXF/SVG plan, or the image's new placement); empty clears it. */
export async function saveUnderlayAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get("tournament_id") ?? "");
  const { staff, scope } = await requireTournamentPermission("manage_tournament", id);
  refuse(await tournamentRowRefusal(id));
  return formResult(async () => {
    const raw = String(formData.get("underlay") ?? "");
    if (raw.length > MAX_UNDERLAY_CHARS) refusal("The site plan is too large: hide detail layers (hatching, furniture, text) and save again.");
    let json: unknown = null;
    if (raw) {
      try {
        json = JSON.parse(raw);
      } catch {
        refusal("That is not valid JSON.");
      }
    }
    const { underlay, problem } = parseUnderlay(json);
    if (problem) refusal(problem);
    const owner = await ownerOf(id, scope.orgId);
    let row = await venueRowOf(owner);
    if (!row) row = await saveVenueDoc(owner, emptyVenue(), false, staff.role);
    await saveVenueUnderlay(row, underlay, staff.role);
    await audit({ tournament_id: id, organization_id: owner.orgId, actor_role: staff.role, action: "VENUE_MAP_UNDERLAY", entity_type: "venue_map", entity_id: row.id, new_value: { kind: underlay?.kind ?? null, layers: underlay?.kind === "vector" ? underlay.layers.length : undefined } });
    revalidate(id);
    return underlay ? "Site plan saved." : "Site plan removed.";
  });
}
