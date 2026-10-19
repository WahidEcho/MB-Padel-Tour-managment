/**
 * The ITF Rules of Tennis the scoring console times by, in our own words (Rule 10,
 * change of ends; Rule 29a, continuous play). Pure (shared with the app through
 * @core): the web page /regulations/itf-rules-of-tennis/[rule] and the timers'
 * "ITF Rule 29a · p. 14" reference read from here. Short summaries for the court,
 * not the ITF's text: every page links to the official 2026 Rules of Tennis.
 */
export { ITF_RULES_PDF } from "../scoring/timing";

export const rulePath = (rule: string) => `/regulations/itf-rules-of-tennis/${encodeURIComponent(rule)}`;

export interface TennisRuleSummary {
  rule: string;
  title: string;
  /** Page of the 2026 Rules of Tennis PDF. */
  page: string;
  summary: string[];
  inMoveScore: string[];
}

export const ITF_TENNIS_RULES: Record<string, TennisRuleSummary> = {
  "10": {
    rule: "10",
    title: "Change of ends",
    page: "p. 7",
    summary: [
      "The players change ends after the first, the third and every other odd game of each set.",
      "They also change at the end of a set when the set's games add up to an odd number; otherwise they change after the first game of the next set.",
      "In a tie-break they change ends every six points.",
    ],
    inMoveScore: [
      "The console tells the referee when the players change ends, and can swap its left and right point buttons by itself (an organiser setting).",
    ],
  },
  "29a": {
    rule: "29a",
    title: "Continuous play: time between points, changeovers and set breaks",
    page: "p. 14",
    summary: [
      "Play is continuous from the first serve. At most 25 seconds pass from the end of one point to the next serve.",
      "At a change of ends there are at most 90 seconds — except after the first game of each set and during a tie-break, where play goes on without a rest.",
      "At the end of each set there is a set break of at most 120 seconds.",
    ],
    inMoveScore: [
      "The 25-second, changeover and set break timers count up to these limits; past a limit the referee chooses a code violation, a warning or no action, and the choice is in the match log.",
    ],
  },
};

export const ruleSummary = (rule: string): TennisRuleSummary | null => ITF_TENNIS_RULES[rule] ?? null;
