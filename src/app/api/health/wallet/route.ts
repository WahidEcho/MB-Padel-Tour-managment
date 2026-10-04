import { NextResponse } from "next/server";
import { appleWalletStatus } from "@/lib/pass/wallet";

/**
 * Whether Apple Wallet passes can be signed, and if not, which variable to fix.
 * Shows only public facts (pass type, team, expiry), never the credentials.
 */
export async function GET() {
  return NextResponse.json({ apple: appleWalletStatus() }, { headers: { "Cache-Control": "no-store" } });
}
