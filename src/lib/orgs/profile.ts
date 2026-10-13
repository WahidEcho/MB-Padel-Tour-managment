/**
 * An organisation's public profile and branding, its application to join, and
 * Move Beyond's billing fields: the shapes, limits and sanitisers. Pure (no Node,
 * browser or Next.js APIs), so every rule here is unit-tested.
 *
 * Public means exactly the fields of `PublicOrgProfile`: never member emails,
 * event codes, the application, the plan/billing or the top-board switch.
 */

export const ORG_LIMITS = {
  name: 120,
  about: 2000,
  city: 80,
  country: 80,
  venues: 10,
  venueName: 80,
  venueAddress: 200,
  courts: 50,
  contactName: 120,
  phone: 40,
  website: 200,
  sport: 40,
  email: 254,
} as const;

const HEX = /^#[0-9a-fA-F]{6}$/;
/** Logos come from our own upload path: https, or the local stand-in's http. */
export const isLogoUrl = (u: unknown): u is string => typeof u === "string" && u.length <= 1000 && /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/)/.test(u);

export interface OrgColors {
  primary: string | null;
  accent: string | null;
}

export interface OrgVenue {
  name: string;
  address: string | null;
  courts: number | null;
}

export interface OrgPlan {
  tier: "free" | "standard" | "pro";
  commission_pct: number;
  subscription_status: "none" | "trial" | "active" | "past_due" | "cancelled";
  limits: Record<string, unknown>;
}

export const PLAN_TIERS: OrgPlan["tier"][] = ["free", "standard", "pro"];
export const SUBSCRIPTION_STATUSES: OrgPlan["subscription_status"][] = ["none", "trial", "active", "past_due", "cancelled"];

/** Trimmed, control characters dropped, cut to `max`; null when empty. */
export function cleanText(v: unknown, max: number, multiline = false): string | null {
  if (typeof v !== "string") return null;
  const s = (multiline ? v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "") : v.replace(/[\u0000-\u001f\u007f]/g, " "))
    .replace(multiline ? /[ \t]+/g : /\s+/g, " ")
    .trim();
  return s ? s.slice(0, max) : null;
}

export function cleanColor(v: unknown): string | null {
  return typeof v === "string" && HEX.test(v.trim()) ? v.trim().toLowerCase() : null;
}

export function cleanColors(v: unknown): OrgColors {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return { primary: cleanColor(o.primary), accent: cleanColor(o.accent) };
}

export function cleanVenues(v: unknown): OrgVenue[] {
  if (!Array.isArray(v)) return [];
  const out: OrgVenue[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const name = cleanText(r.name, ORG_LIMITS.venueName);
    if (!name) continue;
    const n = typeof r.courts === "number" ? r.courts : parseInt(String(r.courts ?? ""), 10);
    out.push({
      name,
      address: cleanText(r.address, ORG_LIMITS.venueAddress),
      courts: Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), ORG_LIMITS.courts) : null,
    });
    if (out.length >= ORG_LIMITS.venues) break;
  }
  return out;
}

/** The plan as stored (defaults for anything missing or unknown). */
export function cleanPlan(v: unknown): OrgPlan {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const pct = typeof o.commission_pct === "number" ? o.commission_pct : parseFloat(String(o.commission_pct ?? ""));
  return {
    tier: PLAN_TIERS.includes(o.tier as OrgPlan["tier"]) ? (o.tier as OrgPlan["tier"]) : "free",
    commission_pct: Number.isFinite(pct) ? Math.min(100, Math.max(0, Math.round(pct * 100) / 100)) : 0,
    subscription_status: SUBSCRIPTION_STATUSES.includes(o.subscription_status as OrgPlan["subscription_status"])
      ? (o.subscription_status as OrgPlan["subscription_status"])
      : "none",
    limits: o.limits && typeof o.limits === "object" && !Array.isArray(o.limits) ? (o.limits as Record<string, unknown>) : {},
  };
}

/* ---------------- what the public sees ---------------- */

export interface OrgRowPublicPart {
  slug: string;
  name: string;
  logo_url: string | null;
  colors: unknown;
  about: string | null;
  city: string | null;
  country: string | null;
  venues: unknown;
}

export interface PublicOrgProfile {
  slug: string;
  name: string;
  logoUrl: string | null;
  colors: OrgColors;
  about: string | null;
  city: string | null;
  country: string | null;
  venues: OrgVenue[];
}

/** Only these columns are ever read for a public profile. */
export const PUBLIC_ORG_COLUMNS = "id, slug, name, status, logo_url, colors, about, city, country, venues";

export function toPublicOrg(o: OrgRowPublicPart): PublicOrgProfile {
  return {
    slug: o.slug,
    name: o.name,
    logoUrl: isLogoUrl(o.logo_url) ? o.logo_url : null,
    colors: cleanColors(o.colors),
    about: o.about ?? null,
    city: o.city ?? null,
    country: o.country ?? null,
    venues: cleanVenues(o.venues),
  };
}

/* ---------------- applying ---------------- */

export interface OrgApplication {
  name: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string | null;
  sport: string | null;
  city: string | null;
  country: string | null;
  website: string | null;
  about: string | null;
}

export type ApplicationCheck = { ok: true; value: OrgApplication } | { ok: false; field: keyof OrgApplication | "form"; message: string };

const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
/** Text that looks like a credential is refused: an application never needs one. */
const SECRETISH = /\b(password|passwd|pwd|api[_ -]?key|secret|token|otp)\s*[:=]/i;

/**
 * An application as typed, checked. Only the whitelisted fields survive; every
 * other field is ignored. A form whose values together exceed `maxTotal`
 * characters is refused outright.
 */
export function checkApplication(input: Record<string, unknown>, maxTotal = 6000): ApplicationCheck {
  const total = Object.values(input).reduce<number>((n, v) => n + (typeof v === "string" ? v.length : 0), 0);
  if (total > maxTotal) return { ok: false, field: "form", message: "That is too long. Keep the application short." };
  const name = cleanText(input.name, ORG_LIMITS.name);
  if (!name || name.length < 2) return { ok: false, field: "name", message: "Enter the organisation's name." };
  const contact_name = cleanText(input.contact_name, ORG_LIMITS.contactName);
  if (!contact_name) return { ok: false, field: "contact_name", message: "Enter your name." };
  const contact_email = (cleanText(input.contact_email, ORG_LIMITS.email) ?? "").toLowerCase();
  if (!EMAIL.test(contact_email)) return { ok: false, field: "contact_email", message: "Enter a valid email address." };
  const phone = cleanText(input.contact_phone, ORG_LIMITS.phone);
  if (phone && !/^[+()\d\s-]{6,40}$/.test(phone)) return { ok: false, field: "contact_phone", message: "Enter a phone number (digits, spaces, + and - only)." };
  const website = cleanText(input.website, ORG_LIMITS.website);
  if (website && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(website)) return { ok: false, field: "website", message: "Enter the website as https://…" };
  const value: OrgApplication = {
    name,
    contact_name,
    contact_email,
    contact_phone: phone,
    sport: cleanText(input.sport, ORG_LIMITS.sport),
    city: cleanText(input.city, ORG_LIMITS.city),
    country: cleanText(input.country, ORG_LIMITS.country),
    website,
    about: cleanText(input.about, ORG_LIMITS.about, true),
  };
  if (Object.values(value).some((v) => typeof v === "string" && SECRETISH.test(v))) {
    return { ok: false, field: "form", message: "Please don't include passwords, keys or codes in an application." };
  }
  return { ok: true, value };
}

/** "Cairo Padel Club!" → "cairo-padel-club". Always a valid organisation slug (2–60). */
export function slugFromName(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return s.length >= 2 ? s : `org-${s || "new"}`.replace(/-+$/, "");
}

/* ---------------- branding into the app skin ---------------- */

/** The organisation's colours and logo, as defaults for a tournament skin that has none of its own. */
export function orgSkinDefaults(o: { colors?: unknown; logo_url?: string | null } | null | undefined): { seedA: string | null; seedB: string | null; logoUrl: string | null } {
  if (!o) return { seedA: null, seedB: null, logoUrl: null };
  const c = cleanColors(o.colors);
  return { seedA: c.primary, seedB: c.accent, logoUrl: isLogoUrl(o.logo_url) ? o.logo_url : null };
}
