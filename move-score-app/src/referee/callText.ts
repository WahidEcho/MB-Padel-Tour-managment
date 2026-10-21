/**
 * The words of a call for assistance in the app (English, Spanish, French: the shared
 * table src/lib/referees/callWords.ts, via @core), in the phone's language, and the
 * master's answer from a push button. Once the app's own language setting (src/i18n) is
 * on this branch, `callLangNow` should read it instead of the phone's locale.
 */
import { callLang, callWord, type CallLang, type CallWordKey } from "@core";

export function callLangNow(): CallLang {
  try {
    return callLang(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return "en";
  }
}

/** The call words in the phone's language. */
export const ct = (key: CallWordKey, vars?: Record<string, string | number>) => callWord(callLangNow(), key, vars);

/** "14:05" in the phone's own clock. */
export const callTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
