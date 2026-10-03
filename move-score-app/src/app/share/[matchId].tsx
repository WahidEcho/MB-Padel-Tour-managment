import { useLocalSearchParams } from "expo-router";
import { ShareFlow } from "../../story/ShareFlow";
import { useMatchStory, usePassStory, useTieStory } from "../../story/useStoryInfo";

function MatchShare({ id }: { id: string }) {
  return <ShareFlow state={useMatchStory(id)} />;
}

function TieShare({ id, slug }: { id: string; slug: string | undefined }) {
  return <ShareFlow state={useTieStory(id, slug)} />;
}

function PassShare() {
  return <ShareFlow state={usePassStory()} />;
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
