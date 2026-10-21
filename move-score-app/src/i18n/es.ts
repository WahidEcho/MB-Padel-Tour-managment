/** Spanish. Typed against English: a missing or extra key fails `tsc`. */
import type { Shape } from "./translate";
import type { Words } from "./en";
import { common } from "./es/common";
import { account } from "./es/account";
import { auth } from "./es/auth";
import { player } from "./es/player";
import { ui } from "./es/ui";
import { screens } from "./es/screens";
import { event } from "./es/event";
import { hero } from "./es/hero";
import { schedule } from "./es/schedule";
import { score } from "./es/score";
import { referee } from "./es/referee";
import { coach } from "./es/coach";
import { story } from "./es/story";
import { pass } from "./es/pass";
import { lock } from "./es/lock";

export const es: Shape<Words> = { common, account, auth, player, ui, screens, event, hero, schedule, score, referee, coach, story, pass, lock };
