import type { Shape } from "../translate";
import type { lock as en } from "../en/lock";

export const lock: Shape<typeof en> = {
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
};
