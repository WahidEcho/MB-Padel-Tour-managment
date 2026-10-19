import { useLocalSearchParams } from "expo-router";
import { LineupScreenBody } from "../../../referee/LineupScreen";
import { Screen } from "../../../ui/Screen";
import { BackHeader } from "../../../ui/Header";

/** A tie's line-ups, opened from a rubber (the console's "Line-up" chip, the master's court list). */
export default function LineupRoute() {
  const { matchId } = useLocalSearchParams<{ matchId: string }>();
  return (
    <Screen tabs={false}>
      <BackHeader label="Match" />
      <LineupScreenBody matchId={matchId} />
    </Screen>
  );
}
