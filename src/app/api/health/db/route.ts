import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";

/**
 * Which database key the server is really using, for the security gate:
 * "secret" when it can read the RLS-protected canary row (only the secret key
 * bypasses row-level security), "anon" when it cannot, "open" before the gate
 * has been applied at all.
 */
export async function GET() {
  const { data, error } = await db().from("rls_canary").select("id").eq("id", 1).maybeSingle();
  const key = error ? (/does not exist|schema cache/i.test(error.message) ? "open" : "anon") : data ? "secret" : "anon";
  const t0 = Date.now();
  await db().from("tournaments").select("id").limit(1);
  return NextResponse.json({ ok: true, key, dbMs: Date.now() - t0, region: process.env.VERCEL_REGION ?? null }, { headers: { "Cache-Control": "no-store" } });
}
