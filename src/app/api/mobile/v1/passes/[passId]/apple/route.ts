import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { appleWalletConfigured, applePass, walletData } from "@/lib/pass/wallet";

const NOT_SET_UP = "Apple Wallet is not set up yet";

/** The pass as an Apple Wallet file. The pass id is unguessable; it is the only key. */
export async function GET(_request: Request, { params }: { params: Promise<{ passId: string }> }) {
  const { passId } = await params;
  const data = await walletData(passId);
  if (!data) return NextResponse.json({ error: "Pass not found" }, { status: 404 });
  let file: Buffer | null;
  try {
    file = await applePass(data);
  } catch (e) {
    console.error(`[apple-wallet] signing pass ${passId} failed: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ error: "Apple Wallet couldn't make this pass. Try again later.", code: "sign_failed" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (!file) return NextResponse.json({ error: NOT_SET_UP, code: "not_configured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  return new NextResponse(new Uint8Array(file), {
    headers: {
      "Content-Type": "application/vnd.apple.pkpass",
      "Content-Disposition": `attachment; filename="movescore-${data.serial}.pkpass"`,
      "Content-Length": String(file.length),
      "Cache-Control": "no-store",
    },
  });
}

/**
 * The app asks first (no signing, no body) and only then hands the link to Safari,
 * which shows the Add Pass sheet: 200 ready, 404 no such pass, 503 not set up
 * (credentials missing or unusable, so the app shows a note instead of a dead page).
 */
export async function HEAD(_request: Request, { params }: { params: Promise<{ passId: string }> }) {
  const { passId } = await params;
  const headers = { "Cache-Control": "no-store" };
  if (!/^[0-9a-f-]{36}$/i.test(passId)) return new NextResponse(null, { status: 404, headers });
  const { data } = await db().from("event_passes").select("id").eq("id", passId).maybeSingle();
  if (!data) return new NextResponse(null, { status: 404, headers });
  return new NextResponse(null, { status: appleWalletConfigured() ? 200 : 503, headers });
}
