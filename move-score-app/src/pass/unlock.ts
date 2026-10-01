import type { MPass } from "@core";
import { api } from "../api/client";
import { queryClient } from "../api/queries";

/** Parses the venue code's link: https://<site>/v/<event>?c=<code> */
export function parseVenueLink(data: string): { groupSlug: string; code: string } | null {
  const m = /\/v\/([a-z0-9-]+)\?(?:.*&)?c=([A-Za-z0-9]+)/i.exec(data);
  return m ? { groupSlug: decodeURIComponent(m[1]!), code: m[2]! } : null;
}

export async function unlockWith(groupSlug: string, code: string): Promise<{ pass: MPass; stampedDay: string }> {
  const r = await api<{ pass: MPass; stampedDay: string }>("/api/mobile/v1/passes/unlock", { who: "me", body: { groupSlug, code } });
  queryClient.setQueryData(["pass", r.pass.eventGroupId], { pass: r.pass });
  return r;
}
