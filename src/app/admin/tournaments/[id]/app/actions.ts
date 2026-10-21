"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requireScopedPermission, requireTournamentPermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { notifyAnnouncement, notifyPlayStatus } from "@/lib/notify/hooks";
import { playStatusWords } from "@/lib/notify/i18n";
import { refuse, tournamentRowRefusal } from "@/lib/rowGuards";
import { zonedToIso } from "@/lib/tennis/ties";
import { updateBranding } from "@/lib/backgroundStorage";
import { formResult, refusal, type FormState } from "@/lib/refusal";
import { playStatusProblem, playStatusPush, type PlayStatusConfig, type PlayStatusKind } from "@/lib/notices/playStatus";
import { dayKeyIn } from "@/lib/schedule/orderOfPlay";

const HEX = /^#[0-9a-fA-F]{6}$/;
const path = (id: string) => `/admin/tournaments/${id}/app`;
const text = (f: FormData, k: string, max = 120) => String(f.get(k) ?? "").trim().slice(0, max) || null;

/**
 * The organisation's group of this name, or a new one. Slugs are unique across
 * the platform, so a slug another organisation holds gets a suffix instead of
 * being reused (the old upsert would have renamed that group and joined it).
 */
async function eventGroupFor(orgId: string, name: string): Promise<string> {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 50) || `event-${Date.now()}`;
  const { data: own } = await db().from("event_groups").select("id").eq("slug", base).eq("organization_id", orgId).maybeSingle();
  if (own) return (own as { id: string }).id;
  for (let i = 0; i < 4; i++) {
    const slug = i === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    const { data, error } = await db().from("event_groups").insert({ slug, name, organization_id: orgId }).select("id").single();
    if (!error && data) return (data as { id: string }).id;
  }
  throw new Error("Could not create the event group. Try another name.");
}

/** Where and when, the event group, and the look inside the app. */
export async function saveAppSettings(formData: FormData) {
  const id = String(formData.get("tournament_id"));
  const { staff } = await requireTournamentPermission("manage_tournament", id);
  const role = staff.role;
  // A friendly session's hidden row has no app settings of its own.
  refuse(await tournamentRowRefusal(id));
  let groupId = text(formData, "event_group_id", 40);
  // An event group never mixes organisations: a group of another one is "not found".
  if (groupId) await requireScopedPermission("manage_tournament", { eventGroup: groupId });
  const newGroup = text(formData, "new_group_name", 80);
  if (newGroup) groupId = await eventGroupFor(staff.orgId, newGroup);
  const seedA = text(formData, "seed_a", 7);
  const seedB = text(formData, "seed_b", 7);
  const mode = text(formData, "skin_mode", 5);
  const tz = text(formData, "timezone", 60) ?? "Africa/Cairo";
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    throw new Error("Unknown time zone. Use a name like Africa/Cairo.");
  }
  // The first match, entered as the event's wall clock (refunds close 24 h before it).
  const startsLocal = text(formData, "starts_at", 16);
  const startsAt = startsLocal ? zonedToIso(startsLocal, tz) : null;
  if (startsLocal && !startsAt) throw new Error("Enter the start time as a date and a time.");
  const patch = {
    event_group_id: groupId,
    venue_name: text(formData, "venue_name"),
    city: text(formData, "city", 60),
    country_code: text(formData, "country_code", 2)?.toUpperCase() ?? null,
    timezone: tz,
    starts_on: text(formData, "starts_on", 10),
    ends_on: text(formData, "ends_on", 10),
    // Only when the form sends the field, so a caller without it never clears a set start time.
    ...(formData.has("starts_at") ? { starts_at: startsAt } : {}),
    app_skin: {
      seedA: seedA && HEX.test(seedA) ? seedA : null,
      seedB: seedB && HEX.test(seedB) ? seedB : null,
      mode: mode === "light" || mode === "dark" ? mode : null,
      artworkUrl: text(formData, "artwork_url", 500),
      showPhotos: formData.get("show_photos") === "on",
      // Off unless ticked: junior players are minors (src/lib/players/publicInfo.ts).
      showAges: formData.get("show_ages") === "on",
    },
    updated_at: new Date().toISOString(),
  };
  const { error } = await db().from("tournaments").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
  await audit({ tournament_id: id, actor_role: role, action: "APP_SETTINGS_EDITED", entity_type: "tournament", entity_id: id, new_value: patch });
  revalidatePath(path(id));
}

/** The group's own details. Whether it is featured, and where, is set on Admin → Discover. */
export async function saveEventGroup(formData: FormData) {
  const id = String(formData.get("tournament_id"));
  const groupId = String(formData.get("group_id"));
  const role = (await requireTournamentPermission("manage_tournament", id)).staff.role;
  await requireScopedPermission("manage_tournament", { eventGroup: groupId });
  // A friendly session's hidden row has no app settings of its own.
  refuse(await tournamentRowRefusal(id));
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
    updated_at: new Date().toISOString(),
  };
  await db().from("event_groups").update(patch).eq("id", groupId);
  await audit({ tournament_id: id, actor_role: role, action: "EVENT_GROUP_EDITED", entity_type: "event_group", entity_id: groupId, new_value: patch });
  revalidatePath(path(id));
}

export async function postAnnouncement(formData: FormData) {
  const id = String(formData.get("tournament_id"));
  const role = (await requireTournamentPermission("manage_tournament", id)).staff.role;
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
  const id = String(formData.get("tournament_id"));
  const announcementId = String(formData.get("announcement_id"));
  await requireTournamentPermission("manage_tournament", id);
  // The announcement's own tournament (or group) decides whose it is, not the posted id.
  await requireScopedPermission("manage_tournament", { appAnnouncement: announcementId });
  // A friendly session's hidden row has no app settings of its own.
  refuse(await tournamentRowRefusal(id));
  await db().from("announcements").delete().eq("id", announcementId);
  revalidatePath(path(id));
}

/**
 * Play status (rain delay, play suspended, resumed): a banner on the tournament
 * page in the app and on the public site, until the organiser sets it back to
 * normal. Stored in `branding_config.playStatus` (no migration) with the
 * compare-and-set of updateBranding, sent on the live feed as `playStatus`.
 * "Push to followers" sends it as a major alert (never for "normal").
 */
export async function savePlayStatus(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get("tournament_id") ?? "");
  const { staff } = await requireTournamentPermission("manage_tournament", id);
  // A friendly session's hidden row has no app settings of its own.
  refuse(await tournamentRowRefusal(id));
  return formResult(async () => {
    const kind = String(formData.get("kind") ?? "");
    const message = String(formData.get("message") ?? "").trim();
    const clock = String(formData.get("resume_at") ?? "").trim();
    const { data: t } = await db().from("tournaments").select("name, timezone").eq("id", id).maybeSingle();
    const tz = (t as { timezone?: string | null } | null)?.timezone || "Africa/Cairo";
    const name = (t as { name?: string } | null)?.name ?? "the event";
    let resumeAt: string | null = null;
    if (clock) {
      if (!/^\d{2}:\d{2}$/.test(clock)) refusal("Enter the resume time as HH:MM.");
      // Today in the event's zone: "resume about 15:30" is always the same day.
      resumeAt = zonedToIso(`${dayKeyIn(new Date().toISOString(), tz)}T${clock}`, tz);
      if (!resumeAt) refusal("Enter the resume time as HH:MM.");
    }
    const problem = playStatusProblem({ kind, message, resumeAt });
    if (problem) refusal(problem);
    const typed = kind as PlayStatusKind;
    const next: PlayStatusConfig = {
      kind: typed,
      ...(message && typed !== "normal" ? { message } : {}),
      ...(resumeAt && (typed === "delayed" || typed === "suspended") ? { resumeAt } : {}),
      updatedAt: new Date().toISOString(),
    };
    let before: PlayStatusConfig | null = null;
    const written = await updateBranding(id, (current) => {
      before = current.playStatus ?? null;
      return { ...current, playStatus: next };
    });
    if (!written.ok) refusal("Could not save the play status. Reload the page and try again.");
    await audit({ tournament_id: id, actor_role: staff.role, action: "PLAY_STATUS_SET", entity_type: "tournament", entity_id: id, old_value: before, new_value: next });
    const push = formData.get("push") === "on" && typed !== "normal";
    if (push) {
      const pushed = { kind: typed as Exclude<PlayStatusKind, "normal">, eventName: name, message: next.message ?? null, resumeClock: next.resumeAt ? clock : null };
      const words = playStatusPush(pushed);
      // Phones set to Spanish or French read the fixed words in their language (the message stays as typed).
      await notifyPlayStatus({ tournamentId: id, title: words.title, body: words.body, updatedAt: next.updatedAt, tr: playStatusWords(pushed).tr });
    }
    revalidatePath(path(id));
    return typed === "normal" ? "Saved. The banner is off." : push ? "Saved. The banner is up and followers are being told." : "Saved. The banner is up.";
  });
}
