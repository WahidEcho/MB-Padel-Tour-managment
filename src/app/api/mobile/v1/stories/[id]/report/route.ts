import { checkRateLimit } from "@/lib/ratelimit";
import { privateJson } from "@/lib/mobile/http";
import { strictBody } from "@/lib/players/http";
import { reportStory } from "@/lib/stories/server";
import { isReportReason, STORY_REPORT_REASONS } from "@/lib/stories/rules";
import { refusedJson, signInFirst, storyUser } from "@/lib/stories/http";

/**
 * POST { reason }: reports a story (one report per account). Three accounts'
 * reports hide it for everyone until staff restore or remove it (Admin → Stories).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const who = await storyUser(request);
  if (!who) return signInFirst();
  const body = await strictBody(request, ["reason"]);
  if (!body || !isReportReason(body.reason)) return privateJson({ error: `Pick a reason: ${STORY_REPORT_REASONS.join(", ")}.`, code: "bad_request" }, 400);
  const rl = await checkRateLimit({ key: `story-report:${who.userId}`, limit: 60, windowSeconds: 3600 });
  if (!rl.allowed) return privateJson({ error: "Too many reports. Try again later.", code: "too_many" }, 429);
  const done = await reportStory(who.userId, id, body.reason);
  return done.ok ? privateJson({ reported: true }) : refusedJson(done);
}
