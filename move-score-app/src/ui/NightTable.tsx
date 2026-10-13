import { Pressable, View } from "react-native";
import type { NightTable as Table, NightTableEntry } from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Eyebrow } from "./Text";
import { Chip, LivePill } from "./Bits";
import { openMatch } from "../nav/links";

/**
 * A night's table (Phase 8): the order of play per court with "about" times,
 * from the shared buildNightTable. The layout follows `table.layout`, so the
 * owner's reference layout lands here and on the web together.
 */
function Entry({ e, court }: { e: NightTableEntry; court?: string }) {
  const { t } = useTheme();
  const waiting = e.state === "waiting" || e.state === "called";
  // The match screen has something to show once the match is on court.
  const tappable = e.state === "live" || e.state === "finished";
  const label = [court, `${e.position}.`, e.round, `${e.a} v ${e.b}`, e.state === "called" ? "Called to court" : null, e.label].filter(Boolean).join(" ");
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole={tappable ? "button" : undefined}
      disabled={!tappable}
      onPress={() => openMatch(e.matchId)}
      style={({ pressed }) => ({
        borderRadius: 14,
        borderWidth: 1,
        borderColor: e.state === "live" ? t.live : e.state === "called" ? t.ball : t.line,
        paddingHorizontal: 10,
        paddingVertical: 8,
        gap: 2,
        opacity: pressed ? 0.7 : e.state === "finished" || e.state === "cancelled" ? 0.6 : 1,
      })}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <Eyebrow size={10}>{[court, `${e.position}`, e.round].filter(Boolean).join(" · ")}</Eyebrow>
        {e.state === "live" ? <LivePill /> : waiting ? <Chip label={e.state === "called" ? `Called · ${e.label}` : e.label} ball={e.state === "called"} /> : <Eyebrow size={10}>{e.label}</Eyebrow>}
      </View>
      <Body weight={e.winner === "A" ? "bold" : "semi"} size={14} numberOfLines={1}>{e.a}</Body>
      <Body tone="ink2" weight={e.winner === "B" ? "bold" : "regular"} size={13} numberOfLines={1}>{`v ${e.b}`}</Body>
    </Pressable>
  );
}

export function NightTable({ table, compact = false }: { table: Table; compact?: boolean }) {
  if (table.layout === "by_round") {
    return (
      <View style={{ gap: 10 }}>
        {table.rounds.map((r) => (
          <View key={r.round} style={{ gap: 6 }}>
            <Eyebrow>{r.round}</Eyebrow>
            {r.entries.map((e) => (
              <Entry key={e.matchId} e={e} court={e.court} />
            ))}
          </View>
        ))}
      </View>
    );
  }
  return (
    <View style={{ gap: 12 }}>
      {table.courts.map((c) => {
        // On the league page: what is on now and next, not the whole night.
        const from = Math.max(0, c.entries.findIndex((e) => e.state !== "finished" && e.state !== "cancelled"));
        const entries = compact ? c.entries.slice(from, from + 3) : c.entries;
        if (!entries.length) return null;
        return (
          <View key={c.courtId || "none"} style={{ gap: 6 }}>
            <Eyebrow>{c.name}</Eyebrow>
            {entries.map((e) => (
              <Entry key={e.matchId} e={e} />
            ))}
          </View>
        );
      })}
      <Body tone="ink3" size={12}>Times are estimates: each match starts when its court is free.</Body>
    </View>
  );
}
