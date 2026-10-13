/**
 * An organisation applying to run its events on Move Score (status 'applied';
 * Move Beyond approves or turns it down in Admin → Organisations). Server-only.
 *
 * Public and unauthenticated, so: rate-limited per network address and per
 * contact email (hashed), size-limited, only the whitelisted fields are kept
 * (src/lib/orgs/profile.ts checkApplication), nothing secret is asked for or
 * stored, and the answer is the same whatever happened (a duplicate, a bot
 * filling the hidden field, a slug that was taken).
 */
import { randomBytes } from "node:crypto";
import { db } from "../supabase";
import { audit } from "../audit";
import { checkRateLimit } from "../ratelimit";
import { emailAllowed } from "../auth/limits";
import { checkApplication, slugFromName } from "./profile";

export const APPLY_PER_IP = { limit: 5, windowSeconds: 3600 };
export const APPLY_PER_EMAIL = { limit: 3, windowSeconds: 86_400 };

export type ApplyResult = { ok: true; email: string } | { ok: false; message: string; field?: string; status?: 429 };

/** The hidden field a person never sees: a bot that fills it gets the usual answer and nothing is stored. */
export const HONEYPOT = "company_fax";

export async function submitApplication(input: Record<string, unknown>, ip: string): Promise<ApplyResult> {
  const ipGate = await checkRateLimit({ key: `org-apply:${ip}`, ...APPLY_PER_IP });
  if (!ipGate.allowed) return { ok: false, message: "Too many applications from this network. Try again later.", status: 429 };
  const checked = checkApplication(input);
  if (!checked.ok) return { ok: false, message: checked.message, field: checked.field };
  const app = checked.value;
  if (typeof input[HONEYPOT] === "string" && input[HONEYPOT]) return { ok: true, email: app.contact_email };
  if (!(await emailAllowed("org-apply", app.contact_email, APPLY_PER_EMAIL.limit, APPLY_PER_EMAIL.windowSeconds))) {
    return { ok: false, message: "We already have applications from this email today. Move Beyond will be in touch.", status: 429 };
  }
  const base = slugFromName(app.name);
  for (let attempt = 0; attempt < 4; attempt++) {
    const slug = attempt === 0 ? base : `${base.slice(0, 50)}-${randomBytes(3).toString("hex")}`;
    const { data, error } = await db()
      .from("organizations")
      .insert({
        slug,
        name: app.name,
        status: "applied",
        city: app.city,
        country: app.country,
        application: { ...app, submitted_at: new Date().toISOString(), via: typeof input.via === "string" && input.via === "app" ? "app" : "web" },
      })
      .select("id")
      .single();
    if (data) {
      await audit({ organization_id: (data as { id: string }).id, actor_role: "public", action: "ORGANIZATION_APPLIED", entity_type: "organization", entity_id: (data as { id: string }).id });
      return { ok: true, email: app.contact_email };
    }
    if (!/duplicate|unique/i.test(error?.message ?? "")) break;
  }
  return { ok: false, message: "Could not send the application. Try again in a moment." };
}
