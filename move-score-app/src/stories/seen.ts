/**
 * Which stories this phone has seen: kept on the phone only (never sent), so the
 * row can put unseen posters first and ring them. Stories live 24 hours, so the
 * newest 600 ids are plenty.
 */
import { createStore } from "../state/store";
import { getJson, setJson } from "../state/kv";

const KEY = "ms.stories.seen";
const MAX = 600;

function load(): string[] {
  const v = getJson<unknown>(KEY, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(-MAX) : [];
}

export const seenStories = createStore<ReadonlySet<string>>(new Set(load()));

export function markSeen(id: string) {
  const now = seenStories.get();
  if (now.has(id)) return;
  const list = [...now, id].slice(-MAX);
  seenStories.set(new Set(list));
  setJson(KEY, list);
}
