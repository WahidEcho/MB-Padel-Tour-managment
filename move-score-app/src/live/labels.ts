/**
 * The words the lock-screen card and the My matches widget show, in the app's
 * language. Both run in the widget extension's own JavaScript context (no
 * imports there), so the app hands the words over in their props (`labels`).
 * A card the server starts or updates by push carries the server's content state
 * instead; without `labels` the card falls back to its built-in English.
 */
import { tr } from "../i18n/t";

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

export function lockLabels(): LockLabels {
  return {
    now: tr("lock.now"),
    soon: tr("lock.soon"),
    beOn: tr("lock.beOn"),
    headToCourt: tr("lock.headToCourt"),
    nextOn: tr("lock.nextOn"),
    upNext: tr("lock.upNext"),
    final: tr("lock.final"),
    courtCaps: tr("lock.courtCaps"),
    vs: tr("lock.vs"),
    liveCaps: tr("lock.liveCaps"),
    tbc: tr("lock.tbc"),
    noMatches: tr("lock.noMatches"),
    signIn: tr("lock.signIn"),
    myMatches: tr("lock.myMatches"),
    status: {
      Live: tr("lock.statusLive"),
      Paused: tr("lock.statusPaused"),
      Final: tr("lock.final"),
      Walkover: tr("lock.statusWalkover"),
      Retired: tr("lock.statusRetired"),
      "Called to court": tr("lock.statusCalled"),
      "Up next": tr("lock.upNext"),
    },
  };
}
