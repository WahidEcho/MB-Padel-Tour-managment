import { privateJson } from "@/lib/mobile/http";
import { myStories } from "@/lib/stories/server";
import { signInFirst, storyUser } from "@/lib/stories/http";

/** The account's own live stories with their view and like counts, whom it blocked, and whether it may post. */
export async function GET(request: Request) {
  const who = await storyUser(request);
  if (!who) return signInFirst();
  return privateJson(await myStories(who.userId));
}
