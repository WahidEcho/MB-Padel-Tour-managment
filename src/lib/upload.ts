import { db, mediaPublicUrl } from "./supabase";

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml"];

/** Uploads an image to the public media bucket; returns its public URL. */
export async function uploadImage(file: File, prefix: string): Promise<string> {
  if (file.size === 0) throw new Error("Empty file");
  if (file.size > MAX_BYTES) throw new Error("Image too large (max 8 MB)");
  if (!ALLOWED.includes(file.type)) throw new Error("Unsupported image type");

  const ext = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const path = `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const bytes = await file.arrayBuffer();
  const { error } = await db().storage.from("media").upload(path, bytes, {
    contentType: file.type,
    upsert: false,
  });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return mediaPublicUrl(path);
}
