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
import { useT } from "../i18n";
import { tr } from "../i18n/t";

const COLUMN = 236;

/**
 * The shared bracket's fixed words (draw names, "Places 5–8", "Round 2", "QF 2",
 * "Winner SF 1") in the app's language. Round names the organiser typed stay as written.
 */
function bracketWord(w: string): string {
  const fixed: Record<string, () => string> = {
    Cup: () => tr("hero.cup"),
    Plate: () => tr("hero.plate"),
    Placement: () => tr("hero.placement"),
    Final: () => tr("hero.finalRound"),
    "Semi-finals": () => tr("hero.semiFinals"),
    "Quarter-finals": () => tr("hero.quarterFinals"),
    QF: () => tr("hero.qf"),
    SF: () => tr("hero.sf"),
  };
  if (fixed[w]) return fixed[w]();
  let m = /^(Winner|Loser) (.+)$/.exec(w);
  if (m) return tr(m[1] === "Winner" ? "hero.winnerOf" : "hero.loserOf", { ref: bracketWord(m[2]) });
  m = /^Places (\d+)–(\d+)$/.exec(w);
  if (m) return tr("hero.places", { from: m[1], to: m[2] });
  m = /^Round of (\d+)$/.exec(w);
  if (m) return tr("hero.roundOf", { n: m[1] });
  m = /^Round (\d+)$/.exec(w);
  if (m) return tr("hero.roundN", { n: m[1] });
  m = /^(QF|SF) (\d+)$/.exec(w);
  if (m) return `${bracketWord(m[1])} ${m[2]}`;
  return w;
}

function Side({ side, v, score, won, lost }: { side: BracketSide; v: Model; score: number | null; won: boolean; lost: boolean }) {
  const tr = useT();
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
        {team ? team.name : side.from ? bracketWord(side.from) : tr("hero.toBeDecided")}
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
  const tr = useT();
  const tie = item.tie;
  const tz = v.bundle.tournament.timezone;
  const done = tie.status === "completed";
  const live = tie.status === "live";
  const scored = done || live;
  const winA = done && tie.winner != null && tie.winner === tie.a;
  const winB = done && tie.winner != null && tie.winner === tie.b;
  const court = v.court(tie.courtId);
  const foot = live
    ? tr("hero.pillLive")
    : done
      ? tr("hero.pillFinal")
      : [tie.scheduledTime ? `${dayIn(tie.scheduledTime, tz)} ${timeIn(tie.scheduledTime, tz)}` : null, court].filter(Boolean).join(" · ") || tr("hero.timeToBeConfirmedCap");
  const from = (x: string | null) => (x ? bracketWord(x) : tr("hero.toBeDecided"));
  const a = v.team(tie.a)?.name ?? from(item.a.from);
  const b = v.team(tie.b)?.name ?? from(item.b.from);
  const ref = bracketWord(item.ref);
  return (
    <Pressable
      onPress={() => openTie(tie.id)}
      accessibilityRole="link"
      accessibilityLabel={[`${ref}: ${tr("hero.against", { a, b })}`, scored ? tr("hero.rubbersA11y", { score: `${tie.rubbersA}–${tie.rubbersB}` }) : null, foot].filter(Boolean).join(". ")}
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
      <Eyebrow size={10} tone="ink3">{ref}</Eyebrow>
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
  useT();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 14, paddingRight: 36 }} style={{ marginHorizontal: -18, paddingLeft: 18 }}>
      {draw.rounds.map((round) => (
        <View key={round.roundNo} style={{ width: COLUMN, gap: 18 }}>
          {round.blocks.map((block) => (
            <View key={block.name} style={{ gap: 10 }}>
              <Eyebrow>{bracketWord(block.name)}</Eyebrow>
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
  const tr = useT();
  const draws = placementBrackets(ties);
  const [key, setKey] = useState<string | null>(null);
  if (!draws.length) return <Empty title={tr("hero.bracketsEmptyTitle")} body={tr("hero.bracketsEmptyBody")} />;
  const draw = draws.find((d) => d.key === key) ?? draws[0];
  return (
    <View style={{ gap: 12 }}>
      {draws.length > 1 ? <Segments value={draw.key} options={draws.map((d) => ({ key: d.key, label: bracketWord(d.name) }))} onChange={setKey} /> : null}
      {draw.places ? (
        <Body tone="ink2" size={13}>
          {tr("hero.bracketNote", { name: bracketWord(draw.name), places: bracketWord(draw.places) })}
        </Body>
      ) : null}
      <Draw draw={draw} v={v} />
    </View>
  );
}
