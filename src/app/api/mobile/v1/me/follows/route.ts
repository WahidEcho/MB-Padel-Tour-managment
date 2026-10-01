import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { ownerOf } from "@/lib/mobile/identity";
import { privateJson, readJson } from "@/lib/mobile/http";
import type { FollowKind, MFollow } from "@/lib/mobile/contract";

const KINDS: FollowKind[] = ["player", "nation", "tie", "match", "tournament", "event_group"];
const MAX_FOLLOWS = 300;

async function list(ownerKind: string, ownerId: string): Promise<MFollow[]> {
  const { data } = await db().from("follows").select("target_kind, target_key, tournament_id").eq("owner_kind", ownerKind).eq("owner_id", ownerId);
  return ((data ?? []) as { target_kind: FollowKind; target_key: string; tournament_id: string | null }[]).map((r) => ({
    kind: r.target_kind,
    key: r.target_key,
    tournamentId: r.tournament_id,
  }));
}

export async function GET(request: Request) {
  const { owner } = await ownerOf(request);
  if (!owner) return NextResponse.json({ error: "Register this phone first" }, { status: 401 });
  return privateJson({ follows: await list(owner.kind, owner.id) });
}

/**
 * Follow or unfollow: { add?: MFollow[], remove?: MFollow[] }. Also used to merge
 * a guest's follows into an account on sign-in (union, never a silent delete).
 */
export async function POST(request: Request) {
  const { owner, installationId } = await ownerOf(request);
  if (!owner) return NextResponse.json({ error: "Register this phone first" }, { status: 401 });
  const body = await readJson<{ add?: MFollow[]; remove?: MFollow[]; mergeInstall?: boolean }>(request);
  const valid = (f: MFollow) => KINDS.includes(f?.kind) && typeof f.key === "string" && /^[A-Za-z0-9-]{2,64}$/.test(f.key);
  const add = (body?.add ?? []).filter(valid).slice(0, 100);
  const remove = (body?.remove ?? []).filter(valid).slice(0, 100);
  if (owner.kind === "user" && body?.mergeInstall && installationId) {
    const guest = await list("install", installationId);
    add.push(...guest);
    await db().from("push_devices").update({ user_id: owner.id }).eq("installation_id", installationId);
  }
  if (add.length) {
    const current = await list(owner.kind, owner.id);
    if (current.length + add.length > MAX_FOLLOWS) return NextResponse.json({ error: `You can follow up to ${MAX_FOLLOWS} things` }, { status: 400 });
    await db()
      .from("follows")
      .upsert(
        add.map((f) => ({ owner_kind: owner.kind, owner_id: owner.id, target_kind: f.kind, target_key: f.key, tournament_id: f.tournamentId ?? null })),
        { onConflict: "owner_kind,owner_id,target_kind,target_key", ignoreDuplicates: true },
      );
  }
  for (const f of remove) {
    await db().from("follows").delete().eq("owner_kind", owner.kind).eq("owner_id", owner.id).eq("target_kind", f.kind).eq("target_key", f.key);
  }
  return privateJson({ follows: await list(owner.kind, owner.id) });
}
