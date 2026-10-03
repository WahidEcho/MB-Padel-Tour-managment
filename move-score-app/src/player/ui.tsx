import { View } from "react-native";
import { router } from "expo-router";
import { Image } from "expo-image";
import { isDoneStatus, isLiveStatus, scoreLine, type MMyMatch, type MMyPlayer } from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { whenIn } from "../api/model";
import { Body, Eyebrow, Num } from "../ui/Text";
import { Card, Chip, Flag } from "../ui/Bits";

/** The player's photo, or their initials on the stage colour. */
export function PlayerAvatar({ player, size = 72 }: { player: Pick<MMyPlayer, "name" | "photoUrl">; size?: number }) {
  const { t } = useTheme();
  const initials = player.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  if (player.photoUrl) {
    return (
      <Image
        source={{ uri: player.photoUrl }}
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: t.chip }}
        contentFit="cover"
        accessibilityLabel={`Photo of ${player.name}`}
      />
    );
  }
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: t.chip, borderWidth: 1, borderColor: t.line, alignItems: "center", justifyContent: "center" }}>
      <Num size={size * 0.36} tone="ink2">{initials}</Num>
    </View>
  );
}

/** Name, flag and team on one line. */
export function PlayerIdentity({ player }: { player: MMyPlayer }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {(player.iso2 || player.nationCode) && <Flag iso2={player.iso2} code={player.nationCode} size={22} />}
      <Body tone="ink2" size={13.5}>{player.teamName || player.nationCode || ""}</Body>
    </View>
  );
}

/** One of the player's matches: who against whom, when or the score. Opens the match. */
export function MyMatchRow({ m, timezone, withDay = true }: { m: MMyMatch; timezone: string; withDay?: boolean }) {
  const live = isLiveStatus(m.status);
  const done = isDoneStatus(m.status);
  const won = done && m.winner && m.mySide ? (m.mySide === "A" ? m.winner === m.a : m.winner === m.b) : null;
  const label = live ? "Live" : done ? (won === null ? "Result" : won ? "Won" : "Lost") : whenIn(m.scheduledTime, timezone, withDay);
  const line = scoreLine(m.score);
  const name = (side: "A" | "B") => (side === "A" ? m.aName : m.bName) ?? "To be decided";
  return (
    <Card
      onPress={() => router.push({ pathname: "/match/[id]", params: { id: m.id } })}
      accessibilityLabel={`${name("A")} against ${name("B")}. ${label}${line ? `. ${line}` : ""}`}
      style={{ gap: 6 }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <Eyebrow size={10} style={{ flex: 1 }} numberOfLines={1}>{[m.tournamentName, m.round].filter(Boolean).join(" · ")}</Eyebrow>
        {live ? <Chip label="LIVE" ball /> : <Eyebrow size={10} tone={won ? "ink" : "ink2"}>{label}</Eyebrow>}
      </View>
      {(["A", "B"] as const).map((side) => (
        <Body key={side} size={15} weight={m.mySide === side ? "bold" : "regular"} tone={m.mySide === side ? "ink" : "ink2"} numberOfLines={1}>
          {name(side)}
        </Body>
      ))}
      {line ? <Body size={13} tone={live ? "live" : "ink2"}>{line}</Body> : null}
    </Card>
  );
}
