/**
 * Move Score Stories, end to end on the stand-in (migration 0043).
 *
 *   1. Signed out: the feed reads (public, CDN-cached, no private columns), but
 *      posting, liking, reporting and blocking are 401 "sign_in".
 *   2. Signed in: a composer export (1080×1920 JPEG) posts from a match, a tie-less
 *      pass slug; a PNG, a square picture, a private event and an unknown context
 *      are refused. The picture lands under stories/<poster key>/<id>.jpg.
 *   3. Likes and views: one per account (views also per signed-out phone); only the
 *      poster sees the counts.
 *   4. Block: the blocker's own feed leaves the poster out, everyone else still sees
 *      them; unblocking brings them back.
 *   5. Reports: one per account; the third account's report hides the story for all.
 *   6. Staff: another organisation's admin cannot restore it; the event's admin can
 *      (later reports count from then); a platform admin removes (the picture goes)
 *      and bans (posting refused); the ban is lifted.
 *   7. Lifetime: a story past 24 hours is gone from every feed, and the drain's
 *      sweep deletes the row and its picture. The poster deletes their own story
 *      (the picture goes); someone else's delete is a 404.
 *
 *   LOCALDB_PORT=54421 npm run localdb                       # another terminal
 *   npm run build && npx next start -p 3121                  # env from .env.localdb (SUPABASE_URL on :54421)
 *   BASE_URL=http://localhost:3121 SUPABASE_URL=http://localhost:54421 npm run e2e:stories
 *
 * Creates and deletes its own data.
 */
import { randomUUID } from "crypto";
import { db } from "../../src/lib/supabase";
import { MOVE_BEYOND_SLUG } from "../../src/lib/orgs/roles";
import { mintInstallToken } from "../../src/lib/mobile/identity";
import { posterKey } from "../../src/lib/stories/server";
import type { MMyStories, MStoryFeed } from "../../src/lib/stories/rules";
import { appUser, assertStandIn, bearer, check, cookie, finish, fixtures, http, section, sleep, type Who } from "./lib/fixtures";
import { staffToken } from "./lib/session";
import { callAction, form } from "./lib/actions";

assertStandIn("stories");

const SUPA = process.env.SUPABASE_URL ?? "";
const tag = randomUUID().slice(0, 6);
const f = fixtures(tag);
const made = { users: [] as string[], orgs: [] as string[], members: [] as string[] };
const ORG_ACTIONS = "src/app/admin/org/stories/actions.ts";
const PLATFORM_ACTIONS = "src/app/admin/platform/stories/actions.ts";

/** A JPEG header with a frame of the given size (the server reads the bytes, not a claimed type). */
function jpeg(width: number, height: number, padding = 4000): string {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const bytes = new Uint8Array([0xff, 0xd8, ...app0, ...sof, ...new Array(padding).fill(0x7f), 0xff, 0xd9]);
  return Buffer.from(bytes).toString("base64");
}
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 4, 56, 0, 0, 7, 128, 8, 2, 0, 0, 0]).toString("base64");

async function objects(prefix: string): Promise<string[]> {
  const r = await fetch(`${SUPA}/storage/v1/_localdb/objects?prefix=${encodeURIComponent(prefix)}`);
  return (await r.json()) as string[];
}

type StoryRow = { hidden_at: string | null; hidden_reason: string | null; restored_at: string | null; removed_at: string | null; removed_by: string | null };
async function storyRow(id: string): Promise<StoryRow> {
  const { data } = await db().from("stories").select("hidden_at, hidden_reason, restored_at, removed_at, removed_by").eq("id", id).single();
  return data as StoryRow;
}

const feedOf = (r: { json: Record<string, unknown> | null }) => r.json as unknown as MStoryFeed;
const storyIds = (feed: MStoryFeed | null | undefined) => (feed?.posters ?? []).flatMap((p) => p.stories.map((s) => s.id));

async function main() {
  const { data: mb } = await db().from("organizations").select("id").eq("slug", MOVE_BEYOND_SLUG).single();
  const MB = (mb as { id: string }).id;

  const T = await f.tournament({ name: "Stories Open" });
  const PRIVATE = await f.tournament({ name: "Stories Private" });
  await db().from("tournaments").update({ organization_id: MB, public_access_enabled: true }).eq("id", T);
  await db().from("tournaments").update({ organization_id: MB, public_access_enabled: false }).eq("id", PRIVATE);
  const { data: tr } = await db().from("tournaments").select("id, slug").in("id", [T, PRIVATE]);
  const slugOf = new Map(((tr ?? []) as { id: string; slug: string }[]).map((t) => [t.id, t.slug]));
  const SLUG = slugOf.get(T)!;
  const { teams } = await f.teams(T, ["Egypt", "Japan"]);
  const M = await f.match(T, { team_a_id: teams[0]!.id, team_b_id: teams[1]!.id });
  const { teams: pt } = await f.teams(PRIVATE, ["Peru", "Chile"]);
  const PM = await f.match(PRIVATE, { team_a_id: pt[0]!.id, team_b_id: pt[1]!.id });

  const poster = await appUser(`stories.poster.${tag}@example.com`);
  const fan = await appUser(`stories.fan.${tag}@example.com`);
  const r1 = await appUser(`stories.r1.${tag}@example.com`);
  const r2 = await appUser(`stories.r2.${tag}@example.com`);
  const r3 = await appUser(`stories.r3.${tag}@example.com`);
  made.users.push(poster.userId, fan.userId, r1.userId, r2.userId, r3.userId);
  const P = bearer(poster.token);
  const DIR = `stories/${posterKey(poster.userId)}/`;
  const FAN = bearer(fan.token);
  const guest: Who = { "X-Install-Token": mintInstallToken(`e2e-stories-${tag}`) };
  const IMG = jpeg(1080, 1920);

  /* ---------------- 1. signed out ---------------- */
  section("1. Signed out: read only");
  const pub0 = await http("GET", "/api/mobile/v1/stories");
  check(pub0.status === 200 && /public/.test(pub0.cache ?? "") && /s-maxage=10/.test(pub0.cache ?? ""), "the feed reads, shared at the CDN", { status: pub0.status, cache: pub0.cache });
  const anonPost = await http("POST", "/api/mobile/v1/stories", guest, { image: IMG, context: { kind: "match", matchId: M.id } });
  check(anonPost.status === 401 && anonPost.json?.code === "sign_in", "posting needs an account (an install token is not one)", anonPost.status);
  const anonMine = await http("GET", "/api/mobile/v1/me/stories", guest);
  check(anonMine.status === 401, "no 'my stories' without an account", anonMine.status);

  /* ---------------- 2. posting ---------------- */
  section("2. Signed in: posting");
  const png = await http("POST", "/api/mobile/v1/stories", P, { image: PNG, context: { kind: "match", matchId: M.id } });
  check(png.status === 400 && png.json?.code === "image_type", "a PNG is refused", png.json);
  const square = await http("POST", "/api/mobile/v1/stories", P, { image: jpeg(1080, 1080), context: { kind: "match", matchId: M.id } });
  check(square.status === 400 && square.json?.code === "image_shape", "a square picture is refused (only the 9:16 export)", square.json);
  const priv = await http("POST", "/api/mobile/v1/stories", P, { image: IMG, context: { kind: "match", matchId: PM.id } });
  check(priv.status === 404 && priv.json?.code === "context", "a private event's match is refused", priv.json);
  const nocontext = await http("POST", "/api/mobile/v1/stories", P, { image: IMG, context: { kind: "gallery" } });
  check(nocontext.status === 400 && nocontext.json?.code === "context", "a picture with no match, tie or pass is refused", nocontext.json);
  const extra = await http("POST", "/api/mobile/v1/stories", P, { image: IMG, context: { kind: "match", matchId: M.id }, caption: "hi" });
  check(extra.status === 400, "no free-text caption is taken", extra.status);

  const post1 = await http("POST", "/api/mobile/v1/stories", P, { image: IMG, context: { kind: "match", matchId: M.id } });
  const s1 = (post1.json?.story ?? {}) as { id: string; caption: string | null; link: { matchId: string; slug: string }; mine?: boolean };
  check(post1.status === 201 && s1.link?.matchId === M.id && s1.link.slug === SLUG && /Egypt .* v Japan/.test(s1.caption ?? ""), "posted from a match, with its caption and link", post1.json);
  const post2 = await http("POST", "/api/mobile/v1/stories", P, { image: IMG, context: { kind: "pass", slug: SLUG } });
  const S2 = (post2.json?.story as { id: string } | undefined)?.id ?? "";
  check(post2.status === 201 && Boolean(S2), "posted from a pass (the event's slug)", post2.status);
  const S1 = s1.id;
  const files = await objects(DIR);
  check(files.includes(`${DIR}${S1}.jpg`) && files.includes(`${DIR}${S2}.jpg`), "pictures stored under stories/<poster key>/<id>.jpg (no account id in the URL)", files);
  const { data: row } = await db().from("stories").select("organization_id, tournament_id, expires_at, created_at").eq("id", S1).single();
  const life = Date.parse((row as { expires_at: string }).expires_at) - Date.parse((row as { created_at: string }).created_at);
  check((row as { organization_id: string }).organization_id === MB && Math.abs(life - 86_400_000) < 2000, "tied to the event's organisation, expiring 24 hours on", row);

  await sleep(4_500); // the server keeps the shared feed for 4 s
  const pub1 = await http("GET", "/api/mobile/v1/stories");
  const ids1 = storyIds(feedOf(pub1));
  check(ids1.includes(S1) && ids1.includes(S2), "both stories in the public feed", ids1.length);
  check(!/auth_user_id|organization_id|hidden_|removed_|restored_at|image_path|@example\.com/.test(pub1.text) && !pub1.text.includes(poster.userId), "no private columns or account ids in the feed", pub1.text.slice(0, 300));
  const pub1p = feedOf(pub1).posters.find((p) => p.stories.some((s) => s.id === S1));
  check(Boolean(pub1p) && /^p-/.test(pub1p!.key) && pub1p!.stories.length === 2 && pub1p!.stories[0]!.id === S1, "grouped under one opaque poster key, oldest first", pub1p?.key);
  check(!/"likes"|"views"|"liked"|"mine"/.test(pub1.text), "no counts or per-account flags in the shared feed");
  const tfeed = await http("GET", `/api/mobile/v1/t/${SLUG}/stories`);
  check(tfeed.status === 200 && storyIds(feedOf(tfeed)).includes(S1), "the event hub's own feed", tfeed.status);
  const tprivate = await http("GET", `/api/mobile/v1/t/${slugOf.get(PRIVATE)}/stories`);
  check(tprivate.status === 404, "a private event has no story feed", tprivate.status);

  /* ---------------- 3. likes and views ---------------- */
  section("3. Likes and views");
  const anonLike = await http("POST", `/api/mobile/v1/stories/${S1}/like`, guest, { liked: true });
  check(anonLike.status === 401, "liking needs an account", anonLike.status);
  const like = await http("POST", `/api/mobile/v1/stories/${S1}/like`, FAN, { liked: true });
  const like2 = await http("POST", `/api/mobile/v1/stories/${S1}/like`, FAN, { liked: true });
  check(like.status === 200 && like2.status === 200, "a fan likes it (twice is still one)", [like.status, like2.status]);
  for (const who of [FAN, FAN, guest, bearer(r1.token)]) await http("POST", `/api/mobile/v1/stories/${S1}/view`, who);
  const mine = await http("GET", "/api/mobile/v1/me/stories", P);
  const m1 = (mine.json as unknown as MMyStories).stories.find((s) => s.id === S1);
  check(mine.status === 200 && m1?.likes === 1 && m1?.views === 3 && /private/.test(mine.cache ?? ""), "the poster sees 1 like and 3 views (account, phone, account)", { likes: m1?.likes, views: m1?.views });
  const fanFeed = await http("GET", "/api/mobile/v1/me/stories/feed", FAN);
  const fs1 = feedOf(fanFeed).posters.flatMap((p) => p.stories).find((s) => s.id === S1);
  check(fanFeed.status === 200 && fs1?.liked === true && fs1?.likes === undefined && fs1?.views === undefined && /no-store/.test(fanFeed.cache ?? ""), "the fan's feed marks the like but shows no counts", fs1);
  const posterFeed = await http("GET", "/api/mobile/v1/me/stories/feed", P);
  const ps1 = feedOf(posterFeed).posters.flatMap((p) => p.stories).find((s) => s.id === S1);
  check(ps1?.mine === true && ps1?.likes === 1, "the poster's feed carries their counts", ps1);
  const unlike = await http("POST", `/api/mobile/v1/stories/${S1}/like`, FAN, { liked: false });
  const { count: likesLeft } = await db().from("story_likes").select("story_id", { count: "exact", head: true }).eq("story_id", S1);
  check(unlike.status === 200 && likesLeft === 0, "unliked", likesLeft);

  /* ---------------- 4. block ---------------- */
  section("4. Block");
  const anonBlock = await http("POST", `/api/mobile/v1/stories/${S1}/block`, guest);
  check(anonBlock.status === 401, "blocking needs an account", anonBlock.status);
  const self = await http("POST", `/api/mobile/v1/stories/${S1}/block`, P);
  check(self.status === 400, "nobody blocks themselves", self.status);
  const block = await http("POST", `/api/mobile/v1/stories/${S1}/block`, FAN);
  check(block.status === 200 && block.json?.key === pub1p?.key, "the fan blocks the poster", block.json);
  const fanAfter = storyIds(feedOf(await http("GET", "/api/mobile/v1/me/stories/feed", FAN)));
  const fanAfterT = storyIds(feedOf(await http("GET", `/api/mobile/v1/me/stories/feed?t=${SLUG}`, FAN)));
  const otherAfter = storyIds(feedOf(await http("GET", "/api/mobile/v1/me/stories/feed", bearer(r1.token))));
  check(!fanAfter.includes(S1) && !fanAfter.includes(S2) && !fanAfterT.includes(S1), "the blocker's feeds leave the poster out", fanAfter);
  check(otherAfter.includes(S1), "everyone else still sees them");
  const blockedLike = await http("POST", `/api/mobile/v1/stories/${S1}/like`, FAN, { liked: true });
  check(blockedLike.status === 404, "a blocked poster's story cannot be liked by the blocker", blockedLike.status);
  const fanMine = (await http("GET", "/api/mobile/v1/me/stories", FAN)).json as unknown as MMyStories;
  check(fanMine.blocked.length === 1 && fanMine.blocked[0]!.key === pub1p?.key && !JSON.stringify(fanMine).includes(poster.userId), "listed in the fan's blocked people (by key, never an account id)", fanMine.blocked);
  const unblock = await http("POST", "/api/mobile/v1/me/stories/blocks", FAN, { unblock: pub1p!.key });
  const fanBack = storyIds(feedOf(await http("GET", "/api/mobile/v1/me/stories/feed", FAN)));
  check(unblock.status === 200 && fanBack.includes(S1), "unblocked: back in the fan's feed", unblock.status);

  /* ---------------- 5. reports ---------------- */
  section("5. Reports");
  const anonReport = await http("POST", `/api/mobile/v1/stories/${S1}/report`, guest, { reason: "spam" });
  check(anonReport.status === 401, "reporting needs an account", anonReport.status);
  const badReason = await http("POST", `/api/mobile/v1/stories/${S1}/report`, bearer(r1.token), { reason: "boring" });
  check(badReason.status === 400, "an unknown reason is refused", badReason.status);
  const own = await http("POST", `/api/mobile/v1/stories/${S1}/report`, P, { reason: "spam" });
  check(own.status === 400, "nobody reports their own story", own.status);
  await http("POST", `/api/mobile/v1/stories/${S1}/report`, bearer(r1.token), { reason: "spam" });
  await http("POST", `/api/mobile/v1/stories/${S1}/report`, bearer(r1.token), { reason: "hate" });
  await http("POST", `/api/mobile/v1/stories/${S1}/report`, bearer(r2.token), { reason: "harassment" });
  let st = await storyRow(S1);
  check(!st.hidden_at, "two accounts' reports (one twice) do not hide it");
  const third = await http("POST", `/api/mobile/v1/stories/${S1}/report`, bearer(r3.token), { reason: "nudity" });
  st = await storyRow(S1);
  check(third.status === 200 && st.hidden_reason === "reports", "the third account's report hides it", st);
  await sleep(4_500);
  const hiddenPub = storyIds(feedOf(await http("GET", "/api/mobile/v1/stories")));
  check(!hiddenPub.includes(S1) && hiddenPub.includes(S2), "hidden from the public feed (the other story stays)", hiddenPub.length);
  const hiddenView = await http("POST", `/api/mobile/v1/stories/${S1}/view`, FAN);
  check(hiddenView.status === 404, "a hidden story takes no more views or reactions", hiddenView.status);

  /* ---------------- 6. staff ---------------- */
  section("6. Staff: restore, remove, ban");
  const { data: o } = await db().from("organizations").insert({ slug: `e2e-stories-x-${tag}`, name: `E2E Stories Other ${tag}`, status: "approved" }).select("id").single();
  const X = (o as { id: string }).id;
  made.orgs.push(X);
  const xAdmin = await appUser(`stories.xadmin.${tag}@example.com`);
  made.users.push(xAdmin.userId);
  await db().from("organization_members").insert({ organization_id: X, auth_user_id: xAdmin.userId, invited_email: `stories.xadmin.${tag}@example.com`, role: "admin", status: "active" });
  const XADMIN = cookie(staffToken({ kind: "member", userId: xAdmin.userId, orgId: X, role: "admin" }));
  const mbAdmin = await appUser(`stories.mbadmin.${tag}@example.com`);
  made.users.push(mbAdmin.userId);
  await db().from("organization_members").insert({ organization_id: MB, auth_user_id: mbAdmin.userId, invited_email: `stories.mbadmin.${tag}@example.com`, role: "admin", status: "active" });
  made.members.push(mbAdmin.userId);
  const MBADMIN = cookie(staffToken({ kind: "member", userId: mbAdmin.userId, orgId: MB, role: "admin" }));

  const xPage = await http("GET", "/admin/org/stories", XADMIN);
  check(xPage.status === 200 && !xPage.text.includes(S1), "another organisation's Stories page does not list it", xPage.status);
  const xRestore = await callAction(ORG_ACTIONS, "moderateOrgStoryAction", [null, form({ story_id: S1, do: "restore" })], XADMIN);
  st = await storyRow(S1);
  check(!/"ok":true/.test(xRestore.text) && Boolean(st.hidden_at), "another organisation's admin cannot restore it", xRestore.text.slice(0, 160));
  const xPlatform = await callAction(PLATFORM_ACTIONS, "moderateStoryAction", [null, form({ story_id: S1, do: "remove" })], MBADMIN);
  check(!/"ok":true/.test(xPlatform.text), "an organisation admin who is not a platform admin cannot use the platform page's actions", xPlatform.text.slice(0, 160));
  const mbPage = await http("GET", "/admin/org/stories", MBADMIN);
  check(mbPage.status === 200 && mbPage.text.includes(S1) && mbPage.text.includes("Hidden by reports"), "the event's organisation lists it as hidden by reports", mbPage.status);
  const restore = await callAction(ORG_ACTIONS, "moderateOrgStoryAction", [null, form({ story_id: S1, do: "restore" })], MBADMIN);
  st = await storyRow(S1);
  check(/"ok":true/.test(restore.text) && !st.hidden_at && Boolean(st.restored_at), "the event's admin restores it", restore.text.slice(-160));
  await http("POST", `/api/mobile/v1/stories/${S1}/report`, FAN, { reason: "other" });
  st = await storyRow(S1);
  check(!st.hidden_at, "after a restore, only newer reports count (one is not three)");

  const pa = await appUser(`stories.platform.${tag}@example.com`);
  made.users.push(pa.userId);
  await db().from("platform_admins").insert({ auth_user_id: pa.userId, email: `stories.platform.${tag}@example.com`, note: "e2e" });
  await db().from("organization_members").insert({ organization_id: MB, auth_user_id: pa.userId, invited_email: `stories.platform.${tag}@example.com`, role: "owner", status: "active" });
  made.members.push(pa.userId);
  const PLATFORM = cookie(staffToken({ kind: "member", userId: pa.userId, orgId: MB, role: "owner" }));
  const platPage = await http("GET", "/admin/platform/stories", PLATFORM);
  check(platPage.status === 200 && platPage.text.includes(S1), "the platform page lists every organisation's reported stories", platPage.status);
  const remove = await callAction(PLATFORM_ACTIONS, "moderateStoryAction", [null, form({ story_id: S1, do: "remove" })], PLATFORM);
  st = await storyRow(S1);
  const afterRemove = await objects(DIR);
  check(/"ok":true/.test(remove.text) && Boolean(st.removed_at) && !afterRemove.includes(`${DIR}${S1}.jpg`), "a platform admin removes it: its picture is deleted", { st, afterRemove });
  const reRestore = await callAction(ORG_ACTIONS, "moderateOrgStoryAction", [null, form({ story_id: S1, do: "restore" })], MBADMIN);
  check(/"ok":false/.test(reRestore.text), "a removed story cannot be restored", reRestore.text.slice(-160));

  const ban = await callAction(PLATFORM_ACTIONS, "moderateStoryAction", [null, form({ story_id: S2, do: "ban", reason: "e2e" })], PLATFORM);
  const banned = await http("POST", "/api/mobile/v1/stories", P, { image: IMG, context: { kind: "match", matchId: M.id } });
  const posterMine = (await http("GET", "/api/mobile/v1/me/stories", P)).json as unknown as MMyStories;
  check(/"ok":true/.test(ban.text) && banned.status === 403 && banned.json?.code === "banned" && posterMine.canPost === false, "banned: posting is refused", { ban: ban.text.slice(-120), post: banned.status });
  await sleep(4_500);
  check(!storyIds(feedOf(await http("GET", "/api/mobile/v1/stories"))).includes(S2), "the banned poster's live stories are gone");
  const lift = await callAction(PLATFORM_ACTIONS, "liftStoryBanAction", [null, form({ user_id: poster.userId })], PLATFORM);
  check(/"ok":true/.test(lift.text), "the ban is lifted", lift.text.slice(-120));

  /* ---------------- 7. lifetime and deletion ---------------- */
  section("7. Lifetime and deletion");
  const post3 = await http("POST", "/api/mobile/v1/stories", P, { image: IMG, context: { kind: "match", matchId: M.id } });
  const S3 = (post3.json?.story as { id: string } | undefined)?.id ?? "";
  const post4 = await http("POST", "/api/mobile/v1/stories", P, { image: IMG, context: { kind: "match", matchId: M.id } });
  const S4 = (post4.json?.story as { id: string } | undefined)?.id ?? "";
  check(post3.status === 201 && post4.status === 201, "posting works again after the ban is lifted", [post3.status, post4.status]);
  // 25 hours on: the story's expiry is moved into the past.
  await db().from("stories").update({ created_at: new Date(Date.now() - 25 * 3600_000).toISOString(), expires_at: new Date(Date.now() - 3600_000).toISOString() }).eq("id", S3);
  await sleep(4_500);
  const expiredPub = storyIds(feedOf(await http("GET", "/api/mobile/v1/stories")));
  const expiredMine = (await http("GET", "/api/mobile/v1/me/stories", P)).json as unknown as MMyStories;
  const expiredView = await http("POST", `/api/mobile/v1/stories/${S3}/view`, FAN);
  check(!expiredPub.includes(S3) && expiredPub.includes(S4) && !expiredMine.stories.some((s) => s.id === S3) && expiredView.status === 404, "after 24 hours it is gone from every surface", { pub: expiredPub.length });
  const drain = await http("POST", "/api/internal/messages/drain", { Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` });
  const { data: gone3 } = await db().from("stories").select("id").eq("id", S3);
  const afterSweep = await objects(DIR);
  check(drain.status === 200 && Number(drain.json?.storiesSwept ?? 0) >= 1 && (gone3 ?? []).length === 0 && !afterSweep.includes(`${DIR}${S3}.jpg`), "the drain's sweep deletes the row and the picture", { status: drain.status, swept: drain.json?.storiesSwept });

  const notMine = await http("DELETE", `/api/mobile/v1/stories/${S4}`, FAN);
  check(notMine.status === 404, "someone else's delete is a 404", notMine.status);
  const del = await http("DELETE", `/api/mobile/v1/stories/${S4}`, P);
  const { data: gone4 } = await db().from("stories").select("id").eq("id", S4);
  const afterDelete = await objects(DIR);
  check(del.status === 200 && (gone4 ?? []).length === 0 && !afterDelete.includes(`${DIR}${S4}.jpg`), "the poster deletes their own story: row and picture gone", del.status);
}

main()
  .catch((e) => {
    console.error(e);
    check(false, "the script ran to the end", String(e));
  })
  .finally(async () => {
    const users = made.users;
    if (users.length) {
      const { data: rows } = await db().from("stories").select("image_path").in("auth_user_id", users);
      const paths = ((rows ?? []) as { image_path: string }[]).map((r) => r.image_path);
      if (paths.length) await db().storage.from("media").remove(paths);
      await db().from("stories").delete().in("auth_user_id", users);
      await db().from("story_blocks").delete().in("blocker_user_id", users);
      await db().from("story_bans").delete().in("auth_user_id", users);
      await db().from("story_likes").delete().in("auth_user_id", users);
      await db().from("story_reports").delete().in("reporter_user_id", users);
      await db().from("platform_admins").delete().in("auth_user_id", users);
      await db().from("organization_members").delete().in("auth_user_id", users);
      await db().from("audit_logs").delete().in("actor_user_id", users);
      await db().from("app_users").delete().in("auth_user_id", users);
    }
    await db().from("request_counters").delete().like("bucket_key", "story-%");
    for (const id of made.orgs) {
      await db().from("audit_logs").delete().eq("organization_id", id);
      await db().from("organizations").delete().eq("id", id);
    }
    const ok = await f.cleanup();
    check(ok, "cleaned up");
    finish("stories");
  });
