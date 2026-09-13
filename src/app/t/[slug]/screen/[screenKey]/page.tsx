import TvScreen from "../TvScreen";

export const dynamic = "force-dynamic";

/** One named screen: /t/<slug>/screen/tv-2. */
export default async function KeyedScreenPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; screenKey: string }>;
  searchParams: Promise<{ court?: string; mode?: string; preview?: string }>;
}) {
  const { slug, screenKey } = await params;
  return <TvScreen slug={slug} screenKey={screenKey} overrides={await searchParams} />;
}
