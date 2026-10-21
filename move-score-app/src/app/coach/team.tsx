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
import { useT } from "../../i18n";

/**
 * "My team" (migration 0037): the coach's own team only. Its group table, the next and
 * live ties with their rubbers, every tie with court and time, where the team goes after
 * the groups, and each player's schedule. Read only: line-ups are entered by the referee.
 */
export default function MyTeam() {
  const { t } = useTheme();
  const tr = useT();
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
      <BackHeader label={tr("coach.account")} fallback="/account" />
      {!v ? (
        <LoadState queries={[q]} what={tr("coach.whatTeam")} />
      ) : (
        <View style={{ gap: 14 }}>
          <View style={{ gap: 6 }}>
            <Eyebrow tone="live">{tr("coach.eyebrowEvent", { event: v.event.name })}</Eyebrow>
            <TeamLine team={v.team} size={30} />
            <Body tone="ink2" size={13}>{v.place ? tr("coach.finalPlace", { place: v.place }) : v.landing ? tr("coach.afterGroups", { landing: v.landing }) : v.group ? (/^group\b/i.test(v.group.name) ? v.group.name : tr("coach.groupName", { name: v.group.name })) : (v.event.group ?? "")}</Body>
          </View>
          {alertState !== "on" ? (
            <Card style={{ gap: 8 }}>
              <Body weight="semi">{tr("coach.alertsTitle")}</Body>
              <Body tone="ink2" size={13}>{tr("coach.alertsBody")}</Body>
              <Button label={alertState === "turning-on" ? tr("coach.turningOn") : tr("coach.turnOnAlerts")} onPress={() => void turnAlertsOn()} />
            </Card>
          ) : null}
          {live.length ? <SectionHeader title={tr("coach.liveNow")} /> : null}
          {live.map((x) => <TieCardCoach key={x.id} tie={x} tz={tz} team={v.team} open />)}
          {next ? <SectionHeader title={tr("coach.nextTie")} /> : null}
          {next ? <TieCardCoach tie={next} tz={tz} team={v.team} open /> : null}
          {v.group ? <SectionHeader title={(/^group\b/i.test(v.group.name) ? v.group.name : tr("coach.groupName", { name: v.group.name }))} /> : null}
          {v.group ? <GroupCard group={v.group} teamId={v.team.id} /> : null}
          <SectionHeader title={tr("coach.allTies")} />
          {rest.map((x) => <TieCardCoach key={x.id} tie={x} tz={tz} team={v.team} />)}
          {v.ties.length === 0 ? <Empty title={tr("coach.noTies")} body={tr("coach.noTiesBody")} /> : null}
          <SectionHeader title={tr("coach.playersSchedule")} />
          {v.team.players.map((p) => <ScheduleCard key={p.id} player={p} slots={v.schedule.filter((s) => s.playerId === p.id)} tz={tz} />)}
          <Body tone="ink3" size={12}>{tr("coach.readOnlyFooter")}</Body>
          <Button kind="ghost" label={tr("coach.signOutPhone")} onPress={() => void signOutCoach().then(() => router.replace("/coach"))} />
          <View style={{ height: 24, backgroundColor: t.floor }} />
        </View>
      )}
    </Screen>
  );
}
