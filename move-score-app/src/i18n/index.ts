/**
 * The app's language. "Automatic" follows the phone (the first of its preferred
 * languages the app speaks, else English); Account → Language overrides it, saved
 * on the phone. A change applies at once: every screen that calls `useT()`
 * re-renders, and the phone tells the server (push/register.ts) so alerts arrive
 * in the same language.
 *
 *   const tr = useT();            // inside a component
 *   tr("account.title")           // "Account" / "Cuenta" / "Compte"
 *   tr("common.players", { count })
 *   fmt().day(iso, tz)            // "Tue 20 Oct" / "mar, 20 oct" / "mar. 20 oct."
 *
 * (`useTheme()` already hands out `t` for the palette, hence `tr`.)
 */
import { useSyncExternalStore } from "react";
import { getLocales } from "expo-localization";
import { createStore } from "../state/store";
import { getJson, setJson } from "../state/kv";
import { getLang, onLangChange, setLang, tr, trIn } from "./t";
import { isLang, pickLang, type Lang } from "./translate";

export { tr, trIn, fmt, getLang, onLangChange } from "./t";
export type { Key, Lang, Params } from "./t";
export { LANGS } from "./translate";

export type LangPref = "auto" | Lang;

const KEY = "ms.lang";

function storedPref(): LangPref {
  const v = getJson<unknown>(KEY, "auto");
  return isLang(v) ? v : "auto";
}

/** The phone's own language, among the app's. */
export function phoneLang(): Lang {
  try {
    return pickLang(getLocales().map((l) => l.languageTag || l.languageCode));
  } catch {
    return "en";
  }
}

export const langPref = createStore<LangPref>(storedPref());

function apply() {
  const p = langPref.get();
  setLang(p === "auto" ? phoneLang() : p);
}
apply();

langPref.subscribe(() => {
  setJson(KEY, langPref.get());
  apply();
});

/** Account → Language. */
export function chooseLang(p: LangPref) {
  langPref.set(p);
}

/** The language on screen now; re-renders when it changes. */
export function useLang(): Lang {
  return useSyncExternalStore(onLangChange, getLang, getLang);
}

type Tr = typeof tr;
// One function per language, so `useMemo(…, [tr])` recomputes after a change.
const BOUND: Record<Lang, Tr> = {
  en: (key, params) => trIn("en", key, params),
  es: (key, params) => trIn("es", key, params),
  fr: (key, params) => trIn("fr", key, params),
};

/** `tr` for a component: subscribing to the language, so the screen re-renders on a change. */
export function useT(): Tr {
  return BOUND[useLang()];
}
