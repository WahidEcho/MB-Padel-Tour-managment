import { NextResponse } from "next/server";
import { APP_STORE_URL, appStoreLive } from "../stores";

/** Stable iPhone link (`/app/ios`): the App Store once the app is published there, the download page until then. */
export async function GET(request: Request) {
  if (await appStoreLive()) return NextResponse.redirect(APP_STORE_URL, 302);
  return NextResponse.redirect(new URL("/app#iphone", request.url), 302);
}
