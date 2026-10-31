/**
 * The ITF junior team competition regulations Move Score checks, in our own words.
 * Pure (shared with the app through @core): the regulation page on the web
 * (/regulations/itf-junior-team/[reg]) and every "ITF Reg. 43" link in a warning
 * read from here.
 *
 * These are short summaries written for the court, not the ITF's text. The official
 * regulations decide; every page links to them (ITF_REGULATIONS_URL). Numbering is
 * the 2026 ITF junior team competitions regulations as the code uses them.
 */

/** The ITF's own page for its rules and regulations (the official documents live there). */
export const ITF_REGULATIONS_URL = "https://www.itftennis.com/en/about-us/governance/rules-and-regulations/";

/** Where Move Score's own summary of a regulation is (web; the app opens it in the browser). */
export const regulationPath = (reg: string) => `/regulations/itf-junior-team/${encodeURIComponent(reg)}`;

/** "ITF Reg. 43": how a warning names a regulation (the link text). */
export const regulationLabel = (reg: string) => `ITF Reg. ${reg}`;

export interface RegulationSummary {
  reg: string;
  title: string;
  /** What the rule is about, in plain words. */
  summary: string[];
  /** What Move Score does about it. */
  inMoveScore: string[];
}

export const ITF_TEAM_REGULATIONS: Record<string, RegulationSummary> = {
  "36": {
    reg: "36",
    title: "Draws for the groups and the placement play-offs",
    summary: [
      "The nations are seeded and drawn into groups; the top seeds head the groups.",
      "After the groups, the nations play on for every final place. Where the group positions alone do not decide who goes where, lots are drawn at the venue.",
    ],
    inMoveScore: ["The desk enters how the lots fell before making the placement draws (Ties page)."],
  },
  "38": {
    reg: "38",
    title: "Ranking within a group",
    summary: [
      "Nations in a group are ranked by ties won. Two nations level: the tie between them decides. Three or more level: rubbers won, then the share of sets won, then of games won, over all their group rubbers.",
      "A match tie-break counts as one set and one game. A rubber stopped by injury counts as if the side that went through had won every remaining game; a walkover counts 6-0 6-0.",
    ],
    inMoveScore: ["The group tables are worked out this way after every rubber."],
  },
  "43": {
    reg: "43",
    title: "Naming the players for a tie (order of merit)",
    summary: [
      "Before a tie, each captain names the two singles players. Of the two, the one ranked higher in the nation's order of merit (the ranking the nation sends in with its team) plays Singles 1; the other plays Singles 2.",
      "The doubles pair is named later, after the singles.",
      "A player can play one singles and the doubles, never both singles.",
    ],
    inMoveScore: [
      "The squad lists show each player's place in the order of merit (No. 1 first).",
      "A line-up against the order of merit is a warning, not a refusal: the chair umpire may accept it, and the master referees and the organiser are told at once. The acceptance is recorded with the referee's name.",
    ],
  },
  "46": {
    reg: "46",
    title: "Changing a nominated player",
    summary: [
      "Once the singles are named, a player may be replaced only for a real reason such as illness or injury, and with the Referee's approval.",
    ],
    inMoveScore: ["After the line-ups are confirmed, every change needs a reason. It is recorded as a late change, with who made it."],
  },
  "50": {
    reg: "50",
    title: "A player who retired earlier in the tie",
    summary: [
      "A player who retires from a rubber through illness or injury may not play again in the same tie unless the Referee agrees.",
    ],
    inMoveScore: [
      "Naming that player again is a warning: the referee may accept it (it stands for the Referee's agreement), and the master referees and the organiser are told at once.",
    ],
  },
  "51": {
    reg: "51",
    title: "Match format of the placement play-offs",
    summary: [
      "The main draw and the play-off for the last two places play full singles (best of three tie-break sets). The other placement singles are shorter: two sets and, at one set all, a 10-point match tie-break.",
    ],
    inMoveScore: ["The shorter format is set on those rubbers automatically when the placement draws are made."],
  },
};

export function regulationSummary(reg: string): RegulationSummary | null {
  return ITF_TEAM_REGULATIONS[reg] ?? null;
}
