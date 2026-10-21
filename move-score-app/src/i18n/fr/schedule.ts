import type { Shape } from "../translate";
import type { schedule as en } from "../en/schedule";

export const schedule: Shape<typeof en> = {
  // Order of play
  today: "AUJOURD'HUI",
  todayA11y: "Aujourd'hui, {day}",
  toBeScheduled: "À programmer",
  byCourt: "Par court",
  byTime: "Par horaire",
  liveNow: "En direct",
  notBefore: "Pas avant {time}",
  notBeforeCaps: "PAS AVANT",
  followedBy: "Suivi de",
  followedByCaps: "SUIVI DE",
  timeTbcCaps: "HORAIRE À CONFIRMER",
  courtTbc: "Court à confirmer",
  courtToBeConfirmed: "Court à confirmer",
  timeToBeConfirmed: "Horaire à confirmer",
  nothingThisDay: "Rien de prévu ce jour-là",
  place: "Place {n}",
  places: "Places {from}–{to}",
  groupStage: "Phase de groupes",
  emptyTiesTitle: "L'ordre de jeu n'est pas encore publié",
  emptyTiesBody: "Les rencontres apparaîtront ici dès le tirage des groupes.",
  emptyMatchesTitle: "Pas encore de matchs",
  emptyMatchesBody: "L'ordre de jeu apparaîtra ici une fois le tirage effectué.",

  // League night tables
  calledToCourt: "Appelés sur le court",
  calledLabel: "Appelés · {label}",
  estimates: "Horaires estimés : chaque match commence dès que son court est libre.",
  about: "vers {time}",
  timeToCome: "Horaire à venir",
  onCourt: "Sur le court",
  finished: "Terminé",
  cancelled: "Annulé",
  courtToCome: "Court à venir",

  // Notices
  eyebrowDelayed: "RETARD",
  eyebrowSuspended: "SUSPENDU",
  eyebrowResumed: "REPRISE",
  eyebrowAnnouncement: "ANNONCE",
  playDelayed: "Jeu retardé",
  playSuspended: "Jeu suspendu",
  playResumed: "Reprise du jeu",
  resumeAbout: "Reprise du jeu prévue vers {time}",
};
