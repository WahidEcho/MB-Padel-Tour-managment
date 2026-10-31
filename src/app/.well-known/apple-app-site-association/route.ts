/**
 * Universal links for the Move Score iOS app: the venue QR code (/v/<event>)
 * opens the app when it is installed, and the venue landing page when it is
 * not. Served as JSON with no file extension, as Apple requires. Apple's CDN
 * caches this file, so a change can take a day to reach phones.
 *
 * APP_ID is <Apple Team ID>.<bundle id> of the store build (see
 * move-score-app/app.config.ts; the app's associatedDomains entry points here).
 */
export const dynamic = "force-static";

const APP_ID = "33C2U7Q76F.org.mbeg.movescore";
// /v/<event>: the venue code. /m/<match>: a match's check-in code (court TV or printed).
// /r: a court's referee QR (https://tour.mbeg.org/r#<code>, migration 0034; the code is in
// the #fragment). Added after 1.0.1, which has no /r screen: on a phone still running
// 1.0.1 the court QR opens 1.0.1 on its "page not found" screen (go back, type the code).
// /c: a team coach card's QR (https://tour.mbeg.org/c#<code>, migration 0037), same shape:
// on 1.0.1 (no coach screens) it opens 1.0.1's "page not found"; nothing 1.0.1 already
// handles changes. /register/…, /coach/… and every other path still open the browser:
// "/r" and "/c" match those paths only.
const PATHS = ["/v/*", "/m/*", "/r", "/c"];
const COMMENTS: Record<string, string> = {
  "/r": "Chair umpire QR: open the referee console",
  "/c": "Team coach QR: open the coach sign-in",
};

const AASA = {
  applinks: {
    // Pre-iOS 13 readers expect an empty "apps" array.
    apps: [] as string[],
    details: [
      {
        // iOS 13 and later.
        appIDs: [APP_ID],
        components: PATHS.map((p) => ({ "/": p, comment: COMMENTS[p] ?? "Venue and match codes: open the event pass" })),
        // iOS 12 and earlier.
        appID: APP_ID,
        paths: PATHS,
      },
    ],
  },
};

export function GET() {
  return new Response(JSON.stringify(AASA), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
  });
}
