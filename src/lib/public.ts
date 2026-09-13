/**
 * What a public page and the venue screen are allowed to know.
 *
 * A `Team` row carries the organiser's contact phone and internal notes. That was
 * harmless while every public page was a server component, because a server
 * component renders HTML and the row never leaves the server. The broadcast
 * court card has to be a client component — it holds animation state between
 * polls — and a client component's props are serialised into the page. Hand it a
 * `Team` and the phone number ships to every phone in the venue.
 *
 * So public surfaces take these projections instead. The `?: never` members are
 * deliberate: TypeScript's structural typing would otherwise accept a full `Team`
 * wherever a `PublicTeam` is expected, since a superset satisfies a subset. With
 * them, passing a raw row is a compile error rather than a leak.
 *
 * Pure and framework-free.
 */
import type { Player, Team, Tournament } from "./types";
import { resolvePortrait } from "./portrait";

export interface PublicPlayer {
  id: string;
  full_name: string;
  photo_url: string | null;
  portrait_url: string | null;
  focal_x: number;
  focal_y: number;
}

export interface PublicTeam {
  id: string;
  team_name: string;
  seed_number: number | null;
  team_status: Team["team_status"];
  players: PublicPlayer[];
  // Present only so a full Team row is not assignable here.
  phone?: never;
  notes?: never;
  check_in_status?: never;
}

export type PublicTournament = Pick<
  Tournament,
  "id" | "name" | "slug" | "sport" | "kind" | "status" | "branding_config" | "lower_third_text" | "public_access_enabled"
> & {
  scoring_config?: never;
  format_config?: never;
  court_config?: never;
};

export function toPublicPlayer(p: Player): PublicPlayer {
  const portrait = resolvePortrait(p);
  return {
    id: p.id,
    full_name: p.full_name,
    photo_url: portrait.photoUrl,
    portrait_url: portrait.portraitUrl,
    focal_x: portrait.focalX,
    focal_y: portrait.focalY,
  };
}

export function toPublicTeam(t: Team): PublicTeam {
  return {
    id: t.id,
    team_name: t.team_name,
    seed_number: t.seed_number,
    team_status: t.team_status,
    players: [...(t.players ?? [])]
      .sort((a, b) => a.player_order - b.player_order)
      .map(toPublicPlayer),
  };
}

export function toPublicTournament(t: Tournament): PublicTournament {
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    sport: t.sport,
    kind: t.kind,
    status: t.status,
    branding_config: t.branding_config,
    lower_third_text: t.lower_third_text,
    public_access_enabled: t.public_access_enabled,
  };
}

/** The exact keys a public team may carry. A test pins this list. */
export const PUBLIC_TEAM_KEYS = ["id", "players", "seed_number", "team_name", "team_status"] as const;
