import { getConfig } from "@/lib/mobile/server";
import { publicJson } from "@/lib/mobile/http";

export async function GET() {
  return publicJson(await getConfig(), 60, 600);
}
