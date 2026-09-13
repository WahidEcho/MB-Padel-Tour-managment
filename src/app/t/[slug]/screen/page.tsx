import TvScreen from "./TvScreen";

export const dynamic = "force-dynamic";

/** The tournament's default screen. Equivalent to /screen/main. */
export default async function MainScreenPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ court?: string; mode?: string; preview?: string }>;
}) {
  const { slug } = await params;
  return <TvScreen slug={slug} overrides={await searchParams} />;
}
