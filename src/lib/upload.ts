import { db, mediaPublicUrl } from "./supabase";

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml"];

/** Raster types only. SVG is markup that can carry script, so photos exclude it. */
export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

/**
 * The real type of the bytes, ignoring what the upload claimed.
 *
 * A declared MIME type is attacker-controlled; the first few bytes are not. Used
 * on the path that accepts uploads from the public, so a file named `me.jpg`
 * cannot arrive as something else.
 */
export function sniffImageType(bytes: Uint8Array): string | null {
  const at = (i: number) => bytes[i];
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 &&
    at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a
  ) {
    return "image/png";
  }
  const ascii = (start: number, len: number) =>
    String.fromCharCode(...Array.from(bytes.slice(start, start + len)));
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "image/gif";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  return null;
}

/**
 * Width and height from an image's header, without decoding it.
 *
 * Used for sponsor logos, so the footer can lay a logo out at its real shape
 * before it has loaded — otherwise the loop's width changes as logos arrive and
 * the crawl jumps. Null when the format is unknown or the header is damaged.
 */
export function imageDimensions(bytes: Uint8Array, type?: string): { width: number; height: number } | null {
  const u16be = (i: number) => (bytes[i] << 8) | bytes[i + 1];
  const u16le = (i: number) => bytes[i] | (bytes[i + 1] << 8);
  const u24le = (i: number) => bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16);
  const u32be = (i: number) => ((bytes[i] << 24) >>> 0) + (bytes[i + 1] << 16) + (bytes[i + 2] << 8) + bytes[i + 3];
  const ok = (d: { width: number; height: number }) => (d.width > 0 && d.height > 0 ? d : null);
  const kind = sniffImageType(bytes.slice(0, 16));

  if (kind === "image/png" && bytes.length >= 24) return ok({ width: u32be(16), height: u32be(20) });
  if (kind === "image/gif" && bytes.length >= 10) return ok({ width: u16le(6), height: u16le(8) });
  if (kind === "image/webp" && bytes.length >= 30) {
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunk === "VP8X") return ok({ width: u24le(24) + 1, height: u24le(27) + 1 });
    if (chunk === "VP8L") {
      const b = bytes.slice(21, 25);
      return ok({ width: 1 + (((b[1] & 0x3f) << 8) | b[0]), height: 1 + (((b[3] & 0x0f) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6)) });
    }
    if (chunk === "VP8 ") return ok({ width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff });
    return null;
  }
  if (kind === "image/jpeg") {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      // SOF0..SOF15 carry the frame size, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return ok({ width: u16be(i + 7), height: u16be(i + 5) });
      }
      i += 2 + u16be(i + 2);
    }
    return null;
  }
  if (type === "image/svg+xml") {
    const text = new TextDecoder().decode(bytes.slice(0, 4096));
    const box = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text);
    if (box) return ok({ width: parseFloat(box[1]), height: parseFloat(box[2]) });
    const w = /<svg[^>]*\swidth\s*=\s*["']([\d.]+)/i.exec(text);
    const h = /<svg[^>]*\sheight\s*=\s*["']([\d.]+)/i.exec(text);
    if (w && h) return ok({ width: parseFloat(w[1]), height: parseFloat(h[1]) });
  }
  return null;
}

export interface UploadOptions {
  /** Declared types to accept. Defaults to every image type, SVG included. */
  allow?: string[];
  maxBytes?: number;
  /**
   * Reject when the bytes do not match an accepted type. On by default for
   * anything but SVG, which has no signature to check.
   */
  sniff?: boolean;
  /**
   * Seconds the CDN may keep the object. A year is safe because every upload
   * gets a fresh path, so a replaced photo is a new URL rather than a stale
   * copy to bust. (Supabase storage takes max-age, not `immutable`.)
   */
  cacheSeconds?: number;
}

/** Uploads an image to the public media bucket; returns its public URL. */
export async function uploadImage(file: File, prefix: string, opts: UploadOptions = {}): Promise<string> {
  const allow = opts.allow ?? ALLOWED;
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  if (file.size === 0) throw new Error("Empty file");
  if (file.size > maxBytes) {
    throw new Error(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${Math.round(maxBytes / 1024 / 1024)} MB — export it smaller.`);
  }
  if (!allow.includes(file.type)) throw new Error("Unsupported image type");

  const bytes = await file.arrayBuffer();
  const sniff = opts.sniff ?? file.type !== "image/svg+xml";
  if (sniff) {
    const actual = sniffImageType(new Uint8Array(bytes.slice(0, 16)));
    if (!actual || !allow.includes(actual)) {
      throw new Error("That file is not the kind of image it claims to be.");
    }
  }

  const ext = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  // The timestamp is deliberate cache-busting: replacing a photo produces a new
  // path rather than fighting a cached copy at the old one.
  const path = `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await db().storage.from("media").upload(path, bytes, {
    contentType: file.type,
    upsert: false,
    cacheControl: String(opts.cacheSeconds ?? 31536000),
  });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return mediaPublicUrl(path);
}

/** A sponsor or brand logo: uploaded like any image, with its shape measured from the header. */
export async function uploadLogo(file: File, prefix: string): Promise<{ url: string; aspect?: number }> {
  const head = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
  const dims = imageDimensions(head, file.type);
  const url = await uploadImage(file, prefix);
  return { url, ...(dims ? { aspect: Math.round((dims.width / dims.height) * 1000) / 1000 } : {}) };
}

/** Deletes previously uploaded objects. Missing paths are not an error. */
export async function deleteUploads(urls: (string | null | undefined)[]): Promise<void> {
  const prefix = mediaPublicUrl("");
  const paths = urls
    .filter((u): u is string => Boolean(u) && u!.startsWith(prefix))
    .map((u) => u.slice(prefix.length));
  if (paths.length > 0) await db().storage.from("media").remove(paths);
}
