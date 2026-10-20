import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { placementBrackets, type BracketDraw, type BracketSide, type BracketTie, type MTie } from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Eyebrow, Num } from "./Text";
import { Empty, Flag } from "./Bits";
import { Segments } from "./Segments";
import type { View as Model } from "../api/model";
import { dayIn, timeIn } from "../api/model";
import { openTie } from "../nav/links";

const COLUMN = 236;

function Side({ side, v, score, won, lost }: { side: BracketSide; v: Model; score: number | null; won: boolean; lost: boolean }) {
  const team = v.team(side.teamId);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28 }}>
      {team ? <Flag iso2={team.iso2} code={team.code} size={20} /> : <View style={{ width: 20 }} />}
      <Body
        size={14}
        weight={won ? "bold" : "semi"}
        tone={team ? (lost ? "ink3" : "ink") : "ink3"}
        numberOfLines={1}
        style={{ flex: 1, fontStyle: team ? "normal" : "italic" }}
      >
        {team ? team.name : (side.from ?? "To be decided")}
      </Body>
      {score != null ? (
        <Num size={16} tone={lost ? "ink3" : "ink"}>
          {score}
        </Num>
      ) : null}
    </View>
  );
}

function TieBox({ item, v }: { item: BracketTie; v: Model }) {
  const { t } = useTheme();
  const tie = item.tie;
  const tz = v.bundle.tournament.timezone;
  const done = tie.status === "completed";
  const live = tie.status === "live";
  const scored = done || live;
  const winA = done && tie.winner != null && tie.winner === tie.a;
  const winB = done && tie.winner != null && tie.winner === tie.b;
  const court = v.court(tie.courtId);
  const foot = live
    ? "LIVE"
    : done
      ? "FINAL"
      : [tie.scheduledTime ? `${dayIn(tie.scheduledTime, tz)} ${timeIn(tie.scheduledTime, tz)}` : null, court].filter(Boolean).join(" · ") || "Time to be confirmed";
  const a = v.team(tie.a)?.name ?? item.a.from ?? "To be decided";
  const b = v.team(tie.b)?.name ?? item.b.from ?? "To be decided";
  return (
    <Pressable
      onPress={() => openTie(tie.id)}
      accessibilityRole="link"
      accessibilityLabel={`${item.ref}: ${a} against ${b}. ${scored ? `Rubbers ${tie.rubbersA}–${tie.rubbersB}. ` : ""}${foot}`}
      style={({ pressed }) => ({
        backgroundColor: pressed ? t.chip : t.surface,
        borderColor: live ? t.live : t.line,
        borderWidth: 1,
        borderRadius: 16,
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 4,
      })}
    >
      <Eyebrow size={10} tone="ink3">{item.ref}</Eyebrow>
      <Side side={item.a} v={v} score={scored ? tie.rubbersA : null} won={winA} lost={winB} />
      <View style={{ height: 1, backgroundColor: t.line }} />
      <Side side={item.b} v={v} score={scored ? tie.rubbersB : null} won={winB} lost={winA} />
      <Eyebrow size={10} tone={live ? "live" : "ink3"} style={{ marginTop: 2 }}>
        {foot}
      </Eyebrow>
    </Pressable>
  );
}

function Draw({ draw, v }: { draw: BracketDraw; v: Model }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 14, paddingRight: 36 }} style={{ marginHorizontal: -18, paddingLeft: 18 }}>
      {draw.rounds.map((round) => (
        <View key={round.roundNo} style={{ width: COLUMN, gap: 18 }}>
          {round.blocks.map((block) => (
            <View key={block.name} style={{ gap: 10 }}>
              <Eyebrow>{block.name}</Eyebrow>
              {block.ties.map((item) => (
                <TieBox key={item.tie.id} item={item} v={v} />
              ))}
            </View>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

/** The Cup and Plate of a nations event: one column per round, swipe sideways for the next round. */
export function Brackets({ ties, v }: { ties: MTie[]; v: Model }) {
  const draws = placementBrackets(ties);
  const [key, setKey] = useState<string | null>(null);
  if (!draws.length) return <Empty title="The Cup and Plate draws are not out yet" body="They appear here as soon as the group stage is finished." />;
  const draw = draws.find((d) => d.key === key) ?? draws[0];
  return (
    <View style={{ gap: 12 }}>
      {draws.length > 1 ? <Segments value={draw.key} options={draws.map((d) => ({ key: d.key, label: d.name }))} onChange={setKey} /> : null}
      {draw.places ? (
        <Body tone="ink2" size={13}>
          {`${draw.name} · ${draw.places}. Every place is played for — swipe for the next round.`}
        </Body>
      ) : null}
      <Draw draw={draw} v={v} />
    </View>
  );
}
