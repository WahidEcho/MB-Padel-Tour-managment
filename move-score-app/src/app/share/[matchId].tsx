import { useLocalSearchParams } from "expo-router";
import { ShareFlow } from "../../story/ShareFlow";
import { useMatchStory, usePassStory, useTieStory } from "../../story/useStoryInfo";
import { useFeaturedGroup } from "../../api/featured";

function MatchShare({ id }: { id: string }) {
  return <ShareFlow state={useMatchStory(id)} storyContext={{ kind: "match", matchId: id }} />;
}

function TieShare({ id, slug }: { id: string; slug: string | undefined }) {
  return <ShareFlow state={useTieStory(id, slug)} storyContext={{ kind: "tie", tieId: id, ...(slug ? { slug } : {}) }} />;
}

function PassShare() {
  const slug = useFeaturedGroup()?.tournaments[0]?.slug;
  return <ShareFlow state={usePassStory()} storyContext={slug ? { kind: "pass", slug } : null} />;
}

/**
 * Share a match, a tie (`kind=tie&slug=…`) or the pass (`pass`): a photo story
 * ("I'm here" → camera → compose) or the branded card without a photo.
 */
export default function Share() {
  const { matchId, kind, slug } = useLocalSearchParams<{ matchId: string; kind?: string; slug?: string }>();
  if (matchId === "pass") return <PassShare />;
  if (kind === "tie") return <TieShare id={matchId} slug={slug} />;
  return <MatchShare id={matchId} />;
}
