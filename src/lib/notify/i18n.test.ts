import { describe, expect, it } from "vitest";
import { ALERT_DICTS, alertLang, aw, labelIn, playStatusWords, statusWord, wordsFor } from "./i18n";
import { composeCalledToCourt, composeCallReminder, composeLineups, composeMatchFinished, composeMatchLive, composeMatchScheduled, composeMatchSoon, composeNightMatch, composeTieDecided, composeTieSchedule, composeTieStarting, composeAnnouncement } from "./compose";
import { coachCalled, coachFinished, coachLineup, coachRubberSoon, coachStarted, coachTieResult, coachTieSoon } from "../coaches/alerts";
import { lockLabelsFor, startAlertIn, stateIn } from "./lockWords";
import { startAlert, upcomingState } from "./liveActivity";

const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("alert dictionaries", () => {
  const keys = Object.keys(ALERT_DICTS.en).sort();
  for (const lang of ["es", "fr"] as const) {
    it(`${lang}: every key, none empty, the same {placeholders}`, () => {
      const d = ALERT_DICTS[lang];
      expect(Object.keys(d).sort()).toEqual(keys);
      for (const k of keys as (keyof typeof d)[]) {
        expect(d[k].trim(), k).not.toBe("");
        // French names a "round of 16" by its half ("8es de finale"): {half} instead of {n}.
        const want = lang === "fr" && k === "lb_roundOf" ? ["half"] : holes(ALERT_DICTS.en[k]);
        expect(holes(d[k]), k).toEqual(want);
      }
    });
  }
});

describe("the phone's language", () => {
  it("reads the stored locale", () => {
    expect(alertLang("es")).toBe("es");
    expect(alertLang("fr-CA")).toBe("fr");
    expect(alertLang("en-GB")).toBe("en");
    expect(alertLang("ar")).toBe("en");
    expect(alertLang(null)).toBe("en");
  });
  it("picks the phone's words, the players' own when it is theirs, English otherwise", () => {
    const p = composeMatchSoon({ matchId: "m", a: "EGY", b: "USA", court: "Court 2", label: "Group A", playerIds: ["p1"], starredFans: false });
    expect(wordsFor(p, "es", false).title).toBe("Siguiente en Court 2: EGY vs. USA");
    expect(wordsFor(p, "fr", true).title).toBe("Vous jouez ensuite sur Court 2");
    expect(wordsFor(p, "es", true).title).toBe("Juegas a continuación en Court 2");
    expect(wordsFor(p, "de", true).title).toBe("You're next on Court 2");
    expect(wordsFor(p, null, false)).toEqual({ title: p.title, body: p.body });
  });
  it("sends an old outbox row (no translations) as written", () => {
    const old = { title: "Live now: A v B", body: "Final", self: { title: "x", body: "y" } };
    expect(wordsFor(old, "fr", false)).toEqual({ title: "Live now: A v B", body: "Final" });
    expect(wordsFor(old, "es", true)).toEqual({ title: "x", body: "y" });
  });
  it("leaves announcements as the organiser wrote them", () => {
    const a = composeAnnouncement({ id: "1", title: "Rain delay", body: "Back at 3", tournamentId: "t", eventGroupId: null });
    expect(a.tr).toBeUndefined();
    expect(wordsFor(a, "es", false)).toEqual({ title: "Rain delay", body: "Back at 3" });
  });
});

describe("labels", () => {
  it("translates the platform's own words and keeps the organiser's", () => {
    expect(labelIn("es", "No. 1 singles")).toBe("Individual n.º 1");
    expect(labelIn("fr", "Doubles")).toBe("Double");
    expect(labelIn("es", "Cup · places 1–8 · Semi-final")).toBe("Copa · puestos 1–8 · Semifinal");
    expect(labelIn("fr", "Plate · places 9–16 · Play-off 11–12")).toBe("Consolante · places 9–16 · Match de classement 11–12");
    expect(labelIn("fr", "Group B")).toBe("Poule B");
    expect(labelIn("fr", "Round of 16")).toBe("8es de finale");
    expect(labelIn("es", "Final · Junior Finals 2026")).toBe("Final · Junior Finals 2026");
    expect(labelIn("fr", "Sunday Night League")).toBe("Sunday Night League");
    expect(labelIn("en", "Group B")).toBe("Group B");
  });
  it("writes statuses in place of a score", () => {
    expect(statusWord("fr", "walkover")).toBe("forfait");
    expect(statusWord("es", "retired")).toBe("retirada");
    expect(statusWord("es", "something_new")).toBe("something_new");
  });
});

describe("alerts in Spanish and French", () => {
  const egy = { name: "Egypt", code: "EGY" };
  const jpn = { name: "Japan", code: "JPN" };

  it("keeps English as the row's own words", () => {
    const p = composeTieSchedule({ kind: "tie_rescheduled", tieId: "t1", tournamentId: "t", a: egy, b: jpn, court: "Court 2", at: "2026-11-04T13:30:00.000Z", timeZone: "Africa/Cairo", eventName: "Junior Finals" });
    expect(p.title).toBe("Moved: EGY v JPN");
    expect(p.body).toBe("Court 2 · Wed 4 Nov, 15:30 (Cairo time) · Junior Finals");
    expect(p.tr?.es?.title).toBe("Cambio: EGY vs. JPN");
    expect(p.tr?.es?.body).toMatch(/^Court 2 · mié/);
    expect(p.tr?.es?.body).toContain("15:30 (hora de Cairo) · Junior Finals");
    expect(p.tr?.fr?.title).toBe("Déplacé : EGY vs JPN");
    expect(p.tr?.fr?.body).toMatch(/^Court 2 · mer\.? 4 nov\.?, 15:30 \(heure de Cairo\) · Junior Finals$/);
  });

  it("times to be announced", () => {
    const p = composeTieSchedule({ kind: "tie_scheduled", tieId: "t1", tournamentId: "t", a: egy, b: jpn, court: null, at: null, timeZone: "Africa/Cairo", eventName: "Junior Finals" });
    expect(p.tr?.es?.body).toBe("Pista por anunciar · hora por anunciar · Junior Finals");
    expect(p.tr?.fr?.body).toBe("Court à annoncer · horaire à annoncer · Junior Finals");
  });

  it("starting soon, line-ups, live, result, tie decided", () => {
    expect(composeTieStarting({ tieId: "t", a: egy, b: jpn, court: "Court 1", at: "2026-11-04T13:30:00Z", timeZone: "Africa/Cairo" }).tr?.fr).toEqual({ title: "Bientôt : EGY vs JPN", body: "Court 1 à 15:30" });
    const l = composeLineups({ tieId: "t", a: egy, b: jpn, rubbers: [{ label: "No. 2 singles", a: "Ali", b: "TBD" }, { label: "Doubles", a: "Ali / Omar", b: "Sato / Ito" }] });
    expect(l.tr?.es).toEqual({ title: "Alineaciones: EGY vs. JPN", body: "Individual n.º 2: Ali vs. Por definir · Dobles: Ali / Omar vs. Sato / Ito" });
    expect(composeMatchLive({ matchId: "m", tieId: null, label: "Semi-final", a: "Ali", b: "Sato", court: "Court 1", playerIds: [], nations: [] }).tr?.es).toEqual({ title: "En directo: Ali vs. Sato", body: "Semifinal · Court 1" });
    const done = composeMatchFinished({ matchId: "m", tieId: null, label: "Final", winner: "Ali (EGY)", loser: "Sato (JPN)", score: "6–4 6–4", playerIds: [] });
    expect(done.title).toBe("Ali (EGY) won");
    expect(done.tr?.fr).toEqual({ title: "Victoire de Ali (EGY)", body: "6–4 6–4 contre Sato (JPN) · Finale" });
    expect(composeMatchFinished({ matchId: "m", tieId: null, label: "Final", winner: "A", loser: "B", score: "walkover", playerIds: [] }).tr?.es?.body).toBe("W.O. ante B · Final");
    expect(composeTieDecided({ tieId: "t", winner: egy, loser: jpn, rubbers: "2–1", stageLabel: "Group stage · Junior Finals" }).tr?.es).toEqual({ title: "Egypt vence a Japan 2–1", body: "Fase de grupos · Junior Finals" });
  });

  it("a single match's court and time", () => {
    const p = composeMatchScheduled({ matchId: "m", a: egy, b: jpn, court: "Court 3", at: null, timeZone: "Africa/Cairo", eventName: "Open", playerIds: ["p1"] });
    expect(p.title).toBe("Court and time: Egypt v Japan");
    expect(p.url).toBe("movescore://match/m");
    expect(p.targets).toEqual([{ kind: "match", key: "m" }, { kind: "player", key: "p1" }]);
    expect(p.tr?.fr?.title).toBe("Court et horaire : Egypt vs Japan");
  });

  it("match day: called to court and the reminder, for fans and for the players", () => {
    const base = { matchId: "m2", a: "Team A", b: "Team B", court: "Court 2", label: "Group A" };
    const called = composeCalledToCourt({ ...base, playerIds: ["p1"], deadline: "2026-11-04T12:35:00Z", timeZone: "Africa/Cairo", minutes: 5 });
    expect(called.tr?.es?.title).toBe("Llamada a Court 2: Team A vs. Team B");
    expect(called.tr?.es?.self).toEqual({ title: "Te llaman a Court 2", body: "Team A vs. Team B: preséntate en pista antes de las 14:35 (5 min)." });
    expect(called.tr?.fr?.body).toBe("Joueurs attendus sur le court avant 14:35 · Poule A");
    const r = composeCallReminder({ ...base, playerIds: ["p2"], deadline: "2026-11-04T12:35:00Z", timeZone: "Africa/Cairo", minutesLeft: 2 });
    expect(r.title).toBe("2 min to reach Court 2");
    expect(r.tr?.fr?.self?.title).toBe("Plus que 2 min pour rejoindre Court 2");
    expect(r.self?.playerIds).toEqual(["p2"]);
  });

  it("a league night's table, with the estimate translated", () => {
    const p = composeNightMatch({ matchId: "m", a: { name: "Ali", code: null }, b: { name: "Omar", code: null }, court: "Court 1", position: 2, about: "about 19:40", eventName: "Tuesday Night", playerIds: ["p1"] });
    expect(p.title).toBe("Your table: Court 1, about 19:40");
    expect(p.tr?.es?.title).toBe("Tu partido: Court 1, hacia las 19:40");
    expect(p.tr?.fr?.self?.body).toBe("Ali vs Omar · match 2 sur Court 1 · Tuesday Night");
  });

  it("coaches' alerts", () => {
    const us = { teamId: "t1", code: "EGY" };
    expect(coachTieSoon({ us, them: "JPN", tieId: "t", court: null, at: "2026-11-04T13:30:00Z", timeZone: "Africa/Cairo", stage: "Group A" }).tr?.es).toEqual({ title: "EGY vs. JPN empieza en 5 minutos", body: "Pista por anunciar a las 15:30 · Grupo A" });
    expect(coachRubberSoon({ us, them: null, matchId: "m", court: "Court 1", label: "No. 1 singles", players: [] }).tr?.fr).toEqual({ title: "Prochain match sur Court 1 : Simple n° 1 · EGY vs À déterminer", body: "Le match en cours n'est plus qu'à un jeu de la fin." });
    expect(coachCalled({ us, them: "JPN", matchId: "m", court: "Court 1", label: "Doubles", players: [], deadline: "2026-11-04T13:30:00Z", timeZone: "Africa/Cairo" }).tr?.es?.body).toBe("Jugadores a pista antes de las 15:30.");
    expect(coachStarted({ us, them: "JPN", matchId: "m", court: null, label: "Doubles", players: ["Ali"] }).tr?.fr?.body).toBe("Ali · sur le court");
    expect(coachFinished({ us, them: "JPN", matchId: "m", label: "Doubles", won: false, score: "", status: "retired" }).tr?.fr).toEqual({ title: "Perdu : Double · EGY vs JPN", body: "abandon" });
    expect(coachTieResult({ us, them: "JPN", tieId: "t", won: true, rubbers: "2–1", stage: "Cup · places 1–8 · Final" }).tr?.es).toEqual({ title: "EGY vence a JPN 2–1", body: "Copa · puestos 1–8 · Final" });
    const lineup = coachLineup({ us, them: "JPN", tieId: "t", rubbers: [{ label: "No. 1 singles", players: ["Ali"] }], late: true });
    expect(lineup.title).toBe("Line-up changed: EGY v JPN");
    expect(lineup.tr?.fr).toEqual({ title: "Composition modifiée : EGY vs JPN", body: "Simple n° 1 : Ali" });
  });

  it("the play-status push keeps the organiser's message", () => {
    const w = playStatusWords({ kind: "delayed", eventName: "Junior Finals", message: "Rain", resumeClock: "15:30" });
    expect(w.en).toEqual({ title: "Play delayed · Junior Finals", body: "Rain. Play expected to resume about 15:30" });
    expect(w.tr.es).toEqual({ title: "Juego retrasado · Junior Finals", body: "Rain. Está previsto reanudar el juego hacia las 15:30" });
    expect(playStatusWords({ kind: "resumed", eventName: "X", message: null, resumeClock: null }).tr.fr?.body).toBe("Le jeu a repris.");
  });

  it("officials' alerts", () => {
    expect(aw("es", "assistanceBody", { name: "Ana", court: "Court 4" })).toBe("El juez Ana pide asistencia en Court 4");
    expect(aw("fr", "coachLineupSubmittedBody", { by: "Coach of Egypt", vs: "EGY vs JPN", court: " (Court 1)" })).toBe("Coach of Egypt a envoyé la composition de EGY vs JPN (Court 1). Confirmez-la dans l'écran des compositions.");
  });
});

describe("lock-screen cards", () => {
  // "Say the same words as the app" lives in move-score-app/src/i18n/i18n.test.ts: Vercel's build
  // has no move-score-app folder, so nothing under src/ may import from it.
  it("English cards carry no labels (the card's own words)", () => {
    const s = upcomingState({ matchId: "m", phase: "called", a: "EGY", b: "JPN", court: "Court 1", until: null });
    expect(stateIn(s, "en")).toBe(s);
    expect((stateIn(s, "fr") as { labels: { status: Record<string, string> } }).labels.status["Called to court"]).toBe("Appelé sur le court");
    expect(lockLabelsFor("en")).toBeNull();
    expect(startAlertIn("en", s)).toBeNull();
    expect(startAlert(s).title).toBe("Called to court");
    expect(startAlertIn("es", s)).toEqual({ title: "Te llaman a pista", body: "EGY vs. JPN en Court 1. Ve ya a la pista." });
  });
});
