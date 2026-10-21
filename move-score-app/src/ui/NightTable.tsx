import { Pressable, View } from "react-native";
import type { NightTable as Table, NightTableEntry } from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Eyebrow } from "./Text";
import { Chip, LivePill } from "./Bits";
import { openMatch } from "../nav/links";
import { useT } from "../i18n";
import { tr } from "../i18n/t";

/** The shared table's fixed words ("about 19:40", "On court", "Court to come") in the app's language. */
function entryLabel(e: NightTableEntry): string {
  if (e.state === "live") return tr("schedule.onCourt");
  if (e.state === "finished") return tr("schedule.finished");
  if (e.state === "cancelled") return tr("schedule.cancelled");
  const about = /^about (.+)$/.exec(e.label);
  if (about) return tr("schedule.about", { time: about[1] });
  if (e.label === "Time to come") return tr("schedule.timeToCome");
  return e.label;
}

const courtName = (name: string, id: string) => (!id && name === "Court to come" ? tr("schedule.courtToCome") : name);
const side = (x: string) => (x === "TBD" ? tr("common.tbd") : x);

/**
 * A night's table (Phase 8): the order of play per court with "about" times,
 * from the shared buildNightTable. The layout follows `table.layout`, so the
 * owner's reference layout lands here and on the web together.
 */
function Entry({ e, court }: { e: NightTableEntry; court?: string }) {
  const { t } = useTheme();
  const tr = useT();
  const waiting = e.state === "waiting" || e.state === "called";
  // The match screen has something to show once the match is on court.
  const tappable = e.state === "live" || e.state === "finished";
  const shown = entryLabel(e);
  const a = side(e.a);
  const b = side(e.b);
  const label = [court, `${e.position}.`, e.round, `${a} ${tr("common.vs")} ${b}`, e.state === "called" ? tr("schedule.calledToCourt") : null, shown].filter(Boolean).join(" ");
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
        {e.state === "live" ? <LivePill /> : waiting ? <Chip label={e.state === "called" ? tr("schedule.calledLabel", { label: shown }) : shown} ball={e.state === "called"} /> : <Eyebrow size={10}>{shown}</Eyebrow>}
      </View>
      <Body weight={e.winner === "A" ? "bold" : "semi"} size={14} numberOfLines={1}>{a}</Body>
      <Body tone="ink2" weight={e.winner === "B" ? "bold" : "regular"} size={13} numberOfLines={1}>{`${tr("common.vs")} ${b}`}</Body>
    </Pressable>
  );
}

export function NightTable({ table, compact = false }: { table: Table; compact?: boolean }) {
  const tr = useT();
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
            <Eyebrow>{courtName(c.name, c.courtId)}</Eyebrow>
            {entries.map((e) => (
              <Entry key={e.matchId} e={e} />
            ))}
          </View>
        );
      })}
      <Body tone="ink3" size={12}>{tr("schedule.estimates")}</Body>
    </View>
  );
}
