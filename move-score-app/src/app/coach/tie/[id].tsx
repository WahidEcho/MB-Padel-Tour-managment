import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Screen } from "../../../ui/Screen";
import { BackHeader } from "../../../ui/Header";
import { Body } from "../../../ui/Text";
import { LoadState } from "../../../ui/LoadState";
import { session } from "../../../state/session";
import { useCoachTie } from "../../../coach/session";
import { TieCardCoach } from "../../../coach/ui";

/** One of the coach's own ties with its rubbers (another team's tie is "not found"). */
export default function CoachTie() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const coach = session.use((s) => s.coach);
  const q = useCoachTie(id);
  const tz = coach?.event.timeZone ?? "Africa/Cairo";
  return (
    <Screen tabs={false} onRefresh={() => q.refetch()}>
      <BackHeader label="My team" fallback="/coach/team" />
      {!q.data || !coach ? (
        <LoadState queries={[q]} what="this tie" />
      ) : (
        <View style={{ gap: 10 }}>
          <TieCardCoach tie={q.data} tz={tz} team={coach.team} open />
          <Body tone="ink3" size={12}>{q.data.lineupLocked ? "Line-ups are locked." : "Line-ups are not locked yet."} The opponents&apos; players show once each rubber starts.</Body>
        </View>
      )}
    </Screen>
  );
}
