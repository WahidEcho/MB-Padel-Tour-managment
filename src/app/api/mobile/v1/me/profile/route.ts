import { playerCaller } from "@/lib/players/http";
import { privateJson } from "@/lib/mobile/http";
import { loadMyProfile } from "@/lib/players/profile";

/** GET → { profile: MMyProfile }: the signed-in player's tournaments, sessions and results. */
export async function GET(request: Request) {
  const caller = await playerCaller(request);
  if (caller instanceof Response) return caller;
  return privateJson({ profile: await loadMyProfile(caller.userId) });
}
