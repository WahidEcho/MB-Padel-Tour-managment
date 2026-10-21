/**
 * The app's current language and `tr()`, without React Native: plain modules
 * (api/model.ts, error messages, Live Activity texts) import this. The language
 * itself is decided in ./index.ts (the phone's language, or the Account switch)
 * and set here; it is "en" until then, and in unit tests.
 */
import { en, type Key } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { formatters, type Formatters } from "./format";
import { translate, type Dict, type Lang, type Params } from "./translate";

export type { Key } from "./en";
export type { Lang, Params } from "./translate";

const DICTS = { en, es, fr } as unknown as Record<Lang, Dict>;

let current: Lang = "en";
let currentFmt: Formatters = formatters("en");
const subs = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang) {
  if (lang === current) return;
  current = lang;
  currentFmt = formatters(lang);
  subs.forEach((f) => f());
}

export function onLangChange(f: () => void): () => void {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}

/** The words for `key` in the current language: `tr("account.title")`, `tr("common.players", { count: 3 })`. */
export function tr(key: Key, params?: Params): string {
  return translate(DICTS, current, key, params);
}

/** The words for `key` in a given language (tests, previews). */
export function trIn(lang: Lang, key: Key, params?: Params): string {
  return translate(DICTS, lang, key, params);
}

/** Dates, times and numbers in the current language. */
export function fmt(): Formatters {
  return currentFmt;
}
