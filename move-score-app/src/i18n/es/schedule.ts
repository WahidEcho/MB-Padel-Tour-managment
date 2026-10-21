import type { Shape } from "../translate";
import type { schedule as en } from "../en/schedule";

export const schedule: Shape<typeof en> = {
  // Order of play
  today: "HOY",
  todayA11y: "Hoy, {day}",
  toBeScheduled: "Por programar",
  byCourt: "Por pista",
  byTime: "Por hora",
  liveNow: "En directo",
  notBefore: "No antes de las {time}",
  notBeforeCaps: "NO ANTES DE",
  followedBy: "A continuación",
  followedByCaps: "A CONTINUACIÓN",
  timeTbcCaps: "HORA POR CONFIRMAR",
  courtTbc: "Pista por confirmar",
  courtToBeConfirmed: "Pista por confirmar",
  timeToBeConfirmed: "Hora por confirmar",
  nothingThisDay: "No hay nada este día",
  place: "Puesto {n}",
  places: "Puestos {from}–{to}",
  groupStage: "Fase de grupos",
  emptyTiesTitle: "El orden de juego aún no está publicado",
  emptyTiesBody: "Las eliminatorias aparecerán aquí en cuanto se sorteen los grupos.",
  emptyMatchesTitle: "Aún no hay partidos",
  emptyMatchesBody: "El orden de juego aparecerá aquí cuando se haga el sorteo.",

  // League night tables
  calledToCourt: "Llamados a pista",
  calledLabel: "Llamados · {label}",
  estimates: "Horas estimadas: cada partido empieza cuando su pista queda libre.",
  about: "hacia las {time}",
  timeToCome: "Hora por llegar",
  onCourt: "En pista",
  finished: "Terminado",
  cancelled: "Cancelado",
  courtToCome: "Pista por asignar",

  // Notices
  eyebrowDelayed: "RETRASO",
  eyebrowSuspended: "SUSPENDIDO",
  eyebrowResumed: "REANUDADO",
  eyebrowAnnouncement: "AVISO",
  playDelayed: "Juego retrasado",
  playSuspended: "Juego suspendido",
  playResumed: "Se reanuda el juego",
  resumeAbout: "Está previsto reanudar el juego hacia las {time}",
};
