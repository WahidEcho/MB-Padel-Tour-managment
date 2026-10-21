/**
 * A short referee code (src/lib/orgs/shortCode.ts) that no code row uses yet: with only
 * 4 characters two codes can collide, and organization_codes.code_hash is unique, so a
 * new code is checked against every stored fingerprint (revoked ones too) before it is
 * handed out. Server only.
 */
import { db } from "../supabase";
import { generateShortRefereeCode, hashEventCode } from "./codes";

export async function freshShortRefereeCode(taken: Set<string> = new Set(), tries = 20): Promise<{ code: string; hash: string }> {
  for (let i = 0; i < tries; i++) {
    const code = generateShortRefereeCode();
    const hash = hashEventCode(code);
    if (taken.has(hash)) continue;
    const { data, error } = await db().from("organization_codes").select("id").eq("code_hash", hash).limit(1);
    if (error) throw new Error("Could not check the new code. Try again.");
    if (!data?.length) {
      taken.add(hash);
      return { code, hash };
    }
  }
  throw new Error("Could not find a free code. Try again.");
}
