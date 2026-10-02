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
const PATHS = ["/v/*"];

const AASA = {
  applinks: {
    // Pre-iOS 13 readers expect an empty "apps" array.
    apps: [] as string[],
    details: [
      {
        // iOS 13 and later.
        appIDs: [APP_ID],
        components: PATHS.map((p) => ({ "/": p, comment: "Venue code: opens the event pass" })),
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
