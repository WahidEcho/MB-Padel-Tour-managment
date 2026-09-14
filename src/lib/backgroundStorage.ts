/**
 * Storage work for the event background. Server-only: it uses the service key.
 */
import { randomBytes } from "node:crypto";
import { db, mediaPublicUrl } from "./supabase";
import { deleteUploads } from "./upload";
import {
  BACKGROUND_TYPES,
  DEFAULT_DIM,
  backgroundPath,
  backgroundProblem,
  isBackgroundPath,
  sanitizeSvg,
  sniffBackground,
} from "./background";
import type { BrandingConfig, EventBackground } from "./types";

const YEAR_SECONDS = 31536000;

function stamp(): string {
  return `${Date.now()}-${randomBytes(4).toString("hex")}`;
}

/** A one-time link the organiser's browser uploads the file to directly. */
export async function createBackgroundUpload(
  tournamentId: string,
  file: { type: string; size: number },
): Promise<{ ok: true; path: string; signedUrl: string } | { ok: false; message: string }> {
  const problem = backgroundProblem(file);
  if (problem) return { ok: false, message: problem };
  const path = backgroundPath(tournamentId, file.type, stamp());
  const { data, error } = await db().storage.from("media").createSignedUploadUrl(path);
  if (error || !data) return { ok: false, message: "Could not start the upload. Try again." };
  return { ok: true, path, signedUrl: data.signedUrl };
}

/**
 * The first bytes of a stored object and its full size, read through the
 * authenticated endpoint — never the public URL, whose CDN would keep a copy of a
 * file that is about to be refused.
 */
async function readHead(path: string): Promise<{ head: Uint8Array; size: number } | null> {
  const key = process.env.SUPABASE_KEY ?? "";
  const res = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/authenticated/media/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Range: "bytes=0-8191" },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const head = new Uint8Array(await res.arrayBuffer()).slice(0, 8192);
  const range = res.headers.get("content-range");
  const total = range ? Number(range.split("/")[1]) : Number(res.headers.get("content-length"));
  return { head, size: Number.isFinite(total) && total > 0 ? total : head.length };
}

async function remove(path: string) {
  await db().storage.from("media").remove([path]);
}

/**
 * Checks what arrived and turns it into the event's background. A file that is not
 * what it claims, or is too large, is deleted and refused. An SVG is published
 * only after it is cleaned, under a new name, so no copy of the original is ever
 * served.
 */
export async function acceptBackgroundUpload(
  tournamentId: string,
  path: string,
  previous: EventBackground | undefined,
): Promise<{ ok: true; background: EventBackground; removed: string[] } | { ok: false; message: string }> {
  if (!isBackgroundPath(tournamentId, path)) return { ok: false, message: "That upload does not belong to this event." };
  const read = await readHead(path);
  if (!read) return { ok: false, message: "The upload did not arrive. Try again." };

  const mime = sniffBackground(read.head);
  const type = mime ? BACKGROUND_TYPES[mime] : undefined;
  if (!mime || !type || type.ext !== path.split(".").pop()) {
    await remove(path);
    return { ok: false, message: "That file is not the kind of file it claims to be." };
  }
  const tooBig = backgroundProblem({ type: mime, size: read.size });
  if (tooBig) {
    await remove(path);
    return { ok: false, message: tooBig };
  }

  let finalPath = path;
  let bytes = read.size;
  let removed: string[] = [];
  if (type.kind === "svg") {
    const { data, error } = await db().storage.from("media").download(path);
    if (error || !data) return { ok: false, message: "The upload did not arrive. Try again." };
    const cleaned = sanitizeSvg(await data.text());
    removed = cleaned.removed;
    if (removed.length > 0) {
      finalPath = backgroundPath(tournamentId, mime, stamp());
      const body = new Blob([cleaned.svg], { type: mime });
      const up = await db().storage.from("media").upload(finalPath, body, {
        contentType: mime,
        cacheControl: String(YEAR_SECONDS),
        upsert: false,
      });
      await remove(path);
      if (up.error) return { ok: false, message: "Could not publish the cleaned SVG. Try again." };
      bytes = body.size;
    }
  }

  return {
    ok: true,
    removed,
    background: {
      url: mediaPublicUrl(finalPath),
      kind: type.kind,
      mime,
      bytes,
      dim: previous?.dim ?? DEFAULT_DIM,
      showOnPublic: previous?.showOnPublic ?? false,
    },
  };
}

/**
 * Deletes a replaced background's file unless another event still shows it — a
 * cloned tournament starts out sharing its source's background. When the check
 * itself fails, the file is kept: an orphaned file costs storage, a deleted one
 * blanks another event's walls.
 */
export async function removeBackgroundIfUnused(url: string | undefined): Promise<void> {
  if (!url) return;
  const { data, error } = await db()
    .from("tournaments")
    .select("id")
    .eq("branding_config->background->>url", url)
    .limit(1);
  if (error || !Array.isArray(data)) return;
  if (data.length === 0) await deleteUploads([url]);
}

export function withBackground(branding: BrandingConfig, background: EventBackground | undefined): BrandingConfig {
  const next = { ...branding };
  if (background) next.background = background;
  else delete next.background;
  return next;
}

/**
 * Writes a tournament's branding built from the row as it is now, and only if
 * nobody wrote it in between; otherwise reads again and rebuilds. Two organisers
 * (or the settings page and a session page in two tabs) saving at once can then
 * never put back a background whose file the other has just replaced and deleted.
 *
 * Returns the branding the write replaced, so a caller deletes only files its own
 * write took off the screens.
 */
export async function updateBranding(
  tournamentId: string,
  build: (current: BrandingConfig) => BrandingConfig,
): Promise<{ ok: true; before: BrandingConfig; after: BrandingConfig } | { ok: false }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data: row, error } = await db()
      .from("tournaments")
      .select("branding_config, updated_at")
      .eq("id", tournamentId)
      .maybeSingle();
    if (error || !row) return { ok: false };
    const current = (row as { branding_config: BrandingConfig | null; updated_at: string | null });
    const before = current.branding_config ?? {};
    const after = build(before);
    let query = db()
      .from("tournaments")
      .update({ branding_config: after, updated_at: new Date().toISOString() })
      .eq("id", tournamentId);
    query = current.updated_at === null ? query.is("updated_at", null) : query.eq("updated_at", current.updated_at);
    const { data: written, error: writeError } = await query.select("id");
    if (writeError) return { ok: false };
    if ((written ?? []).length === 1) return { ok: true, before, after };
  }
  return { ok: false };
}
