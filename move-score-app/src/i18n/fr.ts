/** French. Typed against English: a missing or extra key fails `tsc`. */
import type { Shape } from "./translate";
import type { Words } from "./en";
import { common } from "./fr/common";
import { account } from "./fr/account";
import { auth } from "./fr/auth";
import { player } from "./fr/player";
import { ui } from "./fr/ui";
import { screens } from "./fr/screens";
import { event } from "./fr/event";
import { hero } from "./fr/hero";
import { schedule } from "./fr/schedule";
import { score } from "./fr/score";
import { referee } from "./fr/referee";
import { coach } from "./fr/coach";
import { story } from "./fr/story";
import { pass } from "./fr/pass";
import { lock } from "./fr/lock";
import { stories } from "./fr/stories";

export const fr: Shape<Words> = { common, account, auth, player, ui, screens, event, hero, schedule, score, referee, coach, story, pass, lock, stories };
