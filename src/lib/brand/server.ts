/**
 * Branding, server side: an event's brand from its rows (tournament, event group,
 * organisation) and the bytes of a logo for files that embed it (Excel, share images).
 * Pure part: brand.ts.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "../supabase";
import { isSafeImageUrl } from "../sponsors";
import { SITE_URL } from "../site";
import type { BrandingConfig } from "../types";
import { plainBrand, resolveEventBrand, type EventBrand } from "./brand";

/** The brand of a tournament's event (its group's name when it has one). Never throws. */
export async function loadEventBrand(tournamentId: string): Promise<EventBrand> {
  try {
    const { data } = await db().from("tournaments").select("id, name, branding_config, app_skin, event_group_id, organization_id").eq("id", tournamentId).maybeSingle();
    const t = data as { id: string; name: string; branding_config: BrandingConfig | null; app_skin: { seedA?: string | null; seedB?: string | null; logoUrl?: string | null } | null; event_group_id: string | null; organization_id: string | null } | null;
    if (!t) return plainBrand("Move Score");
    const [g, o] = await Promise.all([
      t.event_group_id ? db().from("event_groups").select("name").eq("id", t.event_group_id).maybeSingle() : Promise.resolve({ data: null }),
      t.organization_id ? db().from("organizations").select("name, slug, logo_url, colors").eq("id", t.organization_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    return resolveEventBrand({ tournament: t, group: (g.data as { name: string } | null) ?? null, org: (o.data as { name: string; slug: string; logo_url: string | null; colors: unknown } | null) ?? null });
  } catch {
    return plainBrand("Move Score");
  }
}

export interface ImageBytes {
  buffer: Buffer;
  /** What ExcelJS and Satori take: png or jpeg (anything else is converted to png when possible). */
  extension: "png" | "jpeg";
  width: number;
  height: number;
}

const MAX_BYTES = 3 * 1024 * 1024;
const cache = new Map<string, Promise<ImageBytes | null>>();

function sniff(buf: Buffer): "png" | "jpeg" | "gif" | "webp" | "svg" | null {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return "jpeg";
  if (buf.length > 6 && buf.subarray(0, 3).toString() === "GIF") return "gif";
  if (buf.length > 12 && buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return "webp";
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(buf.subarray(0, 600).toString("utf8"))) return "svg";
  return null;
}

/** PNG width/height from its IHDR; JPEG from its first SOF marker. */
function dimensions(buf: Buffer, ext: "png" | "jpeg"): { width: number; height: number } {
  if (ext === "png") return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return { width: 1, height: 1 };
}

async function toPng(buf: Buffer, maxHeight: number): Promise<ImageBytes | null> {
  try {
    const sharp = (await import("sharp")).default;
    const out = await sharp(buf, { density: 200 }).resize({ height: maxHeight, withoutEnlargement: false, fit: "inside" }).png().toBuffer({ resolveWithObject: true });
    return { buffer: out.data, extension: "png", width: out.info.width, height: out.info.height };
  } catch {
    return null;
  }
}

/**
 * The server fetches a logo only from our own storage (the Supabase project the uploads
 * go to) or our own site: never an arbitrary address an organiser typed (a print page
 * still shows those, fetched by the browser).
 */
export function fetchableLogo(src: string): boolean {
  if (!isSafeImageUrl(src)) return false;
  const origin = new URL(src).origin;
  const own = [process.env.SUPABASE_URL, process.env.PUBLIC_SITE_URL, SITE_URL].flatMap((u) => {
    try {
      return u ? [new URL(u).origin] : [];
    } catch {
      return [];
    }
  });
  return own.includes(origin);
}

async function load(src: string, maxHeight: number): Promise<ImageBytes | null> {
  let buf: Buffer;
  if (src.startsWith("/") && !src.startsWith("//")) {
    // Our own files (public/), never outside it.
    if (src.includes("..")) return null;
    buf = await readFile(join(process.cwd(), "public", src));
  } else {
    if (!fetchableLogo(src)) return null;
    const res = await fetch(src, { signal: AbortSignal.timeout(4000), redirect: "error" });
    if (!res.ok) return null;
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_BYTES) return null;
    buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) return null;
  }
  const kind = sniff(buf);
  if (!kind) return null;
  if (kind === "png" || kind === "jpeg") {
    const d = dimensions(buf, kind);
    // Big photos are shrunk (when sharp is there) so a workbook stays small.
    if (d.height > maxHeight * 2) return (await toPng(buf, maxHeight)) ?? { buffer: buf, extension: kind, ...d };
    return { buffer: buf, extension: kind, ...d };
  }
  return toPng(buf, maxHeight);
}

/**
 * A logo's bytes as PNG or JPEG: a public path ("/brand/…") or an https URL the
 * organiser set (event, organisation, sponsor logos). Null when it cannot be read in
 * time or is not an image: the file is made without it. Cached per process.
 */
export function imageBytes(src: string | null | undefined, maxHeight = 240): Promise<ImageBytes | null> {
  if (!src) return Promise.resolve(null);
  const key = `${maxHeight}:${src}`;
  let p = cache.get(key);
  if (!p) {
    p = load(src, maxHeight).catch(() => null);
    cache.set(key, p);
    // Remote logos change: keep them five minutes; our own files for good.
    if (!src.startsWith("/")) setTimeout(() => cache.delete(key), 5 * 60_000).unref?.();
  }
  return p;
}

/** A data: URI for Satori (share images). */
export function dataUri(img: ImageBytes | null): string | null {
  return img ? `data:image/${img.extension};base64,${img.buffer.toString("base64")}` : null;
}
