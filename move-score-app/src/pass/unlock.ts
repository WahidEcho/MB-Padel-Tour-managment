import type { MPass } from "@core";
import { api } from "../api/client";
import { rememberPass } from "./usePass";

/** Parses the venue code's link: https://<site>/v/<event>?c=<code> */
export function parseVenueLink(data: string): { groupSlug: string; code: string } | null {
  const m = /\/v\/([a-z0-9-]+)\?(?:.*&)?c=([A-Za-z0-9]+)/i.exec(data);
  return m ? { groupSlug: decodeURIComponent(m[1]!), code: m[2]! } : null;
}

/** stampedDay is null when the scan unlocked the on-site edition outside the event's days. */
export async function unlockWith(groupSlug: string, code: string): Promise<{ pass: MPass; stampedDay: string | null }> {
  const r = await api<{ pass: MPass; stampedDay: string | null }>("/api/mobile/v1/passes/unlock", { who: "me", body: { groupSlug, code } });
  rememberPass(r.pass.eventGroupId, { pass: r.pass });
  return r;
}
