import { privateJson } from "@/lib/mobile/http";
import { blockPoster } from "@/lib/stories/server";
import { refusedJson, signInFirst, storyUser } from "@/lib/stories/http";

/**
 * POST: blocks this story's poster for the signed-in account: their stories never
 * reach it again (GET /me/stories/feed leaves them out). Unblocking: POST
 * /me/stories/blocks { unblock: key }.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const who = await storyUser(request);
  if (!who) return signInFirst();
  const done = await blockPoster(who.userId, id);
  return done.ok ? privateJson({ blocked: true, key: done.key }) : refusedJson(done);
}
