import { NextResponse } from "next/server";
import { googleSaveUrl, walletData } from "@/lib/pass/wallet";

/** Redirects to Google Wallet's "save" page for this pass. */
export async function GET(request: Request, { params }: { params: Promise<{ passId: string }> }) {
  const { passId } = await params;
  const data = await walletData(passId);
  if (!data) return NextResponse.json({ error: "Pass not found" }, { status: 404 });
  const url = await googleSaveUrl(data, new URL(request.url).origin);
  if (!url) return NextResponse.json({ error: "Google Wallet is not set up yet" }, { status: 503 });
  return NextResponse.redirect(url, { headers: { "Cache-Control": "no-store" } });
}
