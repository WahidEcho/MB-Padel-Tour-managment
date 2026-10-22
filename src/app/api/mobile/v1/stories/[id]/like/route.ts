import { checkRateLimit } from "@/lib/ratelimit";
import { privateJson } from "@/lib/mobile/http";
import { strictBody } from "@/lib/players/http";
import { setLike } from "@/lib/stories/server";
import { refusedJson, signInFirst, storyUser } from "@/lib/stories/http";

/** POST { liked: boolean }: one like per account and story (only the poster sees the count). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const who = await storyUser(request);
  if (!who) return signInFirst();
  const body = await strictBody(request, ["liked"]);
  if (!body || typeof body.liked !== "boolean") return privateJson({ error: "Say liked: true or false.", code: "bad_request" }, 400);
  const rl = await checkRateLimit({ key: `story-like:${who.userId}`, limit: 300, windowSeconds: 3600 });
  if (!rl.allowed) return privateJson({ error: "Slow down a little.", code: "too_many" }, 429);
  const done = await setLike(who.userId, id, body.liked);
  return done.ok ? privateJson({ liked: done.liked }) : refusedJson(done);
}
