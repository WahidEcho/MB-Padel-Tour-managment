import { useDiscover } from "./queries";

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
