/**
 * Move Score Stories, server side (migration 0043). Pure rules: ./rules.ts.
 *
 * Reads select explicit columns only and never put an account id in a payload: a
 * poster is an opaque HMAC key. Shared feeds (CDN) are the same for everyone; a
 * signed-in phone reads its own feed from a private route that leaves out the
 * posters it blocked, so a blocked poster's stories never reach the blocker.
 */
import { createHmac, randomUUID } from "crypto";
import { db, mediaPublicUrl } from "@/lib/supabase";
import { audit } from "@/lib/audit";
import { memo } from "@/lib/mobile/http";
import { takeRateLimit } from "@/lib/ratelimit";
import { imageDimensions, sniffImageType } from "@/lib/upload";
import { accountStatus } from "@/lib/auth/accounts";
import type { Owner } from "@/lib/mobile/identity";
import {
  STORY_MAX_BYTES,
  STORY_POSTS_PER_DAY,
  cleanCaption,
  groupPosters,
  isStoryId,
  reportsHide,
  storyExpiry,
  storyImageProblem,
  type MBlockedPoster,
  type MMyStories,
  type MStory,
  type MStoryFeed,
  type StoryContextInput,
  type StoryPostKind,
  type StoryReportReason,
} from "./rules";

export const STORY_PREFIX = "stories/";

/** The columns every read takes (never more). */
const COLUMNS = "id, auth_user_id, poster_name, poster_avatar_url, tournament_id, match_id, tie_id, kind, image_path, caption, created_at, expires_at";

interface Row {
  id: string;
  auth_user_id: string;
  poster_name: string | null;
  poster_avatar_url: string | null;
  tournament_id: string;
  match_id: string | null;
  tie_id: string | null;
  kind: StoryPostKind;
  image_path: string;
  caption: string | null;
  created_at: string;
  expires_at: string;
}

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET must be set");
  return s;
}

/** The opaque, stable key of a poster in feeds (never the account id). */
export function posterKey(userId: string): string {
  return `p-${createHmac("sha256", secret()).update(`story-poster:${userId}`).digest("base64url").slice(0, 18)}`;
}

/** Who counts as one view: the account, else the phone's install id (as an HMAC). */
export function viewerKey(owner: Owner): string {
  return `v-${createHmac("sha256", secret()).update(`story-view:${owner.kind}:${owner.id}`).digest("base64url").slice(0, 24)}`;
}

const nowIso = () => new Date().toISOString();

/* ---------------- where a story comes from ---------------- */

interface Place {
  tournamentId: string;
  orgId: string | null;
  slug: string;
  matchId: string | null;
  tieId: string | null;
  caption: string | null;
}

interface TournamentRow {
  id: string;
  slug: string;
  name: string;
  kind: string;
  organization_id: string | null;
  public_access_enabled: boolean | null;
}

/** A tournament everyone may see: a public tournament, or a night of a public league. */
async function publicTournament(where: { id?: string; slug?: string }): Promise<TournamentRow | null> {
  let q = db().from("tournaments").select("id, slug, name, kind, organization_id, public_access_enabled");
  q = where.id ? q.eq("id", where.id) : q.eq("slug", where.slug ?? "");
  const { data } = await q.maybeSingle();
  const t = data as TournamentRow | null;
  if (!t || t.public_access_enabled !== true) return null;
  if (t.kind === "tournament") return t;
  if (t.kind === "friendly_session") {
    const { isPublicLeagueSession } = await import("@/lib/leagues/server");
    return (await isPublicLeagueSession(t.id)) ? t : null;
  }
  return null;
}

async function teamNames(ids: (string | null)[]): Promise<Map<string, string>> {
  const want = ids.filter((x): x is string => Boolean(x));
  if (!want.length) return new Map();
  const { data } = await db().from("teams").select("id, team_name").in("id", want);
  return new Map(((data ?? []) as { id: string; team_name: string }[]).map((t) => [t.id, t.team_name]));
}

/** The public event a story context leads to, with its caption; null when it is not public. */
export async function placeOf(ctx: StoryContextInput): Promise<Place | null> {
  if (ctx.kind === "match") {
    const { data } = await db().from("matches").select("id, tournament_id, team_a_id, team_b_id, tie_id").eq("id", ctx.matchId).maybeSingle();
    const m = data as { id: string; tournament_id: string; team_a_id: string | null; team_b_id: string | null; tie_id: string | null } | null;
    if (!m) return null;
    const t = await publicTournament({ id: m.tournament_id });
    if (!t) return null;
    const names = await teamNames([m.team_a_id, m.team_b_id]);
    const a = m.team_a_id ? names.get(m.team_a_id) : null;
    const b = m.team_b_id ? names.get(m.team_b_id) : null;
    return { tournamentId: t.id, orgId: t.organization_id, slug: t.slug, matchId: m.id, tieId: m.tie_id, caption: cleanCaption([a && b ? `${a} v ${b}` : null, t.name]) };
  }
  if (ctx.kind === "tie") {
    const { data } = await db().from("ties").select("id, tournament_id, team_a_id, team_b_id").eq("id", ctx.tieId).maybeSingle();
    const tie = data as { id: string; tournament_id: string; team_a_id: string | null; team_b_id: string | null } | null;
    if (!tie) return null;
    const t = await publicTournament({ id: tie.tournament_id });
    if (!t) return null;
    const names = await teamNames([tie.team_a_id, tie.team_b_id]);
    const a = tie.team_a_id ? names.get(tie.team_a_id) : null;
    const b = tie.team_b_id ? names.get(tie.team_b_id) : null;
    return { tournamentId: t.id, orgId: t.organization_id, slug: t.slug, matchId: null, tieId: tie.id, caption: cleanCaption([a && b ? `${a} v ${b}` : null, t.name]) };
  }
  const t = await publicTournament({ slug: ctx.slug });
  if (!t) return null;
  return { tournamentId: t.id, orgId: t.organization_id, slug: t.slug, matchId: null, tieId: null, caption: cleanCaption([t.name]) };
}

/* ---------------- posting ---------------- */

export type Refused = { ok: false; status: number; error: string; code: string };
const refused = (status: number, code: string, error: string): Refused => ({ ok: false, status, code, error });

export async function isBanned(userId: string): Promise<boolean> {
  const { data } = await db().from("story_bans").select("auth_user_id").eq("auth_user_id", userId).maybeSingle();
  return Boolean(data);
}

/** The picture sent as base64: checked by its bytes, never by what the phone says it is. */
export function checkStoryImage(base64: unknown): { ok: true; bytes: Uint8Array } | Refused {
  if (typeof base64 !== "string" || !base64) return refused(400, "image", "No picture was sent.");
  const clean = base64.replace(/^data:[^;]+;base64,/, "");
  if (clean.length > Math.ceil((STORY_MAX_BYTES * 4) / 3) + 8) return refused(413, "image_size", "That picture is too large.");
  const bytes = new Uint8Array(Buffer.from(clean, "base64"));
  const type = sniffImageType(bytes.slice(0, 16));
  const dims = type ? imageDimensions(bytes, type) : null;
  const problem = storyImageProblem({ type, bytes: bytes.length, width: dims?.width ?? null, height: dims?.height ?? null });
  if (problem === "empty") return refused(400, "image", "No picture was sent.");
  if (problem === "type") return refused(400, "image_type", "A story is a JPEG made in Move Score's story composer.");
  if (problem === "size") return refused(413, "image_size", "That picture is too large.");
  if (problem === "shape") return refused(400, "image_shape", "A story is a 1080×1920 picture made in Move Score's story composer.");
  return { ok: true, bytes };
}

/** Posts a story for a signed-in account. */
export async function postStory(p: { userId: string; accessToken: string; bytes: Uint8Array; context: StoryContextInput }): Promise<{ ok: true; story: MStory } | Refused> {
  if (await isBanned(p.userId)) return refused(403, "banned", "You can't post stories. Contact info@mbeg.org if you think this is a mistake.");
  const place = await placeOf(p.context);
  if (!place) return refused(404, "context", "That match or event is not public.");
  const rl = await takeRateLimit({ key: `story-post:${p.userId}`, limit: STORY_POSTS_PER_DAY, windowSeconds: 86_400 });
  if (!rl.allowed) return refused(429, "too_many", "That's a lot of stories for one day. Try again tomorrow.");
  const account = await accountStatus(p.userId, p.accessToken).catch(() => null);
  const id = randomUUID();
  // The folder is the poster key, not the account id: the picture's public URL must not name the account.
  const path = `${STORY_PREFIX}${posterKey(p.userId)}/${id}.jpg`;
  const { error: upErr } = await db().storage.from("media").upload(path, p.bytes, { contentType: "image/jpeg", upsert: false, cacheControl: "86400" });
  if (upErr) throw new Error(`Upload failed: ${upErr.message}`);
  const created = Date.now();
  const row = {
    id,
    auth_user_id: p.userId,
    poster_name: account?.displayName?.slice(0, 80) ?? null,
    poster_avatar_url: account?.avatarUrl && account.avatarUrl.length <= 600 ? account.avatarUrl : null,
    organization_id: place.orgId,
    tournament_id: place.tournamentId,
    match_id: place.matchId,
    tie_id: place.tieId,
    kind: p.context.kind,
    image_path: path,
    caption: place.caption,
    created_at: new Date(created).toISOString(),
    expires_at: storyExpiry(created),
  };
  const { error } = await db().from("stories").insert(row);
  if (error) {
    await db().storage.from("media").remove([path]);
    throw new Error(error.message);
  }
  await audit({ action: "STORY_POSTED", actor_role: "user", actor_user_id: p.userId, tournament_id: place.tournamentId, entity_type: "story", entity_id: id });
  return { ok: true, story: { ...toStory({ ...row, kind: row.kind }, place.slug), mine: true, likes: 0, views: 0 } };
}

/* ---------------- reading ---------------- */

function toStory(r: Row, slug: string): MStory {
  return {
    id: r.id,
    imageUrl: mediaPublicUrl(r.image_path),
    kind: r.kind,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    caption: r.caption,
    link: { matchId: r.match_id, tieId: r.tie_id, slug },
  };
}

/** Live stories (optionally one tournament's), of public events, by posters who are not banned. */
async function liveRows(tournamentId?: string): Promise<{ rows: Row[]; slugs: Map<string, string> }> {
  let q = db().from("stories").select(COLUMNS).is("removed_at", null).is("hidden_at", null).gt("expires_at", nowIso());
  if (tournamentId) q = q.eq("tournament_id", tournamentId);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(500);
  if (error) throw new Error(error.message);
  let rows = (data ?? []) as Row[];
  if (!rows.length) return { rows, slugs: new Map() };
  const users = [...new Set(rows.map((r) => r.auth_user_id))];
  const { data: bans } = await db().from("story_bans").select("auth_user_id").in("auth_user_id", users);
  const banned = new Set(((bans ?? []) as { auth_user_id: string }[]).map((b) => b.auth_user_id));
  rows = rows.filter((r) => !banned.has(r.auth_user_id));
  // The event must still be public (a tournament taken private takes its stories with it).
  const slugs = new Map<string, string>();
  for (const tid of new Set(rows.map((r) => r.tournament_id))) {
    const t = await publicTournament({ id: tid });
    if (t) slugs.set(tid, t.slug);
  }
  return { rows: rows.filter((r) => slugs.has(r.tournament_id)), slugs };
}

function feedOf(rows: Row[], slugs: Map<string, string>, decorate?: (r: Row, s: MStory) => MStory): MStoryFeed {
  return {
    generatedAt: nowIso(),
    posters: groupPosters(
      rows.map((r) => {
        const s = toStory(r, slugs.get(r.tournament_id)!);
        return { posterKey: posterKey(r.auth_user_id), posterName: r.poster_name, posterAvatar: r.poster_avatar_url, story: decorate ? decorate(r, s) : s };
      }),
    ),
  };
}

/** A tournament id by public slug, or null. */
export async function publicTournamentId(slug: string): Promise<string | null> {
  if (!/^[a-z0-9][a-z0-9-]{0,118}[a-z0-9]$/.test(slug)) return null;
  return (await publicTournament({ slug }))?.id ?? null;
}

/** The shared feed: every public event's live stories (or one event's), the same for everyone. */
export function publicFeed(tournamentId?: string): Promise<MStoryFeed> {
  return memo(`stories:${tournamentId ?? "all"}`, 4_000, async () => {
    const { rows, slugs } = await liveRows(tournamentId);
    return feedOf(rows, slugs);
  });
}

/** Whose stories this account blocked. */
async function blockedBy(userId: string): Promise<string[]> {
  const { data } = await db().from("story_blocks").select("blocked_user_id").eq("blocker_user_id", userId).limit(2000);
  return ((data ?? []) as { blocked_user_id: string }[]).map((b) => b.blocked_user_id);
}

async function counts(ids: string[]): Promise<{ likes: Map<string, number>; views: Map<string, number> }> {
  const likes = new Map<string, number>();
  const views = new Map<string, number>();
  if (!ids.length) return { likes, views };
  const [l, v] = await Promise.all([
    db().from("story_likes").select("story_id").in("story_id", ids).limit(20_000),
    db().from("story_views").select("story_id").in("story_id", ids).limit(50_000),
  ]);
  for (const r of (l.data ?? []) as { story_id: string }[]) likes.set(r.story_id, (likes.get(r.story_id) ?? 0) + 1);
  for (const r of (v.data ?? []) as { story_id: string }[]) views.set(r.story_id, (views.get(r.story_id) ?? 0) + 1);
  return { likes, views };
}

/**
 * A signed-in account's feed: the shared one without the posters it blocked, with
 * its own likes marked, and the counts on its own stories (only the poster sees them).
 */
export async function feedFor(userId: string, tournamentId?: string): Promise<MStoryFeed> {
  const [{ rows, slugs }, blocked] = await Promise.all([liveRows(tournamentId), blockedBy(userId)]);
  const hide = new Set(blocked);
  const shown = rows.filter((r) => !hide.has(r.auth_user_id));
  const ids = shown.map((r) => r.id);
  const own = shown.filter((r) => r.auth_user_id === userId).map((r) => r.id);
  const [{ data: liked }, c] = await Promise.all([
    ids.length ? db().from("story_likes").select("story_id").eq("auth_user_id", userId).in("story_id", ids) : Promise.resolve({ data: [] }),
    counts(own),
  ]);
  const likedSet = new Set(((liked ?? []) as { story_id: string }[]).map((x) => x.story_id));
  return feedOf(shown, slugs, (r, s) => {
    const mine = r.auth_user_id === userId;
    return { ...s, liked: likedSet.has(r.id), ...(mine ? { mine: true, likes: c.likes.get(r.id) ?? 0, views: c.views.get(r.id) ?? 0 } : {}) };
  });
}

/** The account's own stories (live or hidden by reports, not removed or expired), with counts; whom it blocked. */
export async function myStories(userId: string): Promise<MMyStories> {
  const { data } = await db()
    .from("stories")
    .select(`${COLUMNS}, hidden_at`)
    .eq("auth_user_id", userId)
    .is("removed_at", null)
    .gt("expires_at", nowIso())
    .order("created_at", { ascending: true })
    .limit(100);
  const rows = (data ?? []) as (Row & { hidden_at: string | null })[];
  const { data: ts } = rows.length ? await db().from("tournaments").select("id, slug").in("id", [...new Set(rows.map((r) => r.tournament_id))]) : { data: [] };
  const slug = new Map(((ts ?? []) as { id: string; slug: string }[]).map((t) => [t.id, t.slug]));
  const c = await counts(rows.map((r) => r.id));
  const blockedIds = await blockedBy(userId);
  const blocked: MBlockedPoster[] = [];
  if (blockedIds.length) {
    const { data: names } = await db().from("stories").select("auth_user_id, poster_name, created_at").in("auth_user_id", blockedIds).order("created_at", { ascending: false }).limit(1000);
    const nameOf = new Map<string, string | null>();
    for (const n of (names ?? []) as { auth_user_id: string; poster_name: string | null }[]) if (!nameOf.has(n.auth_user_id)) nameOf.set(n.auth_user_id, n.poster_name);
    for (const id of blockedIds) blocked.push({ key: posterKey(id), name: nameOf.get(id) ?? null });
  }
  return {
    stories: rows.map((r) => ({ ...toStory(r, slug.get(r.tournament_id) ?? ""), mine: true, likes: c.likes.get(r.id) ?? 0, views: c.views.get(r.id) ?? 0 })),
    blocked,
    canPost: !(await isBanned(userId)),
  };
}

/* ---------------- one story ---------------- */

interface StoryFacts {
  id: string;
  auth_user_id: string;
  image_path: string;
  tournament_id: string;
  organization_id: string | null;
  expires_at: string;
  hidden_at: string | null;
  removed_at: string | null;
  restored_at: string | null;
}

async function storyFacts(id: string): Promise<StoryFacts | null> {
  if (!isStoryId(id)) return null;
  const { data } = await db()
    .from("stories")
    .select("id, auth_user_id, image_path, tournament_id, organization_id, expires_at, hidden_at, removed_at, restored_at")
    .eq("id", id)
    .maybeSingle();
  return (data as StoryFacts | null) ?? null;
}

/** A story viewers can act on now: live (and its event still public). */
async function liveStory(id: string): Promise<StoryFacts | null> {
  const s = await storyFacts(id);
  if (!s || s.removed_at || s.hidden_at || Date.parse(s.expires_at) <= Date.now()) return null;
  if (await isBanned(s.auth_user_id)) return null;
  return (await publicTournament({ id: s.tournament_id })) ? s : null;
}

const NOT_FOUND = refused(404, "not_found", "That story is gone.");
type Done = { ok: true } | Refused;

async function removeFiles(paths: string[]) {
  const own = paths.filter((p) => p.startsWith(STORY_PREFIX) && !p.includes(".."));
  for (let i = 0; i < own.length; i += 100) await db().storage.from("media").remove(own.slice(i, i + 100));
}

/** The poster deletes their own story: the row and the picture go. */
export async function deleteOwnStory(userId: string, id: string): Promise<Done> {
  const s = await storyFacts(id);
  if (!s || s.auth_user_id !== userId) return NOT_FOUND;
  await removeFiles([s.image_path]);
  const { error } = await db().from("stories").delete().eq("id", id).eq("auth_user_id", userId);
  if (error) throw new Error(error.message);
  await audit({ action: "STORY_DELETED", actor_role: "user", actor_user_id: userId, tournament_id: s.tournament_id, entity_type: "story", entity_id: id });
  return { ok: true };
}

export async function setLike(userId: string, id: string, liked: boolean): Promise<{ ok: true; liked: boolean } | Refused> {
  const s = await liveStory(id);
  if (!s) return NOT_FOUND;
  if ((await blockedBy(userId)).includes(s.auth_user_id)) return NOT_FOUND;
  if (liked) {
    const { error } = await db().from("story_likes").upsert({ story_id: id, auth_user_id: userId, liked_at: nowIso() }, { onConflict: "story_id,auth_user_id", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  } else {
    await db().from("story_likes").delete().eq("story_id", id).eq("auth_user_id", userId);
  }
  return { ok: true, liked };
}

export async function recordView(owner: Owner, id: string): Promise<Done> {
  const s = await liveStory(id);
  if (!s) return NOT_FOUND;
  const { error } = await db().from("story_views").upsert({ story_id: id, viewer_key: viewerKey(owner), viewed_at: nowIso() }, { onConflict: "story_id,viewer_key", ignoreDuplicates: true });
  if (error) throw new Error(error.message);
  return { ok: true };
}

/** One report per account; enough distinct reports hide the story until staff decide. */
export async function reportStory(userId: string, id: string, reason: StoryReportReason): Promise<{ ok: true; hidden: boolean } | Refused> {
  const s = await liveStory(id);
  if (!s) return NOT_FOUND;
  if (s.auth_user_id === userId) return refused(400, "own_story", "That's your own story: delete it instead.");
  const { error } = await db().from("story_reports").upsert({ story_id: id, reporter_user_id: userId, reason, reported_at: nowIso() }, { onConflict: "story_id,reporter_user_id", ignoreDuplicates: true });
  if (error) throw new Error(error.message);
  const { data } = await db().from("story_reports").select("reported_at").eq("story_id", id).limit(1000);
  const times = ((data ?? []) as { reported_at: string }[]).map((r) => r.reported_at);
  let hidden = false;
  if (reportsHide(times, s.restored_at)) {
    const { data: changed } = await db().from("stories").update({ hidden_at: nowIso(), hidden_reason: "reports" }).eq("id", id).is("hidden_at", null).select("id");
    hidden = Boolean((changed as unknown[] | null)?.length);
  }
  await audit({ action: hidden ? "STORY_HIDDEN_BY_REPORTS" : "STORY_REPORTED", actor_role: "user", actor_user_id: userId, tournament_id: s.tournament_id, entity_type: "story", entity_id: id, new_value: { reason, reports: times.length } });
  return { ok: true, hidden };
}

/** Blocks the story's poster for this account. */
export async function blockPoster(userId: string, id: string): Promise<{ ok: true; key: string } | Refused> {
  const s = await storyFacts(id);
  if (!s) return NOT_FOUND;
  if (s.auth_user_id === userId) return refused(400, "own_story", "You can't block yourself.");
  const { error } = await db().from("story_blocks").upsert({ blocker_user_id: userId, blocked_user_id: s.auth_user_id, blocked_at: nowIso() }, { onConflict: "blocker_user_id,blocked_user_id", ignoreDuplicates: true });
  if (error) throw new Error(error.message);
  return { ok: true, key: posterKey(s.auth_user_id) };
}

export async function unblockPoster(userId: string, key: string): Promise<Done> {
  const target = (await blockedBy(userId)).find((b) => posterKey(b) === key);
  if (!target) return NOT_FOUND;
  await db().from("story_blocks").delete().eq("blocker_user_id", userId).eq("blocked_user_id", target);
  return { ok: true };
}

/* ---------------- staff ---------------- */

export interface ModerationRow {
  id: string;
  imageUrl: string | null;
  posterName: string | null;
  posterUserId: string;
  tournamentName: string | null;
  caption: string | null;
  createdAt: string;
  expiresAt: string;
  hiddenAt: string | null;
  hiddenReason: string | null;
  removedAt: string | null;
  removedBy: string | null;
  reports: { reason: string; at: string }[];
  banned: boolean;
}

/**
 * Stories staff should look at: reported, hidden or removed, newest first.
 * `orgId` narrows to one organisation's events (its admins); platform admins pass none.
 */
export async function moderationQueue(orgId?: string): Promise<ModerationRow[]> {
  const { data: reps } = await db().from("story_reports").select("story_id, reason, reported_at").order("reported_at", { ascending: false }).limit(2000);
  const reports = (reps ?? []) as { story_id: string; reason: string; reported_at: string }[];
  let q = db()
    .from("stories")
    .select("id, auth_user_id, poster_name, image_path, tournament_id, organization_id, caption, created_at, expires_at, hidden_at, hidden_reason, removed_at, removed_by");
  if (orgId) q = q.eq("organization_id", orgId);
  const reportedIds = [...new Set(reports.map((r) => r.story_id))];
  const or = [`hidden_at.not.is.null`, `removed_at.not.is.null`, ...(reportedIds.length ? [`id.in.(${reportedIds.slice(0, 300).join(",")})`] : [])].join(",");
  const { data, error } = await q.or(or).order("created_at", { ascending: false }).limit(300);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as {
    id: string;
    auth_user_id: string;
    poster_name: string | null;
    image_path: string;
    tournament_id: string;
    organization_id: string | null;
    caption: string | null;
    created_at: string;
    expires_at: string;
    hidden_at: string | null;
    hidden_reason: string | null;
    removed_at: string | null;
    removed_by: string | null;
  }[];
  const tids = [...new Set(rows.map((r) => r.tournament_id))];
  const users = [...new Set(rows.map((r) => r.auth_user_id))];
  const [{ data: ts }, { data: bans }] = await Promise.all([
    tids.length ? db().from("tournaments").select("id, name").in("id", tids) : Promise.resolve({ data: [] }),
    users.length ? db().from("story_bans").select("auth_user_id").in("auth_user_id", users) : Promise.resolve({ data: [] }),
  ]);
  const tname = new Map(((ts ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name]));
  const banned = new Set(((bans ?? []) as { auth_user_id: string }[]).map((b) => b.auth_user_id));
  const sorted = rows.sort((a, b) => Number(Boolean(b.hidden_at && !b.removed_at)) - Number(Boolean(a.hidden_at && !a.removed_at)) || b.created_at.localeCompare(a.created_at));
  return sorted.map((r) => ({
    id: r.id,
    imageUrl: r.removed_at ? null : mediaPublicUrl(r.image_path),
    posterName: r.poster_name,
    posterUserId: r.auth_user_id,
    tournamentName: tname.get(r.tournament_id) ?? null,
    caption: r.caption,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    hiddenAt: r.hidden_at,
    hiddenReason: r.hidden_reason,
    removedAt: r.removed_at,
    removedBy: r.removed_by,
    reports: reports.filter((x) => x.story_id === r.id).map((x) => ({ reason: x.reason, at: x.reported_at })),
    banned: banned.has(r.auth_user_id),
  }));
}

/** Staff put a hidden story back (later reports count from now). A removed story stays removed. */
export async function restoreStory(id: string, by: string): Promise<boolean> {
  const { data } = await db()
    .from("stories")
    .update({ hidden_at: null, hidden_reason: null, restored_at: nowIso() })
    .eq("id", id)
    .is("removed_at", null)
    .select("id, tournament_id");
  const row = ((data ?? []) as { id: string; tournament_id: string }[])[0];
  if (!row) return false;
  await audit({ action: "STORY_RESTORED", tournament_id: row.tournament_id, entity_type: "story", entity_id: id, new_value: { by } });
  return true;
}

/** Staff remove a story: hidden for good, its picture deleted. */
export async function removeStory(id: string, by: string): Promise<boolean> {
  const s = await storyFacts(id);
  if (!s || s.removed_at) return false;
  await removeFiles([s.image_path]);
  await db().from("stories").update({ removed_at: nowIso(), removed_by: by.slice(0, 120), hidden_at: s.hidden_at ?? nowIso(), hidden_reason: "staff" }).eq("id", id);
  await audit({ action: "STORY_REMOVED", tournament_id: s.tournament_id, entity_type: "story", entity_id: id, new_value: { by } });
  return true;
}

/** Platform admins: the story's poster may no longer post, and their live stories are removed. */
export async function banPosterOf(id: string, by: string, reason: string | null): Promise<boolean> {
  const s = await storyFacts(id);
  if (!s) return false;
  const { error } = await db()
    .from("story_bans")
    .upsert({ auth_user_id: s.auth_user_id, banned_by: by.slice(0, 120), reason: reason?.slice(0, 300) || null, banned_at: nowIso() }, { onConflict: "auth_user_id" });
  if (error) throw new Error(error.message);
  const { data: live } = await db().from("stories").select("id").eq("auth_user_id", s.auth_user_id).is("removed_at", null);
  for (const r of (live ?? []) as { id: string }[]) await removeStory(r.id, by);
  await audit({ action: "STORY_POSTER_BANNED", tournament_id: s.tournament_id, entity_type: "story", entity_id: id, new_value: { by, reason } });
  return true;
}

export async function liftBan(userId: string, by: string): Promise<boolean> {
  const { data } = await db().from("story_bans").delete().eq("auth_user_id", userId).select("auth_user_id");
  const done = Boolean((data as unknown[] | null)?.length);
  if (done) await audit({ action: "STORY_BAN_LIFTED", entity_type: "user", entity_id: userId, new_value: { by } });
  return done;
}

export async function storyBans(): Promise<{ userId: string; bannedBy: string; reason: string | null; at: string; name: string | null }[]> {
  const { data } = await db().from("story_bans").select("auth_user_id, banned_by, reason, banned_at").order("banned_at", { ascending: false }).limit(200);
  const rows = (data ?? []) as { auth_user_id: string; banned_by: string; reason: string | null; banned_at: string }[];
  const names = new Map<string, string | null>();
  if (rows.length) {
    const { data: s } = await db().from("stories").select("auth_user_id, poster_name").in("auth_user_id", rows.map((r) => r.auth_user_id)).limit(1000);
    for (const n of (s ?? []) as { auth_user_id: string; poster_name: string | null }[]) if (!names.get(n.auth_user_id)) names.set(n.auth_user_id, n.poster_name);
  }
  return rows.map((r) => ({ userId: r.auth_user_id, bannedBy: r.banned_by, reason: r.reason, at: r.banned_at, name: names.get(r.auth_user_id) ?? null }));
}

/* ---------------- housekeeping ---------------- */

/** Expired stories are deleted with their pictures (views, likes and reports go with them). */
export async function sweepExpiredStories(limit = 500): Promise<number> {
  const { data } = await db().from("stories").select("id, image_path, removed_at").lte("expires_at", nowIso()).limit(limit);
  const rows = (data ?? []) as { id: string; image_path: string; removed_at: string | null }[];
  if (!rows.length) return 0;
  await removeFiles(rows.filter((r) => !r.removed_at).map((r) => r.image_path));
  await db().from("stories").delete().in("id", rows.map((r) => r.id));
  return rows.length;
}

/** Account deletion: the account's stories and pictures, likes, reports and blocks go. A ban stays. */
export async function forgetStories(userId: string): Promise<void> {
  const { data } = await db().from("stories").select("id, image_path, removed_at").eq("auth_user_id", userId).limit(1000);
  const rows = (data ?? []) as { id: string; image_path: string; removed_at: string | null }[];
  await removeFiles(rows.filter((r) => !r.removed_at).map((r) => r.image_path));
  if (rows.length) await db().from("stories").delete().eq("auth_user_id", userId);
  await db().from("story_likes").delete().eq("auth_user_id", userId);
  await db().from("story_reports").delete().eq("reporter_user_id", userId);
  await db().from("story_blocks").delete().eq("blocker_user_id", userId);
  await db().from("story_blocks").delete().eq("blocked_user_id", userId);
  await db().from("story_views").delete().eq("viewer_key", viewerKey({ kind: "user", id: userId }));
}
