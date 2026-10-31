/**
 * Alert wording in each phone's language (English, Spanish, French). Pure, so
 * every sentence is tested (i18n.test.ts, compose.test.ts).
 *
 * The outbox keeps one alert per event (compose.ts): English in `title`/`body`
 * (what older rows and unknown languages get), and the same alert in Spanish and
 * French in `tr`. The drain reads each phone's `push_devices.locale` (the app's
 * language, sent with every registration) and picks the wording with
 * `wordsFor`. Names, codes, courts and anything the organiser typed (round
 * names, event names, announcements) are never translated; the fixed labels the
 * platform writes itself ("No. 1 singles", "Group A", "Cup · places 1–8") are.
 */

export const ALERT_LANGS = ["en", "es", "fr"] as const;
export type AlertLang = (typeof ALERT_LANGS)[number];

/** A phone's stored locale ("es", "fr-CA", "en-GB", null) → the alert language, English when unknown. */
export function alertLang(locale: string | null | undefined): AlertLang {
  const code = String(locale ?? "")
    .trim()
    .toLowerCase()
    .split(/[-_]/)[0];
  return code === "es" || code === "fr" ? code : "en";
}

export interface Words {
  title: string;
  body: string;
}

/** One alert in one language: the general wording and, when it has one, the players' own. */
export interface AlertWords extends Words {
  self?: Words;
}

/** The Spanish and French versions an outbox row carries next to its English. */
export type AlertTranslations = Partial<Record<Exclude<AlertLang, "en">, AlertWords>>;

/**
 * What one phone reads: its language's wording when the row has it, else the
 * English. `self` picks the players' own wording (payload.self).
 */
export function wordsFor(
  payload: { title: string; body: string; self?: { title: string; body: string } | null; tr?: AlertTranslations | null },
  locale: string | null | undefined,
  self: boolean,
): Words {
  const lang = alertLang(locale);
  const local = lang === "en" ? undefined : payload.tr?.[lang];
  if (self && payload.self) {
    const w = local?.self;
    return w?.title && w.body !== undefined ? { title: w.title, body: w.body } : { title: payload.self.title, body: payload.self.body };
  }
  return local?.title ? { title: local.title, body: local.body ?? payload.body } : { title: payload.title, body: payload.body };
}

/* ---------------- times ---------------- */

/** "14:30" in the event's zone. The clock reads the same in every language. */
export function clock(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

const INTL: Record<AlertLang, string> = { en: "en-GB", es: "es-ES", fr: "fr-FR" };

/** "Wed 4 Nov" / "mié, 4 nov" / "mer. 4 nov." in the event's zone. */
export function dayIn(lang: AlertLang, iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(INTL[lang], { timeZone, weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/* ---------------- the words ---------------- */

const EN = {
  vs: "{a} v {b}",
  line: "{label}: ",
  courtTba: "Court to be announced",
  timeTba: "time to be announced",
  whenAt: "{day}, {time} ({city} time)",
  tbd: "TBD",
  players: "Players",
  onCourt: "on court",
  about: "about {time}",
  // ties and matches
  moved: "Moved: {vs}",
  scheduled: "Scheduled: {vs}",
  scheduleBody: "{court} · {when} · {event}",
  courtAndTime: "Court and time: {vs}",
  startingSoon: "Starting soon: {vs}",
  courtAt: "{court} at {time}",
  lineups: "Line-ups: {vs}",
  liveNow: "Live now: {vs}",
  won: "{winner} won",
  wonBody: "{score} against {loser} · {label}",
  wonBodyNoScore: "against {loser} · {label}",
  beat: "{winner} beat {loser} {rubbers}",
  // league nights
  yourTable: "Your table: {court}, {when}",
  nightPlace: " · match {n} on {court}",
  nightBody: "{vs}{place} · {event}",
  // match day
  nextOn: "Next on {court}: {vs}",
  nextOnBody: "The match on court is one game from the end · {label}",
  youNext: "You're next on {court}",
  youNextBody: "{vs}: the match on court is one game from the end. Get ready.",
  calledTo: "Called to {court}: {vs}",
  calledToBody: "Players to the court by {by} · {label}",
  youCalled: "You're called to {court}",
  youCalledBody: "{vs}: be at the court by {by} ({minutes} min).",
  minLeftTo: "{minutes} min to reach {court}",
  minLeftToBody: "{vs} · players to the court by {by}",
  youMinLeft: "{minutes} min left to reach {court}",
  youMinLeftBody: "{vs}: be at the court by {by}, or the referee may record a no-show.",
  // team coaches
  coachTieSoon: "{vs} starts in 5 minutes",
  coachTieSoonBody: "{court} at {time} · {stage}",
  coachNextOn: "Next on {court}: {label} · {vs}",
  coachNextOnBody: "{players}: the match on court is one game from the end.",
  coachNextOnBodyNone: "The match on court is one game from the end.",
  coachCalled: "Called to {court}: {label} · {vs}",
  coachCalledBody: "{players} to the court by {time}.",
  coachStarted: "Started: {label} · {vs}",
  coachWon: "Won: {label} · {vs}",
  coachLost: "Lost: {label} · {vs}",
  matchWon: "Match won",
  matchLost: "Match lost",
  coachBeat: "{us} beat {them} {rubbers}",
  coachLostTo: "{us} lost to {them} {rubbers}",
  lineupChanged: "Line-up changed: {vs}",
  lineupEntered: "Line-up entered: {vs}",
  lineupEnteredBody: "Line-up entered",
  // officials
  assistance: "Call for assistance",
  assistanceBody: "Chair umpire {name} is calling for assistance at {court}",
  coachLineupChanged: "Line-up changed by the coach",
  coachLineupSubmitted: "Line-up submitted by the coach",
  coachLineupChangedBody: "{by} changed the line-up for {vs}{court}. Confirm it in the line-up screen.",
  coachLineupSubmittedBody: "{by} submitted the line-up for {vs}{court}. Confirm it in the line-up screen.",
  lineupException: "Line-up exception",
  lineupExceptionBody: "{actor} accepted a line-up exception{court}: {issues}",
  onCourtName: " on {court}",
  // play status
  playDelayed: "Play delayed",
  playSuspended: "Play suspended",
  playResumed: "Play resumed",
  resumeAbout: "Play expected to resume about {time}",
  underWayAgain: "Play is under way again.",
  followEventPage: "Follow the event page for updates.",
  // statuses written instead of a score
  st_walkover: "walkover",
  st_retired: "retired",
  st_disqualified: "disqualified",
  st_cancelled: "cancelled",
  // fixed labels the platform writes
  lb_S1: "No. 1 singles",
  lb_S2: "No. 2 singles",
  lb_D: "Doubles",
  lb_match: "Match",
  lb_placement: "Placement",
  lb_final: "Final",
  lb_groupStage: "Group stage",
  lb_group: "Group {name}",
  lb_semi: "Semi-final",
  lb_semis: "Semi-finals",
  lb_quarter: "Quarter-final",
  lb_quarters: "Quarter-finals",
  lb_third: "Third place",
  lb_cup: "Cup",
  lb_plate: "Plate",
  lb_places: "places {from}–{to}",
  lb_Places: "Places {from}–{to}",
  lb_round: "Round {n}",
  lb_roundOf: "Round of {n}",
  lb_playoff: "Play-off {from}–{to}",
};

type Dict = Record<keyof typeof EN, string>;

const ES: Dict = {
  vs: "{a} vs. {b}",
  line: "{label}: ",
  courtTba: "Pista por anunciar",
  timeTba: "hora por anunciar",
  whenAt: "{day}, {time} (hora de {city})",
  tbd: "Por definir",
  players: "Jugadores",
  onCourt: "en pista",
  about: "hacia las {time}",
  moved: "Cambio: {vs}",
  scheduled: "Programado: {vs}",
  scheduleBody: "{court} · {when} · {event}",
  courtAndTime: "Pista y hora: {vs}",
  startingSoon: "A punto de empezar: {vs}",
  courtAt: "{court} a las {time}",
  lineups: "Alineaciones: {vs}",
  liveNow: "En directo: {vs}",
  won: "Gana {winner}",
  wonBody: "{score} ante {loser} · {label}",
  wonBodyNoScore: "Ante {loser} · {label}",
  beat: "{winner} vence a {loser} {rubbers}",
  yourTable: "Tu partido: {court}, {when}",
  nightPlace: " · partido {n} en {court}",
  nightBody: "{vs}{place} · {event}",
  nextOn: "Siguiente en {court}: {vs}",
  nextOnBody: "Al partido en pista le queda un juego · {label}",
  youNext: "Juegas a continuación en {court}",
  youNextBody: "{vs}: al partido en pista le queda un juego. Prepárate.",
  calledTo: "Llamada a {court}: {vs}",
  calledToBody: "Jugadores a pista antes de las {by} · {label}",
  youCalled: "Te llaman a {court}",
  youCalledBody: "{vs}: preséntate en pista antes de las {by} ({minutes} min).",
  minLeftTo: "{minutes} min para llegar a {court}",
  minLeftToBody: "{vs} · jugadores a pista antes de las {by}",
  youMinLeft: "Te quedan {minutes} min para llegar a {court}",
  youMinLeftBody: "{vs}: preséntate en pista antes de las {by} o el juez podrá declarar la incomparecencia.",
  coachTieSoon: "{vs} empieza en 5 minutos",
  coachTieSoonBody: "{court} a las {time} · {stage}",
  coachNextOn: "Siguiente en {court}: {label} · {vs}",
  coachNextOnBody: "{players}: al partido en pista le queda un juego.",
  coachNextOnBodyNone: "Al partido en pista le queda un juego.",
  coachCalled: "Llamada a {court}: {label} · {vs}",
  coachCalledBody: "{players} a pista antes de las {time}.",
  coachStarted: "Empieza: {label} · {vs}",
  coachWon: "Ganado: {label} · {vs}",
  coachLost: "Perdido: {label} · {vs}",
  matchWon: "Partido ganado",
  matchLost: "Partido perdido",
  coachBeat: "{us} vence a {them} {rubbers}",
  coachLostTo: "{us} pierde ante {them} {rubbers}",
  lineupChanged: "Alineación cambiada: {vs}",
  lineupEntered: "Alineación registrada: {vs}",
  lineupEnteredBody: "Alineación registrada",
  assistance: "Solicitud de asistencia",
  assistanceBody: "El juez de silla {name} pide asistencia en {court}",
  coachLineupChanged: "El entrenador ha cambiado la alineación",
  coachLineupSubmitted: "El entrenador ha enviado la alineación",
  coachLineupChangedBody: "{by} ha cambiado la alineación de {vs}{court}. Confírmala en la pantalla de alineaciones.",
  coachLineupSubmittedBody: "{by} ha enviado la alineación de {vs}{court}. Confírmala en la pantalla de alineaciones.",
  lineupException: "Excepción en la alineación",
  lineupExceptionBody: "{actor} ha aceptado una excepción en la alineación{court}: {issues}",
  onCourtName: " en {court}",
  playDelayed: "Juego retrasado",
  playSuspended: "Juego suspendido",
  playResumed: "Se reanuda el juego",
  resumeAbout: "Está previsto reanudar el juego hacia las {time}",
  underWayAgain: "El juego se ha reanudado.",
  followEventPage: "Sigue la página del evento para más novedades.",
  st_walkover: "W.O.",
  st_retired: "retirada",
  st_disqualified: "descalificación",
  st_cancelled: "cancelado",
  lb_S1: "Individual n.º 1",
  lb_S2: "Individual n.º 2",
  lb_D: "Dobles",
  lb_match: "Partido",
  lb_placement: "Clasificación",
  lb_final: "Final",
  lb_groupStage: "Fase de grupos",
  lb_group: "Grupo {name}",
  lb_semi: "Semifinal",
  lb_semis: "Semifinales",
  lb_quarter: "Cuartos de final",
  lb_quarters: "Cuartos de final",
  lb_third: "Tercer puesto",
  lb_cup: "Copa",
  lb_plate: "Consolación",
  lb_places: "puestos {from}–{to}",
  lb_Places: "Puestos {from}–{to}",
  lb_round: "Ronda {n}",
  lb_roundOf: "Ronda de {n}",
  lb_playoff: "Por los puestos {from}–{to}",
};

const FR: Dict = {
  vs: "{a} vs {b}",
  line: "{label} : ",
  courtTba: "Court à annoncer",
  timeTba: "horaire à annoncer",
  whenAt: "{day}, {time} (heure de {city})",
  tbd: "À déterminer",
  players: "Joueurs",
  onCourt: "sur le court",
  about: "vers {time}",
  moved: "Déplacé : {vs}",
  scheduled: "Programmé : {vs}",
  scheduleBody: "{court} · {when} · {event}",
  courtAndTime: "Court et horaire : {vs}",
  startingSoon: "Bientôt : {vs}",
  courtAt: "{court} à {time}",
  lineups: "Compositions : {vs}",
  liveNow: "En direct : {vs}",
  won: "Victoire de {winner}",
  wonBody: "{score} contre {loser} · {label}",
  wonBodyNoScore: "Contre {loser} · {label}",
  beat: "{winner} bat {loser} {rubbers}",
  yourTable: "Votre match : {court}, {when}",
  nightPlace: " · match {n} sur {court}",
  nightBody: "{vs}{place} · {event}",
  nextOn: "Prochain match sur {court} : {vs}",
  nextOnBody: "Le match en cours n'est plus qu'à un jeu de la fin · {label}",
  youNext: "Vous jouez ensuite sur {court}",
  youNextBody: "{vs} : le match en cours n'est plus qu'à un jeu de la fin. Préparez-vous.",
  calledTo: "Appel sur {court} : {vs}",
  calledToBody: "Joueurs attendus sur le court avant {by} · {label}",
  youCalled: "On vous appelle sur {court}",
  youCalledBody: "{vs} : soyez sur le court avant {by} ({minutes} min).",
  minLeftTo: "{minutes} min pour rejoindre {court}",
  minLeftToBody: "{vs} · joueurs attendus sur le court avant {by}",
  youMinLeft: "Plus que {minutes} min pour rejoindre {court}",
  youMinLeftBody: "{vs} : soyez sur le court avant {by}, sinon l'arbitre peut constater votre absence.",
  coachTieSoon: "{vs} commence dans 5 minutes",
  coachTieSoonBody: "{court} à {time} · {stage}",
  coachNextOn: "Prochain match sur {court} : {label} · {vs}",
  coachNextOnBody: "{players} : le match en cours n'est plus qu'à un jeu de la fin.",
  coachNextOnBodyNone: "Le match en cours n'est plus qu'à un jeu de la fin.",
  coachCalled: "Appel sur {court} : {label} · {vs}",
  coachCalledBody: "{players} sur le court avant {time}.",
  coachStarted: "Début : {label} · {vs}",
  coachWon: "Gagné : {label} · {vs}",
  coachLost: "Perdu : {label} · {vs}",
  matchWon: "Match gagné",
  matchLost: "Match perdu",
  coachBeat: "{us} bat {them} {rubbers}",
  coachLostTo: "{us} s'incline face à {them} {rubbers}",
  lineupChanged: "Composition modifiée : {vs}",
  lineupEntered: "Composition saisie : {vs}",
  lineupEnteredBody: "Composition saisie",
  assistance: "Demande d'assistance",
  assistanceBody: "Le juge de chaise {name} demande de l'assistance sur {court}",
  coachLineupChanged: "Composition modifiée par l'entraîneur",
  coachLineupSubmitted: "Composition envoyée par l'entraîneur",
  coachLineupChangedBody: "{by} a modifié la composition de {vs}{court}. Confirmez-la dans l'écran des compositions.",
  coachLineupSubmittedBody: "{by} a envoyé la composition de {vs}{court}. Confirmez-la dans l'écran des compositions.",
  lineupException: "Exception de composition",
  lineupExceptionBody: "{actor} a accepté une exception de composition{court} : {issues}",
  onCourtName: " sur {court}",
  playDelayed: "Jeu retardé",
  playSuspended: "Jeu interrompu",
  playResumed: "Reprise du jeu",
  resumeAbout: "Reprise du jeu prévue vers {time}",
  underWayAgain: "Le jeu a repris.",
  followEventPage: "Suivez la page de l'événement pour les dernières informations.",
  st_walkover: "forfait",
  st_retired: "abandon",
  st_disqualified: "disqualification",
  st_cancelled: "annulé",
  lb_S1: "Simple n° 1",
  lb_S2: "Simple n° 2",
  lb_D: "Double",
  lb_match: "Match",
  lb_placement: "Classement",
  lb_final: "Finale",
  lb_groupStage: "Phase de poules",
  lb_group: "Poule {name}",
  lb_semi: "Demi-finale",
  lb_semis: "Demi-finales",
  lb_quarter: "Quart de finale",
  lb_quarters: "Quarts de finale",
  lb_third: "Troisième place",
  lb_cup: "Coupe",
  lb_plate: "Consolante",
  lb_places: "places {from}–{to}",
  lb_Places: "Places {from}–{to}",
  lb_round: "Tour {n}",
  lb_roundOf: "{half}es de finale",
  lb_playoff: "Match de classement {from}–{to}",
};

export type AlertKey = keyof typeof EN;

const DICTS: Record<AlertLang, Dict> = { en: EN, es: ES, fr: FR };

/** For the completeness test. */
export const ALERT_DICTS: Readonly<Record<AlertLang, Readonly<Dict>>> = DICTS;

/** The sentence for `key` in `lang`, with `{name}` filled in. */
export function aw(lang: AlertLang, key: AlertKey, params: Record<string, string | number | null | undefined> = {}): string {
  return DICTS[lang][key].replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = params[name];
    return v === undefined || v === null ? whole : String(v);
  });
}

/** "EGY v JPN" / "EGY vs. JPN" / "EGY vs JPN". */
export function vsIn(lang: AlertLang, a: string, b: string): string {
  return aw(lang, "vs", { a, b });
}

/** A match status written in place of a score ("walkover" → "W.O." / "forfait"). */
export function statusWord(lang: AlertLang, status: string): string {
  const key = `st_${status}` as AlertKey;
  return key in EN ? aw(lang, key) : status;
}

const FIXED: Record<string, AlertKey> = {
  "No. 1 singles": "lb_S1",
  "No. 2 singles": "lb_S2",
  Doubles: "lb_D",
  Match: "lb_match",
  Placement: "lb_placement",
  Final: "lb_final",
  "Group stage": "lb_groupStage",
  "Semi-final": "lb_semi",
  "Semi-finals": "lb_semis",
  "Quarter-final": "lb_quarter",
  "Quarter-finals": "lb_quarters",
  "Third place": "lb_third",
  Cup: "lb_cup",
  Plate: "lb_plate",
};

function labelPart(lang: AlertLang, part: string): string {
  const fixed = FIXED[part];
  if (fixed) return aw(lang, fixed);
  let m = /^Group (.+)$/.exec(part);
  if (m) return aw(lang, "lb_group", { name: m[1] });
  m = /^places (\d+)\s*[–-]\s*(\d+)$/.exec(part);
  if (m) return aw(lang, "lb_places", { from: m[1], to: m[2] });
  m = /^Places (\d+)\s*[–-]\s*(\d+)$/.exec(part);
  if (m) return aw(lang, "lb_Places", { from: m[1], to: m[2] });
  m = /^Play-off (\d+)\s*[–-]\s*(\d+)$/.exec(part);
  if (m) return aw(lang, "lb_playoff", { from: m[1], to: m[2] });
  m = /^Round of (\d+)$/.exec(part);
  if (m) return aw(lang, "lb_roundOf", { n: m[1], half: Number(m[1]) / 2 });
  m = /^Round (\d+)$/.exec(part);
  if (m) return aw(lang, "lb_round", { n: m[1] });
  return part;
}

/**
 * A label in `lang`: the platform's own fixed words translated, piece by piece
 * ("Cup · places 1–8 · Semi-final" → "Copa · puestos 1–8 · Semifinal"), and
 * anything else (an organiser's round or event name) exactly as written.
 */
export function labelIn(lang: AlertLang, label: string): string {
  if (lang === "en" || !label) return label;
  return label
    .split(" · ")
    .map((p) => labelPart(lang, p))
    .join(" · ");
}

/** Builds the same alert in each language: English first (the row's own words), then `tr`. */
export function inEveryLanguage(build: (lang: AlertLang) => AlertWords): { en: AlertWords; tr: AlertTranslations } {
  return { en: build("en"), tr: { es: build("es"), fr: build("fr") } };
}

/* ---------------- play status (Admin → In the app) ---------------- */

/**
 * The play-status push in every language. The organiser's own message stays as
 * typed; the title and the fixed sentences are translated.
 */
export function playStatusWords(o: { kind: "delayed" | "suspended" | "resumed"; eventName: string; message: string | null; resumeClock: string | null }): { en: AlertWords; tr: AlertTranslations } {
  return inEveryLanguage((lang) => {
    const head = aw(lang, o.kind === "delayed" ? "playDelayed" : o.kind === "suspended" ? "playSuspended" : "playResumed");
    const resume = o.kind !== "resumed" && o.resumeClock ? aw(lang, "resumeAbout", { time: o.resumeClock }) : null;
    const body = [o.message, resume].filter(Boolean).join(". ");
    return {
      title: `${head} · ${o.eventName}`.slice(0, 120),
      body: (body || aw(lang, o.kind === "resumed" ? "underWayAgain" : "followEventPage")).slice(0, 600),
    };
  });
}
