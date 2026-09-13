"use client";

import { usePathname } from "next/navigation";
import PresenceBeat from "./PresenceBeat";
import type { PresencePage } from "@/lib/presence";

/**
 * The presence beat for whichever public page is showing.
 *
 * The pill lives in the shared header so it mounts once for overview,
 * leaderboard, live, bracket and winner — but each of those is a different page
 * and is counted separately, and a layout is not told which one it is rendering.
 * Reading the path on the client is what lets one mount serve all of them.
 */
export default function PresenceBeatForPath({ slug }: { slug: string }) {
  const pathname = usePathname();
  const page = pageFromPath(pathname, slug);
  if (!page) return null;
  return <PresenceBeat slug={slug} page={page} />;
}

function pageFromPath(pathname: string, slug: string): PresencePage | null {
  const prefix = `/t/${slug}`;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length).replace(/\/$/, "");
  switch (rest) {
    case "":
      return "overview";
    case "/leaderboard":
      return "leaderboard";
    case "/live":
      return "live";
    case "/bracket":
      return "bracket";
    case "/winner":
      return "winner";
    default:
      // A single match page is somebody following one court, not a page worth
      // counting on its own.
      return null;
  }
}
