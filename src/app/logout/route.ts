import { NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/auth";

export async function GET(request: Request) {
  await clearSessionCookie();
  return NextResponse.redirect(new URL("/", request.url));
}
