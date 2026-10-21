import type { Shape } from "../translate";
import type { lock as en } from "../en/lock";

export const lock: Shape<typeof en> = {
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
};
