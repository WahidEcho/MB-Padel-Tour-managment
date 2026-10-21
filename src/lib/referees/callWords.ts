/**
 * The words of a call for assistance (migrations 0035 and 0042) in English, Spanish and
 * French: the pushes to master referees and the organiser (written in each phone's
 * language, `push_devices.locale`), the court referee's card and the master's desk (app
 * and web). Pure, shared with the app through `@core`. English is the source of truth;
 * es/fr are typed against it, so a missing key fails the type check.
 */
export type CallLang = "en" | "es" | "fr";

const en = {
  pushTitle: "Call for assistance",
  pushBody: "Referee {name} is calling for assistance at {court}",
  reminderTitle: "Call for assistance: no answer yet",
  reminderBody: "{court} still needs a master referee — tap to answer",
  goingTitle: "Call for assistance taken",
  goingBody: "Master referee {name} is going to the emergency call at {court}",
  escalationTitle: "No master referee has answered",
  escalationBody: "Referee {name} has been calling for assistance at {court} for {minutes} minutes and no master referee has taken it.",
  coming: "Coming",
  decline: "Decline",
  resolve: "Resolved",
  callButton: "Call for assistance",
  calling: "Calling…",
  callAgain: "Call again",
  cancel: "Cancel",
  callingNoAnswer: "Calling the master referees… no answer yet · {clock}",
  remindersSent: "Reminder sent",
  remindersSentMany: "Reminder sent ({n})",
  organiserAlerted: "Organiser alerted",
  isComing: "{name} is coming to {court}",
  answerComing: "Coming · on the way since {time}",
  answerDeclined: "Declined · {time}",
  answerNone: "No answer yet",
  declinedList: "Declined: {names}",
  noMastersOnDuty: "No master referee is signed in right now: call the desk.",
  resolvedBy: "Resolved by {name}",
  resolved: "Resolved",
  cancelled: "Call cancelled",
  mastersHeader: "Master referees",
  calledAt: "Called {time}",
  calledBy: "Referee {name} is calling for assistance at {court}",
  youComing: "You: Coming",
  youDeclined: "You declined. Tap Coming if you can go after all.",
  goingDesk: "{name} is going · {court}",
  alreadyTaken: "{name} already took this call.",
  noConnection: "No connection: call the desk.",
  alarmTitle: "Emergency call",
  alarmFor: "Ringing for {clock}",
  alarmDesk: "Open the master desk",
};
export type CallWordKey = keyof typeof en;

const es: Record<CallWordKey, string> = {
  pushTitle: "Llamada de asistencia",
  pushBody: "El árbitro {name} pide asistencia en {court}",
  reminderTitle: "Llamada de asistencia: aún sin respuesta",
  reminderBody: "{court} todavía necesita un juez árbitro: toca para responder",
  goingTitle: "Llamada de asistencia atendida",
  goingBody: "El juez árbitro {name} va a la llamada de emergencia en {court}",
  escalationTitle: "Ningún juez árbitro ha respondido",
  escalationBody: "El árbitro {name} lleva {minutes} minutos pidiendo asistencia en {court} y ningún juez árbitro la ha atendido.",
  coming: "Voy",
  decline: "Rechazar",
  resolve: "Resuelto",
  callButton: "Pedir asistencia",
  calling: "Llamando…",
  callAgain: "Llamar de nuevo",
  cancel: "Cancelar",
  callingNoAnswer: "Llamando a los jueces árbitros… aún sin respuesta · {clock}",
  remindersSent: "Recordatorio enviado",
  remindersSentMany: "Recordatorio enviado ({n})",
  organiserAlerted: "Organizador avisado",
  isComing: "{name} va a {court}",
  answerComing: "Va · en camino desde las {time}",
  answerDeclined: "Rechazó · {time}",
  answerNone: "Aún sin respuesta",
  declinedList: "Rechazaron: {names}",
  noMastersOnDuty: "Ningún juez árbitro ha iniciado sesión: llama a la mesa.",
  resolvedBy: "Resuelto por {name}",
  resolved: "Resuelto",
  cancelled: "Llamada cancelada",
  mastersHeader: "Jueces árbitros",
  calledAt: "Llamada a las {time}",
  calledBy: "El árbitro {name} pide asistencia en {court}",
  youComing: "Tú: Voy",
  youDeclined: "Rechazaste. Toca Voy si al final puedes ir.",
  goingDesk: "{name} va · {court}",
  alreadyTaken: "{name} ya atendió esta llamada.",
  noConnection: "Sin conexión: llama a la mesa.",
  alarmTitle: "Llamada de emergencia",
  alarmFor: "Sonando desde hace {clock}",
  alarmDesk: "Abrir el panel del juez árbitro",
};

const fr: Record<CallWordKey, string> = {
  pushTitle: "Appel à l'aide",
  pushBody: "L'arbitre {name} demande de l'aide sur {court}",
  reminderTitle: "Appel à l'aide : toujours sans réponse",
  reminderBody: "{court} attend toujours un juge-arbitre — touchez pour répondre",
  goingTitle: "Appel à l'aide pris en charge",
  goingBody: "Le juge-arbitre {name} se rend à l'appel d'urgence sur {court}",
  escalationTitle: "Aucun juge-arbitre n'a répondu",
  escalationBody: "L'arbitre {name} demande de l'aide sur {court} depuis {minutes} minutes et aucun juge-arbitre ne l'a pris en charge.",
  coming: "J'arrive",
  decline: "Refuser",
  resolve: "Résolu",
  callButton: "Appeler à l'aide",
  calling: "Appel en cours…",
  callAgain: "Rappeler",
  cancel: "Annuler",
  callingNoAnswer: "Appel des juges-arbitres… pas encore de réponse · {clock}",
  remindersSent: "Rappel envoyé",
  remindersSentMany: "Rappel envoyé ({n})",
  organiserAlerted: "Organisateur prévenu",
  isComing: "{name} arrive sur {court}",
  answerComing: "Arrive · en route depuis {time}",
  answerDeclined: "A refusé · {time}",
  answerNone: "Pas encore de réponse",
  declinedList: "Ont refusé : {names}",
  noMastersOnDuty: "Aucun juge-arbitre n'est connecté : appelez la table.",
  resolvedBy: "Résolu par {name}",
  resolved: "Résolu",
  cancelled: "Appel annulé",
  mastersHeader: "Juges-arbitres",
  calledAt: "Appel à {time}",
  calledBy: "L'arbitre {name} demande de l'aide sur {court}",
  youComing: "Vous : J'arrive",
  youDeclined: "Vous avez refusé. Touchez J'arrive si vous pouvez finalement y aller.",
  goingDesk: "{name} y va · {court}",
  alreadyTaken: "{name} a déjà pris cet appel.",
  noConnection: "Pas de connexion : appelez la table.",
  alarmTitle: "Appel d'urgence",
  alarmFor: "Sonne depuis {clock}",
  alarmDesk: "Ouvrir le bureau du juge-arbitre",
};

const WORDS: Record<CallLang, Record<CallWordKey, string>> = { en, es, fr };

/** "es-ES", "fr", "fr_CA", "en-GB", null → the call's language (English unless Spanish or French). */
export function callLang(locale: string | null | undefined): CallLang {
  const p = (locale ?? "").trim().toLowerCase().slice(0, 2);
  return p === "es" || p === "fr" ? p : "en";
}

/** The words for `key` in `lang`, with {name}, {court}, {time}, {clock}, {n}, {minutes} filled in. */
export function callWord(lang: CallLang, key: CallWordKey, vars: Record<string, string | number> = {}): string {
  const s = WORDS[lang]?.[key] ?? en[key];
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]).trim() : m));
}

/** Every key of every language (tests: no language is missing a placeholder). */
export const CALL_WORDS = WORDS;
