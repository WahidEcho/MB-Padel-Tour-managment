/**
 * Nations as tennis names them. The ITF uses IOC-style three-letter codes (GER,
 * SUI, NED), which are not ISO alpha-3 (DEU, CHE, NLD); flags are keyed by
 * ISO 3166-1 alpha-2. Both are stored on the team row so nothing converts at
 * render time. Pure.
 */
export interface Nation {
  /** ITF three-letter code, upper case. */
  code: string;
  name: string;
  /** ISO 3166-1 alpha-2, lower case, as flag sets name their files. */
  iso2: string;
}

const LIST: [string, string, string][] = [
  ["ALG", "Algeria", "dz"],
  ["ARG", "Argentina", "ar"],
  ["ARM", "Armenia", "am"],
  ["AUS", "Australia", "au"],
  ["AUT", "Austria", "at"],
  ["AZE", "Azerbaijan", "az"],
  ["BAH", "Bahamas", "bs"],
  ["BAR", "Barbados", "bb"],
  ["BEL", "Belgium", "be"],
  ["BIH", "Bosnia and Herzegovina", "ba"],
  ["BOL", "Bolivia", "bo"],
  ["BRA", "Brazil", "br"],
  ["BUL", "Bulgaria", "bg"],
  ["CAN", "Canada", "ca"],
  ["CHI", "Chile", "cl"],
  ["CHN", "China", "cn"],
  ["COL", "Colombia", "co"],
  ["CRC", "Costa Rica", "cr"],
  ["CRO", "Croatia", "hr"],
  ["CYP", "Cyprus", "cy"],
  ["CZE", "Czechia", "cz"],
  ["DEN", "Denmark", "dk"],
  ["DOM", "Dominican Republic", "do"],
  ["ECU", "Ecuador", "ec"],
  ["EGY", "Egypt", "eg"],
  ["ESA", "El Salvador", "sv"],
  ["ESP", "Spain", "es"],
  ["EST", "Estonia", "ee"],
  ["FIN", "Finland", "fi"],
  ["FRA", "France", "fr"],
  ["GBR", "Great Britain", "gb"],
  ["GEO", "Georgia", "ge"],
  ["GER", "Germany", "de"],
  ["GRE", "Greece", "gr"],
  ["GUA", "Guatemala", "gt"],
  ["HKG", "Hong Kong, China", "hk"],
  ["HUN", "Hungary", "hu"],
  ["INA", "Indonesia", "id"],
  ["IND", "India", "in"],
  ["IRI", "Iran", "ir"],
  ["IRL", "Ireland", "ie"],
  ["ISR", "Israel", "il"],
  ["ITA", "Italy", "it"],
  ["JAM", "Jamaica", "jm"],
  ["JOR", "Jordan", "jo"],
  ["JPN", "Japan", "jp"],
  ["KAZ", "Kazakhstan", "kz"],
  ["KEN", "Kenya", "ke"],
  ["KOR", "Korea, Republic of", "kr"],
  ["KSA", "Saudi Arabia", "sa"],
  ["KUW", "Kuwait", "kw"],
  ["LAT", "Latvia", "lv"],
  ["LBN", "Lebanon", "lb"],
  ["LTU", "Lithuania", "lt"],
  ["LUX", "Luxembourg", "lu"],
  ["MAR", "Morocco", "ma"],
  ["MAS", "Malaysia", "my"],
  ["MDA", "Moldova", "md"],
  ["MEX", "Mexico", "mx"],
  ["MKD", "North Macedonia", "mk"],
  ["MLT", "Malta", "mt"],
  ["MNE", "Montenegro", "me"],
  ["NAM", "Namibia", "na"],
  ["NED", "Netherlands", "nl"],
  ["NGR", "Nigeria", "ng"],
  ["NOR", "Norway", "no"],
  ["NZL", "New Zealand", "nz"],
  ["OMA", "Oman", "om"],
  ["PAK", "Pakistan", "pk"],
  ["PAN", "Panama", "pa"],
  ["PAR", "Paraguay", "py"],
  ["PER", "Peru", "pe"],
  ["PHI", "Philippines", "ph"],
  ["POL", "Poland", "pl"],
  ["POR", "Portugal", "pt"],
  ["PUR", "Puerto Rico", "pr"],
  ["QAT", "Qatar", "qa"],
  ["ROU", "Romania", "ro"],
  ["RSA", "South Africa", "za"],
  ["SGP", "Singapore", "sg"],
  ["SLO", "Slovenia", "si"],
  ["SRB", "Serbia", "rs"],
  ["SRI", "Sri Lanka", "lk"],
  ["SUI", "Switzerland", "ch"],
  ["SVK", "Slovakia", "sk"],
  ["SWE", "Sweden", "se"],
  ["SYR", "Syria", "sy"],
  ["THA", "Thailand", "th"],
  ["TPE", "Chinese Taipei", "tw"],
  ["TUN", "Tunisia", "tn"],
  ["TUR", "Türkiye", "tr"],
  ["UAE", "United Arab Emirates", "ae"],
  ["UGA", "Uganda", "ug"],
  ["UKR", "Ukraine", "ua"],
  ["URU", "Uruguay", "uy"],
  ["USA", "United States", "us"],
  ["UZB", "Uzbekistan", "uz"],
  ["VEN", "Venezuela", "ve"],
  ["VIE", "Vietnam", "vn"],
  ["ZIM", "Zimbabwe", "zw"],
];

export const NATIONS: Nation[] = LIST.map(([code, name, iso2]) => ({ code, name, iso2 }));
const BY_CODE = new Map(NATIONS.map((n) => [n.code, n]));

/** The nation for an ITF code, case-insensitive. Undefined for an unknown code. */
export function nationByCode(code: string | null | undefined): Nation | undefined {
  return code ? BY_CODE.get(code.trim().toUpperCase()) : undefined;
}

/** A three-letter code as it should be stored, or null when it is not one. */
export function normalizeNationCode(code: string | null | undefined): string | null {
  const c = (code ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : null;
}
