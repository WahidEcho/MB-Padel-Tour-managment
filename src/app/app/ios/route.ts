import { NextResponse } from "next/server";
import { APP_STORE_URL, TESTFLIGHT_URL, appStoreLive } from "../stores";

/** Stable iPhone link (`/app/ios`): the App Store once the app is published there, TestFlight early access until then. */
export async function GET() {
  if (await appStoreLive()) return NextResponse.redirect(APP_STORE_URL, 302);
  return NextResponse.redirect(TESTFLIGHT_URL, 302);
}
