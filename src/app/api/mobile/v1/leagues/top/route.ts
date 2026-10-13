import { topBoard } from "@/lib/leagues/server";
import { publicJson } from "@/lib/mobile/http";

/**
 * "Top of all leagues" across the platform for a month (?month=YYYY-MM, default
 * this month): every counting league of every approved organisation that did not
 * opt out. Names and points only.
 */
export async function GET(request: Request) {
  const month = new URL(request.url).searchParams.get("month") ?? undefined;
  return publicJson(await topBoard("platform", month), 30, 300);
}
