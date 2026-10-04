/**
 * The public site: one place for its address. Pure module (no Node, browser or
 * Next.js APIs): the Move Score app imports it through move-score-app/src/core,
 * and the email layout renders in the browser too.
 *
 * Server code that builds links reads PUBLIC_SITE_URL first (siteUrl() in
 * src/lib/messaging/links.ts); this is the production default.
 */
export const SITE_HOST = "tour.mbeg.org";
export const SITE_URL = `https://${SITE_HOST}`;
/** The Move Score landing page (store links; the legal pages sit under it). */
export const APP_PAGE_URL = `${SITE_URL}/movescore`;
