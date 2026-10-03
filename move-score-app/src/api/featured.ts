import { useBundle, useDiscover, useLive } from "./queries";

/** The tournaments the app centres on: the featured event's, else whatever is live. */
export function useFeaturedSlugs(): { slug: string; name: string; id: string }[] {
  const d = useDiscover();
  const fromFeatured = (d.data?.featured ?? []).flatMap((g) => g.tournaments);
  const list = fromFeatured.length ? fromFeatured : (d.data?.live ?? []);
  return list.slice(0, 4).map((t) => ({ slug: t.slug, name: t.name, id: t.id }));
}

export function useFeaturedGroup() {
  const d = useDiscover();
  return d.data?.featured[0] ?? null;
}

/**
 * The reads a featured-event tab cannot show anything without: Discover, then
 * the first tournament's bundle (and its live list, when the tab shows matches:
 * `live` is the poll interval the tab already uses, so no extra polling).
 * Hand them to <LoadState> while any has no data; empty when there is no event.
 */
export function useFeaturedNeeds({ live = 5_000 }: { live?: number | false } = {}) {
  const d = useDiscover();
  const slug = useFeaturedSlugs()[0]?.slug;
  const b = useBundle(slug);
  const l = useLive(live ? slug : undefined, live || undefined);
  const needs = !d.data ? [d] : !slug ? [] : live ? [b, l] : [b];
  return { needs, waiting: needs.some((q) => q.data === undefined) };
}
