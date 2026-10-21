/**
 * Permanent QR links. A printed QR code encodes `https://tour.mbeg.org/q/<code>`,
 * which never changes and never expires (it is our own domain, no third-party
 * shortener); the address it forwards to is a setting an admin can change at any
 * time (Admin → QR codes), so the printed code can be pointed somewhere new
 * without reprinting. Targets live in `platform_settings` under `qr_links`. Pure.
 */
export const QR_LINKS_KEY = "qr_links";

export interface QrLink {
  /** Where the code forwards to: a full https address, or a path on this site. */
  target: string;
  /** What the code is for, shown in the admin. */
  label: string;
}

/**
 * Built-in codes: they work before anyone saves a setting, and a code that has
 * been printed must never disappear, so these can be repointed but not removed.
 */
export const DEFAULT_QR_LINKS: Record<string, QrLink> = {
  app: { target: "/app", label: "Move Score app download" },
};

export const QR_CODE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** A target as stored: `https://…` or a site path (`/app`); null when it is neither. */
export function normalizeTarget(raw: string): string | null {
  const t = raw.trim();
  if (/^\/(?!\/)[^\s]*$/.test(t)) return t;
  try {
    const u = new URL(t);
    return u.protocol === "https:" && !/\s/.test(t) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The stored links over the built-in ones, every bad entry dropped. */
export function parseQrLinks(stored: unknown): Record<string, QrLink> {
  const out: Record<string, QrLink> = { ...DEFAULT_QR_LINKS };
  if (!stored || typeof stored !== "object") return out;
  for (const [code, v] of Object.entries(stored as Record<string, unknown>)) {
    if (!QR_CODE_NAME.test(code) || !v || typeof v !== "object") continue;
    const target = normalizeTarget(String((v as { target?: unknown }).target ?? ""));
    if (!target) continue;
    const label = String((v as { label?: unknown }).label ?? out[code]?.label ?? code).slice(0, 80);
    out[code] = { target, label };
  }
  return out;
}
