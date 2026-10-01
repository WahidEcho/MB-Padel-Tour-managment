import { NextResponse } from "next/server";
import { applePass, walletData } from "@/lib/pass/wallet";

/** The pass as an Apple Wallet file. The pass id is unguessable; it is the only key. */
export async function GET(_request: Request, { params }: { params: Promise<{ passId: string }> }) {
  const { passId } = await params;
  const data = await walletData(passId);
  if (!data) return NextResponse.json({ error: "Pass not found" }, { status: 404 });
  const file = await applePass(data);
  if (!file) return NextResponse.json({ error: "Apple Wallet is not set up yet" }, { status: 503 });
  return new NextResponse(new Uint8Array(file), {
    headers: { "Content-Type": "application/vnd.apple.pkpass", "Content-Disposition": `attachment; filename="movescore-${data.serial}.pkpass"`, "Cache-Control": "no-store" },
  });
}
