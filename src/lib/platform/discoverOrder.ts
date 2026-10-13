/**
 * The order of the app's Discover hero: featured event groups and live
 * tournaments, set by Move Beyond on Admin → Discover. Stored in
 * `platform_settings` key `discover_order` as one ordered list of ids, each an
 * event group's or a stand-alone tournament's. Pure.
 */

export const DISCOVER_ORDER_KEY = "discover_order";
export const MAX_DISCOVER_ITEMS = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The stored list, or [] for anything that is not a list of ids. Duplicates keep their first place. */
export function parseDiscoverOrder(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const v of raw) if (typeof v === "string" && UUID.test(v) && !seen.has(v)) seen.add(v);
  return [...seen].slice(0, MAX_DISCOVER_ITEMS);
}

/**
 * Items in the stored order. An item is placed by the first of its keys found in
 * the list (a tournament by its own id, then its event group's); unlisted items
 * keep their current order after the listed ones.
 */
export function inDiscoverOrder<T>(items: T[], keys: (item: T) => (string | null | undefined)[], order: string[]): T[] {
  const pos = new Map(order.map((id, i) => [id, i]));
  const rank = (item: T) => {
    for (const k of keys(item)) if (k && pos.has(k)) return pos.get(k)!;
    return Number.POSITIVE_INFINITY;
  };
  return items
    .map((item, i) => ({ item, i, r: rank(item) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.item);
}
