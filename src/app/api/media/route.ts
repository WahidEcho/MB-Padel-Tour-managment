import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/guard";
import { PHOTO_TYPES, uploadImage } from "@/lib/upload";

export const dynamic = "force-dynamic";

const FOLDERS: Record<string, { prefix: string; permission: "manage_teams" | "manage_players" }> = {
  "tournament-player": { prefix: "players", permission: "manage_teams" },
  "profile-player": { prefix: "profiles", permission: "manage_players" },
};

/**
 * Staff photo upload.
 *
 * A route rather than a server action so the editor can upload while the
 * operator keeps typing, show progress, and put the resulting URL into the
 * unsaved draft — nothing is written to a player until they press Save.
 *
 * Public self-upload at session registration is a different endpoint with its
 * own limits: see /api/f/[slug]/photo.
 */
export async function POST(req: Request) {
  const folder = String(new URL(req.url).searchParams.get("folder") ?? "");
  const target = FOLDERS[folder];
  if (!target) return NextResponse.json({ error: "Unknown folder" }, { status: 400 });

  try {
    await requirePermission(target.permission);
  } catch {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });

  try {
    const url = await uploadImage(file, target.prefix, { allow: PHOTO_TYPES, maxBytes: 8 * 1024 * 1024 });
    return NextResponse.json({ url });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
