/**
 * The lock-screen card's words for a card the server starts or updates (APNs
 * replaces the card's whole content state, so the words the app handed over are
 * gone after the first server push). The card reads `labels` when the state has
 * them (move-score-app/src/live/MatchScoreActivity.tsx) and falls back to its
 * built-in English otherwise, so English cards carry none and look exactly as
 * before. The same words as the app's `lock` namespace (move-score-app/src/i18n);
 * lockWords.test.ts keeps the two equal.
 */
import { aw, vsIn, type AlertLang } from "./i18n";
import type { LiveScoreState } from "./liveActivity";

export interface LockLabels {
  now: string;
  soon: string;
  /** "{court}" is replaced on the card. */
  beOn: string;
  headToCourt: string;
  nextOn: string;
  upNext: string;
  final: string;
  courtCaps: string;
  vs: string;
  liveCaps: string;
  tbc: string;
  noMatches: string;
  signIn: string;
  myMatches: string;
  /** The server's English status words ("Live", "Final", …) → the card's. */
  status: Record<string, string>;
}

type Words = Omit<LockLabels, "status"> & { statusLive: string; statusPaused: string; statusWalkover: string; statusRetired: string; statusCalled: string };

export const LOCK_WORDS: Record<Exclude<AlertLang, "en">, Words> = {
  es: {
    now: "Ya",
    soon: "Pronto",
    beOn: "Ve a {court}",
    headToCourt: "Ve a tu pista",
    nextOn: "Siguiente en {court}",
    upNext: "A continuación",
    final: "Final",
    courtCaps: "PISTA",
    vs: "vs.",
    statusLive: "En directo",
    statusPaused: "En pausa",
    statusWalkover: "W.O.",
    statusRetired: "Retirada",
    statusCalled: "Llamada a pista",
    liveCaps: "EN DIRECTO",
    tbc: "Por conf.",
    noMatches: "No tienes partidos próximos",
    signIn: "Inicia sesión para ver tus partidos",
    myMatches: "MIS PARTIDOS",
  },
  fr: {
    now: "Maintenant",
    soon: "Bientôt",
    beOn: "Direction {court}",
    headToCourt: "Rejoignez votre court",
    nextOn: "Ensuite : {court}",
    upNext: "À suivre",
    final: "Terminé",
    courtCaps: "COURT",
    vs: "vs",
    statusLive: "En direct",
    statusPaused: "Interrompu",
    statusWalkover: "Forfait",
    statusRetired: "Abandon",
    statusCalled: "Appelé sur le court",
    liveCaps: "DIRECT",
    tbc: "À conf.",
    noMatches: "Aucun match à venir",
    signIn: "Connectez-vous pour voir vos matchs",
    myMatches: "MES MATCHS",
  },
};

/** The card's labels in `lang`; none for English (the card's own words). */
export function lockLabelsFor(lang: AlertLang): LockLabels | null {
  if (lang === "en") return null;
  const { statusLive, statusPaused, statusWalkover, statusRetired, statusCalled, ...rest } = LOCK_WORDS[lang];
  return {
    ...rest,
    status: { Live: statusLive, Paused: statusPaused, Final: rest.final, Walkover: statusWalkover, Retired: statusRetired, "Called to court": statusCalled, "Up next": rest.upNext },
  };
}

/** The content state for a phone in `lang`: English unchanged, other languages with their labels. */
export function stateIn<T extends LiveScoreState>(state: T, lang: AlertLang): T | (T & { labels: LockLabels }) {
  const labels = lockLabelsFor(lang);
  return labels ? { ...state, labels } : state;
}

const START = {
  es: { called: "Te llaman a pista", calledBody: "{vs}{where}. Ve ya a la pista.", soon: "Tu partido es el siguiente", final: "Final", live: "Partido en directo", where: " en {court}" },
  fr: { called: "Appel sur le court", calledBody: "{vs}{where}. Rejoignez le court maintenant.", soon: "Votre match est le prochain", final: "Terminé", live: "Match en direct", where: " sur {court}" },
} as const;

/** The alert that comes with a card started by push, in `lang` (null: English, liveActivity.ts's startAlert). */
export function startAlertIn(lang: AlertLang, state: LiveScoreState): { title: string; body: string } | null {
  if (lang === "en") return null;
  const w = START[lang];
  const vs = vsIn(lang, state.a || aw(lang, "tbd"), state.b || aw(lang, "tbd"));
  const where = state.court ? w.where.replace("{court}", state.court) : "";
  switch (state.phase) {
    case "called":
      return { title: w.called, body: w.calledBody.replace("{vs}", vs).replace("{where}", where) };
    case "soon":
      return { title: w.soon, body: `${vs}${where}.` };
    case "final":
      return { title: w.final, body: `${vs} ${state.sets}`.trim() };
    default:
      return { title: w.live, body: `${vs}${where}.` };
  }
}
