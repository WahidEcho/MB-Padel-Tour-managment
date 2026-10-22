import { publicJson, privateJson } from "@/lib/mobile/http";
import { checkStoryImage, postStory, publicFeed } from "@/lib/stories/server";
import { parseStoryContext, STORY_MAX_BYTES } from "@/lib/stories/rules";
import { refusedJson, signInFirst, storyUser } from "@/lib/stories/http";

/**
 * Move Score Stories (migration 0043).
 *
 * GET: every public event's live stories, grouped by poster: the same answer for
 * everyone (signed in or not), shared at the CDN for a few seconds. No account id,
 * no moderation fields: posters are opaque keys. A signed-in phone reads
 * GET /me/stories/feed instead, which leaves out the posters it blocked.
 *
 * POST { image: base64 JPEG, context: { kind: "match", matchId } | { kind: "tie", tieId, slug? } |
 * { kind: "pass", slug } } → 201 { story }. Signed-in accounts only (401 code "sign_in"),
 * not banned (403 "banned"), a public event only (404 "context"), 20 a day (429 "too_many").
 * The picture is the story composer's 1080×1920 JPEG, at most 2 MB, checked by its bytes.
 */
export async function GET() {
  return publicJson(await publicFeed(), 10, 30);
}

export async function POST(request: Request) {
  const who = await storyUser(request);
  if (!who) return signInFirst();
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > Math.ceil((STORY_MAX_BYTES * 4) / 3) + 4096) return privateJson({ error: "That picture is too large.", code: "image_size" }, 413);
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return privateJson({ error: "No story was sent.", code: "bad_request" }, 400);
  const extra = Object.keys(body).filter((k) => k !== "image" && k !== "context");
  if (extra.length) return privateJson({ error: `Unknown field: ${extra[0].slice(0, 40)}`, code: "bad_request" }, 400);
  const context = parseStoryContext((body as { context?: unknown }).context);
  if (!context) return privateJson({ error: "Post a story from a match, a tie or your pass.", code: "context" }, 400);
  const image = checkStoryImage((body as { image?: unknown }).image);
  if (!image.ok) return refusedJson(image);
  const done = await postStory({ userId: who.userId, accessToken: who.token, bytes: image.bytes, context });
  if (!done.ok) return refusedJson(done);
  return privateJson({ story: done.story }, 201);
}
