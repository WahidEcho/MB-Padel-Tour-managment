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

/** Deletes previously uploaded objects. Missing paths are not an error. */
export async function deleteUploads(urls: (string | null | undefined)[]): Promise<void> {
  const prefix = mediaPublicUrl("");
  const paths = urls
    .filter((u): u is string => Boolean(u) && u!.startsWith(prefix))
    .map((u) => u.slice(prefix.length));
  if (paths.length > 0) await db().storage.from("media").remove(paths);
}
