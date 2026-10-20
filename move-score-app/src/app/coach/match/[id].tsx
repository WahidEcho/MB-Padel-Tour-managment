import { View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { timeIn } from "../../../api/model";
import { useTheme } from "../../../theme/ThemeProvider";
import { Screen } from "../../../ui/Screen";
import { BackHeader } from "../../../ui/Header";
import { Body } from "../../../ui/Text";
import { Card, LinkChip, SectionHeader } from "../../../ui/Bits";
import { LoadState } from "../../../ui/LoadState";
import { useCoachMatch } from "../../../coach/session";
import { session } from "../../../state/session";
import { RubberCard } from "../../../coach/ui";

/** One of the coach's own rubbers: live score and match log (never who entered it). */
export default function CoachMatch() {
  const { t } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useCoachMatch(id);
  const tz = session.use((s) => s.coach?.event.timeZone) ?? "Africa/Cairo";
  const m = q.data;
  return (
    <Screen tabs={false} onRefresh={() => q.refetch()}>
      <BackHeader label="My team" fallback="/coach/team" />
      {!m ? (
        <LoadState queries={[q]} what="this match" />
      ) : (
        <View style={{ gap: 10 }}>
          <RubberCard r={m.rubber} tz={tz} us={m.team} them={m.opponent} />
          {m.tieId ? <LinkChip label="The whole tie" onPress={() => router.push({ pathname: "/coach/tie/[id]", params: { id: m.tieId! } })} /> : null}
          <SectionHeader title="Match log" />
          {m.log.length === 0 ? <Body tone="ink2" size={13}>Nothing yet: the log starts with the first point.</Body> : null}
          {[...m.log].reverse().map((e) => (
            <Card key={e.n} style={{ gap: 2, opacity: e.undone ? 0.5 : 1 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                <Body weight="semi" size={14} style={{ flex: 1, textDecorationLine: e.undone ? "line-through" : "none" }}>{e.title}</Body>
                {e.chip ? <Body size={11} weight="bold" style={{ color: t.ink2 }}>{e.chip}</Body> : null}
              </View>
              <Body tone="ink2" size={13}>{e.detail}</Body>
              {e.at ? <Body tone="ink3" size={11}>{timeIn(e.at, tz)}</Body> : null}
            </Card>
          ))}
        </View>
      )}
    </Screen>
  );
}
