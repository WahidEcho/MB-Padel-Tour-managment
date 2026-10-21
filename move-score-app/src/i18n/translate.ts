/**
 * The app's words, without React or React Native: dictionaries keyed
 * "namespace.key", `{name}` interpolation and simple plurals. Pure, so it is
 * unit-tested (translate.test.ts) and usable from plain modules.
 *
 * A value is a string, or plural forms `{ one, other, zero? }` chosen by the
 * `count` parameter ("zero" only when given and count is 0). French counts 0 and
 * 1 as singular ("0 point", "1 jeu"); English and Spanish only 1.
 */

export const LANGS = ["en", "es", "fr"] as const;
export type Lang = (typeof LANGS)[number];

export interface PluralForms {
  one: string;
  other: string;
  zero?: string;
}

export type Entry = string | PluralForms;
export type Namespace = Record<string, Entry>;
export type Dict = Record<string, Namespace>;

/**
 * The same keys with any wording: what es.ts and fr.ts must match. A missing or
 * extra key is a TypeScript error.
 */
export type Shape<T> = {
  [K in keyof T]: T[K] extends string ? string : T[K] extends { one: string; other: string } ? PluralForms : Shape<T[K]>;
};

/** "account.title" for every key of every namespace. */
export type KeyOf<D> = { [N in keyof D & string]: `${N}.${keyof D[N] & string}` }[keyof D & string];

export type Params = Record<string, string | number | null | undefined>;

export function isLang(x: unknown): x is Lang {
  return typeof x === "string" && (LANGS as readonly string[]).includes(x);
}

/** "es-MX", "fr_CA", "EN" → the app's language for it, or null when the app has none. */
export function langOfTag(tag: string | null | undefined): Lang | null {
  const code = String(tag ?? "")
    .trim()
    .toLowerCase()
    .split(/[-_]/)[0];
  return isLang(code) ? code : null;
}

/** The first of the phone's preferred languages the app speaks, else English. */
export function pickLang(preferred: (string | null | undefined)[]): Lang {
  for (const p of preferred) {
    const l = langOfTag(p);
    if (l) return l;
  }
  return "en";
}

export function pluralForm(lang: Lang, n: number): "one" | "other" {
  const abs = Math.abs(n);
  if (lang === "fr") return abs < 2 ? "one" : "other";
  return abs === 1 ? "one" : "other";
}

/** Replaces each `{name}` with its parameter; unknown names stay as written so a slip shows. */
export function interpolate(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = params[name];
    return v === undefined || v === null ? whole : String(v);
  });
}

function lookup(dict: Dict, key: string): Entry | undefined {
  const dot = key.indexOf(".");
  if (dot < 0) return undefined;
  return dict[key.slice(0, dot)]?.[key.slice(dot + 1)];
}

/**
 * The words for `key` in `lang`'s dictionary, falling back to English, then to
 * the key itself (never an empty screen).
 */
export function translate(dicts: Record<Lang, Dict>, lang: Lang, key: string, params?: Params): string {
  const entry = lookup(dicts[lang], key) ?? lookup(dicts.en, key);
  if (entry === undefined) return key;
  if (typeof entry === "string") return interpolate(entry, params);
  const count = Number(params?.count ?? 0);
  const form = count === 0 && entry.zero !== undefined ? entry.zero : entry[pluralForm(lang, count)];
  return interpolate(form, params);
}

/** Every key path of a dictionary ("ns.key"), for the completeness tests. */
export function keysOf(dict: Dict): string[] {
  return Object.entries(dict).flatMap(([ns, entries]) => Object.keys(entries).map((k) => `${ns}.${k}`));
}
