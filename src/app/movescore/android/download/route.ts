import { NextResponse } from "next/server";
import { ANDROID_APK } from "../apk";

/** Stable download link for the Android APK (`/movescore/android/download`), so shared links survive new builds. */
export function GET() {
  return NextResponse.redirect(ANDROID_APK.url, 302);
}
