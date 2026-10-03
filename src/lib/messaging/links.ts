/** Public links that go into messages. They must be the live site, never localhost. */
export const DEFAULT_SITE_URL = "https://mb-tournament.vercel.app";

export function siteUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.PUBLIC_SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, "");
}

export function tournamentLink(slug: string | null | undefined): string {
  return slug ? `${siteUrl()}/t/${slug}` : siteUrl();
}

/** The Move Score landing page (store links, and the universal link into the app). */
export function appLink(): string {
  return `${siteUrl()}/movescore`;
}
