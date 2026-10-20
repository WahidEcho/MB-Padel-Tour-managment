import { useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Screen } from "../../../ui/Screen";
import { BackHeader } from "../../../ui/Header";
import { Body } from "../../../ui/Text";
import { Button } from "../../../ui/Bits";
import { LoadState } from "../../../ui/LoadState";
import { session } from "../../../state/session";
import { useCoachLineup, useCoachTie } from "../../../coach/session";
import { TieCardCoach } from "../../../coach/ui";
import { CoachLineupPicker } from "../../../coach/CoachLineupPicker";

/**
 * One of the coach's own ties with its rubbers (another team's tie is "not found"). While the
 * event's coach line-up entry is on (`lineupEntry` on the tie; off by default), "Enter line-up".
 */
export default function CoachTie() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const coach = session.use((s) => s.coach);
  const q = useCoachTie(id);
  const [entering, setEntering] = useState(false);
  const entryOn = Boolean(q.data?.lineupEntry);
  const lu = useCoachLineup(id, entryOn && (entering || Boolean(q.data?.lineupEntry?.submittedAt)));
  const tz = coach?.event.timeZone ?? "Africa/Cairo";
  const entry = lu.data?.entry;
  return (
    <Screen tabs={false} onRefresh={() => Promise.all([q.refetch(), lu.refetch()])}>
      <BackHeader label="My team" fallback="/coach/team" />
      {!q.data || !coach ? (
        <LoadState queries={[q]} what="this tie" />
      ) : (
        <View style={{ gap: 12 }}>
          <TieCardCoach tie={q.data} tz={tz} team={coach.team} open />
          {entryOn && entry && (entering || !entry.open) ? (
            <CoachLineupPicker key={entry.submitted?.at ?? "new"} tieId={q.data.id} initial={entry} tz={tz} onDone={() => void q.refetch()} />
          ) : null}
          {entryOn && q.data.lineupEntry?.open && !entering ? (
            <Button label={q.data.lineupEntry.submittedAt ? "Change the line-up" : "Enter line-up"} onPress={() => setEntering(true)} />
          ) : null}
          {entering && lu.isLoading ? <Body tone="ink3">Loading your squad…</Body> : null}
          <Body tone="ink3" size={12}>{q.data.lineupLocked ? "Line-ups are locked." : "Line-ups are not locked yet."} The opponents&apos; players show once the line-ups are confirmed.</Body>
        </View>
      )}
    </Screen>
  );
}
