import { privateJson } from "@/lib/mobile/http";
import { recordView } from "@/lib/stories/server";
import { refusedJson, storyViewer } from "@/lib/stories/http";

/**
 * POST: this phone saw the story (counted once per account, or per phone when
 * signed out; only the poster sees the count). Needs the install token at least.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await storyViewer(request);
  if (!viewer) return privateJson({ counted: false });
  const done = await recordView(viewer, id);
  return done.ok ? privateJson({ counted: true }) : refusedJson(done);
}
