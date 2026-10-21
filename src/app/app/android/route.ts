import { NextResponse } from "next/server";
import { ANDROID_APK } from "../stores";

/** Stable Android link (`/app/android`): the latest APK, so printed QR codes survive new builds. */
export function GET() {
  return NextResponse.redirect(ANDROID_APK.url, 302);
}
