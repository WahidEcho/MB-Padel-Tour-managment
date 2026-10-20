import { Pressable, View } from "react-native";
import { router } from "expo-router";
import { isDoneStatus, isLiveStatus, scoreLine, type MCoachRubber, type MCoachSlot, type MCoachTeamRef, type MCoachTeamView, type MCoachTie } from "@core";
import { dayIn, timeIn } from "../api/model";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Eyebrow, Num } from "../ui/Text";
import { Card, Flag } from "../ui/Bits";

/** The coach's screens (migration 0037): their own team only, read-only. Scores read our team first. */

export const when = (iso: string | null, tz: string) => (iso ? `${dayIn(iso, tz)} · ${timeIn(iso, tz)}` : "Time to be set");

export function TeamLine({ team, size = 20, bold = true }: { team: MCoachTeamRef | null; size?: number; bold?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 }}>
      <Flag iso2={team?.iso2} code={team?.code} size={size} />
      <Body weight={bold ? "bold" : "regular"} numberOfLines={1} style={{ flexShrink: 1 }}>{team?.name ?? "To be decided"}</Body>
    </View>
  );
}

export function StatusPill({ status, result }: { status: string; result: "us" | "them" | null }) {
  const { t } = useTheme();
  const live = isLiveStatus(status as never);
  const done = isDoneStatus(status as never) || status === "completed";
  const label = live ? "LIVE" : done ? (result === "us" ? "WON" : result === "them" ? "LOST" : "FINAL") : status === "ready" ? "CALLED" : status === "cancelled" ? "NOT PLAYED" : "SCHEDULED";
  const bg = live ? t.liveFill : done && result === "us" ? t.success : t.chip;
  const ink = live || (done && result === "us") ? "#FFFFFF" : t.ink2;
  return (
    <View style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 }}>
      <Body size={11} weight="bold" style={{ color: ink, letterSpacing: 0.6 }}>{label}</Body>
    </View>
  );
}

export function RubberCard({ r, tz, us, them, onPress }: { r: MCoachRubber; tz: string; us: MCoachTeamRef; them: MCoachTeamRef | null; onPress?: () => void }) {
  const points = r.score?.points && isLiveStatus(r.status) ? `${r.score.points.a}–${r.score.points.b}` : null;
  return (
    <Card onPress={onPress} style={{ gap: 6 }} accessibilityLabel={`${r.label}, ${r.status}`}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <Body weight="semi">{r.label}</Body>
        <StatusPill status={r.status} result={r.result} />
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <Body size={14} numberOfLines={2} style={{ flex: 1 }}>
          <Body weight="bold" size={14}>{us.code} </Body>
          {r.ours.length ? r.ours.map((p) => p.name).join(" / ") : "line-up not entered yet"}
        </Body>
        <Num size={16}>{scoreLine(r.score)}</Num>
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <Body size={14} tone="ink2" numberOfLines={2} style={{ flex: 1 }}>
          <Body weight="bold" size={14} tone="ink2">{them?.code ?? "TBD"} </Body>
          {r.theirs ? (r.theirs.length ? r.theirs.map((p) => p.name).join(" / ") : "to be named") : "shown once the line-ups are confirmed"}
        </Body>
        {points ? <Num size={16} tone="live">{points}</Num> : null}
      </View>
      <Body size={12} tone="ink3">{[r.court, r.scheduledTime ? when(r.scheduledTime, tz) : null].filter(Boolean).join(" · ") || "Court and time to be set"}</Body>
    </Card>
  );
}

export function TieCardCoach({ tie, tz, team, open = false }: { tie: MCoachTie; tz: string; team: MCoachTeamRef; open?: boolean }) {
  return (
    <View style={{ gap: 8 }}>
      <Card onPress={() => router.push({ pathname: "/coach/tie/[id]", params: { id: tie.id } })} style={{ gap: 8 }} accessibilityLabel={`${team.name} v ${tie.opponent?.name ?? "to be decided"}, ${tie.stageLabel}`}>
        <Eyebrow tone="ink2">{tie.stageLabel}</Eyebrow>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <View style={{ flex: 1, gap: 6 }}>
            <TeamLine team={team} />
            <TeamLine team={tie.opponent} bold={false} />
          </View>
          <View style={{ alignItems: "flex-end", gap: 6 }}>
            <Num size={26}>{`${tie.rubbersUs}–${tie.rubbersThem}`}</Num>
            <StatusPill status={tie.status} result={tie.result} />
          </View>
        </View>
        <Body size={13} tone="ink2">{`${tie.court ?? "Court to be set"} · ${when(tie.scheduledTime, tz)}`}</Body>
        {!tie.lineupEntered && tie.status === "scheduled" ? <Body size={12} tone="ink3">Line-up not entered yet: give it to the referee as usual.</Body> : null}
      </Card>
      {open ? tie.rubbers.map((r) => <RubberCard key={r.matchId} r={r} tz={tz} us={team} them={tie.opponent} onPress={() => router.push({ pathname: "/coach/match/[id]", params: { id: r.matchId } })} />) : null}
    </View>
  );
}

export function GroupCard({ group, teamId }: { group: NonNullable<MCoachTeamView["group"]>; teamId: string }) {
  const { t } = useTheme();
  return (
    <Card style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Body size={11} tone="ink3" style={{ width: 18 }}>#</Body>
        <Body size={11} tone="ink3" style={{ flex: 1 }}>TEAM</Body>
        <Body size={11} tone="ink3" style={{ width: 28, textAlign: "right" }}>P</Body>
        <Body size={11} tone="ink3" style={{ width: 28, textAlign: "right" }}>W</Body>
        <Body size={11} tone="ink3" style={{ width: 44, textAlign: "right" }}>RUB</Body>
        <Body size={11} tone="ink3" style={{ width: 44, textAlign: "right" }}>SETS</Body>
      </View>
      {group.rows.map((r) => (
        <View key={r.teamId} style={{ flexDirection: "row", gap: 8, alignItems: "center", paddingVertical: 4, borderRadius: 8, backgroundColor: r.teamId === teamId ? t.chip : "transparent" }}>
          <Body size={13} style={{ width: 18 }}>{String(r.rank)}</Body>
          <View style={{ flex: 1 }}><TeamLine team={r.team} size={16} bold={r.teamId === teamId} /></View>
          <Body size={13} style={{ width: 28, textAlign: "right" }}>{String(r.played)}</Body>
          <Body size={13} style={{ width: 28, textAlign: "right" }}>{String(r.won)}</Body>
          <Body size={13} style={{ width: 44, textAlign: "right" }}>{`${r.rubbersWon ?? 0}–${r.rubbersLost ?? 0}`}</Body>
          <Body size={13} style={{ width: 44, textAlign: "right" }}>{`${r.setsWon}–${r.setsLost}`}</Body>
        </View>
      ))}
      {group.rows.length === 0 ? <Body size={13} tone="ink2">No results yet.</Body> : null}
    </Card>
  );
}

export function ScheduleCard({ player, slots, tz }: { player: { id: string; name: string }; slots: MCoachSlot[]; tz: string }) {
  return (
    <Card style={{ gap: 6 }}>
      <Body weight="semi">{player.name}</Body>
      {slots.length === 0 ? <Body size={13} tone="ink3">Not in a line-up yet.</Body> : null}
      {slots.map((s) => (
        <Pressable key={s.matchId} accessibilityRole="button" onPress={() => router.push({ pathname: "/coach/match/[id]", params: { id: s.matchId } })} style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
          <Body size={13}>{`${s.label} v ${s.opponent ?? "TBD"}`}</Body>
          <Body size={13} tone="ink2">{[s.court, s.scheduledTime ? when(s.scheduledTime, tz) : null].filter(Boolean).join(" · ")}</Body>
        </Pressable>
      ))}
    </Card>
  );
}
