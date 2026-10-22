import { privateJson } from "@/lib/mobile/http";
import { strictBody } from "@/lib/players/http";
import { unblockPoster } from "@/lib/stories/server";
import { refusedJson, signInFirst, storyUser } from "@/lib/stories/http";

/** POST { unblock: key }: shows a blocked poster's stories again (key from GET /me/stories `blocked`). */
export async function POST(request: Request) {
  const who = await storyUser(request);
  if (!who) return signInFirst();
  const body = await strictBody(request, ["unblock"]);
  if (!body || typeof body.unblock !== "string" || !/^p-[A-Za-z0-9_-]{6,40}$/.test(body.unblock)) return privateJson({ error: "Say which poster to unblock.", code: "bad_request" }, 400);
  const done = await unblockPoster(who.userId, body.unblock);
  return done.ok ? privateJson({ unblocked: true }) : refusedJson(done);
}
