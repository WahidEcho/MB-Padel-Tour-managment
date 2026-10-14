/**
 * Who can see a league (migration 0031, the owner's three options):
 *
 *   everyone     an active or closed league is public: anyone in the app, the
 *                organisation's page, the top boards (the behaviour before 0031).
 *   org_players  the organisation's players (a signed-in account whose own player
 *                profile the organisation has with a vouching source), the league's
 *                members, and the organisation's staff.
 *   invite_only  the league's members, accounts that entered the league's current
 *                invite code, and the organisation's staff.
 *
 * Everyone else gets the same 404 as a league that does not exist. A league that
 * is not `everyone` is only ever served on a per-user, never-cached path, and its
 * points never reach a public top board (src/lib/leagues/server.ts).
 *
 * Pure: shared with the Move Score app through move-score-app/src/core/index.ts.
 */

export const LEAGUE_VISIBILITIES = ["everyone", "org_players", "invite_only"] as const;
export type LeagueVisibility = (typeof LEAGUE_VISIBILITIES)[number];

export const isLeagueVisibility = (v: unknown): v is LeagueVisibility => typeof v === "string" && (LEAGUE_VISIBILITIES as readonly string[]).includes(v);

/**
 * A stored value read safely: a missing one is the column default ('everyone');
 * anything else unknown fails closed ('invite_only': members and staff only).
 */
export function leagueVisibility(raw: unknown): LeagueVisibility {
  if (raw === undefined || raw === null) return "everyone";
  return isLeagueVisibility(raw) ? raw : "invite_only";
}

/** Public: shared by every phone and the CDN, on the organisation's page and the top boards. */
export const isPublicVisibility = (v: unknown): boolean => leagueVisibility(v) === "everyone";

/** What the person asking is to this league. Every flag is false for a signed-out caller. */
export interface LeagueViewer {
  /** An active member (any role) of the league's organisation. */
  staff: boolean;
  /** Their own player profile is in the league (any status but removed). */
  member: boolean;
  /** Their own player profile is the organisation's player with a vouching source (not 'matched' / 'league'), not rejected. */
  orgPlayer: boolean;
  /** They entered the league's current invite code. */
  codeHolder: boolean;
}

export const NOBODY: LeagueViewer = { staff: false, member: false, orgPlayer: false, codeHolder: false };

/** Whether this viewer may see a league of this visibility. */
export function canSeeLeague(visibility: unknown, viewer: LeagueViewer): boolean {
  const v = leagueVisibility(visibility);
  if (v === "everyone") return true;
  if (viewer.staff || viewer.member) return true;
  if (v === "org_players") return viewer.orgPlayer;
  return viewer.codeHolder;
}

/** The app's small badge for a league that is not public (none for 'everyone'). */
export const LEAGUE_VISIBILITY_BADGE: Record<LeagueVisibility, string | null> = {
  everyone: null,
  org_players: "Members only",
  invite_only: "Invite only",
};

/** The organiser's choice in Admin → League → Settings, with what each means. */
export const LEAGUE_VISIBILITY_OPTIONS: { value: LeagueVisibility; label: string; help: string }[] = [
  {
    value: "everyone",
    label: "Everyone",
    help: "Anyone can find the league in the app, on your organisation's page and on the top boards.",
  },
  {
    value: "org_players",
    label: "Your players only",
    help: "Only your organisation's players (signed in with their own player profile), the league's members and your staff see it. Its points stay off the public top boards.",
  },
  {
    value: "invite_only",
    label: "Invite only",
    help: "Only the league's members, people who enter its invite code in the app, and your staff see it. Set an invite code below to share it. Its points stay off the public top boards.",
  },
];

/** Whether a holder's code is still the league's current one (a new or cleared code ends it). */
export function codeStillHeld(heldSetAt: string | null | undefined, currentSetAt: string | null | undefined): boolean {
  if (!heldSetAt || !currentSetAt) return false;
  const a = Date.parse(heldSetAt);
  const b = Date.parse(currentSetAt);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}
