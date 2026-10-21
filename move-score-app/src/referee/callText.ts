/**
 * The words of a call for assistance in the app (English, Spanish, French: the shared
 * table src/lib/referees/callWords.ts, via @core), in the phone's language, and the
 * master's answer from a push button. Follows the app's own language setting (src/i18n).
 */
import { callLang, callWord, type CallLang, type CallWordKey } from "@core";
import { getLang } from "../i18n/t";

export function callLangNow(): CallLang {
  return callLang(getLang());
}

/** The call words in the phone's language. */
export const ct = (key: CallWordKey, vars?: Record<string, string | number>) => callWord(callLangNow(), key, vars);

/** "14:05" in the phone's own clock. */
export const callTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
