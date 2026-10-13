/**
 * Where each thing in the app opens. Every screen links through these, so a
 * match, tie, tournament, player, nation or team opens the same page wherever
 * it is tapped.
 */
import { router } from "expo-router";
import type { MTeam } from "@core";

/** A team that is a nation: a three-letter ITF code in a nations (ties) event. */
export function isNation(team: Pick<MTeam, "code"> | null | undefined, isTies: boolean): boolean {
  return Boolean(team && isTies && /^[A-Z]{3}$/.test(team.code));
}

export const openMatch = (id: string) => router.push({ pathname: "/match/[id]", params: { id } });
export const openTie = (id: string) => router.push({ pathname: "/tie/[id]", params: { id } });
export const openTournament = (slug: string, tab?: "ties" | "matches" | "groups" | "nations") =>
  router.push({ pathname: "/t/[slug]", params: tab ? { slug, tab } : { slug } });
/** An organisation's page (profile, its tournaments, follow). */
export const openOrg = (slug: string) => router.push({ pathname: "/org/[slug]", params: { slug } });
/** A league's page (divisions, joining, boards, nights and fixtures). */
export const openLeague = (slug: string) => router.push({ pathname: "/league/[slug]", params: { slug } });
/** Leagues: the top of all leagues and the account's own leagues. */
export const openLeagues = () => router.push("/leagues");
export const openPlayer = (id: string, slug: string) => router.push({ pathname: "/player/[id]", params: { id, slug } });
/** `slug` is the tournament the nation was tapped in, shown even when it is not the featured event. */
export const openNation = (code: string, slug?: string) => router.push({ pathname: "/nation/[code]", params: slug ? { code, slug } : { code } });

/** A nation opens its nation page (follow, pin, every tie); any other team its own page in that tournament. */
export function openTeam(team: Pick<MTeam, "id" | "code">, slug: string, isTies: boolean) {
  if (isNation(team, isTies)) openNation(team.code, slug);
  else router.push({ pathname: "/team/[id]", params: { id: team.id, slug } });
}
