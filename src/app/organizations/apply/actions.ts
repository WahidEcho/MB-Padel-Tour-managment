"use server";

import { headers } from "next/headers";
import { clientIpFrom } from "@/lib/ratelimit";
import { HONEYPOT, submitApplication } from "@/lib/orgs/apply";

export type ApplyState = { ok: true; email: string } | { ok: false; message: string; field?: string } | null;

const FIELDS = ["name", "contact_name", "contact_email", "contact_phone", "sport", "city", "country", "website", "about", "via", HONEYPOT];

/** The public application form (web, and the app's link to it). See src/lib/orgs/apply.ts. */
export async function applyAction(_prev: ApplyState, formData: FormData): Promise<ApplyState> {
  const input: Record<string, unknown> = {};
  for (const k of FIELDS) {
    const v = formData.get(k);
    if (typeof v === "string") input[k] = v;
  }
  const r = await submitApplication(input, clientIpFrom(await headers()));
  return r.ok ? { ok: true, email: r.email } : { ok: false, message: r.message, field: r.field };
}
