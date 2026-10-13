/**
 * Database rows → the app's contract shapes (see contract.ts). Pure.
 *
 * This is the only place a row becomes something a phone receives, so it is also
 * where private columns stop: every shape is built field by field, never spread.
 */
import type { Match, MatchRules, MatchSnapshot, Player, Stage, StageRuleKey, Standing, Team, Tie, Tournament, BrandingConfig } from "../types";
import { resolveSponsors } from "../sponsors";
import { resolvePortrait, portraitSrc, sizedImageSrc, PORTRAIT_WIDTHS } from "../portrait";
import { rubberPlan } from "../tennis/ties";
import { matchDayRules, publicMatchDay } from "../matchday/rules";
import { scoringConfigForMatch, type BracketTier } from "../scoring/rules";
import { sportOf } from "../sports/registry";
import { SIDES, redBlueTeams } from "../sides";
import { toPublicPlayer } from "../public";
import type {
  AppSkin,
  MBundle,
  MCourtCall,
  MCourtPlayer,
  MCourtTeam,
  MMatch,
  MMatchRules,
  MSides,
  MStageRules,
  MScore,
  MSponsor,
  MStandingRow,
  MTeam,
  MTie,
  MTimelinePoint,
  MTournamentCard,
  MatchStatusLite,
  SideKey,
} from "./contract";
import { setsWon } from "./contract";

/** The columns this file reads from `tournaments`, including the 0015 additions. */
export type TournamentRow = Tournament & {
  event_group_id?: string | null;
  venue_name?: string | null;
  city?: string | null;
  timezone?: string | null;
  starts_on?: string | null;
  ends_on?: string | null;
  app_skin?: (AppSkin & { showPhotos?: boolean }) | null;
};

const HEX = /^#[0-9a-fA-F]{6}$/;

export function toSkin(t: Pick<TournamentRow, "app_skin" | "branding_config">): AppSkin {
  const s = t.app_skin ?? {};
  const b = (t.branding_config ?? {}) as BrandingConfig;
  return {
    seedA: s.seedA && HEX.test(s.seedA) ? s.seedA : null,
    seedB: s.seedB && HEX.test(s.seedB) ? s.seedB : null,
    mode: s.mode === "light" || s.mode === "dark" ? s.mode : null,
    artworkUrl: sizedImageSrc(s.artworkUrl ?? null, 1080),
    logoUrl: sizedImageSrc(s.logoUrl ?? b.eventLogoUrl ?? null, 320),
  };
}

export function toCard(t: TournamentRow, liveCount: number, teamCount: number): MTournamentCard {
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    sport: t.sport,
    status: t.status,
    eventGroupId: t.event_group_id ?? null,
    venue: t.venue_name ?? null,
    city: t.city ?? null,
    startsOn: t.starts_on ?? null,
    endsOn: t.ends_on ?? null,
    timezone: t.timezone || "Africa/Cairo",
    liveCount,
    teamCount,
    skin: toSkin(t),
  };
}

function sponsor(s: { name: string; logoUrl: string; aspect?: number; tier?: string }): MSponsor {
  return { name: s.name, logoUrl: sizedImageSrc(s.logoUrl, 480) ?? s.logoUrl, aspect: s.aspect ?? null, tier: s.tier ?? null };
}

export function toTeam(t: Team, groupId: string | null, showPhotos: boolean): MTeam {
  return {
    id: t.id,
    name: t.team_name,
    code: t.nation_code || shortCode(t.team_name),
    iso2: t.iso2 ?? null,
    seed: t.seed_number,
    groupId,
    status: t.team_status,
    players: [...(t.players ?? [])]
      .sort((a, b) => a.player_order - b.player_order)
      .map((p) => ({
        id: p.id,
        name: p.full_name,
        teamId: t.id,
        photoUrl: showPhotos ? sizedImageSrc(portraitSrc(resolvePortrait(p)), 320) : null,
      })),
  };
}

/** "Taymour / Mohsen" → "T/M"; "Egypt" → "EGY". Only a fallback label. */
export function shortCode(name: string): string {
  const parts = name.split(/[\s/]+/).filter(Boolean);
  if (parts.length >= 2) return parts.slice(0, 3).map((p) => p[0]!.toUpperCase()).join("");
  return name.slice(0, 3).toUpperCase();
}

/** Only the rule fields: never `stageOverrides`, `doubles` or the confirmation switch. */
function ruleFields(c: MatchRules): MMatchRules {
  const out: MMatchRules = {
    setsToWinMatch: c.setsToWinMatch,
    gamesToWinSet: c.gamesToWinSet,
    tiebreakEnabled: c.tiebreakEnabled,
    tiebreakAtGames: c.tiebreakAtGames,
    tiebreakTargetPoints: c.tiebreakTargetPoints,
    tiebreakWinByTwo: c.tiebreakWinByTwo,
    walkoverScore: c.walkoverScore,
  };
  if (c.decidingPoint !== undefined) out.decidingPoint = c.decidingPoint;
  if (c.matchTiebreak !== undefined) out.matchTiebreak = c.matchTiebreak;
  if (c.matchTiebreakPoints !== undefined) out.matchTiebreakPoints = c.matchTiebreakPoints;
  return out;
}

/** A stage and tier that falls in each rule bucket, to resolve it through scoringConfigForMatch. */
const BUCKETS: Record<StageRuleKey, { stage: Stage; tier: BracketTier | null }> = {
  group: { stage: "group", tier: null },
  quarter_semi: { stage: "semi_final", tier: "cup" },
  final: { stage: "final", tier: "cup" },
  bracket: { stage: "knockout", tier: "cup" },
  plate_quarter_semi: { stage: "semi_final", tier: "plate" },
  plate_final: { stage: "final", tier: "plate" },
  plate_bracket: { stage: "knockout", tier: "plate" },
};

/**
 * The rules per stage as the server resolves them (src/lib/scoring/rules.ts), so a
 * phone never layers the stored config itself. `plateBrackets` lets it find a
 * knockout match's bucket.
 */
export function toStageRules(t: Pick<Tournament, "scoring_config" | "sport">, plateBrackets: string[]): MStageRules {
  const tournament = { scoring_config: t.scoring_config ?? null, sport: t.sport };
  const stages = {} as Record<StageRuleKey, MMatchRules>;
  for (const [key, b] of Object.entries(BUCKETS) as [StageRuleKey, (typeof BUCKETS)[StageRuleKey]][]) {
    stages[key] = ruleFields(scoringConfigForMatch(tournament, { stage: b.stage }, b.tier));
  }
  const doubles = sportOf(t.sport).id === "tennis" ? (t.scoring_config?.doubles ?? null) : null;
  return {
    base: ruleFields(scoringConfigForMatch(tournament, { stage: "friendly" })),
    stages,
    doubles: doubles ? pickPartialRules(doubles) : null,
    plateBrackets: [...plateBrackets].sort(),
  };
}

function pickPartialRules(r: Partial<MatchRules>): Partial<MMatchRules> {
  const keys: (keyof MatchRules)[] = [
    "setsToWinMatch",
    "gamesToWinSet",
    "tiebreakEnabled",
    "tiebreakAtGames",
    "tiebreakTargetPoints",
    "tiebreakWinByTwo",
    "walkoverScore",
    "decidingPoint",
    "matchTiebreak",
    "matchTiebreakPoints",
  ];
  const out: Record<string, unknown> = {};
  for (const k of keys) if (r[k] !== undefined) out[k] = r[k];
  return out as Partial<MMatchRules>;
}

/** Red and blue teams as the screens and the umpire use them (src/lib/sides.ts). */
export function toSides(branding: BrandingConfig | null | undefined): MSides {
  return {
    redBlue: redBlueTeams(branding),
    A: { label: SIDES.A.label, short: SIDES.A.short, hex: SIDES.A.hex },
    B: { label: SIDES.B.label, short: SIDES.B.short, hex: SIDES.B.hex },
  };
}

export function toBundle(
  t: TournamentRow,
  teams: Team[],
  groupOf: Map<string, string>,
  courts: { id: string; court_name: string; court_order: number; is_active: boolean }[],
  groups: { id: string; group_name: string; group_order: number }[],
  liveCount: number,
  plateBrackets: string[] = [],
): MBundle {
  const showPhotos = t.app_skin?.showPhotos === true;
  const { main, footer } = resolveSponsors(t.branding_config);
  const isTies = Boolean(t.format_config?.ties);
  return {
    version: bundleVersion(t, teams, courts.length, groups.length),
    tournament: {
      ...toCard(t, liveCount, teams.length),
      isTies,
      showPhotos,
      rubberPlan: isTies ? rubberPlan(t.format_config?.ties) : [],
      lowerThird: t.lower_third_text || null,
      matchDay: publicMatchDay(matchDayRules(t.match_day_rules, t)),
    },
    teams: teams.map((tm) => toTeam(tm, groupOf.get(tm.id) ?? null, showPhotos)),
    courts: courts.filter((c) => c.is_active).map((c) => ({ id: c.id, name: c.court_name, order: c.court_order })),
    groups: groups.map((g) => ({ id: g.id, name: g.group_name, order: g.group_order })),
    sponsors: { main: main ? sponsor(main) : null, footer: footer.map(sponsor) },
    rules: toStageRules(t, plateBrackets),
    sides: toSides(t.branding_config),
  };
}

/**
 * A team on a court card. Players go through toPublicPlayer (the public player
 * shape, portrait resolved) and are then built field by field: no phone, email,
 * access code or profile link can ride along, whatever the row carried.
 */
export function toCourtTeam(t: Pick<Team, "id" | "team_name" | "nation_code" | "iso2" | "players">, showPhotos: boolean): MCourtTeam {
  return {
    id: t.id,
    name: t.team_name,
    code: t.nation_code || shortCode(t.team_name),
    iso2: t.iso2 ?? null,
    players: [...(t.players ?? [])]
      .sort((a, b) => a.player_order - b.player_order)
      .map((p): MCourtPlayer => {
        const pub = toPublicPlayer(p as Player);
        const src = portraitSrc({ photoUrl: pub.photo_url, portraitUrl: pub.portrait_url, focalX: pub.focal_x, focalY: pub.focal_y });
        return {
          id: pub.id,
          name: pub.full_name,
          teamId: t.id,
          photoUrl: showPhotos ? sizedImageSrc(src, PORTRAIT_WIDTHS.hero) : null,
          focalX: pub.focal_x,
          focalY: pub.focal_y,
        };
      }),
  };
}

/** One open call as the hero needs it: who is here and the deadline; never the device or the referee. */
export interface CallRow {
  match_id: string;
  court_id: string | null;
  called_at: string;
  deadline_at: string;
  extensions: number | null;
  a_present_at: string | null;
  b_present_at: string | null;
}

export function toCourtCall(r: CallRow): MCourtCall {
  return {
    matchId: r.match_id,
    courtId: r.court_id,
    calledAt: r.called_at,
    deadlineAt: r.deadline_at,
    extensions: Math.max(0, Number(r.extensions) || 0),
    presentA: Boolean(r.a_present_at),
    presentB: Boolean(r.b_present_at),
  };
}

/** Changes whenever something in the bundle could have changed. */
export function bundleVersion(t: Pick<Tournament, "updated_at">, teams: Team[], courts: number, groups: number): string {
  const players = teams.reduce((n, tm) => n + (tm.players?.length ?? 0), 0);
  let h = 0;
  for (const tm of teams) for (const ch of tm.id + tm.team_name + (tm.players ?? []).map((p) => p.full_name).join()) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return `${Date.parse(t.updated_at) || 0}.${teams.length}.${players}.${courts}.${groups}.${(h >>> 0).toString(36)}`;
}

interface StateLike {
  matchOver?: boolean;
  isTiebreak?: boolean;
  teamA?: { points?: string; games?: number; tiebreakPoints?: number };
  teamB?: { points?: string; games?: number; tiebreakPoints?: number };
  servingTeam?: SideKey | null;
}

export function toScore(m: Pick<Match, "team_a_id" | "team_b_id">, snap: MatchSnapshot | null): MScore | null {
  if (!snap) return null;
  const st = (snap.snapshot_json ?? {}) as StateLike;
  const sets = (snap.completed_sets ?? []).map((s) => ({
    a: s.teamAGames,
    b: s.teamBGames,
    tb: s.tiebreak ? { a: s.tiebreak.a, b: s.tiebreak.b } : null,
    ...(s.matchTiebreak ? { mtb: true } : {}),
  }));
  const over = st.matchOver === true;
  const tiebreak = !over && (snap.is_tiebreak || st.isTiebreak === true);
  const serving: SideKey | null =
    st.servingTeam === "A" || st.servingTeam === "B"
      ? st.servingTeam
      : snap.serving_team_id
        ? snap.serving_team_id === m.team_a_id
          ? "A"
          : "B"
        : null;
  return {
    sets,
    games: over ? null : { a: snap.team_a_games ?? 0, b: snap.team_b_games ?? 0 },
    points: over
      ? null
      : tiebreak
        ? { a: String(snap.tiebreak_team_a_points ?? 0), b: String(snap.tiebreak_team_b_points ?? 0) }
        : { a: snap.team_a_point_label ?? "0", b: snap.team_b_point_label ?? "0" },
    tiebreak,
    serving: over ? null : serving,
    setsWon: setsWon(sets),
    lastEventNumber: snap.last_event_number ?? 0,
    lastUndo: snap.last_undo_event_number ?? 0,
    updatedAt: snap.updated_at ?? null,
  };
}

export function toMatch(m: Match, snap: MatchSnapshot | null): MMatch {
  return {
    id: m.id,
    tieId: m.tie_id ?? null,
    rubberNo: m.rubber_no ?? null,
    rubberType: m.rubber_type ?? null,
    stage: m.stage,
    groupId: m.group_id,
    round: m.round_name,
    order: m.match_order,
    courtId: m.court_id,
    scheduledTime: m.scheduled_time,
    status: m.status as MatchStatusLite,
    a: m.team_a_id,
    b: m.team_b_id,
    aPlayers: (m.team_a_player_ids as string[] | null | undefined) ?? [],
    bPlayers: (m.team_b_player_ids as string[] | null | undefined) ?? [],
    winner: m.winner_team_id,
    startedAt: m.started_at,
    endedAt: m.ended_at,
    score: toScore(m, snap),
    bracketId: m.bracket_id ?? null,
  };
}

export function toTie(t: Tie): MTie {
  return {
    id: t.id,
    stage: t.stage,
    groupId: t.group_id,
    roundNo: t.round_no,
    roundName: t.round_name,
    order: t.tie_order,
    courtId: t.court_id,
    scheduledTime: t.scheduled_time,
    a: t.team_a_id,
    b: t.team_b_id,
    status: t.status,
    rubbersA: t.rubbers_a,
    rubbersB: t.rubbers_b,
    winner: t.winner_team_id,
    placesFrom: t.places_from,
    placesTo: t.places_to,
    lineupLocked: Boolean(t.lineup_locked_at),
  };
}

export function toStandingRow(s: Standing): MStandingRow {
  const r = s as Standing & { rubbers_won?: number | null; rubbers_lost?: number | null };
  return {
    teamId: s.team_id,
    rank: s.rank,
    played: s.played,
    won: s.won,
    lost: s.lost,
    points: s.points,
    rubbersWon: r.rubbers_won ?? null,
    rubbersLost: r.rubbers_lost ?? null,
    setsWon: s.sets_won,
    setsLost: s.sets_lost,
    gamesWon: s.games_won,
    gamesLost: s.games_lost,
    status: s.status,
  };
}

/** One stored score event, reduced to what a timeline needs. */
export interface TimelineRow {
  event_number: number;
  event_type: string;
  team_id: string | null;
  ga: number | null;
  gb: number | null;
  set: number | null;
}

/**
 * Point-by-point for the momentum chart. Events are append-only, so an UNDO
 * removes the event before it rather than being a point of its own; replaying the
 * log as a stack gives the points that stand.
 */
export function buildTimeline(rows: TimelineRow[], teamA: string | null): MTimelinePoint[] {
  const stack: (TimelineRow & { kind: string })[] = [];
  for (const r of [...rows].sort((x, y) => x.event_number - y.event_number)) {
    if (r.event_type === "UNDO") {
      stack.pop();
      continue;
    }
    stack.push({ ...r, kind: r.event_type });
  }
  const out: MTimelinePoint[] = [];
  let prevA = 0;
  let prevB = 0;
  let prevSet = 1;
  for (const e of stack) {
    const set = (e.set ?? prevSet) || 1;
    if (e.kind === "POINT_AWARDED" && e.team_id) {
      const w: SideKey = e.team_id === teamA ? "A" : "B";
      if (set !== prevSet) {
        // The point won the set: the new state already shows the next set at 0-0,
        // so the deciding game is the old count plus this game.
        out.push({ w, set: prevSet, game: `${prevA + (w === "A" ? 1 : 0)}-${prevB + (w === "B" ? 1 : 0)}` });
        prevA = 0;
        prevB = 0;
        prevSet = set;
        continue;
      }
      const ga = e.ga ?? prevA;
      const gb = e.gb ?? prevB;
      const point: MTimelinePoint = { w, set };
      if (ga !== prevA || gb !== prevB) point.game = `${ga}-${gb}`;
      out.push(point);
      prevA = ga;
      prevB = gb;
    } else {
      if (set !== prevSet) prevSet = set;
      prevA = e.ga ?? prevA;
      prevB = e.gb ?? prevB;
    }
  }
  return out;
}
