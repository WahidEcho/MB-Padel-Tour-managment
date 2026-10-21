import { NextResponse } from "next/server";
import { ANDROID_APK } from "../../stores";

/** Stable APK link (`/app/android/download`): the latest build, so shared links and QR codes survive new builds. */
export function GET() {
  return NextResponse.redirect(ANDROID_APK.url, 302);
}
