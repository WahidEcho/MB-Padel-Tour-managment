import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { appleWalletConfigured, applePass, walletData } from "@/lib/pass/wallet";

const NOT_SET_UP = "Apple Wallet is not set up yet";

/** The pass as an Apple Wallet file. The pass id is unguessable; it is the only key. */
export async function GET(_request: Request, { params }: { params: Promise<{ passId: string }> }) {
  const { passId } = await params;
  const data = await walletData(passId);
  if (!data) return NextResponse.json({ error: "Pass not found" }, { status: 404 });
  const file = await applePass(data);
  if (!file) return NextResponse.json({ error: NOT_SET_UP, code: "not_configured" }, { status: 503 });
  return new NextResponse(new Uint8Array(file), {
    headers: { "Content-Type": "application/vnd.apple.pkpass", "Content-Disposition": `attachment; filename="movescore-${data.serial}.pkpass"`, "Cache-Control": "no-store" },
  });
}

/**
 * The app asks first (no signing, no body) and only then hands the link to Safari,
 * which shows the Add Pass sheet: 200 ready, 404 no such pass, 503 not set up.
 */
export async function HEAD(_request: Request, { params }: { params: Promise<{ passId: string }> }) {
  const { passId } = await params;
  const headers = { "Cache-Control": "no-store" };
  if (!/^[0-9a-f-]{36}$/i.test(passId)) return new NextResponse(null, { status: 404, headers });
  const { data } = await db().from("event_passes").select("id").eq("id", passId).maybeSingle();
  if (!data) return new NextResponse(null, { status: 404, headers });
  return new NextResponse(null, { status: appleWalletConfigured() ? 200 : 503, headers });
}
