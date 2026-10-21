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
import { useT } from "../../../i18n";

/**
 * One of the coach's own ties with its rubbers (another team's tie is "not found"). While the
 * event's coach line-up entry is on (`lineupEntry` on the tie; off by default), "Enter line-up".
 */
export default function CoachTie() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const tr = useT();
  const coach = session.use((s) => s.coach);
  const q = useCoachTie(id);
  const [entering, setEntering] = useState(false);
  const entryOn = Boolean(q.data?.lineupEntry);
  const lu = useCoachLineup(id, entryOn && (entering || Boolean(q.data?.lineupEntry?.submittedAt)));
  const tz = coach?.event.timeZone ?? "Africa/Cairo";
  const entry = lu.data?.entry;
  return (
    <Screen tabs={false} onRefresh={() => Promise.all([q.refetch(), lu.refetch()])}>
      <BackHeader label={tr("coach.myTeam")} fallback="/coach/team" />
      {!q.data || !coach ? (
        <LoadState queries={[q]} what={tr("coach.whatTie")} />
      ) : (
        <View style={{ gap: 12 }}>
          <TieCardCoach tie={q.data} tz={tz} team={coach.team} open />
          {entryOn && entry && (entering || !entry.open) ? (
            <CoachLineupPicker key={entry.submitted?.at ?? "new"} tieId={q.data.id} initial={entry} tz={tz} onDone={() => void q.refetch()} />
          ) : null}
          {entryOn && q.data.lineupEntry?.open && !entering ? (
            <Button label={q.data.lineupEntry.submittedAt ? tr("coach.changeLineup") : tr("coach.enterLineup")} onPress={() => setEntering(true)} />
          ) : null}
          {entering && lu.isLoading ? <Body tone="ink3">{tr("coach.loadingSquad")}</Body> : null}
          <Body tone="ink3" size={12}>{`${q.data.lineupLocked ? tr("coach.lineupsLocked") : tr("coach.lineupsNotLocked")} ${tr("coach.opponentsShow")}`}</Body>
        </View>
      )}
    </Screen>
  );
}
