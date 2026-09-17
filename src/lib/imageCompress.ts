/**
 * Shrinking a picture in the browser, before it is uploaded.
 *
 * Every upload path in the app has a size limit, and a phone camera passes it
 * without trying: a modern handset writes 6-12 MB per frame, and the organiser
 * who picked it has no way to make it smaller on the phone. So the picker does
 * it: the file is re-encoded to fit, and only then handed to the form.
 *
 * What is never touched:
 *  - **Animated files.** A GIF, an animated WebP and an APNG all re-encode to a
 *    single still frame, which would silently kill an animated event background.
 *    They are passed through and the server's own limit applies.
 *  - **SVG**, which is markup, not pixels.
 *  - **Anything already inside the limit**, so a logo exported at exactly the
 *    right size is uploaded byte for byte.
 *
 * The decision-making here is pure and tested. Only `compressImageFile` touches
 * the browser.
 */

export const MB = 1024 * 1024;

/** Still rasters, the only things worth re-encoding. */
export const RE_ENCODABLE = ["image/jpeg", "image/png", "image/webp"];

export interface CompressTarget {
  /** The limit the finished file has to fit inside. */
  maxBytes: number;
  /**
   * Longest edge kept, in pixels. A venue screen is 1920 across and the CDN
   * never delivers more than about 800 for a portrait, so anything past 2400 is
   * weight with nothing to show for it.
   */
  maxEdge: number;
}

/** Photos and logos on the staff forms. */
export const DEFAULT_TARGET: CompressTarget = { maxBytes: 4 * MB, maxEdge: 2400 };

/** A full-screen still background: bigger, because it is shown at full size. */
export const BACKGROUND_TARGET: CompressTarget = { maxBytes: 12 * MB, maxEdge: 3840 };

/** Qualities tried in turn. The first that fits wins, so a clean photo stays clean. */
export const QUALITY_LADDER = [0.82, 0.68, 0.55, 0.42] as const;

export function isReEncodable(type: string): boolean {
  return RE_ENCODABLE.includes(type);
}

/** The box `width` x `height` fits into, keeping its shape. Never enlarges. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || longest <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxEdge / longest);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Whether this file is worth re-encoding at all.
 *
 * Only its size is known before it is decoded, so a picture that is under the
 * limit is left alone even when it is 8000 pixels wide: it uploads fine, and the
 * CDN resizes it on delivery.
 */
export function shouldCompress(file: { type: string; size: number }, target: CompressTarget): boolean {
  return isReEncodable(file.type) && file.size > target.maxBytes;
}

/**
 * The attempts, in order: every quality at full size, then the same ladder at
 * half the edge, and again at a quarter. Three rounds is enough for any phone
 * photo to reach a few hundred kilobytes.
 */
export function attemptPlan(target: CompressTarget): { maxEdge: number; quality: number }[] {
  return [1, 0.5, 0.25].flatMap((shrink) =>
    QUALITY_LADDER.map((quality) => ({ maxEdge: Math.round(target.maxEdge * shrink), quality })),
  );
}

/** The type the re-encoded file should carry. WebP keeps transparency; JPEG does not. */
export function outputType(sourceType: string): string {
  return sourceType === "image/jpeg" ? "image/jpeg" : "image/webp";
}

/** The same name with the extension the new bytes deserve. */
export function renamed(name: string, type: string): string {
  const ext = type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : "png";
  const base = name.replace(/\.[^.]+$/, "") || "photo";
  return `${base}.${ext}`;
}

function mb(bytes: number): string {
  return bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function describeShrink(fromBytes: number, toBytes: number): string {
  return `Compressed from ${mb(fromBytes)} to ${mb(toBytes)} so it can be uploaded.`;
}

/**
 * Whether these bytes are an animation, from the header alone.
 *
 * A GIF is assumed to be one — a still GIF is rare and losing nothing by being
 * left alone. WebP says so with an ANIM chunk, and PNG with acTL before IDAT.
 */
export function looksAnimated(bytes: Uint8Array, type: string): boolean {
  if (type === "image/gif") return true;
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...Array.from(bytes.subarray(start, start + length)));
  if (type === "image/webp") {
    // RIFF....WEBPVP8X, with the animation flag in the VP8X chunk, or an ANIM chunk.
    if (bytes.length >= 21 && ascii(12, 4) === "VP8X" && (bytes[20] & 0x02) !== 0) return true;
    return ascii(0, Math.min(bytes.length, 4096)).includes("ANIM");
  }
  if (type === "image/png") {
    // acTL must precede IDAT, so only the head is worth reading.
    const head = ascii(0, Math.min(bytes.length, 4096));
    const idat = head.indexOf("IDAT");
    const actl = head.indexOf("acTL");
    return actl !== -1 && (idat === -1 || actl < idat);
  }
  return false;
}

export interface CompressResult {
  /** The file to upload: the original when nothing was done. */
  file: File;
  changed: boolean;
  fromBytes: number;
  toBytes: number;
  /** A line for the operator, or null when there is nothing to say. */
  note: string | null;
}

function unchanged(file: File, note: string | null = null): CompressResult {
  return { file, changed: false, fromBytes: file.size, toBytes: file.size, note };
}

/** Draws the bitmap at `width` x `height` and encodes it. Null when the browser refuses. */
async function encode(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  type: string,
  quality: number,
): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // A white ground for JPEG, which has no transparency: without it a PNG's
  // transparent corners come out black.
  if (type === "image/jpeg") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Re-encodes `file` until it fits, or gives it back untouched when it already
 * does, cannot be re-encoded, or the browser cannot decode it.
 *
 * Never returns something larger than what it was given.
 */
export async function compressImageFile(file: File, target: CompressTarget = DEFAULT_TARGET): Promise<CompressResult> {
  if (!shouldCompress(file, target)) return unchanged(file);
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") return unchanged(file);

  try {
    const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    if (looksAnimated(head, file.type)) {
      return unchanged(file, "This picture is animated, so it is uploaded as it is.");
    }
  } catch {
    return unchanged(file);
  }

  let bitmap: ImageBitmap;
  try {
    // From the image, so a phone photo taken sideways is not uploaded rotated.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return unchanged(file);
  }

  const type = outputType(file.type);
  let best: Blob | null = null;
  try {
    for (const attempt of attemptPlan(target)) {
      const box = fitWithin(bitmap.width, bitmap.height, attempt.maxEdge);
      const blob = await encode(bitmap, box.width, box.height, type, attempt.quality);
      if (!blob) break;
      if (!best || blob.size < best.size) best = blob;
      if (blob.size <= target.maxBytes) break;
    }
  } finally {
    bitmap.close?.();
  }

  // The encoder can hand back something bigger than a well-packed original, and
  // a browser with no WebP encoder quietly returns a PNG. Either way, only an
  // actual saving is worth taking.
  if (!best || best.size >= file.size) return unchanged(file);

  const outType = best.type || type;
  const out = new File([best], renamed(file.name, outType), { type: outType, lastModified: file.lastModified });
  return {
    file: out,
    changed: true,
    fromBytes: file.size,
    toBytes: out.size,
    note: describeShrink(file.size, out.size),
  };
}
