import { NextResponse } from "next/server";

/** `/download` is an easy-to-say alias of the app download page. */
export function GET(request: Request) {
  return NextResponse.redirect(new URL("/app", request.url), 308);
}
