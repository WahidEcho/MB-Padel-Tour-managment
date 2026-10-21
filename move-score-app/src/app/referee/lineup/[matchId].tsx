import { useLocalSearchParams } from "expo-router";
import { LineupScreenBody } from "../../../referee/LineupScreen";
import { Screen } from "../../../ui/Screen";
import { BackHeader } from "../../../ui/Header";
import { useT } from "../../../i18n";

/** A tie's line-ups, opened from a rubber (the console's "Line-up" chip, the master's court list). */
export default function LineupRoute() {
  const { matchId } = useLocalSearchParams<{ matchId: string }>();
  const tr = useT();
  return (
    <Screen tabs={false}>
      <BackHeader label={tr("referee.match")} />
      <LineupScreenBody matchId={matchId} />
    </Screen>
  );
}
