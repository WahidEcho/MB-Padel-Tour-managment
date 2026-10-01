import { getDiscover } from "@/lib/mobile/server";
import { publicJson } from "@/lib/mobile/http";

/** Discover: the featured event, live, upcoming and past tournaments. `?demo=1` includes demo events. */
export async function GET(request: Request) {
  const demo = new URL(request.url).searchParams.get("demo") === "1";
  return publicJson(await getDiscover(demo), 30, 300);
}
