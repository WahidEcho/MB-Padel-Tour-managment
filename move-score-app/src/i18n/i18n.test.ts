import { describe, expect, it } from "vitest";
import { en } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { formatters } from "./format";
import { LOCK_WORDS } from "../../../src/lib/notify/lockWords";
import { lock as esLock } from "./es/lock";
import { lock as frLock } from "./fr/lock";
import { getLang, setLang, tr, trIn } from "./t";
import { interpolate, keysOf, langOfTag, pickLang, pluralForm, translate, type Dict, type Entry } from "./translate";

const DICTS = { en, es, fr } as unknown as Record<"en" | "es" | "fr", Dict>;

const forms = (e: Entry): string[] => (typeof e === "string" ? [e] : [e.one, e.other, ...(e.zero !== undefined ? [e.zero] : [])]);
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("dictionaries", () => {
  const enKeys = keysOf(DICTS.en).sort();

  it("has words in English", () => {
    expect(enKeys.length).toBeGreaterThan(40);
  });

  for (const lang of ["es", "fr"] as const) {
    describe(lang, () => {
      const dict = DICTS[lang];
      it("has every English key and no other", () => {
        expect(keysOf(dict).sort()).toEqual(enKeys);
      });
      it("has no empty value", () => {
        const empty = Object.entries(dict).flatMap(([ns, entries]) =>
          Object.entries(entries)
            .filter(([, e]) => forms(e).some((f) => !f.trim()))
            .map(([k]) => `${ns}.${k}`),
        );
        expect(empty).toEqual([]);
      });
      it("keeps the same {placeholders} as English", () => {
        const wrong: string[] = [];
        for (const [ns, entries] of Object.entries(DICTS.en)) {
          for (const [k, e] of Object.entries(entries)) {
            const theirs = dict[ns]?.[k];
            if (theirs === undefined) continue;
            const want = [...new Set(forms(e).flatMap(placeholders))].sort();
            const got = [...new Set(forms(theirs).flatMap(placeholders))].sort();
            // `count` may be left out of a singular form ("un jeu"), never added.
            const missing = want.filter((p) => !got.includes(p) && p !== "count");
            const extra = got.filter((p) => !want.includes(p));
            if (missing.length || extra.length) wrong.push(`${ns}.${k}: missing ${missing.join(",")} extra ${extra.join(",")}`);
          }
        }
        expect(wrong).toEqual([]);
      });
      it("uses plural forms exactly where English does", () => {
        const wrong: string[] = [];
        for (const [ns, entries] of Object.entries(DICTS.en)) {
          for (const [k, e] of Object.entries(entries)) {
            const theirs = dict[ns]?.[k];
            if (theirs !== undefined && typeof theirs !== typeof e) wrong.push(`${ns}.${k}`);
          }
        }
        expect(wrong).toEqual([]);
      });
    });
  }
});

describe("interpolation and plurals", () => {
  it("fills {name} and leaves unknown names visible", () => {
    expect(interpolate("Court {n} at {time}", { n: 2, time: "14:30" })).toBe("Court 2 at 14:30");
    expect(interpolate("Hello {who}", {})).toBe("Hello {who}");
    expect(interpolate("No params")).toBe("No params");
  });

  it("picks the plural form per language (French singular for 0 and 1)", () => {
    expect(pluralForm("en", 0)).toBe("other");
    expect(pluralForm("en", 1)).toBe("one");
    expect(pluralForm("es", 0)).toBe("other");
    expect(pluralForm("es", 2)).toBe("other");
    expect(pluralForm("fr", 0)).toBe("one");
    expect(pluralForm("fr", 1)).toBe("one");
    expect(pluralForm("fr", 2)).toBe("other");
  });

  it("translates plurals with the count", () => {
    expect(trIn("en", "common.players", { count: 1 })).toBe("1 player");
    expect(trIn("en", "common.players", { count: 3 })).toBe("3 players");
    expect(trIn("es", "common.matches", { count: 2 })).toBe("2 partidos");
    expect(trIn("fr", "common.matches", { count: 0 })).toBe("0 match");
    expect(trIn("fr", "common.players", { count: 4 })).toBe("4 joueurs");
  });

  it("uses a zero form when there is one", () => {
    const dicts = { en: { x: { n: { zero: "none", one: "one", other: "{count}" } } }, es: {}, fr: {} } as unknown as Record<"en" | "es" | "fr", Dict>;
    expect(translate(dicts, "en", "x.n", { count: 0 })).toBe("none");
    expect(translate(dicts, "es", "x.n", { count: 5 })).toBe("5");
  });

  it("falls back to English, then to the key", () => {
    const dicts = { en: { a: { b: "English" } }, es: { a: {} }, fr: {} } as unknown as Record<"en" | "es" | "fr", Dict>;
    expect(translate(dicts, "es", "a.b")).toBe("English");
    expect(translate(dicts, "fr", "a.missing")).toBe("a.missing");
  });

  it("follows the current language", () => {
    const before = getLang();
    setLang("fr");
    expect(tr("common.back")).toBe("Retour");
    setLang("es");
    expect(tr("common.back")).toBe("Atrás");
    setLang(before);
  });
});

describe("the phone's language", () => {
  it("reads language tags", () => {
    expect(langOfTag("es-MX")).toBe("es");
    expect(langOfTag("fr_CA")).toBe("fr");
    expect(langOfTag("EN")).toBe("en");
    expect(langOfTag("ar-EG")).toBeNull();
    expect(langOfTag(null)).toBeNull();
  });
  it("takes the first preferred language the app speaks, else English", () => {
    expect(pickLang(["ar-EG", "fr-FR", "en-GB"])).toBe("fr");
    expect(pickLang(["de-DE"])).toBe("en");
    expect(pickLang([])).toBe("en");
  });
});

describe("dates and times", () => {
  const at = "2026-10-20T12:30:00Z";
  it("writes the day in each language", () => {
    expect(formatters("en").day(at, "Africa/Cairo")).toBe("Tue 20 Oct");
    expect(formatters("es").day(at, "Africa/Cairo").toLowerCase()).toContain("20 oct");
    expect(formatters("es").day(at, "Africa/Cairo").toLowerCase()).toMatch(/^mar/);
    expect(formatters("fr").day(at, "Africa/Cairo").toLowerCase()).toMatch(/^mar\.? 20 oct/);
  });
  it("keeps a 24-hour clock in the event's zone", () => {
    for (const l of ["en", "es", "fr"] as const) expect(formatters(l).time(at, "Africa/Cairo")).toBe("15:30");
  });
  it("survives a bad zone and a bad date", () => {
    expect(formatters("en").time(at, "Not/AZone")).toMatch(/^\d\d:\d\d$/);
    expect(formatters("fr").day("not a date")).toBe("");
  });
});

describe("lock-screen cards pushed by the server", () => {
  it("say the same words as the app", () => {
    for (const [lang, app] of [["es", esLock], ["fr", frLock]] as const) {
      const server = LOCK_WORDS[lang];
      for (const k of Object.keys(server) as (keyof typeof server)[]) expect(server[k], `${lang}.${k}`).toBe(app[k as keyof typeof app]);
    }
  });
});
