import Avatar from "./Avatar";
import type { BracketTier, Match, Team } from "@/lib/types";

export interface PodiumPlace {
  /** 1 = champion. */
  place: 1 | 2 | 3 | 4;
  team: Team | null;
}

export interface Podium {
  tier: BracketTier;
  places: PodiumPlace[];
}

const MEDAL: Record<number, string> = { 1: "🏆", 2: "🥈", 3: "🥉", 4: "4️⃣" };
const LABEL: Record<number, string> = {
  1: "Champion",
  2: "Runner-up",
  3: "Third place",
  4: "Fourth place",
};

/** How tall each step stands, so the podium reads as a podium. */
const HEIGHT: Record<number, string> = { 1: "p-8", 2: "p-6", 3: "p-5", 4: "p-4" };

function other(match: Match, teamId: string): string | null {
  if (!match.team_a_id || !match.team_b_id) return null;
  return match.team_a_id === teamId ? match.team_b_id : match.team_a_id;
}

/**
 * Who finished where, for one bracket.
 *
 * Scoped to a bracket's own matches rather than the tournament's, because with a
 * Cup and a Plate there are two matches with stage 'final' and two with
 * 'third_place'. Finding either with a plain search would return whichever came
 * back first — so the caller passes the ids that belong to the tier.
 *
 * Third and fourth place come from the third-place match, and only from there.
 * Without one the two losing semi-finalists are genuinely tied and there is no
 * honest third, which is why `depth` is capped before it reaches this.
 */
export function podiumFromMatches(
  matches: Match[],
  teams: Map<string, Team>,
  opts: { tier?: BracketTier; bracketId?: string | null; depth?: number } = {},
): Podium {
  const tier = opts.tier ?? "cup";
  const depth = opts.depth ?? 3;
  const scoped =
    opts.bracketId === undefined ? matches : matches.filter((m) => m.bracket_id === opts.bracketId);

  const finalMatch = scoped.find((m) => m.stage === "final");
  const tpMatch = scoped.find((m) => m.stage === "third_place");
  const team = (id: string | null | undefined) => (id ? teams.get(id) ?? null : null);

  const places: PodiumPlace[] = [];
  const champion = finalMatch?.winner_team_id ?? null;
  if (champion) {
    places.push({ place: 1, team: team(champion) });
    if (depth >= 2) places.push({ place: 2, team: team(other(finalMatch!, champion)) });
  }
  const third = tpMatch?.winner_team_id ?? null;
  if (third && depth >= 3) {
    places.push({ place: 3, team: team(third) });
    if (depth >= 4) places.push({ place: 4, team: team(other(tpMatch!, third)) });
  }

  return { tier, places: places.filter((p) => p.team) };
}

function PodiumCard({ place, team, big }: { place: PodiumPlace["place"]; team: Team; big: boolean }) {
  return (
    <div
      className={`card flex flex-col items-center gap-2 text-center ${place === 1 ? "border-accent" : ""} ${
        big ? HEIGHT[place] : "p-4"
      }`}
    >
      <span className={big ? "text-6xl" : "text-4xl"}>{MEDAL[place]}</span>
      <div className="flex -space-x-2">
        {team.players?.map((p) => (
          <Avatar key={p.id} name={p.full_name} person={p} size={big ? 80 : 48} eager={big} />
        ))}
      </div>
      <p className={`font-bold ${big ? "text-4xl" : "text-xl"}`}>{team.team_name}</p>
      <p className={`text-muted ${big ? "text-xl" : "text-sm"}`}>
        {team.players?.map((p) => p.full_name).join(" & ")}
      </p>
      <p className={`font-semibold uppercase tracking-widest text-accent ${big ? "text-lg" : "text-xs"}`}>
        {LABEL[place]}
      </p>
    </div>
  );
}

/**
 * A podium, up to four places deep.
 *
 * Ordered runner-up, champion, third, fourth so the champion stands in the
 * middle — which is what a podium looks like, and reads correctly on a wall even
 * when the places are read left to right.
 */
export default function WinnerDisplay({
  podium,
  title,
  big = false,
}: {
  podium: Podium;
  /** Shown when there is more than one bracket to tell apart. */
  title?: string;
  big?: boolean;
}) {
  if (podium.places.length === 0) {
    return (
      <p className="card p-10 text-center text-muted">
        {title ? `${title}: ` : ""}The champion will be crowned here. Stay tuned! 🏆
      </p>
    );
  }

  const order = [2, 1, 3, 4];
  const shown = order
    .map((place) => podium.places.find((p) => p.place === place))
    .filter((p): p is PodiumPlace & { team: Team } => Boolean(p?.team));

  return (
    <div className="space-y-2">
      {title && (
        <p className={`text-center font-bold uppercase tracking-widest text-muted ${big ? "text-2xl" : "text-xs"}`}>
          {title}
        </p>
      )}
      <div
        className={`grid items-end gap-4 ${
          shown.length >= 4 ? "sm:grid-cols-4" : shown.length === 3 ? "sm:grid-cols-3" : shown.length === 2 ? "sm:grid-cols-2" : ""
        }`}
      >
        {shown.map((p) => (
          <PodiumCard key={p.place} place={p.place} team={p.team} big={big} />
        ))}
      </div>
    </div>
  );
}
