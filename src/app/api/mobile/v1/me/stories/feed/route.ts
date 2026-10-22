import { notFoundJson, privateJson } from "@/lib/mobile/http";
import { feedFor, publicTournamentId } from "@/lib/stories/server";
import { signInFirst, storyUser } from "@/lib/stories/http";

/**
 * The signed-in account's feed (all public events, or `?t=<slug>`): GET /stories
 * without the posters it blocked, its likes marked, and the counts on its own
 * stories. Per account, never cached.
 */
export async function GET(request: Request) {
  const who = await storyUser(request);
  if (!who) return signInFirst();
  const slug = new URL(request.url).searchParams.get("t");
  let tournamentId: string | undefined;
  if (slug) {
    const id = await publicTournamentId(slug);
    if (!id) return notFoundJson("Tournament not found");
    tournamentId = id;
  }
  return privateJson(await feedFor(who.userId, tournamentId));
}
