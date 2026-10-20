import { useEffect } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { useTheme } from "../../theme/ThemeProvider";
import { Screen } from "../../ui/Screen";
import { BackHeader } from "../../ui/Header";
import { Body, Display, Eyebrow } from "../../ui/Text";
import { Button, Card, Empty, SectionHeader } from "../../ui/Bits";
import { LoadState } from "../../ui/LoadState";
import { session } from "../../state/session";
import { alerts, turnAlertsOn } from "../../push/register";
import { signOutCoach, useCoachTeam } from "../../coach/session";
import { GroupCard, ScheduleCard, TeamLine, TieCardCoach } from "../../coach/ui";

/**
 * "My team" (migration 0037): the coach's own team only. Its group table, the next and
 * live ties with their rubbers, every tie with court and time, where the team goes after
 * the groups, and each player's schedule. Read only: line-ups are entered by the referee.
 */
export default function MyTeam() {
  const { t } = useTheme();
  const coach = session.use((s) => s.coach);
  const q = useCoachTeam();
  const alertState = alerts.use((s) => s.status);
  useEffect(() => {
    if (!coach) router.replace("/coach");
  }, [coach]);
  const v = q.data;
  const tz = v?.event.timeZone ?? "Africa/Cairo";
  const live = v?.ties.filter((x) => x.status === "live") ?? [];
  const next = v?.ties.find((x) => x.id === v.nextTieId && x.status !== "live") ?? null;
  const rest = v?.ties.filter((x) => x.status !== "live" && x.id !== next?.id) ?? [];
  return (
    <Screen tabs={false} onRefresh={() => q.refetch()}>
      <BackHeader label="Account" fallback="/account" />
      {!v ? (
        <LoadState queries={[q]} what="your team" />
      ) : (
        <View style={{ gap: 14 }}>
          <View style={{ gap: 6 }}>
            <Eyebrow tone="live">{`Team coach · ${v.event.name}`}</Eyebrow>
            <TeamLine team={v.team} size={30} />
            <Body tone="ink2" size={13}>{v.place ? `Final place: ${v.place}` : v.landing ? `After the groups: ${v.landing}` : v.group ? (/^group\b/i.test(v.group.name) ? v.group.name : `Group ${v.group.name}`) : (v.event.group ?? "")}</Body>
          </View>
          {alertState !== "on" ? (
            <Card style={{ gap: 8 }}>
              <Body weight="semi">Alerts for your team</Body>
              <Body tone="ink2" size={13}>Tie soon, called to court, started, results and line-ups, on this phone.</Body>
              <Button label={alertState === "turning-on" ? "Turning on…" : "Turn on alerts"} onPress={() => void turnAlertsOn()} />
            </Card>
          ) : null}
          {live.length ? <SectionHeader title="Live now" /> : null}
          {live.map((x) => <TieCardCoach key={x.id} tie={x} tz={tz} team={v.team} open />)}
          {next ? <SectionHeader title="Next tie" /> : null}
          {next ? <TieCardCoach tie={next} tz={tz} team={v.team} open /> : null}
          {v.group ? <SectionHeader title={(/^group\b/i.test(v.group.name) ? v.group.name : `Group ${v.group.name}`)} /> : null}
          {v.group ? <GroupCard group={v.group} teamId={v.team.id} /> : null}
          <SectionHeader title="All ties" />
          {rest.map((x) => <TieCardCoach key={x.id} tie={x} tz={tz} team={v.team} />)}
          {v.ties.length === 0 ? <Empty title="No ties yet" body="Your ties show here once the draw is made." /> : null}
          <SectionHeader title="Players' schedule" />
          {v.team.players.map((p) => <ScheduleCard key={p.id} player={p} slots={v.schedule.filter((s) => s.playerId === p.id)} tz={tz} />)}
          <Body tone="ink3" size={12}>Read only. Line-ups are entered by the referee; for anything on court, speak to the referee.</Body>
          <Button kind="ghost" label="Sign out on this phone" onPress={() => void signOutCoach().then(() => router.replace("/coach"))} />
          <View style={{ height: 24, backgroundColor: t.floor }} />
        </View>
      )}
    </Screen>
  );
}
