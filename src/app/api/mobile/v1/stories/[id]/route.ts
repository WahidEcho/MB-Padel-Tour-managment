import { privateJson } from "@/lib/mobile/http";
import { deleteOwnStory } from "@/lib/stories/server";
import { refusedJson, signInFirst, storyUser } from "@/lib/stories/http";

/** DELETE: the poster deletes their own story (the picture goes too). Anyone else: 404. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const who = await storyUser(request);
  if (!who) return signInFirst();
  const done = await deleteOwnStory(who.userId, id);
  return done.ok ? privateJson({ deleted: true }) : refusedJson(done);
}
