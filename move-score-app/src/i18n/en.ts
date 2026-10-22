/**
 * English: the source of truth for every word the app shows. Each namespace
 * lives in ./en/<namespace>.ts; es.ts and fr.ts must have exactly these keys (a
 * missing or extra key fails `tsc`, an empty value fails i18n.test.ts).
 */
import type { KeyOf } from "./translate";
import { common } from "./en/common";
import { account } from "./en/account";
import { auth } from "./en/auth";
import { player } from "./en/player";
import { ui } from "./en/ui";
import { screens } from "./en/screens";
import { event } from "./en/event";
import { hero } from "./en/hero";
import { schedule } from "./en/schedule";
import { score } from "./en/score";
import { referee } from "./en/referee";
import { coach } from "./en/coach";
import { story } from "./en/story";
import { pass } from "./en/pass";
import { lock } from "./en/lock";
import { stories } from "./en/stories";

export const en = { common, account, auth, player, ui, screens, event, hero, schedule, score, referee, coach, story, pass, lock, stories };

export type Words = typeof en;
/** "account.title", "common.back", … */
export type Key = KeyOf<Words>;
