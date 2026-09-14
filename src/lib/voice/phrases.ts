/**
 * Every clip the voice umpire can say, and the words each one holds.
 *
 * This is the single inventory both sides read: the generator records exactly
 * these phrases into the voice pack, and the call builder only ever asks for ids
 * from here. Whole phrases ("Fifteen love", "Three games to one") are recorded
 * as one clip so they keep a natural rhythm; the rarer, longer scores are built
 * from number words.
 *
 * Changing any text means generating a new pack under a new `VOICE_PACK`
 * version: recorded voices drift between runs, so clips from two runs never mix.
 */

export const VOICE_PACK = "en-v1";
/** Built from a stand-in voice for development only. Never committed or deployed. */
export const DEV_VOICE_PACK = "en-dev";
/**
 * Sample rate of every clip in a pack. 16 kHz keeps speech fully clear through a
 * Bluetooth speaker while holding the whole pack to about 5 MB uncompressed.
 */
export const PACK_SAMPLE_RATE = 16000;

export type ClipId = string;

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty"];

/** Largest number with its own clip. */
export const MAX_NUMBER = 40;

export function numberWord(n: number): string {
  if (n < 20) return ONES[n];
  const tens = TENS[Math.floor(n / 10)];
  return n % 10 === 0 ? tens : `${tens}-${ONES[n % 10]}`;
}

const POINT_WORD: Record<string, string> = { "0": "love", "15": "fifteen", "30": "thirty", "40": "forty" };
export const POINT_LABELS = ["0", "15", "30", "40"] as const;

/** Tie-break scores up to this many points a side are whole-phrase clips. */
export const MAX_TIEBREAK_PHRASE = 7;
/** Games tallies up to this many games are whole-phrase clips. */
export const MAX_GAMES_PHRASE = 7;

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function buildPhrases(): Record<ClipId, string> {
  const p: Record<ClipId, string> = {};

  // Points, server's score first.
  for (const s of POINT_LABELS) {
    for (const r of POINT_LABELS) {
      p[`pts-${s}-${r}`] =
        s === "40" && r === "40" ? "Deuce." : s === r ? `${capitalise(POINT_WORD[s])} all.` : `${capitalise(POINT_WORD[s])} ${POINT_WORD[r]}.`;
    }
  }
  p["adv-server"] = "Advantage server.";
  p["adv-receiver"] = "Advantage receiver.";

  // Tie-break scores, server's points first.
  for (let s = 0; s <= MAX_TIEBREAK_PHRASE; s++) {
    for (let r = 0; r <= MAX_TIEBREAK_PHRASE; r++) {
      p[`tb-${s}-${r}`] = s === r ? `${capitalise(numberWord(s))} all.` : `${capitalise(numberWord(s))} ${numberWord(r)}.`;
    }
  }

  // Number words, for scores past the whole phrases.
  for (let n = 0; n <= MAX_NUMBER; n++) p[`n-${n}`] = numberWord(n);
  p["all"] = "all";
  p["love"] = "love";

  // Games tallies, leader first.
  for (let l = 1; l <= MAX_GAMES_PHRASE; l++) {
    for (let t = 0; t < l; t++) {
      const trailing = t === 0 ? "love" : numberWord(t);
      p[`games-${l}-${t}`] = `${numberWord(l)} ${l === 1 ? "game" : "games"} to ${trailing}.`;
    }
    p[`games-all-${l}`] = `${capitalise(numberWord(l))} ${l === 1 ? "game" : "games"} all.`;
  }
  p["games-to"] = "games to";
  p["game-to"] = "game to";
  p["games-all"] = "games all.";

  // Sets tallies. Best of five is the longest format with a tally.
  p["sets-1-0"] = "one set to love.";
  p["sets-2-0"] = "two sets to love.";
  p["sets-2-1"] = "two sets to one.";
  p["sets-all-1"] = "One set all.";
  p["sets-all-2"] = "Two sets all.";
  p["leads-server"] = "Server leads";
  p["leads-receiver"] = "Receiver leads";

  // Calls.
  p["game"] = "Game.";
  p["set"] = "Set.";
  p["game-and-set"] = "Game and set.";
  p["game-set-match"] = "Game, set and match.";
  p["tie-break"] = "Tie-break.";
  p["correction"] = "Correction.";
  p["break-point"] = "Break point.";
  p["set-point"] = "Set point.";
  p["match-point"] = "Match point.";
  return p;
}

export const PHRASES: Readonly<Record<ClipId, string>> = buildPhrases();

/** Clips followed by a longer breath, so the next part reads as a new sentence. */
export const LONG_PAUSE_AFTER: ReadonlySet<ClipId> = new Set([
  "game",
  "set",
  "game-and-set",
  "tie-break",
  "correction",
]);

/** What the Test button says. */
export const TEST_CALL: ClipId[] = ["pts-15-0", "pts-40-40", "adv-server"];

/** The words of a call, for the caption under the voice controls. */
export function captionFor(ids: ClipId[]): string {
  const text = ids.map((id) => PHRASES[id] ?? "").filter(Boolean);
  return text
    .join(" ")
    .replace(/\s+([.,])/g, "$1")
    .replace(/(^|[.]\s+)([a-z])/g, (_m, lead: string, c: string) => lead + c.toUpperCase());
}
