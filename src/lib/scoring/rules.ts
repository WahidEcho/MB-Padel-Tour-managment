import {
  DEFAULT_SCORING_CONFIG,
  type MatchRules,
  type ScoringConfig,
  type Stage,
  type StageRuleKey,
} from "../types";

/**
 * Which bracket a knockout match belongs to. Resolved from `matches.bracket_id`
 * by the caller; null for group and friendly matches, and for tournaments that
 * only run one bracket.
 */
export type BracketTier = "cup" | "plate";

/**
 * The rule bucket a match falls into, or null when the match must always use the
 * base config.
 *
 * Exhaustive over `Stage` on purpose: a new stage cannot be added without the
 * compiler pointing here.
 */
export function stageRuleKey(stage: Stage, tier: BracketTier | null = null): StageRuleKey | null {
  const plate = tier === "plate";
  switch (stage) {
    case "group":
      // Group matches are never in a bracket, so the tier is irrelevant.
      return "group";
    case "quarter_final":
    case "semi_final":
    case "third_place":
      return plate ? "plate_quarter_semi" : "quarter_semi";
    case "final":
      return plate ? "plate_final" : "final";
    case "knockout":
      return plate ? "plate_bracket" : "bracket";
    case "friendly":
      // Friendly sessions have one set of rules for the whole session. Per-stage
      // overrides are a tournament feature; a session match always uses the
      // backing tournament's base config.
      return null;
  }
}

/** The Cup key a `plate_*` key falls back to when the Plate has no override. */
function inheritsFrom(key: StageRuleKey): StageRuleKey | null {
  switch (key) {
    case "plate_quarter_semi":
      return "quarter_semi";
    case "plate_final":
      return "final";
    case "plate_bracket":
      return "bracket";
    default:
      return null;
  }
}

function pickRules(rules: Partial<MatchRules> | undefined): Partial<MatchRules> {
  if (!rules) return {};
  // Only the rule fields, so a stray `stageOverrides` in stored json can never
  // nest itself into a resolved config.
  const { setsToWinMatch, gamesToWinSet, tiebreakEnabled, tiebreakAtGames, tiebreakTargetPoints, tiebreakWinByTwo, walkoverScore } = rules;
  const out: Partial<MatchRules> = {};
  if (setsToWinMatch !== undefined) out.setsToWinMatch = setsToWinMatch;
  if (gamesToWinSet !== undefined) out.gamesToWinSet = gamesToWinSet;
  if (tiebreakEnabled !== undefined) out.tiebreakEnabled = tiebreakEnabled;
  if (tiebreakAtGames !== undefined) out.tiebreakAtGames = tiebreakAtGames;
  if (tiebreakTargetPoints !== undefined) out.tiebreakTargetPoints = tiebreakTargetPoints;
  if (tiebreakWinByTwo !== undefined) out.tiebreakWinByTwo = tiebreakWinByTwo;
  if (walkoverScore !== undefined) out.walkoverScore = walkoverScore;
  return out;
}

/**
 * The rules one match is played under.
 *
 * Layered, so every layer is optional and an absent layer changes nothing:
 * built-in defaults, then the tournament's own config, then the Cup override for
 * the stage, then the Plate override when the match is in the Plate.
 */
export function scoringConfigForMatch(
  tournament: { scoring_config?: Partial<ScoringConfig> | null } | null | undefined,
  match: { stage: Stage },
  tier: BracketTier | null = null,
): ScoringConfig {
  const base: ScoringConfig = { ...DEFAULT_SCORING_CONFIG, ...(tournament?.scoring_config ?? {}) };
  const key = stageRuleKey(match.stage, tier);
  if (!key) return base;
  const overrides = base.stageOverrides ?? {};
  const parentKey = inheritsFrom(key);
  return {
    ...base,
    ...(parentKey ? pickRules(overrides[parentKey]) : {}),
    ...pickRules(overrides[key]),
  };
}

export interface RuleProblem {
  field: keyof MatchRules;
  message: string;
}

/**
 * Rejects rule combinations the engine cannot honour. Two are worth stating,
 * because both fail silently rather than erroring:
 *
 * - The tie-break trigger in `winGame` is an exact `===` on both sides' games.
 *   With a trigger below `gamesToWinSet - 1` the set can end below
 *   `gamesToWinSet` (a tie-break at 3-3 in a "6-game set" finishes 4-3), which
 *   contradicts the set length the organiser just typed.
 * - A trigger *above* `gamesToWinSet` is legitimate and stays allowed: it is an
 *   advantage set that only breaks at N-N, because `winSet` also requires a
 *   two-game margin.
 *
 * Not offered anywhere in the UI, and deliberately so: `winGame` hard-codes the
 * two-game set margin, so a "first to 4, win by 1" format is not expressible.
 */
export function validateMatchRules(rules: MatchRules): RuleProblem[] {
  const problems: RuleProblem[] = [];
  const whole = (n: number) => Number.isInteger(n) && n >= 1;

  if (!whole(rules.setsToWinMatch)) {
    problems.push({ field: "setsToWinMatch", message: "Sets to win must be a whole number, at least 1." });
  }
  if (!whole(rules.gamesToWinSet)) {
    problems.push({ field: "gamesToWinSet", message: "Games to win a set must be a whole number, at least 1." });
  }
  if (!/^\d+-\d+$/.test(rules.walkoverScore)) {
    problems.push({ field: "walkoverScore", message: 'Walkover score must look like "6-0".' });
  }
  if (rules.tiebreakEnabled) {
    if (!whole(rules.tiebreakTargetPoints)) {
      problems.push({ field: "tiebreakTargetPoints", message: "Tie-break target must be a whole number, at least 1." });
    }
    if (!whole(rules.tiebreakAtGames)) {
      problems.push({ field: "tiebreakAtGames", message: "Tie-break trigger must be a whole number, at least 1." });
    } else if (whole(rules.gamesToWinSet) && rules.tiebreakAtGames < rules.gamesToWinSet - 1) {
      problems.push({
        field: "tiebreakAtGames",
        message: `A tie-break at ${rules.tiebreakAtGames}-${rules.tiebreakAtGames} would end the set at ${rules.tiebreakAtGames + 1} games, short of the ${rules.gamesToWinSet} you set. Use ${rules.gamesToWinSet - 1} or more.`,
      });
    }
  }
  return problems;
}

/** One line describing the resolved rules, for the referee header. */
export function describeMatchRules(rules: MatchRules): string {
  const sets =
    rules.setsToWinMatch === 1 ? "1 set" : `best of ${rules.setsToWinMatch * 2 - 1}`;
  const parts = [sets, `first to ${rules.gamesToWinSet}`];
  if (rules.tiebreakEnabled) {
    const advantage = rules.tiebreakAtGames > rules.gamesToWinSet;
    parts.push(
      `${advantage ? "advantage set, " : ""}tie-break to ${rules.tiebreakTargetPoints} at ${rules.tiebreakAtGames}-${rules.tiebreakAtGames}`,
    );
  } else {
    parts.push("no tie-break");
  }
  return parts.join(" · ");
}

/** How each rule bucket is labelled in the settings form and the referee header. */
export const STAGE_RULE_LABELS: Record<StageRuleKey, string> = {
  group: "Group stage",
  quarter_semi: "Quarter-finals, semi-finals & third place",
  final: "Final",
  bracket: "Earlier knockout rounds",
  plate_quarter_semi: "Plate quarter-finals, semi-finals & third place",
  plate_final: "Plate final",
  plate_bracket: "Plate earlier rounds",
};
